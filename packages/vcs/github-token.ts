/**
 * What a GitHub token can do, asked of GitHub itself.
 *
 * REST tells us who the token belongs to and (for classic tokens) its scopes.
 * Whether it can read or push a repository is answered by git's own smart-HTTP
 * handshake, because the REST `permissions` block reflects the account, not
 * the token: a fine-grained token with Contents: read still reports `push`
 * when its owner has write access. `info/refs` never changes anything.
 */

const API_BASE = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";
const GIT_USERNAME = "x-access-token";
const PROBE_TIMEOUT_MS = 15_000;
const MAX_REPO_PAGES = 5;

export type GithubTokenKind = "classic" | "fine-grained" | "unknown";

export interface GithubTokenInfo {
  accountId: string;
  login: string;
  kind: GithubTokenKind;
  /** Classic tokens only; fine-grained tokens report nothing here. */
  scopes: string[];
  expiresAt: Date | null;
}

export interface GithubTokenRepository {
  fullName: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  /** `permissions.push` from REST: the account's access, not necessarily the token's. */
  canPush: boolean;
}

export type RepoAccess = "write" | "read" | "none";

export interface GithubTokenDeps {
  fetchImpl?: typeof fetch;
}

/**
 * GitHub answered 401: the token is revoked, expired or never valid. Every
 * other failure (outage, rate limit, timeout) is a plain Error, so callers can
 * tell "replace your token" from "try again later".
 */
export class GithubTokenRejectedError extends Error {
  constructor() {
    super("GitHub rejected the token");
    this.name = "GithubTokenRejectedError";
  }
}

export function githubTokenKind(token: string): GithubTokenKind {
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("github_pat_")) return "fine-grained";
  return "unknown";
}

export async function inspectGithubToken(
  token: string,
  deps: GithubTokenDeps = {},
): Promise<GithubTokenInfo> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${API_BASE}/user`, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (response.status === 401) throw new GithubTokenRejectedError();
  if (!response.ok) throw new Error(`GET /user failed: ${response.status}`);
  const user = (await response.json()) as { id?: number | string; login?: string };
  if (user.id === undefined || !user.login) {
    throw new Error("GitHub did not return an account for the token");
  }
  return {
    accountId: String(user.id),
    login: user.login,
    kind: githubTokenKind(token),
    scopes: splitList(response.headers.get("x-oauth-scopes")),
    expiresAt: parseGithubDate(response.headers.get("github-authentication-token-expiration")),
  };
}

export async function listGithubTokenRepositories(
  token: string,
  deps: GithubTokenDeps = {},
): Promise<GithubTokenRepository[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const repositories: GithubTokenRepository[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const response = await fetchImpl(
      `${API_BASE}/user/repos?per_page=100&sort=full_name&page=${page}`,
      { headers: apiHeaders(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (response.status === 401) throw new GithubTokenRejectedError();
    if (!response.ok) throw new Error(`GET /user/repos failed: ${response.status}`);
    const batch = (await response.json()) as Array<{
      full_name?: string;
      private?: boolean;
      default_branch?: string;
      permissions?: { push?: boolean };
    }>;
    for (const item of batch) {
      if (!item.full_name?.includes("/")) continue;
      repositories.push({
        fullName: item.full_name,
        defaultBranch: item.default_branch ?? null,
        isPrivate: item.private === true,
        canPush: item.permissions?.push === true,
      });
    }
    if (batch.length < 100) break;
  }
  return repositories;
}

export async function probeGithubRepoAccess(
  token: string,
  repoFullName: string,
  deps: GithubTokenDeps = {},
): Promise<RepoAccess> {
  if (await gitServiceAccepts(token, repoFullName, "git-receive-pack", deps)) return "write";
  if (await gitServiceAccepts(token, repoFullName, "git-upload-pack", deps)) return "read";
  return "none";
}

async function gitServiceAccepts(
  token: string,
  repoFullName: string,
  service: "git-receive-pack" | "git-upload-pack",
  deps: GithubTokenDeps,
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const basic = Buffer.from(`${GIT_USERNAME}:${token}`).toString("base64");
  const response = await fetchImpl(
    `https://github.com/${repoFullName}.git/info/refs?service=${service}`,
    {
      headers: { Authorization: `Basic ${basic}` },
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    },
  );
  return response.status === 200;
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: ACCEPT,
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function splitList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** GitHub writes `2026-12-05 08:10:35 UTC`; absent for tokens without expiry. */
function parseGithubDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}
