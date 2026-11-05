import type {
  PlatformCredentialSummary,
  PlatformCredentialsResponse,
} from "@pi-cloud-agent/protocol";
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

const READ_ONLY_TOKEN = "github_pat_readonly0000000000000000LfRh";
const WRITE_TOKEN = "github_pat_writer000000000000000000Wr1t";

const github: Record<string, FakeGithubSpec> = {
  [READ_ONLY_TOKEN]: {
    user: { id: 104287479, login: "Cato-Wen" },
    expires: "2027-11-05 00:00:00 UTC",
    repos: [
      // REST says the account can push, but the token itself cannot: git decides.
      { full_name: "food-truck/master-data-management", private: true, push: true },
      { full_name: "ct-kb/team-cookbook-kb", private: true, push: true },
      { full_name: "Cato-Wen/agent-config", private: false, push: true },
    ],
    push: { "food-truck/master-data-management": 403, "ct-kb/team-cookbook-kb": 200 },
  },
  [WRITE_TOKEN]: {
    user: { id: 555, login: "foodtruck-bot" },
    repos: [{ full_name: "food-truck/master-data-management", private: true, push: true }],
  },
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

const operatorApp = () =>
  createApp({
    config: testConfig({ OPERATOR_GITHUB_LOGINS: "default-test-user" }),
    database,
    log: silentLogger(),
    fetchImpl: fakeGithubFetch(github),
  });

const headers = () => ({ Cookie: `pca_session=${cookie}`, "Content-Type": "application/json" });

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function create(app: ReturnType<typeof createApp>, label: string, token: string) {
  const response = await app.request("/admin/credentials", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ label, token }),
  });
  expect(response.status).toBe(201);
  return json<PlatformCredentialSummary>(response);
}

it("refuses non-operators", async () => {
  const app = createApp({
    config: testConfig(),
    database,
    log: silentLogger(),
    fetchImpl: fakeGithubFetch(github),
  });
  const response = await app.request("/admin/credentials", { headers: headers() });
  expect(response.status).toBe(403);
});

it("probes a saved token per private repository and records what git allowed", async () => {
  const created = await create(operatorApp(), "food-truck read-only", READ_ONLY_TOKEN);
  expect(created.label).toBe("food-truck read-only");
  expect(created.accountLogin).toBe("Cato-Wen");
  expect(created.last4).toBe("LfRh");
  expect(created.expiresAt).toBe("2027-11-05T00:00:00.000Z");
  expect(created.probedAt).not.toBeNull();
  // The public repository is ignored; the private ones carry git's verdict,
  // which contradicts REST's `push: true` for master-data-management.
  expect(created.repoAccess).toEqual([
    { repo: "ct-kb/team-cookbook-kb", access: "write" },
    { repo: "food-truck/master-data-management", access: "read" },
  ]);
});

it("never returns the token in list or detail responses", async () => {
  const app = operatorApp();
  const created = await create(app, "food-truck read-only", READ_ONLY_TOKEN);
  expect(JSON.stringify(created)).not.toContain(READ_ONLY_TOKEN);
  const listed = await json<PlatformCredentialsResponse>(
    await app.request("/admin/credentials", { headers: headers() }),
  );
  expect(listed.credentials).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(READ_ONLY_TOKEN);
});

it("re-probes on demand and replaces the token on update", async () => {
  const app = operatorApp();
  const created = await create(app, "food-truck", READ_ONLY_TOKEN);

  const reprobed = await json<PlatformCredentialSummary>(
    await app.request(`/admin/credentials/${created.id}/probe`, {
      method: "POST",
      headers: headers(),
    }),
  );
  expect(reprobed.id).toBe(created.id);
  expect(reprobed.accountLogin).toBe("Cato-Wen");

  const replaced = await json<PlatformCredentialSummary>(
    await app.request(`/admin/credentials/${created.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ token: WRITE_TOKEN }),
    }),
  );
  expect(replaced.id).toBe(created.id);
  expect(replaced.label).toBe("food-truck");
  expect(replaced.accountLogin).toBe("foodtruck-bot");
  expect(replaced.last4).toBe("Wr1t");
  expect(replaced.repoAccess).toEqual([
    { repo: "food-truck/master-data-management", access: "write" },
  ]);
});

it("removes a credential", async () => {
  const app = operatorApp();
  const created = await create(app, "food-truck", READ_ONLY_TOKEN);
  const removed = await app.request(`/admin/credentials/${created.id}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(removed.status).toBe(200);
  const listed = await json<PlatformCredentialsResponse>(
    await app.request("/admin/credentials", { headers: headers() }),
  );
  expect(listed.credentials).toEqual([]);
});
