import { PAT_PROVIDER, type PersonalTokenStatus } from "@pi-cloud-agent/protocol";
import {
  type GithubTokenInfo,
  GithubTokenRejectedError,
  githubTokenKind,
  inspectGithubToken,
  listGithubTokenRepositories,
} from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import type { Database } from "../db/client";
import type { AppUserRow } from "../db/schema";
import {
  deleteVcsConnection,
  getVcsConnection,
  upsertVcsConnection,
} from "../db/vcs-connections";
import { decryptSecret, encryptSecret } from "../secrets/crypto";

/**
 * A developer's own GitHub token: the credential that lets commits, pushes and
 * pull requests carry their identity without a GitHub App installation.
 *
 * The one hard rule is that the token must belong to the signed-in account.
 * A token GitHub has since revoked is reported as invalid; a fine-grained
 * token still waiting for an organization owner is reported as a hint. A
 * GitHub outage is neither — it propagates, so nobody is told to replace a
 * token that is fine.
 */

/** The user's input is at fault: wrong account, missing scope, or a token GitHub refuses. */
export class PersonalTokenError extends Error {}

interface Deps {
  fetchImpl: typeof fetch;
}

export async function savePersonalToken(
  database: Database,
  config: Config,
  user: AppUserRow,
  token: string,
  deps: Deps,
): Promise<PersonalTokenStatus> {
  const info = await inspectGithubToken(token, deps).catch((cause: unknown) => {
    if (cause instanceof GithubTokenRejectedError) {
      throw new PersonalTokenError(
        "GitHub rejected this token. Check that you copied it fully.",
      );
    }
    throw cause;
  });
  if (info.accountId !== user.githubUserId) {
    throw new PersonalTokenError(
      `This token belongs to another GitHub account (${info.login}), not ${user.login}.`,
    );
  }
  if (info.kind === "classic" && !info.scopes.includes("repo")) {
    throw new PersonalTokenError(
      "A classic token needs the repo scope to work with repositories.",
    );
  }
  await upsertVcsConnection(database, {
    userId: user.id,
    provider: PAT_PROVIDER,
    accountId: info.accountId,
    accountName: info.login,
    accessToken: encryptSecret(token, config.vcs.encryptionKey),
    refreshToken: null,
    expiresAt: info.expiresAt,
  });
  return describeToken(token, info, deps);
}

export async function getPersonalTokenStatus(
  database: Database,
  config: Config,
  user: AppUserRow,
  deps: Deps,
): Promise<PersonalTokenStatus> {
  const stored = await getPersonalToken(database, config, user.id);
  if (!stored) return disconnected();
  try {
    const info = await inspectGithubToken(stored.token, deps);
    return describeToken(stored.token, info, deps);
  } catch (cause) {
    if (!(cause instanceof GithubTokenRejectedError)) throw cause;
    return {
      ...disconnected(),
      connected: true,
      kind: githubTokenKind(stored.token),
      login: stored.login,
      last4: last4(stored.token),
      state: "invalid",
    };
  }
}

export async function deletePersonalToken(database: Database, user: AppUserRow): Promise<void> {
  await deleteVcsConnection(database, user.id, PAT_PROVIDER);
}

/** The decrypted token for credential minting. Callers must wrap it in `Secret`. */
export async function getPersonalToken(
  database: Database,
  config: Config,
  userId: string,
): Promise<{ token: string; login: string } | null> {
  const row = await getVcsConnection(database, userId, PAT_PROVIDER);
  if (!row) return null;
  return {
    token: decryptSecret(row.accessToken, config.vcs.encryptionKey),
    login: row.accountName,
  };
}

async function describeToken(
  token: string,
  info: GithubTokenInfo,
  deps: Deps,
): Promise<PersonalTokenStatus> {
  const repositories = await listGithubTokenRepositories(token, deps);
  return {
    connected: true,
    kind: info.kind,
    login: info.login,
    last4: last4(token),
    scopes: info.scopes,
    expiresAt: info.expiresAt?.toISOString() ?? null,
    state: "valid",
    pendingHint:
      info.kind === "fine-grained" && !repositories.some((repository) => repository.isPrivate),
    writableRepos: repositories
      .filter((repository) => repository.canPush)
      .map((repository) => repository.fullName)
      .sort()
      .slice(0, 100),
  };
}

function disconnected(): PersonalTokenStatus {
  return {
    connected: false,
    kind: null,
    login: null,
    last4: null,
    scopes: [],
    expiresAt: null,
    state: "none",
    pendingHint: false,
    writableRepos: [],
  };
}

function last4(token: string): string {
  return token.slice(-4);
}
