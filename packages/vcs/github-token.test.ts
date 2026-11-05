import { describe, expect, it } from "vitest";
import {
  GithubTokenRejectedError,
  githubTokenKind,
  inspectGithubToken,
  listGithubTokenRepositories,
  probeGithubRepoAccess,
} from "./github-token";

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

/** Routes by URL prefix; records every request so tests can assert on headers. */
function fakeFetch(routes: Record<string, Route | ((url: URL) => Route)>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    calls.push({ url: url.toString(), init });
    const match = Object.entries(routes).find(([prefix]) => url.toString().startsWith(prefix));
    if (!match) return new Response("not found", { status: 404 });
    const route = match[1];
    const resolved = typeof route === "function" ? route(url) : route;
    return new Response(resolved.body === undefined ? "" : JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { "content-type": "application/json", ...resolved.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("GitHub token inspection", () => {
  it("tells classic from fine-grained tokens by prefix", () => {
    expect(githubTokenKind("ghp_abc")).toBe("classic");
    expect(githubTokenKind("github_pat_abc")).toBe("fine-grained");
    expect(githubTokenKind("gho_abc")).toBe("unknown");
  });

  it("reads account, kind, scopes and expiry from GET /user", async () => {
    const { fetchImpl } = fakeFetch({
      "https://api.github.com/user": {
        status: 200,
        body: { id: 104287479, login: "Cato-Wen" },
        headers: {
          "x-oauth-scopes": "repo, workflow",
          "github-authentication-token-expiration": "2026-12-05 08:10:35 UTC",
        },
      },
    });
    const info = await inspectGithubToken("ghp_token", { fetchImpl });
    expect(info).toEqual({
      accountId: "104287479",
      login: "Cato-Wen",
      kind: "classic",
      scopes: ["repo", "workflow"],
      expiresAt: new Date("2026-12-05T08:10:35.000Z"),
    });
  });

  it("rejects a token GitHub does not accept with a distinct error", async () => {
    const { fetchImpl } = fakeFetch({
      "https://api.github.com/user": { status: 401, body: { message: "Bad credentials" } },
    });
    await expect(inspectGithubToken("ghp_bad", { fetchImpl })).rejects.toBeInstanceOf(
      GithubTokenRejectedError,
    );
    await expect(listGithubTokenRepositories("ghp_bad", { fetchImpl })).rejects.toBeInstanceOf(
      GithubTokenRejectedError,
    );
  });

  it("does not call a token rejected when GitHub itself is failing", async () => {
    const { fetchImpl } = fakeFetch({
      "https://api.github.com/user": { status: 503, body: { message: "down" } },
    });
    const failure = await inspectGithubToken("ghp_fine", { fetchImpl }).catch((cause) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GithubTokenRejectedError);
  });
});

describe("GitHub repository access probing", () => {
  const repo = "food-truck/master-data-management";
  const receive = `https://github.com/${repo}.git/info/refs?service=git-receive-pack`;
  const upload = `https://github.com/${repo}.git/info/refs?service=git-upload-pack`;

  it("classifies write when receive-pack answers 200", async () => {
    const { fetchImpl } = fakeFetch({ [receive]: { status: 200 }, [upload]: { status: 200 } });
    expect(await probeGithubRepoAccess("ghp_t", repo, { fetchImpl })).toBe("write");
  });

  it("classifies read when only upload-pack answers 200", async () => {
    const { fetchImpl } = fakeFetch({ [receive]: { status: 403 }, [upload]: { status: 200 } });
    expect(await probeGithubRepoAccess("ghp_t", repo, { fetchImpl })).toBe("read");
  });

  it("classifies none when neither endpoint accepts the token", async () => {
    const { fetchImpl } = fakeFetch({ [receive]: { status: 401 }, [upload]: { status: 401 } });
    expect(await probeGithubRepoAccess("ghp_t", repo, { fetchImpl })).toBe("none");
  });

  it("sends basic auth with the x-access-token username to github.com", async () => {
    const { fetchImpl, calls } = fakeFetch({ [receive]: { status: 200 } });
    await probeGithubRepoAccess("ghp_secret", repo, { fetchImpl });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(
      `Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`,
    );
  });
});

describe("GitHub repository listing for a token", () => {
  it("keeps every repository with its private and push flags and stops paging under 100 items", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "https://api.github.com/user/repos": {
        status: 200,
        body: [
          {
            full_name: "food-truck/master-data-management",
            private: true,
            default_branch: "develop",
            permissions: { push: true },
          },
          { full_name: "Cato-Wen/agent-config", private: false, permissions: { push: true } },
          { full_name: "ct-kb/team-cookbook-kb", private: true, permissions: { push: false } },
          { full_name: "broken" },
        ],
      },
    });
    const repos = await listGithubTokenRepositories("ghp_t", { fetchImpl });
    expect(repos).toEqual([
      {
        fullName: "food-truck/master-data-management",
        defaultBranch: "develop",
        isPrivate: true,
        canPush: true,
      },
      {
        fullName: "Cato-Wen/agent-config",
        defaultBranch: null,
        isPrivate: false,
        canPush: true,
      },
      {
        fullName: "ct-kb/team-cookbook-kb",
        defaultBranch: null,
        isPrivate: true,
        canPush: false,
      },
    ]);
    // One page of 4 < 100 means there is nothing more to fetch.
    expect(calls).toHaveLength(1);
  });
});
