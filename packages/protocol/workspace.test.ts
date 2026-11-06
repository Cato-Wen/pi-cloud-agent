import { describe, expect, it } from "vitest";
import type { RepoRef, WorkspaceRepo } from "./repo";
import { triggerSchema } from "./trigger";
import { describeWorkspace, planWorkspace } from "./workspace";

function ref(owner: string, name: string, branch = "main"): RepoRef {
  return {
    provider: "github",
    host: "github.com",
    owner,
    name,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    defaultBranch: branch,
    baseSha: "",
    headSha: "",
    headBranch: "",
    prNumber: null,
  };
}

function context(owner: string, name: string): WorkspaceRepo {
  return {
    provider: "github",
    fullName: `${owner}/${name}`,
    access: "read",
    role: "context",
    ref: ref(owner, name),
  };
}

describe("workspace layout", () => {
  it("gives the primary repository its usual path and SCM_TOKEN", () => {
    expect(planWorkspace(ref("acme", "widgets"), [])).toEqual([
      {
        fullName: "acme/widgets",
        host: "github.com",
        cloneUrl: "https://github.com/acme/widgets.git",
        defaultBranch: "main",
        path: "/workspace/widgets",
        access: "write",
        role: "primary",
        tokenVar: "SCM_TOKEN",
      },
    ]);
  });

  it("numbers context repositories and disambiguates a directory name clash", () => {
    const plan = planWorkspace(ref("acme", "kb"), [
      context("other", "kb"),
      context("acme", "docs"),
    ]);
    expect(plan.map((repo) => repo.path)).toEqual([
      "/workspace/kb",
      "/workspace/other__kb",
      "/workspace/docs",
    ]);
    expect(plan.map((repo) => repo.tokenVar)).toEqual([
      "SCM_TOKEN",
      "SCM_TOKEN_1",
      "SCM_TOKEN_2",
    ]);
    expect(
      plan.slice(1).every((repo) => repo.access === "read" && repo.role === "context"),
    ).toBe(true);
  });
});

describe("workspace description for the agent", () => {
  it("describes nothing for a single-repository workspace", () => {
    expect(describeWorkspace(planWorkspace(ref("acme", "widgets"), []))).toBe("");
  });

  it("lists every repository with its path and access, and forbids writing read-only ones", () => {
    const primary = { ...ref("food-truck", "master-data-management"), headBranch: "develop" };
    const plan = planWorkspace(primary, [context("ct-kb", "team-cookbook-kb")]);
    expect(describeWorkspace(plan)).toBe(
      [
        "工作区：",
        "- /workspace/master-data-management  food-truck/master-data-management  可写",
        "- /workspace/team-cookbook-kb        ct-kb/team-cookbook-kb             只读",
        "只读仓库不要 commit / push。",
      ].join("\n"),
    );
  });
});

describe("trigger compatibility", () => {
  it("parses a trigger without contextRepos as an empty list", () => {
    const trigger = triggerSchema.parse({
      kind: "manual",
      repo: ref("acme", "widgets"),
      prompt: "x",
      source: "manual",
    });
    expect(trigger.contextRepos).toEqual([]);
  });
});
