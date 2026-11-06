import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_ENV, SANDBOX_PATHS } from "@pi-cloud-agent/protocol";
import { CLONE_DEPTH, runCommand as run } from "./command";
import type { RuntimeConfig } from "./config";
import { prepareContextRepositories } from "./context-repos";
import { credentialHelperScript } from "./git-credential-helper";
import type { Reporter } from "./reporter";

/** Prepare the checkout the agent will work in. */

const CREDENTIAL_HELPER_PATH = `${SANDBOX_PATHS.state}/git-credential.sh`;
const DIFF_MAX_OUTPUT_CHARS = 2_000_000;
const UNTRACKED_FILE_LIST_MAX_CHARS = 200_000;
const MAX_UNTRACKED_FILES = 256;

/** Capture the revision at the start of a turn so committed edits are visible. */
export async function gitRevision(path: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "HEAD"], {
    cwd: path,
    timeoutMs: 30_000,
    includeStderr: false,
  });
  if (result.code !== 0 || !result.output) {
    // A freshly initialized repository has no HEAD until its first commit.
    // The diff baseline is optional, so let the agent create that first commit.
    return null;
  }
  return result.output.trim();
}

export interface GitDiffSnapshot {
  patch: string;
  baseSha: string | null;
  headSha: string | null;
  files: number;
  added: number;
  removed: number;
  truncated: boolean;
}

/**
 * Capture tracked, staged, committed-during-turn, deleted, renamed, and
 * untracked changes without modifying the checkout.
 */
export async function gitDiff(path: string, baseSha: string | null): Promise<GitDiffSnapshot> {
  const headSha = await gitRevision(path);
  const tracked = baseSha
    ? await run("git", ["diff", "--no-ext-diff", "--binary", "--find-renames", baseSha, "--"], {
        cwd: path,
        timeoutMs: 60_000,
        maxOutputChars: DIFF_MAX_OUTPUT_CHARS,
        outputPosition: "head",
        includeStderr: false,
      })
    : null;
  if (tracked && tracked.code !== 0)
    throw new Error(`could not capture the checkout diff: ${tracked.stderr || tracked.output}`);

  const untracked = await run(
    "git",
    baseSha
      ? ["ls-files", "--others", "--exclude-standard", "-z"]
      : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: path,
      timeoutMs: 30_000,
      maxOutputChars: UNTRACKED_FILE_LIST_MAX_CHARS,
      outputPosition: "head",
      includeStderr: false,
    },
  );
  if (untracked.code !== 0)
    throw new Error(`could not list untracked files: ${untracked.stderr || untracked.output}`);

  const captured = await captureUntrackedDiff(
    path,
    untracked.output,
    tracked ? [tracked.output] : [],
    Boolean(tracked?.outputTruncated || untracked.outputTruncated),
  );
  const limited = limitDiff(
    captured.chunks.filter(Boolean).join("\n"),
    captured.sourceTruncated,
  );
  return {
    patch: limited.patch,
    baseSha,
    headSha,
    files: countDiffFiles(limited.patch),
    added: countDiffLines(limited.patch, "+"),
    removed: countDiffLines(limited.patch, "-"),
    truncated: limited.truncated,
  };
}

async function captureUntrackedDiff(
  path: string,
  output: string,
  chunks: string[],
  sourceTruncated: boolean,
): Promise<{ chunks: string[]; sourceTruncated: boolean }> {
  const listedFiles = parseNulSeparatedPaths(output);
  const files = listedFiles.paths.slice(0, MAX_UNTRACKED_FILES);
  let capturedChars = chunks.reduce((total, chunk) => total + chunk.length, 0);
  sourceTruncated ||= listedFiles.incomplete || listedFiles.paths.length > files.length;
  for (const file of files) {
    const remainingChars = DIFF_MAX_OUTPUT_CHARS - capturedChars;
    if (remainingChars <= 0) {
      sourceTruncated = true;
      break;
    }
    const fileDiff = await run(
      "git",
      ["diff", "--no-index", "--no-ext-diff", "--binary", "--", "/dev/null", file],
      {
        cwd: path,
        timeoutMs: 60_000,
        maxOutputChars: remainingChars,
        outputPosition: "head",
        includeStderr: false,
      },
    );
    // `git diff --no-index` returns 1 when files differ, which is the success
    // case here. Any other non-zero result is a genuine capture failure.
    if (fileDiff.code > 1) {
      // A file can disappear between ls-files and diff (or be unreadable). Do
      // not discard the complete session snapshot because one optional file
      // could not be captured.
      sourceTruncated = true;
      continue;
    }
    chunks.push(fileDiff.output);
    capturedChars += fileDiff.output.length;
    sourceTruncated ||= fileDiff.outputTruncated;
    if (fileDiff.outputTruncated) break;
  }
  return { chunks, sourceTruncated };
}

