import { describe, expect, it } from "vitest";
import { describeModel } from "./model-descriptor";

const base = { name: "", api: "anthropic-messages", contextWindow: 200_000, maxTokens: 8192 };

describe("model descriptor for Pi", () => {
  it("drives Claude 5 and Claude 4.7+ through adaptive thinking with effort", () => {
    for (const name of [
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-opus-4-7",
    ]) {
      const model = describeModel({ ...base, name });
      expect(model.compat?.forceAdaptiveThinking, name).toBe(true);
      // "disabled" is rejected by these models, so "off" must not be offered to pi-ai;
      // it clamps to the lowest effort instead.
      expect(model.thinkingLevelMap?.off, name).toBeNull();
      expect(model.thinkingLevelMap?.max, name).toBe("max");
    }
  });

  it("leaves older Claude models on budget-based thinking where disabled is still valid", () => {
    const model = describeModel({ ...base, name: "claude-sonnet-4-5" });
    expect(model.compat?.forceAdaptiveThinking).toBeUndefined();
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("does not touch thinking for OpenAI-compatible endpoints", () => {
    const model = describeModel({ ...base, api: "openai-completions", name: "gpt-5" });
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(model.compat?.forceAdaptiveThinking).toBeUndefined();
    expect(model.compat?.maxTokensField).toBe("max_tokens");
  });
});
