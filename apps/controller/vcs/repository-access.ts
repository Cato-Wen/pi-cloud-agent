import { Secret, type VCSProvider, type VcsRepository } from "@pi-cloud-agent/protocol";
import {
  createVcsProvider,
  type GithubTokenRepository,
  inspectGithubToken,
  listGithubTokenRepositories,
  probeGithubRepoAccess,
} from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { findPlatformCredentialsForRepo } from "../db/platform-credentials";
import type { AppUserRow } from "../db/schema";
import {
  loadReviewRepositories,
  usableReviewRepository,
} from "../integrations/review-repositories";
import { getVcsAccessToken, getVcsProvider } from "./connections";
import { getPersonalToken } from "./personal-token";
import { decryptPlatformCredential } from "./platform-credentials";

/**
 * Which credential lets this user touch this repository, and how far.
 *
 * The order is the policy (docs/design/repository-access.md §4.4): the user's
 * own GitHub App sign-in where the App is installed, then their personal
 * token, then a platform credential — and only a read-only one, only for
 * read. A personal token that GitHub now rejects stops the search: a
 * developer who believes they are pushing as themselves must not be handed
 * someone else's read-only token in silence.
 */

export type RepositoryAccess =
  | { mode: "write"; source: "app-user-token" | "pat"; token: Secret }
  | { mode: "read"; source: "pat" | "platform-credential"; token: Secret }
  | { mode: "none"; reason: string };

export type AccessNeed = "read" | "write";

interface Deps {
  fetchImpl: typeof fetch;
}

export async function resolveRepositoryAccess(
  database: Database,
  config: Config,
  user: AppUserRow,
  repoFullName: string,
  need: AccessNeed,
  deps: Deps,
): Promise<RepositoryAccess> {
  const viaApp = await appUserToken(database, config, user, repoFullName);
  if (viaApp) return { mode: "write", source: "app-user-token", token: viaApp };

  const viaPat = await personalTokenAccess(database, config, user, repoFullName, need, deps);
  if (viaPat) return viaPat;

  if (need === "read") {
    const viaPlatform = await platformReadAccess(database, config, repoFullName);
    if (viaPlatform) return viaPlatform;
  }

  return {
    mode: "none",
    reason:
      need === "write"
        ? `No credential can write ${repoFullName}. Add a personal token in Settings, or ask an operator to install the GitHub App.`
        : `No credential can read ${repoFullName}. Add a personal token in Settings, or ask an operator for read access.`,
  };
}

/** Repositories to offer as a task's primary repository: everything the user can push to. */
export async function listWritableRepositories(
  database: Database,
  config: Config,
  user: AppUserRow,
  deps: Deps,
): Promise<Array<VcsRepository & { access: "write" }>> {
  const repos = new Map<string, VcsRepository & { access: "write" }>();
  for (const repository of await appInstalledRepositories(database, config, user)) {
    repos.set(repository.fullName, { ...repository, access: "write" });
  }
  const pat = await getPersonalToken(database, config, user.id);
  if (pat) {
    try {
      for (const repository of await listGithubTokenRepositories(pat.token, deps)) {
        if (repository.canPush) {
          repos.set(repository.fullName, { ...toVcsRepository(repository), access: "write" });
        }
      }
    } catch {
      // A rejected token contributes nothing; Settings reports it as invalid.
    }
  }
  return [...repos.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

/** A forge client that uses whatever credential the access decision picked. */
export function vcsProviderForAccess(
  access: Exclude<RepositoryAccess, { mode: "none" }>,
  deps: Deps,
): VCSProvider {
  return createVcsProvider("github", access.token.expose(), deps);
}

/** Commits inside the sandbox carry the signed-in user, whichever token pushed them. */
export function gitAuthorEnv(user: AppUserRow): Record<string, string> {
  const email = `${user.githubUserId}+${user.login}@users.noreply.github.com`;
  return {
    GIT_AUTHOR_NAME: user.login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: user.login,
    GIT_COMMITTER_EMAIL: email,
  };
}

async function appUserToken(
  database: Database,
  config: Config,
  user: AppUserRow,
  repoFullName: string,
): Promise<Secret | null> {
  if (!config.github.appId || !config.github.privateKey) return null;
  const access = await loadReviewRepositories(database, config, user.id);
  if (!usableReviewRepository(access.repositories, repoFullName)) return null;
  const token = await getVcsAccessToken(database, config, "github", user.id);
  return token ? new Secret(token, "github app user token") : null;
}

/**
 * The user's own token, when it reaches the repository with what is needed.
 * A token GitHub rejects outright yields a `none` with the reason; a valid
 * token that merely lacks this repository yields null so the search continues.
 */
async function personalTokenAccess(
  database: Database,
  config: Config,
  user: AppUserRow,
  repoFullName: string,
  need: AccessNeed,
  deps: Deps,
): Promise<RepositoryAccess | null> {
  const pat = await getPersonalToken(database, config, user.id);
  if (!pat) return null;
  const probed = await probeGithubRepoAccess(pat.token, repoFullName, deps);
  const token = new Secret(pat.token, "personal github token");
  if (probed === "write") return { mode: "write", source: "pat", token };
  if (probed === "read" && need === "read") return { mode: "read", source: "pat", token };
  if (probed === "none" && !(await tokenStillAccepted(pat.token, deps))) {
    return {
      mode: "none",
      reason: "Your personal GitHub token was rejected by GitHub. Update it in Settings.",
    };
  }
  return null;
}

/** Only a credential whose probe said read-only; a writable one is never lent out for reading. */
async function platformReadAccess(
  database: Database,
  config: Config,
  repoFullName: string,
): Promise<RepositoryAccess | null> {
  const candidates = await findPlatformCredentialsForRepo(database, "github", repoFullName);
  const readOnly = candidates.find((row) =>
    row.repoAccess.some(
      (entry) => sameRepo(entry.repo, repoFullName) && entry.access === "read",
    ),
  );
  if (!readOnly) return null;
  return {
    mode: "read",
    source: "platform-credential",
    token: new Secret(
      await decryptPlatformCredential(database, config, readOnly.id),
      `platform credential ${readOnly.label}`,
    ),
  };
}

async function appInstalledRepositories(
  database: Database,
  config: Config,
  user: AppUserRow,
): Promise<VcsRepository[]> {
  if (!config.github.appId || !config.github.privateKey) return [];
  const access = await loadReviewRepositories(database, config, user.id);
  const allowed = new Set(
    access.repositories.filter((item) => !item.problem).map((item) => item.repo),
  );
  if (allowed.size === 0) return [];
  const vcs = await getVcsProvider(database, config, "github", user.id);
  return (await vcs.listRepos()).filter((repository) => allowed.has(repository.fullName));
}

async function tokenStillAccepted(token: string, deps: Deps): Promise<boolean> {
  try {
    await inspectGithubToken(token, deps);
    return true;
  } catch {
    return false;
  }
}

function toVcsRepository(repository: GithubTokenRepository): VcsRepository {
  const [owner = "", name = ""] = repository.fullName.split("/");
  return {
    provider: "github",
    host: "github.com",
    fullName: repository.fullName,
    owner,
    name,
    cloneUrl: `https://github.com/${repository.fullName}.git`,
    defaultBranch: repository.defaultBranch,
  };
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
