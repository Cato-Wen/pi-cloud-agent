import type { AppUserSummary, PersonalTokenStatus } from "@pi-cloud-agent/protocol";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { closeDatabase, type Database } from "../db/client";
import {
  resetTables,
  seedTestUser,
  setupTestDatabase,
  silentLogger,
  testConfig,
} from "../test-support";
import { type FakeGithubSpec, fakeGithubFetch } from "../test-support-github";
import { createApp } from "./app";

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzL18g";
const REPO = "food-truck/master-data-management";

const ownToken: FakeGithubSpec = {
  user: { id: "default-test-user", login: "default-test-user" },
  scopes: "repo, workflow",
  expires: "2026-12-05 08:10:35 UTC",
  repos: [
    { full_name: REPO, private: true, push: true, default_branch: "develop" },
    { full_name: "ct-kb/team-cookbook-kb", private: true, push: false },
  ],
};

let database: Database;
let cookie: string;

beforeAll(() => {
  database = setupTestDatabase();
});
beforeEach(async () => {
  await resetTables(database);
  cookie = (await seedTestUser(database, testConfig())).cookie;
});
afterAll(() => closeDatabase(database));

function appWith(spec: FakeGithubSpec | Record<string, FakeGithubSpec>) {
  return createApp({
    config: testConfig(),
    database,
    log: silentLogger(),
    fetchImpl: fakeGithubFetch(spec),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const headers = () => ({ Cookie: `pca_session=${cookie}`, "Content-Type": "application/json" });

const put = (app: ReturnType<typeof createApp>, token: string) =>
  app.request("/vcs/github/pat", {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ token }),
  });
const get = (app: ReturnType<typeof createApp>) =>
  app.request("/vcs/github/pat", { headers: headers() });

it("stores a token that belongs to the signed-in account and reports what it can write", async () => {
  const app = appWith(ownToken);
  const saved = await put(app, TOKEN);
  expect(saved.status).toBe(200);
  const body = await json<PersonalTokenStatus>(saved);
  expect(body.state).toBe("valid");
  expect(body.kind).toBe("classic");
  expect(body.last4).toBe("L18g");
  expect(body.scopes).toContain("repo");
  expect(body.expiresAt).toBe("2026-12-05T08:10:35.000Z");
  // The kb repo is visible but not pushable, so only the code repo is writable.
  expect(body.writableRepos).toEqual([REPO]);

  const me = await json<AppUserSummary>(await app.request("/auth/me", { headers: headers() }));
  expect(me.hasPat).toBe(true);
  expect((await json<PersonalTokenStatus>(await get(app))).connected).toBe(true);
});

it("refuses a token created by a different GitHub account", async () => {
  const app = appWith({ ...ownToken, user: { id: "someone-else", login: "wenbbinchina" } });
  const saved = await put(app, TOKEN);
  expect(saved.status).toBe(400);
  expect((await json<{ error: string }>(saved)).error).toMatch(/another GitHub account/);
  expect((await json<PersonalTokenStatus>(await get(app))).connected).toBe(false);
});

it("refuses a classic token without the repo scope", async () => {
  const app = appWith({ ...ownToken, scopes: "gist" });
  const saved = await put(app, TOKEN);
  expect(saved.status).toBe(400);
  expect((await json<{ error: string }>(saved)).error).toMatch(/repo scope/);
});

it("flags a fine-grained token that cannot see any private repository as possibly pending approval", async () => {
  const app = appWith({
    ...ownToken,
    scopes: undefined,
    repos: [{ full_name: "default-test-user/notes", private: false, push: true }],
  });
  const body = await json<PersonalTokenStatus>(await put(app, "github_pat_pendingXYZ1"));
  expect(body.kind).toBe("fine-grained");
  expect(body.state).toBe("valid");
  expect(body.pendingHint).toBe(true);
});

it("reports invalid when GitHub now rejects the stored token", async () => {
  expect((await put(appWith(ownToken), TOKEN)).status).toBe(200);
  // Same database, but GitHub has since revoked the token.
  const later = appWith({ ...ownToken, rejectToken: true });
  const body = await json<PersonalTokenStatus>(await get(later));
  expect(body.connected).toBe(true);
  expect(body.state).toBe("invalid");
});

it("never echoes the token back", async () => {
  const app = appWith(ownToken);
  const saved = await put(app, TOKEN);
  expect(JSON.stringify(await saved.json())).not.toContain(TOKEN);
  expect(JSON.stringify(await (await get(app)).json())).not.toContain(TOKEN);
});

it("removes the token", async () => {
  const app = appWith(ownToken);
  await put(app, TOKEN);
  const removed = await app.request("/vcs/github/pat", {
    method: "DELETE",
    headers: headers(),
  });
  expect(removed.status).toBe(200);
  const body = await json<PersonalTokenStatus>(await get(app));
  expect(body.connected).toBe(false);
  expect(body.state).toBe("none");
});
