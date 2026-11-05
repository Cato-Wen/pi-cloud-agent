import type { BranchesResponse, ReposResponse, VCSProvider } from "@pi-cloud-agent/protocol";
import { vcsProviderNames } from "@pi-cloud-agent/vcs";
import { Hono } from "hono";
import type { Config } from "../config";
import type { Database } from "../db/client";
import type { AppUserRow } from "../db/schema";
import { getVcsProvider } from "../vcs/connections";
import {
  listWritableRepositories,
  resolveRepositoryAccess,
  vcsProviderForAccess,
} from "../vcs/repository-access";
import type { AppEnv } from "./deps";

export function metaRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/repos", async (c) => {
    return c.json(
      await resolveRepos(c.get("database"), c.get("config"), c.get("user"), c.get("fetchImpl")),
    );
  });

  app.get("/repos/branches", async (c) => {
    const provider = c.req.query("provider") ?? "github";
    const repo = c.req.query("repo") ?? "";
    const response: BranchesResponse = { branches: [], default: null };
    try {
      const vcs = await providerForRepository(
        c.get("database"),
        c.get("config"),
        c.get("user"),
        c.get("fetchImpl"),
        provider,
        repo,
      );
      if (!vcs) return c.json(response);
      response.branches = await vcs.listBranches(repo);
      response.default = await vcs.getDefaultBranch(repo);
    } catch (error) {
      c.get("log").warn("branch lookup failed", { provider, repo, error });
    }
    return c.json(response);
  });

  return app;
}

/** Sign-in required means GitHub repositories come from the user's credentials, not a bare token. */
function accessGoverned(config: Config, provider: string): boolean {
  return provider === "github" && config.auth.requireUser;
}

async function resolveRepos(
  database: Database,
  config: Config,
  user: AppUserRow | null,
  fetchImpl: typeof fetch,
): Promise<ReposResponse> {
  const repos: ReposResponse["repos"] = [];
  for (const provider of vcsProviderNames()) {
    try {
      if (user && accessGoverned(config, provider)) {
        repos.push(...(await listWritableRepositories(database, config, user, { fetchImpl })));
        continue;
      }
      const vcs = await getVcsProvider(database, config, provider, user?.id ?? null);
      repos.push(...(await vcs.listRepos()));
    } catch {
      // A disconnected or expired identity contributes no repositories.
    }
  }
  return {
    repos: repos.sort((left, right) => left.fullName.localeCompare(right.fullName)),
    source: repos.length > 0 ? "connection" : "none",
  };
}

async function providerForRepository(
  database: Database,
  config: Config,
  user: AppUserRow | null,
  fetchImpl: typeof fetch,
  provider: string,
  repo: string,
): Promise<VCSProvider | null> {
  if (!user || !accessGoverned(config, provider)) {
    return getVcsProvider(database, config, provider, user?.id ?? null);
  }
  const access = await resolveRepositoryAccess(database, config, user, repo, "read", {
    fetchImpl,
  });
  return access.mode === "none" ? null : vcsProviderForAccess(access, { fetchImpl });
}
