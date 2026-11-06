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

  it("falls back to SCM_TOKEN only on the primary repository's host", () => {
    const script = credentialHelperScript(repos, "x-access-token");
    expect(script).toContain('github.com/*) token="${SCM_TOKEN:-}"');
    expect(script).toContain("*) exit 0");
  });

  it("matches host and path case-insensitively, as GitHub does", () => {
    const script = credentialHelperScript(
      [
        {
          host: "GitHub.com",
          cloneUrl: "https://github.com/CT-KB/Team-KB.git",
          tokenVar: "SCM_TOKEN",
        },
      ],
      "x-access-token",
    );
    expect(script).toContain("tr '[:upper:]' '[:lower:]'");
    expect(script).toContain('github.com/ct-kb/team-kb) token="$SCM_TOKEN"');
    expect(script).not.toContain("Team-KB");
  });
});
