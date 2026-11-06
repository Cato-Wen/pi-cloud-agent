import type { ReposResponse, SessionDetail, SessionSummary } from "@pi-cloud-agent/protocol";
import { expect, it } from "vitest";
import { insertPlatformCredential } from "../db/platform-credentials";
import { getRun } from "../db/runs";
import {
  bindTestUser,
  jsonBody as json,
  silentLogger,
  testConfig,
  withTestModel,
} from "../test-support";
import { type FakeGithubSpec, fakeGithubFetch } from "../test-support-github";
import { createApp } from "./app";

const PAT = "ghp_developer0000000000000000000000000dEv1";
const PLATFORM = "github_pat_platformreadonly0000000000RdOn";
const PRIMARY = "food-truck/mdm";
const KB = "ct-kb/team-cookbook-kb";
/** Readable by a platform credential only; the user's own token cannot see it. */
const OTHER_KB = "ct-kb/other-kb";

const github: Record<string, FakeGithubSpec> = {
  [PAT]: {
    user: { id: "default-test-user", login: "default-test-user" },
    scopes: "repo",
    repos: [
      { full_name: PRIMARY, private: true, push: true, default_branch: "develop" },
      { full_name: KB, private: true, push: false, default_branch: "main" },
    ],
  },
  [PLATFORM]: {
    user: { id: 1, login: "platform-bot" },
    repos: [{ full_name: OTHER_KB, private: true, push: false, default_branch: "main" }],
  },
};

// Access rules only apply when sign-in is required.
const config = testConfig({ APP_AUTH_REQUIRED: "true" });
const bound = bindTestUser(config);

async function bindPat(): Promise<void> {
  const { upsertVcsConnection } = await import("../db/vcs-connections");
  const { encryptSecret } = await import("../secrets/crypto");
  await upsertVcsConnection(bound().database, {
    userId: bound().userId,
    provider: "github-pat",
    accountId: "default-test-user",
    accountName: "default-test-user",
    accessToken: encryptSecret(PAT, config.vcs.encryptionKey),
    refreshToken: null,
    expiresAt: null,
  });
}

const app = () =>
  createApp({
    config,
    database: bound().database,
    log: silentLogger(),
    fetchImpl: fakeGithubFetch(github),
  });

const createSession = (contextRepos: string[]) =>
  app().request("/sessions", {
    method: "POST",
    headers: bound().headers,
    body: JSON.stringify(
      withTestModel(
        { repo: PRIMARY, provider: "github", prompt: "read the kb", contextRepos },
        bound().modelConnectionId,
      ),
    ),
  });

it("offers repositories the user can read as context, without the primary one", async () => {
  await bindPat();
  const body = await json<ReposResponse>(
    await app().request(`/repos/context?primary=${encodeURIComponent(PRIMARY)}`, {
      headers: bound().headers,
    }),
  );
  expect(body.repos.map((repo) => repo.fullName)).toEqual([KB]);
});

it("stores context repositories on the session and in the first run's trigger", async () => {
  await bindPat();
  const response = await createSession([KB]);
  expect(response.status, await response.clone().text()).toBe(201);
  const session = await json<SessionSummary>(response);
  expect(session.contextRepos).toEqual([KB]);

  const detail = await json<SessionDetail>(
    await app().request(`/sessions/${session.id}`, { headers: bound().headers }),
  );
  expect(detail.contextRepos).toEqual([KB]);
  const run = await getRun(bound().database, session.latestRunId);
  expect(run?.trigger.contextRepos).toEqual([
    expect.objectContaining({
      fullName: KB,
      access: "read",
      role: "context",
      ref: expect.objectContaining({ cloneUrl: `https://github.com/${KB}.git` }),
    }),
  ]);
});

it("carries the session's context repositories into a follow-up turn", async () => {
  await bindPat();
  const session = await json<SessionSummary>(await createSession([KB]));
  const turn = await app().request(`/sessions/${session.id}/turns`, {
    method: "POST",
    headers: bound().headers,
    body: JSON.stringify(withTestModel({ prompt: "and again" }, bound().modelConnectionId)),
  });
  expect(turn.status, await turn.clone().text()).toBe(201);
  const { id } = await json<{ id: string }>(turn);
  const run = await getRun(bound().database, id);
  expect(run?.trigger.contextRepos.map((repo) => repo.fullName)).toEqual([KB]);
});

it("never lends a platform credential for a context repository", async () => {
  await bindPat();
  const { encryptSecret } = await import("../secrets/crypto");
  await insertPlatformCredential(bound().database, {
    provider: "github",
    label: "ct-kb read-only",
    accountId: "1",
    accountLogin: "platform-bot",
    accessToken: encryptSecret(PLATFORM, config.vcs.encryptionKey),
    expiresAt: null,
    repoAccess: [{ repo: OTHER_KB, access: "read" }],
    probedAt: new Date(),
    updatedBy: null,
  });
  const listed = await json<ReposResponse>(
    await app().request(`/repos/context?primary=${encodeURIComponent(PRIMARY)}`, {
      headers: bound().headers,
    }),
  );
  expect(listed.repos.map((repo) => repo.fullName)).toEqual([KB]);
  const response = await createSession([OTHER_KB]);
  expect(response.status).toBe(422);
  expect((await json<{ error: string }>(response)).error).toContain(OTHER_KB);
});

it("refuses a context repository nobody can read, naming it", async () => {
  await bindPat();
  const response = await createSession(["acme/private"]);
  expect(response.status).toBe(422);
  expect((await json<{ error: string }>(response)).error).toContain("acme/private");
});

it("ignores the primary repository when it is also listed as context", async () => {
  await bindPat();
  const response = await createSession([PRIMARY]);
  expect(response.status, await response.clone().text()).toBe(201);
  expect((await json<SessionSummary>(response)).contextRepos).toEqual([]);
});
