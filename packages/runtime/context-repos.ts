import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxWorkspaceRepo } from "@pi-cloud-agent/protocol";
import { CLONE_DEPTH, runCommand as run } from "./command";
import type { RuntimeConfig } from "./config";
import type { Reporter } from "./reporter";

/**
 * Clone the read-only repositories that sit next to the primary checkout.
 *
 * A cold start clones every one of them. A resumed workspace clones only
 * those that are missing, so a session that gains a context repository on a
 * later turn still ends up with it. Push is disabled on read-only clones so
 * an agent that forgets the preamble fails locally instead of at the forge.
 */
export async function prepareContextRepositories(
  config: RuntimeConfig,
  reporter: Reporter,
  options: { resumed: boolean },
): Promise<void> {
  for (const repo of config.workspace) {
    if (repo.role !== "context") continue;
    if (options.resumed && existsSync(join(repo.path, ".git"))) continue;
    if (!options.resumed) await rm(repo.path, { recursive: true, force: true });
    await cloneContextRepository(repo);
    if (repo.access === "read") await disablePush(repo);
    reporter.log("git.context_cloned", { fullName: repo.fullName, path: repo.path });
  }
}

async function cloneContextRepository(repo: SandboxWorkspaceRepo): Promise<void> {
  const base = ["clone", "--depth", String(CLONE_DEPTH)];
  const attempts = [
    repo.defaultBranch
      ? [...base, "--branch", repo.defaultBranch, repo.cloneUrl, repo.path]
      : null,
    [...base, repo.cloneUrl, repo.path],
  ].filter((args): args is string[] => args !== null);
  let lastOutput = "";
  for (const args of attempts) {
    const result = await run("git", args);
    if (result.code === 0) return;
    lastOutput = result.output;
  }
  throw new Error(`context repository ${repo.fullName}: clone failed: ${lastOutput}`);
}

/**
 * `origin` loses its push URL, and the clone URL itself is rewritten for
 * pushes, so `git push origin`, a re-added remote and `git push <url>` all
 * fail locally. This guards against an agent forgetting the preamble; a
 * determined one can still push through a different URL or the REST API.
 */
async function disablePush(repo: SandboxWorkspaceRepo): Promise<void> {
  const steps: Array<{ args: string[]; cwd?: string }> = [
    { args: ["remote", "set-url", "--push", "origin", "DISABLED"], cwd: repo.path },
    { args: ["config", "--global", "--add", "url.DISABLED/.pushInsteadOf", repo.cloneUrl] },
  ];
  for (const step of steps) {
    const result = await run("git", step.args, { cwd: step.cwd });
    if (result.code !== 0) {
      throw new Error(
        `context repository ${repo.fullName}: could not disable push: ${result.output}`,
      );
    }
  }
}
