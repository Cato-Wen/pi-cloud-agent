/**
 * The model record handed to Pi for a run.
 *
 * Pi's bundled catalog is not consulted (no network, no files at boot), so
 * this is where a run says what the model can do. Thinking is the part that
 * differs by model family: Claude 4.7+ and Claude 5 only accept adaptive
 * thinking driven by an effort level, and reject the older
 * `thinking: { type: "disabled" }` outright; everything before them still
 * uses budget-based thinking where "disabled" is valid.
 */

export interface ModelDescriptorInput {
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    supportsReasoningEffort: boolean;
    maxTokensField: "max_tokens";
    forceAdaptiveThinking?: boolean;
  };
}

/** Claude 4.7 and later, and every Claude 5: adaptive thinking only. */
const ADAPTIVE_THINKING_CLAUDE =
  /^claude-(?:opus|sonnet|haiku|fable)-(?:4-(?:[7-9]|[1-9]\d)|[5-9](?:-|$))/;

function usesAdaptiveThinking(api: string, modelName: string): boolean {
  return api === "anthropic-messages" && ADAPTIVE_THINKING_CLAUDE.test(modelName);
}

export function describeModel(model: ModelDescriptorInput): ModelDescriptor {
  const adaptive = usesAdaptiveThinking(model.api, model.name);
  return {
    id: model.name,
    name: model.name,
    reasoning: true,
    // "off" is unsupported on adaptive models (the API has no "disabled"),
    // so Pi clamps it to the lowest effort; "max" must be declared to be offered.
    ...(adaptive ? { thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      ...(adaptive ? { forceAdaptiveThinking: true } : {}),
    },
  };
}
