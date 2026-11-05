import type { ReposResponse, SessionSummary } from "@pi-cloud-agent/protocol";
import { beforeEach, expect, it } from "vitest";
import { getAppUserById } from "../db/auth";
import type { Database } from "../db/client";
import { insertPlatformCredential } from "../db/platform-credentials";
import type { AppUserRow, PlatformRepoAccess } from "../db/schema";
import { upsertVcsConnection } from "../db/vcs-connections";
import { createApp } from "../http/app";
import { createCredentialBroker } from "../secrets/broker";
import { encryptSecret } from "../secrets/crypto";
import {
  bindTestDatabase,
  jsonBody as json,
  seedTestUser,
  sessionHeaders,
  silentLogger,
  testConfig,
  withTestModel,
} from "../test-support";
import { type FakeGithubSpec, fakeGithubFetch } from "../test-support-github";
import { savePersonalToken } from "./personal-token";
import { type AccessNeed, resolveRepositoryAccess } from "./repository-access";

const PAT = "ghp_developer0000000000000000000000000dEv1";
const LOGIN = "gho_signin000000000000000000000000000000L0g1";
const REFRESHED = "gho_refreshed0000000000000000000000000000Rfr2";
const READ_ONLY = "github_pat_platformreadonly0000000000RdOn";
const WRITABLE = "github_pat_platformwritable0000000000WrIt";
const REPO = "food-truck/master-data-management";
const ME = { id: "default-test-user", login: "default-test-user" };
const EIGHT_HOURS = 8 * 3_600_000;

const github: Record<string, FakeGithubSpec> = {
  [PAT]: {
    user: ME,
    scopes: "repo, workflow",
    repos: [
      { full_name: REPO, private: true, push: true, default_branch: "develop" },
      { full_name: "ct-kb/team-cookbook-kb", private: true, push: false },
    ],
  },
  [READ_ONLY]: {
    user: { id: 1, login: "Cato-Wen" },
    repos: [{ full_name: REPO, private: true, push: false }],
  },
  [WRITABLE]: {
    user: { id: 2, login: "foodtruck-bot" },
    repos: [{ full_name: REPO, private: true, push: true }],
  },
};

/** The sign-in token sees `repos`; everything else answers as in `github`. */
const withSignIn = (repos: FakeGithubSpec["repos"], extra: Partial<FakeGithubSpec> = {}) => ({
  ...github,
  [LOGIN]: { user: ME, repos, ...extra },
});

// Access rules only apply when sign-in is required; local test mode waves everything through.
const config = testConfig({ APP_AUTH_REQUIRED: "true" });
let database: Database;
let cookie: string;
let userId: string;
let modelConnectionId: string;

bindTestDatabase((bound) => {
  database = bound;
});
beforeEach(async () => {
  ({ cookie, userId, modelConnectionId } = await seedTestUser(database, config));
});

type Spec = FakeGithubSpec | Record<string, FakeGithubSpec>;
const appWith = (spec: Spec) =>
  createApp({ config, database, log: silentLogger(), fetchImpl: fakeGithubFetch(spec) });

async function user(): Promise<AppUserRow> {
  const row = await getAppUserById(database, userId);
  if (!row) throw new Error("test user missing");
  return row;
}

const resolve = async (need: AccessNeed, fetchImpl: typeof fetch) =>
  resolveRepositoryAccess(database, config, await user(), REPO, need, { fetchImpl });

const mintRun = (spec: Spec, provider = "github", repoFullName = REPO) =>
  createCredentialBroker(config, database, silentLogger(), {
    fetchImpl: fakeGithubFetch(spec),
  }).mintForRun({
    userId,
    provider,
    repoFullName,
    modelConnectionId,
    modelSnapshot: "test-provider/test-model",
  });

async function bindPat(): Promise<void> {
  await savePersonalToken(database, config, await user(), PAT, {
    fetchImpl: fakeGithubFetch(github),
  });
}

async function seedSignInToken(expiresAt: Date): Promise<void> {
  await upsertVcsConnection(database, {
    userId,
    provider: "github",
    accountId: ME.id,
    accountName: ME.login,
    accessToken: encryptSecret(LOGIN, config.vcs.encryptionKey),
    refreshToken: encryptSecret("refresh-1", config.vcs.encryptionKey),
    expiresAt,
  });
}

async function seedPlatformCredential(
  label: string,
  token: string,
  repoAccess: PlatformRepoAccess[] | PlatformRepoAccess["access"],
) {
  return insertPlatformCredential(database, {
    provider: "github",
    label,
    accountId: label,
    accountLogin: label,
    accessToken: encryptSecret(token, config.vcs.encryptionKey),
    expiresAt: null,
    repoAccess:
      typeof repoAccess === "string" ? [{ repo: REPO, access: repoAccess }] : repoAccess,
    probedAt: new Date(),
    updatedBy: null,
  });
}

const startTask = (app: ReturnType<typeof createApp>) =>
  app.request("/sessions", {
    method: "POST",
    headers: sessionHeaders(cookie),
    body: JSON.stringify(
      withTestModel(
        { repo: REPO, provider: "github", prompt: "do the thing" },
        modelConnectionId,
      ),
    ),
  });

it("lists repositories the personal token can push to, without a GitHub App installation", async () => {
  await bindPat();
  const body = await json<ReposResponse>(
    await appWith(github).request("/repos", { headers: sessionHeaders(cookie) }),
  );
  expect(body.repos.map((repo) => repo.fullName)).toEqual([REPO]);
  expect(body.repos[0]?.access).toBe("write");
  expect(body.repos[0]?.defaultBranch).toBe("develop");
});

