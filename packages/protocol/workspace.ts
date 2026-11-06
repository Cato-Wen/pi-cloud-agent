import { z } from "zod";
import { SANDBOX_PATHS } from "./env";
import type { RepoRef, WorkspaceRepo } from "./repo";

/**
 * The repositories one run clones, as the sandbox sees them.
 *
 * The controller derives this from the primary `RepoRef` plus the task's
 * context repositories; the runtime consumes it verbatim. Tokens never
 * appear here — only the name of the environment variable that carries one.
 */
export const sandboxWorkspaceRepoSchema = z.object({
  fullName: z.string().min(3),
  host: z.string().min(1),
  cloneUrl: z.string().url(),
  defaultBranch: z.string().min(1),
  /** Absolute path under /workspace. */
  path: z.string().min(1),
  access: z.enum(["read", "write"]),
  role: z.enum(["primary", "context"]),
  /** "SCM_TOKEN" for the primary repository, "SCM_TOKEN_<n>" for context ones. */
  tokenVar: z.string().min(1),
});

export type SandboxWorkspaceRepo = z.infer<typeof sandboxWorkspaceRepoSchema>;

/**
 * Primary first, then context repositories in order. Directories are named
 * after the repository; a clash falls back to `<owner>__<name>` so two
 * repositories called `kb` can both be present.
 */
export function planWorkspace(
  primary: RepoRef,
  context: WorkspaceRepo[],
): SandboxWorkspaceRepo[] {
  const taken = new Set<string>();
  const place = (owner: string, name: string): string => {
    const directory = taken.has(name) ? `${owner}__${name}` : name;
    taken.add(directory);
    return `${SANDBOX_PATHS.workspace}/${directory}`;
  };
  const plan: SandboxWorkspaceRepo[] = [
    {
      fullName: `${primary.owner}/${primary.name}`,
      host: primary.host,
      cloneUrl: primary.cloneUrl,
      defaultBranch: primary.headBranch || primary.defaultBranch,
      path: place(primary.owner, primary.name),
      access: "write",
      role: "primary",
      tokenVar: "SCM_TOKEN",
    },
  ];
  context.forEach((repo, index) => {
    plan.push({
      fullName: repo.fullName,
      host: repo.ref.host,
      cloneUrl: repo.ref.cloneUrl,
      defaultBranch: repo.ref.headBranch || repo.ref.defaultBranch,
      path: place(repo.ref.owner, repo.ref.name),
      access: repo.access,
      role: "context",
      tokenVar: `SCM_TOKEN_${index + 1}`,
    });
  });
  return plan;
}

/** What the agent is told about its workspace. Empty when there is only the primary repository. */
export function describeWorkspace(repos: SandboxWorkspaceRepo[]): string {
  if (repos.length <= 1) return "";
  const pathWidth = Math.max(...repos.map((repo) => repo.path.length)) + 2;
  const nameWidth = Math.max(...repos.map((repo) => repo.fullName.length)) + 2;
  // Deliberately no branch name and no push instruction: whether and where
  // the primary repository is pushed is the task's business, and a stale
  // branch label on a later turn would mislead.
  const lines = repos.map((repo) => {
    const access = repo.access === "write" ? "可写" : "只读";
    return `- ${repo.path.padEnd(pathWidth)}${repo.fullName.padEnd(nameWidth)}${access}`;
  });
  return ["工作区：", ...lines, "只读仓库不要 commit / push。"].join("\n");
}
