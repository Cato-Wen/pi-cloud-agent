import { Secret, type VCSProvider, type VcsRepository } from "@pi-cloud-agent/protocol";
import {
  createVcsProvider,
  GithubTokenRejectedError,
  type GithubTokenRepository,
  inspectGithubToken,
  listGithubTokenRepositories,
  probeGithubRepoAccess,
  type RepoAccess,
} from "@pi-cloud-agent/vcs";
import type { Config } from "../config";
import type { Database } from "../db/client";
import { findPlatformCredentialsForRepo } from "../db/platform-credentials";
import type { AppUserRow, PlatformVcsCredentialRow } from "../db/schema";
import { getVcsAccessToken } from "./connections";
import { getPersonalToken } from "./personal-token";
import { decryptPlatformCredential } from "./platform-credentials";

/**
 * Which credential lets this user touch this repository, and how far.
 *
 * The order is the policy (docs/design/repository-access.md §4.4): the user's
 * own GitHub sign-in where it reaches the repository, then their personal
 * token, then a platform credential — and only a read-only one, only for
 * read. Every token is asked git itself what it may do. A personal token that
 * GitHub now rejects stops the search: a developer who believes they are
 * pushing as themselves must not be handed someone else's read-only token in
 * silence. A sign-in token that fails is merely skipped, because it refreshes
 * on its own and the personal token is the developer's deliberate choice.
 */

export type RepositoryAccess =
  | { mode: "write"; source: "app-user-token" | "pat"; token: Secret }
  | { mode: "read"; source: "app-user-token" | "pat" | "platform-credential"; token: Secret }
  | { mode: "none"; reason: string };

export type AccessNeed = "read" | "write";

interface Deps {
  fetchImpl: typeof fetch;
  /**
   * Only the user's own sign-in and personal tokens. Context repositories use
   * this: a platform credential is an operator's long-lived token and must not
   * enter a sandbox any signed-in user chose. Phase 3 lends it through agents.
   */
  ownCredentialsOnly?: boolean;
}

/** The sign-in token is refreshed if it would expire before the longest run could finish. */
const RUN_TOKEN_SLACK_MS = 5 * 60_000;