function parseNulSeparatedPaths(output: string): { paths: string[]; incomplete: boolean } {
  const lastDelimiter = output.lastIndexOf("\0");
  if (lastDelimiter < 0) return { paths: [], incomplete: output.length > 0 };
  return {
    paths: output.slice(0, lastDelimiter).split("\0").filter(Boolean),
    incomplete: lastDelimiter !== output.length - 1,
  };
}

function limitDiff(
  patch: string,
  sourceTruncated = false,
): { patch: string; truncated: boolean } {
  if (!sourceTruncated && patch.length <= DIFF_MAX_OUTPUT_CHARS)
    return { patch, truncated: false };
  const chunks = patch
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "));
  let output = "";
  for (const chunk of chunks) {
    if (output.length === 0 && chunk.length > DIFF_MAX_OUTPUT_CHARS) {
      output = chunk.slice(0, DIFF_MAX_OUTPUT_CHARS);
      break;
    }
    if (output.length + chunk.length > DIFF_MAX_OUTPUT_CHARS) break;
    output += chunk;
  }
  if (!output && !chunks.length) output = patch.slice(0, DIFF_MAX_OUTPUT_CHARS);
  return {
    patch: `${output.trimEnd()}\n\n[diff truncated by the runtime]\n`,
    truncated: true,
  };
}

function countDiffFiles(patch: string): number {
  return patch.split("\ndiff --git ").length - (patch.startsWith("diff --git ") ? 0 : 1);
}

