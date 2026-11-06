import { describe, expect, it } from "vitest";
import { buildTaskPrompt } from "./catalog";

describe("buildTaskPrompt", () => {
  it("prefixes the workspace description on every turn, after skills on the first", () => {
    expect(buildTaskPrompt("skill", "do", 1, "ws")).toBe("skill\n\n---\n\nws\n\n---\n\ndo");
    expect(buildTaskPrompt(undefined, "do", 2, "ws")).toBe("ws\n\n---\n\ndo");
    expect(buildTaskPrompt("skill", "do", 2, "ws")).toBe("ws\n\n---\n\ndo");
    expect(buildTaskPrompt("skill", "do", 1, "")).toBe("skill\n\n---\n\ndo");
    expect(buildTaskPrompt("skill", "do", 2)).toBe("do");
  });
});