export async function resolveRepositoryAccess(
  database: Database,
  config: Config,
  user: AppUserRow,
  repoFullName: string,
  need: AccessNeed,
  deps: Deps,
): Promise<RepositoryAccess> {
  const viaSignIn = await signInTokenAccess(database, config, user, repoFullName, need, deps);
  if (viaSignIn) return viaSignIn;

  const viaPat = await personalTokenAccess(database, config, user, repoFullName, need, deps);
  if (viaPat) return viaPat;

  if (need === "read" && !deps.ownCredentialsOnly) {
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
  for (const repository of await ownTokenRepositories(database, config, user, deps)) {
    if (repository.canPush && !repos.has(repository.fullName)) {
      repos.set(repository.fullName, { ...toVcsRepository(repository), access: "write" });
    }
  }
  return sortedByName(repos);
}

/** Everything the user's sign-in token and personal token can see, sign-in first. */
async function ownTokenRepositories(
  database: Database,
  config: Config,
  user: AppUserRow,
  deps: Deps,
): Promise<GithubTokenRepository[]> {
  const signIn = await signInToken(database, config, user, deps).catch(() => "");
  const pat = await getPersonalToken(database, config, user.id);
  const repositories: GithubTokenRepository[] = [];
  for (const token of [signIn, pat?.token ?? ""]) {
    if (!token) continue;
    try {
      repositories.push(...(await listGithubTokenRepositories(token, deps)));
    } catch {
      // A rejected or unreachable token contributes nothing; Settings reports it.
    }
  }
  return repositories;
}

function sortedByName<T extends VcsRepository>(repos: Map<string, T>): T[] {
  return [...repos.values()].sort((left, right) => left.fullName.localeCompare(right.fullName));
}

/**
 * Repositories to offer as read-only context: everything either of the
 * user's own tokens can see. Platform credentials are deliberately absent;
 * see `Deps.ownCredentialsOnly`.
 */
export async function listReadableRepositories(
  database: Database,
  config: Config,
  user: AppUserRow,
  deps: Deps,
): Promise<VcsRepository[]> {
  const repos = new Map<string, VcsRepository>();
  for (const repository of await ownTokenRepositories(database, config, user, deps)) {
    if (!repos.has(repository.fullName)) {
      repos.set(repository.fullName, toVcsRepository(repository));
    }
  }
  return sortedByName(repos);
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

/** The GitHub App user token from sign-in, fresh enough to outlive a run. Empty when absent. */
async function signInToken(
  database: Database,
  config: Config,
  user: AppUserRow,
  deps: Deps,
): Promise<string> {
  return getVcsAccessToken(database, config, "github", user.id, {
    minValidityMs: config.runWallClockSeconds * 1000 + RUN_TOKEN_SLACK_MS,
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * The user's own sign-in, where git accepts it for what is needed. Any failure
 * here — expired refresh, GitHub outage, a token GitHub no longer honors —
 * means "not this way", never a verdict on the repository.
 */
async function signInTokenAccess(
  database: Database,
  config: Config,
  user: AppUserRow,
  repoFullName: string,
  need: AccessNeed,
  deps: Deps,
): Promise<RepositoryAccess | null> {
  try {
    const token = await signInToken(database, config, user, deps);
    if (!token) return null;
    const probed = await probeGithubRepoAccess(token, repoFullName, deps);
    return grant(probed, need, new Secret(token, "github app user token"), "app-user-token");
  } catch {
    return null;
  }
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
  const granted = grant(probed, need, new Secret(pat.token, "personal github token"), "pat");
  if (granted) return granted;
  if (probed === "none" && !(await tokenStillAccepted(pat.token, deps))) {
    return {
      mode: "none",
      reason: "Your personal GitHub token was rejected by GitHub. Update it in Settings.",
    };
  }
  return null;
}

/**
 * Only a credential whose probe said read-only for this repository; among
 * those, one that can push nowhere at all comes first, so a sandbox analyzing
 * one repository is not handed a token that could write another.
 */
async function platformReadAccess(
  database: Database,
  config: Config,
  repoFullName: string,
): Promise<RepositoryAccess | null> {
  const candidates = (await findPlatformCredentialsForRepo(database, "github", repoFullName))
    .filter((row) => accessFor(row, repoFullName) === "read")
    .sort((left, right) => Number(canPushAnywhere(left)) - Number(canPushAnywhere(right)));
  const chosen = candidates[0];
  if (!chosen) return null;
  return {
    mode: "read",
    source: "platform-credential",
    token: new Secret(
      await decryptPlatformCredential(database, config, chosen.id),
      `platform credential ${chosen.label}`,
    ),
  };
}

function grant(
  probed: RepoAccess,
  need: AccessNeed,
  token: Secret,
  source: "app-user-token" | "pat",
): RepositoryAccess | null {
  if (probed === "write") return { mode: "write", source, token };
  if (probed === "read" && need === "read") return { mode: "read", source, token };
  return null;
}

async function tokenStillAccepted(token: string, deps: Deps): Promise<boolean> {
  try {
    await inspectGithubToken(token, deps);
    return true;
  } catch (cause) {
    if (cause instanceof GithubTokenRejectedError) return false;
    throw cause;
  }
}

function accessFor(row: PlatformVcsCredentialRow, repoFullName: string): RepoAccess {
  const entry = row.repoAccess.find((item) => sameRepo(item.repo, repoFullName));
  return entry?.access ?? "none";
}

function canPushAnywhere(row: PlatformVcsCredentialRow): boolean {
  return row.repoAccess.some((entry) => entry.access === "write");
}

function toVcsRepository(
  repository: Pick<GithubTokenRepository, "fullName" | "defaultBranch">,
): VcsRepository {
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
