// biome-ignore-all lint/suspicious/noTemplateCurlyInString: POSIX sh parameter expansion, not a template
import { describe, expect, it } from "vitest";
import { credentialHelperScript } from "./git-credential-helper";

const repos = [
  {
    host: "github.com",
    cloneUrl: "https://github.com/food-truck/master-data-management.git",
    tokenVar: "SCM_TOKEN",
  },
  {
    host: "github.com",
    cloneUrl: "https://github.com/ct-kb/team-cookbook-kb.git",
    tokenVar: "SCM_TOKEN_1",
  },
];

describe("credentialHelperScript", () => {
  it("answers each repository with its own token variable and never embeds a value", () => {
    const script = credentialHelperScript(repos, "x-access-token");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(
      'github.com/food-truck/master-data-management) token="$SCM_TOKEN"',
    );
    expect(script).toContain('github.com/ct-kb/team-cookbook-kb) token="$SCM_TOKEN_1"');
    expect(script).toContain('"${SCM_TOKEN_USERNAME:-x-access-token}"');
    expect(script).not.toContain("ghp_");
  });

  it("falls back to SCM_TOKEN for a host/path it does not know", () => {
    const script = credentialHelperScript(repos, "x-access-token");
    expect(script).toContain('*) token="${SCM_TOKEN:-}"');
  });
});
