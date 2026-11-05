import type { ReposResponse, SessionSummary } from "@pi-cloud-agent/protocol";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getAppUserById } from "../db/auth";
import { closeDatabase, type Database } from "../db/client";
import { insertPlatformCredential } from "../db/platform-credentials";
import type { AppUserRow } from "../db/schema";
import { createApp } from "../http/app";
import { createCredentialBroker } from "../secrets/broker";
import { encryptSecret } from "../secrets/crypto";
import {
  resetTables,
  seedTestUser,
  setupTestDatabase,
  silentLogger,
  testConfig,
  withTestModel,
} from "../test-support";
import { type FakeGithubSpec, fakeGithubFetch } from "../test-support-github";
import { savePersonalToken } from "./personal-token";
import { resolveRepositoryAccess } from "./repository-access";

const PAT = "ghp_developer0000000000000000000000000dEv1";
const READ_ONLY = "github_pat_platformreadonly0000000000RdOn";
const WRITABLE = "github_pat_platformwritable0000000000WrIt";
const REPO = "food-truck/master-data-management";

const github: Record<string, FakeGithubSpec> = {
  [PAT]: {
    user: { id: "default-test-user", login: "default-test-user" },
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

// Access rules only apply when sign-in is required; local test mode waves everything through.
const config = testConfig({ APP_AUTH_REQUIRED: "true" });
let database: Database;
let cookie: string;
let userId: string;
let modelConnectionId: string;

beforeAll(() => {
  database = setupTestDatabase();
});
beforeEach(async () => {
  await resetTables(database);
  ({ cookie, userId, modelConnectionId } = await seedTestUser(database, config));
});
afterAll(() => closeDatabase(database));

const appWith = (spec: FakeGithubSpec | Record<string, FakeGithubSpec>) =>
  createApp({ config, database, log: silentLogger(), fetchImpl: fakeGithubFetch(spec) });
const headers = () => ({ Cookie: `pca_session=${cookie}`, "Content-Type": "application/json" });
const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

async function user(): Promise<AppUserRow> {
  const row = await getAppUserById(database, userId);
  if (!row) throw new Error("test user missing");
  return row;
}

async function bindPat(): Promise<void> {
  await savePersonalToken(database, config, await user(), PAT, {
    fetchImpl: fakeGithubFetch(github),
  });
}

async function seedPlatformCredential(label: string, token: string, access: "read" | "write") {
  return insertPlatformCredential(database, {
    provider: "github",
    label,
    accountId: label,
    accountLogin: label,
    accessToken: encryptSecret(token, config.vcs.encryptionKey),
    expiresAt: null,
    repoAccess: [{ repo: REPO, access }],
    probedAt: new Date(),
    updatedBy: null,
  });
}

const startTask = (app: ReturnType<typeof createApp>) =>
  app.request("/sessions", {
    method: "POST",
    headers: headers(),
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
    await appWith(github).request("/repos", { headers: headers() }),
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
  const revoked = { ...github, [PAT]: { ...github[PAT], rejectToken: true } } as Record<
    string,
    FakeGithubSpec
  >;
  const access = await resolveRepositoryAccess(database, config, await user(), REPO, "read", {
    fetchImpl: fakeGithubFetch(revoked),
  });
  expect(access.mode).toBe("none");
  if (access.mode === "none") expect(access.reason).toMatch(/rejected/);
});

it("prefers a read-only platform credential over a writable one for read access", async () => {
  await seedPlatformCredential("writable", WRITABLE, "write");
  await seedPlatformCredential("read-only", READ_ONLY, "read");
  const access = await resolveRepositoryAccess(database, config, await user(), REPO, "read", {
    fetchImpl: fakeGithubFetch(github),
  });
  expect(access.mode).toBe("read");
  if (access.mode === "read") {
    expect(access.source).toBe("platform-credential");
    expect(access.token.expose()).toBe(READ_ONLY);
  }
});

it("does not use a writable platform credential to satisfy a read request", async () => {
  await seedPlatformCredential("writable", WRITABLE, "write");
  const access = await resolveRepositoryAccess(database, config, await user(), REPO, "read", {
    fetchImpl: fakeGithubFetch(github),
  });
  expect(access.mode).toBe("none");
});

it("mints the personal token and the signed-in author for a run", async () => {
  await bindPat();
  const broker = createCredentialBroker(config, database, silentLogger(), {
    fetchImpl: fakeGithubFetch(github),
  });
  const minted = await broker.mintForRun({
    userId,
    provider: "github",
    repoFullName: REPO,
    modelConnectionId,
    modelSnapshot: "test-provider/test-model",
  });
  expect(minted.secrets.SCM_TOKEN?.expose()).toBe(PAT);
  expect(minted.secrets.GITHUB_TOKEN?.expose()).toBe(PAT);
  expect(minted.env.SCM_TOKEN_USERNAME).toBe("x-access-token");
  expect(minted.env.GIT_AUTHOR_NAME).toBe("default-test-user");
  expect(minted.env.GIT_AUTHOR_EMAIL).toBe(
    "default-test-user+default-test-user@users.noreply.github.com",
  );
  expect(minted.env.GIT_COMMITTER_EMAIL).toBe(minted.env.GIT_AUTHOR_EMAIL);
});
