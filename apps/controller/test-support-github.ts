/**
 * A stand-in for GitHub over `fetch`, keyed by the token each request carries.
 *
 * Routes what the credential code asks GitHub: who a token is (`GET /user`),
 * what it can see (`GET /user/repos`, `GET /repos/:owner/:name`), and whether
 * git accepts it for a repository (`info/refs?service=…`). Everything else is
 * 404. Tests inject it through `Deps.fetchImpl`; nothing is mocked at module
 * level.
 */

interface FakeGithubRepo {
  full_name: string;
  private: boolean;
  push: boolean;
  default_branch?: string;
}

export interface FakeGithubSpec {
  user: { id: string | number; login: string };
  /** Classic scopes header, e.g. "repo, workflow". Omit for fine-grained tokens. */
  scopes?: string;
  /** GitHub's expiry header format: "2026-12-05 08:10:35 UTC". */
  expires?: string;
  repos: FakeGithubRepo[];
  /** Status for receive-pack per repo. Default: 200 when `push`, else 403. */
  push?: Record<string, number>;
  /** Status for upload-pack per repo. Default: 200 for listed repos. */
  read?: Record<string, number>;
  /** Every request answers 401, as GitHub does for revoked or expired tokens. */
  rejectToken?: boolean;
}

type SpecInput = FakeGithubSpec | Record<string, FakeGithubSpec>;

interface FakeGithubOptions {
  /** Answer for the OAuth refresh exchange (`POST /login/oauth/access_token`). */
  oauthRefresh?: { access_token: string; refresh_token?: string; expires_in?: number };
  /** Every request answers this status, as during a GitHub outage. */
  status?: number;
}

export function fakeGithubFetch(
  spec: SpecInput,
  options: FakeGithubOptions = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const global = answerUnauthenticated(options, url);
    if (global) return global;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : {}),
    );
    const resolved = specForToken(spec, tokenFrom(headers.get("authorization")));
    if (!resolved || resolved.rejectToken) return json(401, { message: "Bad credentials" });
    return (
      answerRest(resolved, url) ??
      answerGit(resolved, url) ??
      json(404, { message: "Not Found" })
    );
  }) as typeof fetch;
}

/** Outage and the OAuth refresh exchange are answered before any token is looked at. */
function answerUnauthenticated(options: FakeGithubOptions, url: URL): Response | null {
  if (options.status) return json(options.status, { message: "GitHub is unavailable" });
  if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
    return options.oauthRefresh
      ? json(200, options.oauthRefresh)
      : json(400, { error: "bad_refresh_token" });
  }
  return null;
}

function specForToken(spec: SpecInput, token: string | null): FakeGithubSpec | undefined {
  const isSingle = "user" in spec && "repos" in spec;
  if (isSingle) return spec as FakeGithubSpec;
  return token ? (spec as Record<string, FakeGithubSpec>)[token] : undefined;
}

function answerRest(spec: FakeGithubSpec, url: URL): Response | null {
  if (url.host !== "api.github.com") return null;
  if (url.pathname === "/user") return answerUser(spec);
  if (url.pathname === "/user/repos") {
    const firstPage = (url.searchParams.get("page") ?? "1") === "1";
    return json(200, firstPage ? spec.repos.map(toRestRepo) : []);
  }
  const repoPath = /^\/repos\/([^/]+\/[^/]+)(\/branches)?$/.exec(url.pathname);
  return repoPath ? answerRepository(spec, repoPath[1] ?? "", Boolean(repoPath[2])) : null;
}

function answerUser(spec: FakeGithubSpec): Response {
  return json(
    200,
    { id: spec.user.id, login: spec.user.login },
    {
      ...(spec.scopes ? { "x-oauth-scopes": spec.scopes } : {}),
      ...(spec.expires ? { "github-authentication-token-expiration": spec.expires } : {}),
    },
  );
}

function answerRepository(spec: FakeGithubSpec, fullName: string, branches: boolean): Response {
  const known = spec.repos.find((item) => item.full_name === fullName);
  if (!known) return json(404, { message: "Not Found" });
  return branches
    ? json(200, [{ name: known.default_branch ?? "main" }])
    : json(200, toRestRepo(known));
}

function answerGit(spec: FakeGithubSpec, url: URL): Response | null {
  if (url.host !== "github.com" || !url.pathname.endsWith(".git/info/refs")) return null;
  const repo = url.pathname.slice(1, -".git/info/refs".length);
  const known = spec.repos.find((item) => item.full_name === repo);
  const service = url.searchParams.get("service");
  if (service === "git-receive-pack") {
    const fallback = known ? (known.push ? 200 : 403) : 404;
    return new Response("", { status: spec.push?.[repo] ?? fallback });
  }
  if (service === "git-upload-pack") {
    return new Response("", { status: spec.read?.[repo] ?? (known ? 200 : 404) });
  }
  return null;
}

function toRestRepo(repo: FakeGithubRepo) {
  return {
    full_name: repo.full_name,
    private: repo.private,
    default_branch: repo.default_branch ?? "main",
    permissions: { push: repo.push, pull: true },
  };
}

function tokenFrom(authorization: string | null): string | null {
  if (!authorization) return null;
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString();
    return decoded.slice(decoded.indexOf(":") + 1);
  }
  return null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