it("lets a task start on a repository the personal token can write", async () => {
  await bindPat();
  const response = await startTask(appWith(github));
  expect(response.status, await response.clone().text()).toBe(201);
  expect((await json<SessionSummary>(response)).repo).toBe(REPO);
});

it("refuses to start when no credential can write the repository", async () => {
  const response = await startTask(appWith(github));
  expect(response.status).toBe(422);
  expect((await json<{ error: string }>(response)).error).toMatch(/personal token/i);
});

it("fails loudly instead of falling back when the personal token is rejected", async () => {
  await bindPat();
  await seedPlatformCredential("food-truck read-only", READ_ONLY, "read");
  // GitHub revoked the developer's token; a read-only platform credential exists.
  const revoked = { ...github, [PAT]: { ...github[PAT], rejectToken: true } } as Spec;
  const access = await resolve("read", fakeGithubFetch(revoked));
  expect(access.mode).toBe("none");
  if (access.mode === "none") expect(access.reason).toMatch(/rejected/);
});

it("prefers a read-only platform credential over a writable one for read access", async () => {
  await seedPlatformCredential("writable", WRITABLE, "write");
  await seedPlatformCredential("read-only", READ_ONLY, "read");
  const access = await resolve("read", fakeGithubFetch(github));
  expect(access.mode).toBe("read");
  if (access.mode === "read") {
    expect(access.source).toBe("platform-credential");
    expect(access.token.expose()).toBe(READ_ONLY);
  }
});

it("does not use a writable platform credential to satisfy a read request", async () => {
  await seedPlatformCredential("writable", WRITABLE, "write");
  expect((await resolve("read", fakeGithubFetch(github))).mode).toBe("none");
});

it("prefers a platform credential that can push nowhere over one that can push elsewhere", async () => {
  await seedPlatformCredential("mixed", WRITABLE, [
    { repo: REPO, access: "read" },
    { repo: "food-truck/other", access: "write" },
  ]);
  await seedPlatformCredential("pure read-only", READ_ONLY, "read");
  const access = await resolve("read", fakeGithubFetch(github));
  expect(access.mode).toBe("read");
  if (access.mode === "read") expect(access.token.expose()).toBe(READ_ONLY);
});

it("mints the personal token and the signed-in author for a run", async () => {
  await bindPat();
  const minted = await mintRun(github);
  expect(minted.secrets.SCM_TOKEN?.expose()).toBe(PAT);
  expect(minted.secrets.GITHUB_TOKEN?.expose()).toBe(PAT);
  expect(minted.env.SCM_TOKEN_USERNAME).toBe("x-access-token");
  expect(minted.env.GIT_AUTHOR_NAME).toBe("default-test-user");
  expect(minted.env.GIT_AUTHOR_EMAIL).toBe(
    "default-test-user+default-test-user@users.noreply.github.com",
  );
  expect(minted.env.GIT_COMMITTER_EMAIL).toBe(minted.env.GIT_AUTHOR_EMAIL);
});

it("does not substitute a read-only platform credential when the personal token cannot push", async () => {
  await bindPat();
  await seedPlatformCredential("food-truck read-only", READ_ONLY, "read");
  // The developer's token is still valid but lost push rights on this repository.
  const demoted = { ...github, [PAT]: { ...github[PAT], push: { [REPO]: 403 } } } as Spec;
  await expect(mintRun(demoted)).rejects.toThrow(/write/);
});

it("does not inject a GitHub author into Azure DevOps runs", async () => {
  const minted = await mintRun(github, "azure-devops", "org/project/repo");
  expect(minted.env.GIT_AUTHOR_EMAIL).toBeUndefined();
});

// ---- sign-in (GitHub App user) token ----------------------------------------

it("uses the sign-in token when it can push, without a GitHub App id configured", async () => {
  await seedSignInToken(new Date(Date.now() + EIGHT_HOURS));
  const spec = withSignIn([{ full_name: REPO, private: true, push: true }]);
  const access = await resolve("write", fakeGithubFetch(spec));
  expect(access.mode).toBe("write");
  if (access.mode === "write") {
    expect(access.source).toBe("app-user-token");
    expect(access.token.expose()).toBe(LOGIN);
  }
});

it("falls through to the personal token when the sign-in token cannot push", async () => {
  await seedSignInToken(new Date(Date.now() + EIGHT_HOURS));
  await bindPat();
  const spec = withSignIn([{ full_name: REPO, private: true, push: false }]);
  const access = await resolve("write", fakeGithubFetch(spec));
  expect(access.mode).toBe("write");
  if (access.mode === "write") expect(access.source).toBe("pat");
});

it("ignores a sign-in token GitHub rejects and still uses the personal token", async () => {
  await seedSignInToken(new Date(Date.now() + EIGHT_HOURS));
  await bindPat();
  const access = await resolve("write", fakeGithubFetch(withSignIn([], { rejectToken: true })));
  expect(access.mode).toBe("write");
  if (access.mode === "write") expect(access.source).toBe("pat");
});

it("refreshes a sign-in token that would expire during a run before handing it out", async () => {
  // Valid for five more minutes; a run may take up to RUN_WALL_CLOCK_SECONDS (600 in tests).
  await seedSignInToken(new Date(Date.now() + 5 * 60_000));
  const repos = [{ full_name: REPO, private: true, push: true }];
  const fetchImpl = fakeGithubFetch(
    { ...withSignIn(repos), [REFRESHED]: { user: ME, repos } },
    {
      oauthRefresh: { access_token: REFRESHED, refresh_token: "refresh-2", expires_in: 28_800 },
    },
  );
  const access = await resolve("write", fetchImpl);
  expect(access.mode).toBe("write");
  if (access.mode === "write") expect(access.token.expose()).toBe(REFRESHED);
});