function countDiffLines(patch: string, prefix: "+" | "-"): number {
  return patch
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`)).length;
}

/**
 * Teach git the injected token without ever writing it to disk.
 *
 * The helper prints the credential from the environment on demand, so the token
 * lives only in this process's environment rather than in `.git/config` or a
 * `.git-credentials` file that the agent could later read or commit.
 */
export async function configureGitCredentials(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<void> {
  if (!config.git.hasToken) {
    reporter.log("git.no_token", { detail: "proceeding without git authentication" });
    return;
  }

  const settings =
    config.workspace.length > 1
      ? await installCredentialHelperScript(config, reporter)
      : inlineCredentialHelper(config);
  for (const [key, value] of settings) {
    const result = await run("git", ["config", "--global", "--replace-all", key, value]);
    if (result.code !== 0) {
      reporter.log("git.config_failed", { key, output: result.output });
    }
  }
}

type GitSetting = readonly [key: string, value: string];

/** One repository, one token: the helper reads it straight from the environment. */
function inlineCredentialHelper(config: RuntimeConfig): GitSetting[] {
  const helper =
    `!f() { printf 'username=%s\\npassword=%s\\n' ` +
    `"$\{${SANDBOX_ENV.scmTokenUsername}:-${config.git.username}}" "$${SANDBOX_ENV.scmToken}"; }; f`;
  return [
    ["credential.helper", helper],
    // Without this, git scopes credentials per path and re-asks on redirect.
    ["credential.useHttpPath", "false"],
  ];
}

/**
 * Several repositories, each with its own token: a script picks the variable
 * by host and path. It names variables only, so reading it reveals no token.
 */
async function installCredentialHelperScript(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<GitSetting[]> {
  for (const repo of config.workspace) {
    if (!config.git.tokenVars.includes(repo.tokenVar)) {
      reporter.log("git.token_missing", { fullName: repo.fullName, tokenVar: repo.tokenVar });
    }
  }
  await mkdir(SANDBOX_PATHS.state, { recursive: true });
  await writeFile(
    CREDENTIAL_HELPER_PATH,
    credentialHelperScript(config.workspace, config.git.username),
    { mode: 0o700 },
  );
  // writeFile keeps the mode of a file that already exists (a resumed workspace).
  await chmod(CREDENTIAL_HELPER_PATH, 0o700);
  return [
    ["credential.helper", CREDENTIAL_HELPER_PATH],
    ["credential.useHttpPath", "true"],
  ];
}

/**
 * Clone, then move to the exact revision the trigger named.
 *
 * Branches are tried head-first, then the default, then a plain clone: a trigger
 * can name a branch that has already been deleted by the time the run starts, and
 * failing the whole run for that would be needlessly brittle. A named head SHA,
 * on the other hand, is not optional — running against the wrong commit is worse
 * than not running.
 */
export async function prepareCheckout(
  config: RuntimeConfig,
  reporter: Reporter,
): Promise<"created" | "resumed"> {
  const { repo } = config;
  if (!repo.path.startsWith(`${SANDBOX_PATHS.workspace}/`)) {
    throw new Error("repository checkout path must stay under /workspace");
  }
  if (config.workspaceResumed) {
    if (!(await reuseCheckout(repo.path, reporter))) {
      throw new Error("the provider resumed a workspace without the repository checkout");
    }
    // A session may gain context repositories after its workspace was first
    // created; only the missing ones are cloned.
    await prepareContextRepositories(config, reporter, { resumed: true });
    return "resumed";
  }
  // A repository image is allowed to contain toolchain caches or a stale
  // checkout path. Cold starts must not trust that state: remove only the
  // derived checkout directory before cloning the requested revision.
  await rm(repo.path, { recursive: true, force: true });
  await cloneFreshCheckout(config, reporter);
  await checkoutHeadRevision(repo);
  await fetchDiffRevisions(config);
  reporter.log("git.checkout_ready", { path: repo.path, headSha: repo.headSha || null });
  await prepareContextRepositories(config, reporter, { resumed: false });
  return "created";
}

async function cloneFreshCheckout(config: RuntimeConfig, reporter: Reporter): Promise<void> {
  const { repo } = config;
  const candidates = [...new Set([repo.headBranch, repo.defaultBranch].filter(Boolean))];
  let lastOutput = "";
  for (const branch of candidates) {
    const result = await run("git", [
      "clone",
      "--depth",
      String(CLONE_DEPTH),
      "--branch",
      branch,
      repo.cloneUrl,
      repo.path,
    ]);
    if (result.code === 0) {
      reporter.log("git.cloned", { branch });
      return;
    }
    lastOutput = result.output;
    reporter.log("git.clone_branch_failed", { branch, output: lastOutput });
  }

  const result = await run("git", [
    "clone",
    "--depth",
    String(CLONE_DEPTH),
    repo.cloneUrl,
    repo.path,
  ]);
  if (result.code !== 0) {
    throw new Error(`clone failed: ${result.output || lastOutput || "git exited non-zero"}`);
  }
  reporter.log("git.cloned", { branch: "(default)" });
}

async function checkoutHeadRevision(repo: RuntimeConfig["repo"]): Promise<void> {
  if (!repo.headSha) return;
  const fetched = await run(
    "git",
    ["fetch", "--depth", String(CLONE_DEPTH), "origin", repo.headSha],
    { cwd: repo.path },
  );
  if (fetched.code !== 0) {
    throw new Error(`could not fetch head revision ${repo.headSha}: ${fetched.output}`);
  }
  const checkout = await run("git", ["reset", "--hard", repo.headSha], { cwd: repo.path });
  if (checkout.code !== 0) {
    throw new Error(`could not check out ${repo.headSha}: ${checkout.output}`);
  }
}

async function fetchDiffRevisions(config: RuntimeConfig): Promise<void> {
  const revisions = [
    config.repo.baseSha
      ? { revision: config.repo.baseSha, remote: config.repo.baseCloneUrl }
      : null,
    config.sessionBaseSha ? { revision: config.sessionBaseSha, remote: "origin" } : null,
  ].filter((entry): entry is { revision: string; remote: string } => entry !== null);
  const fetched = new Set<string>();
  for (const { revision, remote } of revisions) {
    if (fetched.has(revision)) continue;
    fetched.add(revision);
    // Fetched but not checked out: a shallow clone would not otherwise have the
    // revision needed for a cumulative diff.
    const result = await run(
      "git",
      ["fetch", "--depth", String(CLONE_DEPTH), remote, revision],
      {
        cwd: config.repo.path,
      },
    );
    if (result.code !== 0) {
      throw new Error(`could not fetch diff revision ${revision}: ${result.output}`);
    }
  }
}

async function reuseCheckout(path: string, reporter: Reporter): Promise<boolean> {
  if (!existsSync(join(path, ".git"))) return false;
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: path });
  if (origin.code !== 0) throw new Error(`could not verify resumed checkout: ${origin.output}`);
  reporter.log("git.workspace_resumed", { path });
  return true;
}
