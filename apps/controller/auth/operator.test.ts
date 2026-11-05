import { describe, expect, it } from "vitest";
import { testConfig } from "../test-support";
import { isOperator } from "./operator";

describe("operator access", () => {
  it("matches logins case-insensitively from OPERATOR_GITHUB_LOGINS", () => {
    const config = testConfig({ OPERATOR_GITHUB_LOGINS: "Cato-Wen, alice" });
    expect(isOperator(config, "cato-wen")).toBe(true);
    expect(isOperator(config, "ALICE")).toBe(true);
    expect(isOperator(config, "bob")).toBe(false);
    expect(isOperator(config, undefined)).toBe(false);
  });
});
