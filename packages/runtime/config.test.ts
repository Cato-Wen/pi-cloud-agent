import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeRedactor } from "./config";

const saved = { ...process.env };

afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, saved);
});

describe("createRuntimeRedactor", () => {
  it("scrubs numbered per-repository tokens as well as the primary one", () => {
    process.env.SCM_TOKEN = "ghp_primary000000000000000000000000000000";
    process.env.SCM_TOKEN_1 = "ghp_context0000000000000000000000000000001";
    const clean = createRuntimeRedactor();
    expect(clean("a ghp_primary000000000000000000000000000000 b")).not.toContain("ghp_primary");
    expect(clean("a ghp_context0000000000000000000000000000001 b")).not.toContain(
      "ghp_context",
    );
  });
});
