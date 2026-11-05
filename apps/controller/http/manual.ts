import {
  type CreateRunBody,
  createRunRequestSchema,
  type RepoRef,
} from "@pi-cloud-agent/protocol";
import type { Context } from "hono";
import type { Config } from "../config";
import type { Database } from "../db/client";
import type { AppUserRow } from "../db/schema";
import { getVcsProvider } from "../vcs/connections";
import { resolveRepositoryAccess, vcsProviderForAccess } from "../vcs/repository-access";
import type { AppEnv } from "./deps";

interface ManualRequest {
  repo: RepoRef;
}

type ManualRequestResult =
  | { ok: true; body: CreateRunBody; request: ManualRequest }
  | { ok: false; error: { error: string; issues?: unknown } };

/** Parse and resolve the shared request accepted by standalone runs and sessions. */
async function readManualRequest(
  body: unknown,
  config: Config,
  database: Database,
  user: AppUserRow | null,
  fetchImpl: typeof fetch,
): Promise<ManualRequestResult> {
  const parsed = createRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { error: "invalid request", issues: parsed.error.issues } };
  }
  try {
    return {
      ok: true,
      body: parsed.data,
      request: await resolveManualRequest(parsed.data, config, database, user, fetchImpl),
    };
  } catch (error) {
    return {
      ok: false,
      error: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function readManualRouteRequest(c: Context<AppEnv>): Promise<ManualRequestResult> {
  return readManualRequest(
    await c.req.json().catch(() => null),
    c.get("config"),
    c.get("database"),
    c.get("user"),
    c.get("fetchImpl"),
  );
}

/** Resolve and validate one dashboard request before anything durable is written. */
async function resolveManualRequest(
  body: CreateRunBody,
  config: Config,
  database: Database,
  user: AppUserRow | null,
  fetchImpl: typeof fetch,
): Promise<ManualRequest> {
  const vcs = await providerForRequest(body, config, database, user, fetchImpl);
  const repository = await vcs.getRepository(body.repo);
  if (!repository)
    throw new Error("repository is not available through the connected identity");
  const branch =
    body.branch?.trim() || (await vcs.getDefaultBranch(body.repo).catch(() => null)) || "";
  const repo: RepoRef = {
    provider: repository.provider,
    host: repository.host,
    owner: repository.owner,
    name: repository.name,
    cloneUrl: repository.cloneUrl,
    defaultBranch: branch || repository.defaultBranch || "main",
    baseSha: "",
    headSha: "",
    headBranch: branch,
    prNumber: null,
  };
  return { repo };
}

/**
 * A task's primary repository must be writable by the signed-in user. The
 * credential that passes that check is also the one used to read metadata,
 * so a developer whose only access is a personal token is not asked through
 * a GitHub App sign-in that cannot see the repository.
 */
async function providerForRequest(
  body: CreateRunBody,
  config: Config,
  database: Database,
  user: AppUserRow | null,
  fetchImpl: typeof fetch,
) {
  if (body.provider !== "github" || !config.auth.requireUser) {
    return getVcsProvider(database, config, body.provider, user?.id ?? null);
  }
  if (!user) throw new Error("authentication is required to run a task");
  const access = await resolveRepositoryAccess(database, config, user, body.repo, "write", {
    fetchImpl,
  });
  if (access.mode === "none") throw new Error(access.reason);
  return vcsProviderForAccess(access, { fetchImpl });
}
