import { SANDBOX_ENV, Secret } from "@pi-cloud-agent/protocol";
import type { Config } from "../config";
import { getAppUserById } from "../db/auth";
import type { Database } from "../db/client";
import {
  modelIdFromSnapshot,
  type ResolvedLlmModel,
  resolveLlmModelForRun,
} from "../llm/connections";
import type { Logger } from "../logger";
import { getVcsProvider } from "../vcs/connections";
import { gitAuthorEnv, resolveRepositoryAccess } from "../vcs/repository-access";

/**
 * Shapes the credentials one run needs, and nothing more.
 *
 * GitHub credentials come from the access decision in vcs/repository-access.ts:
 * the user's own sign-in where the App is installed, their personal token, or
 * a read-only platform credential. Other forges retain their provider-specific
 * behavior; see docs/secrets.md for the remaining sandbox-boundary limitation.
 */
export interface CredentialBroker {
  mintForRepository(input: {
    userId: string;
    provider: string;
    repoFullName: string;
  }): Promise<RepositoryCredentials>;
  mintForRun(input: MintInput): Promise<RunCredentials>;
}

interface RepositoryCredentials {
  secrets: Record<string, Secret>;
  env: Record<string, string>;
  /** Why no forge credential was produced, when none was. */
  problem?: string;
}

interface MintInput {
  userId: string | null;
  provider: string;
  repoFullName: string;
  modelConnectionId: string | null;
  modelSnapshot: string;
}

interface RunCredentials {
  /** Injected as environment variables, kept out of logs and events. */
  secrets: Record<string, Secret>;
  /** Non-secret companions to those credentials (usernames, hosts). */
  env: Record<string, string>;
  model: ResolvedLlmModel;
}

interface BrokerDeps {
  /** Outbound HTTP for GitHub token probes; tests substitute a fake. */
  fetchImpl?: typeof fetch;
}

/** Conventional variable names expected by GitHub's CLI and git. */
const CLI_TOKEN_ALIASES: Record<string, string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  "azure-devops": [],
};

/** The username half of HTTP basic auth for a token, per forge. */
const GIT_USERNAMES: Record<string, string> = {
  github: "x-access-token",
  "azure-devops": "oauth2",
};

export function createCredentialBroker(
  config: Config,
  database: Database,
  log: Logger,
  deps: BrokerDeps = {},
): CredentialBroker {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async mintForRepository({
      userId,
      provider,
      repoFullName,
    }): Promise<RepositoryCredentials> {
      const secrets: Record<string, Secret> = {};
      const env: Record<string, string> = {};
      try {
        const token =
          provider === "github"
            ? await mintGithubRepositoryToken(config, database, userId, repoFullName, fetchImpl)
            : await (await getVcsProvider(database, config, provider, userId)).mintRepoToken(
                repoFullName,
              );
        secrets[SANDBOX_ENV.scmToken] = token;
        for (const alias of CLI_TOKEN_ALIASES[provider] ?? []) secrets[alias] = token;
        env[SANDBOX_ENV.scmTokenUsername] = GIT_USERNAMES[provider] ?? "x-access-token";
        return { secrets, env };
      } catch (error) {
        log.warn("no forge credential for repository", { provider, repo: repoFullName, error });
        return {
          secrets,
          env,
          problem: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async mintForRun({
      userId,
      provider,
      repoFullName,
      modelConnectionId,
      modelSnapshot,
    }): Promise<RunCredentials> {
      if (!userId) throw new Error("authentication is required to run a task");
      if (!modelConnectionId) throw new Error("run has no model connection");
      const model = await resolveLlmModelForRun(
        database,
        config,
        userId,
        modelConnectionId,
        modelIdFromSnapshot(modelSnapshot),
      );
      const secrets: Record<string, Secret> = {
        [SANDBOX_ENV.modelApiKey]: new Secret(model.apiKey, "model api key"),
      };
      if (model.authJson) {
        secrets[SANDBOX_ENV.modelAuthJson] = new Secret(
          model.authJson,
          "model OAuth credential",
        );
      }
      const env: Record<string, string> = {};

      // Public repositories remain usable when no identity is connected. A
      // credential failure is reported by the agent only if the run needs it.
      const repository = await this.mintForRepository({ userId, provider, repoFullName });
      if (
        provider === "github" &&
        config.auth.requireUser &&
        !repository.secrets[SANDBOX_ENV.scmToken]
      ) {
        throw new Error(repository.problem ?? "could not mint a GitHub credential for the run");
      }
      Object.assign(secrets, repository.secrets);
      Object.assign(env, repository.env);

      if (provider === "github") {
        const user = await getAppUserById(database, userId);
        if (user) Object.assign(env, gitAuthorEnv(user));
      }

      env[SANDBOX_ENV.modelAuthType] = model.authType;
      return { secrets, env, model };
    },
  };
}

/**
 * A task's primary repository must be writable by a credential the user owns.
 * There is deliberately no read-only fallback here: a run that silently
 * switched to someone else's token would fail at push time with no warning.
 */
async function mintGithubRepositoryToken(
  config: Config,
  database: Database,
  userId: string,
  repoFullName: string,
  fetchImpl: typeof fetch,
): Promise<Secret> {
  const user = await getAppUserById(database, userId);
  if (!user) throw new Error("run user no longer exists");
  const access = await resolveRepositoryAccess(database, config, user, repoFullName, "write", {
    fetchImpl,
  });
  if (access.mode === "none") throw new Error(access.reason);
  return access.token;
}
