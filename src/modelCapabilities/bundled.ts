import type {
  ModelCapabilityRegistry,
  ModelReasoningCapability,
} from "./types";

/**
 * Bundled fallback.  Keep this intentionally small and conservative: the
 * remote registry can add new models, while this copy must remain safe when
 * the user is offline or GitHub is unavailable.
 */
// K3 takes a top-level `reasoning_effort` and rejects the K2.x `thinking`
// parameter (platform.kimi.ai "Reasoning Effort" + K2→K3 migration guide).
const KIMI_K3_REASONING: ModelReasoningCapability = {
  kind: "select",
  defaultOptionId: "max",
  options: [
    {
      id: "low",
      label: "Low",
      controls: { body: { reasoning_effort: "low" } },
    },
    {
      id: "high",
      label: "High",
      controls: { body: { reasoning_effort: "high" } },
    },
    {
      id: "max",
      label: "Max",
      controls: { body: { reasoning_effort: "max" } },
    },
  ],
};

export const BUNDLED_MODEL_CAPABILITY_REGISTRY: ModelCapabilityRegistry = {
  schemaVersion: 1,
  revision: 2,
  models: [
    {
      match: { provider: "kimi", prefix: "kimi-k2.6" },
      limits: { contextWindowTokens: 262144, inputTokens: 262144 },
      reasoning: {
        kind: "toggle",
        defaultOptionId: "on",
        options: [
          {
            id: "off",
            label: "Off",
            controls: { body: { thinking: { type: "disabled" } } },
          },
          {
            id: "on",
            label: "On",
            controls: { body: { thinking: { type: "enabled" } } },
          },
        ],
      },
    },
    {
      match: { provider: "kimi", prefix: "kimi-k2.7" },
      limits: { contextWindowTokens: 262144, inputTokens: 262144 },
      reasoning: {
        kind: "fixed",
        defaultOptionId: "on",
        options: [
          {
            id: "on",
            label: "Reasoning",
            controls: { body: { thinking: { type: "enabled" } } },
          },
        ],
      },
    },
    {
      match: { provider: "kimi", prefix: "kimi-k3" },
      limits: { contextWindowTokens: 1048576, inputTokens: 1048576 },
      reasoning: KIMI_K3_REASONING,
    },
    {
      // Kimi-for-Coding (api.kimi.com/coding/v1) serves the K3 family under
      // bare ids: k3, k3-256k, kimi-for-coding, kimi-for-coding-highspeed.
      match: { provider: "kimi", prefix: "k3" },
      limits: { contextWindowTokens: 262144, inputTokens: 262144 },
      reasoning: KIMI_K3_REASONING,
    },
    {
      match: { provider: "kimi", exact: "k3-256k" },
      limits: { contextWindowTokens: 262144, inputTokens: 262144 },
      reasoning: KIMI_K3_REASONING,
    },
    {
      match: { provider: "kimi", prefix: "kimi-for-coding" },
      limits: { contextWindowTokens: 262144, inputTokens: 262144 },
      reasoning: KIMI_K3_REASONING,
    },
    {
      match: { provider: "qwen", prefix: "qwen-long" },
      limits: { contextWindowTokens: 10000000, inputTokens: 10000000 },
    },
    {
      match: { provider: "gemini", prefix: "gemini-2.5" },
      limits: { contextWindowTokens: 1048576, inputTokens: 1048576 },
    },
    {
      match: { provider: "openai", prefix: "gpt-5.4" },
      limits: { contextWindowTokens: 1050000, inputTokens: 1050000 },
    },
  ],
};
