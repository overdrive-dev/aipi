import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_XAI_MODEL,
  XAI_API_BASE_URL,
  XAI_CLI_BASE_URL,
  XAI_CLI_RESPONSES_URL,
  XAI_GROK_CLIENT_VERSION,
  XAI_PROVIDER_ID,
  XAI_RESPONSES_URL,
} from "./constants";

export const MODELS = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    // xAI has not published a Grok 4.5-specific max output limit yet;
    // keep the existing Grok Responses ceiling until official metadata is available.
    maxTokens: 131_072,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0.2 },
    contextWindow: 512_000,
    maxTokens: 30_000,
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5 Fast",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 30_000,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    },
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 Reasoning",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 Non-Reasoning",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
];

/** Build a pi model object for direct xAI tool requests. */
export function xaiModelForRequest(modelId?: string): Model<Api> {
  const id = modelId || DEFAULT_XAI_MODEL;
  const model =
    MODELS.find((candidate) => candidate.id === id) ||
    MODELS.find((candidate) => candidate.id === DEFAULT_XAI_MODEL) ||
    MODELS[0];
  return {
    ...model,
    id,
    provider: XAI_PROVIDER_ID,
    api: "xai-responses",
    baseUrl: xaiBaseUrlForModel(id),
  } as any;
}

/** Normalize provider/model-prefixed xAI model ids for routing comparisons. */
export function normalizedXaiModelId(modelId: string): string {
  return (modelId || "").toLowerCase().split("/").pop() || "";
}

/** Return true for models that must route through xAI's Grok CLI proxy. */
export function isGrokCliProxyModel(modelId: string): boolean {
  const normalized = normalizedXaiModelId(modelId);
  return normalized === "grok-build" || normalized === "grok-composer-2.5-fast";
}

/** Resolve the base URL used by a model. */
export function xaiBaseUrlForModel(modelId: string): string {
  return isGrokCliProxyModel(modelId) ? XAI_CLI_BASE_URL : XAI_API_BASE_URL;
}

/** Resolve the Responses endpoint used by a model. */
export function xaiResponsesUrlForModel(modelId: string): string {
  return isGrokCliProxyModel(modelId) ? XAI_CLI_RESPONSES_URL : XAI_RESPONSES_URL;
}

/** Build Grok CLI proxy headers for Composer/Grok Build requests. */
export function grokCliProxyHeaders(modelId: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-grok-client-identifier": "pi-xai-oauth",
    "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-model-override": normalizedXaiModelId(modelId),
  };
  if (sessionId) headers["x-grok-conv-id"] = sessionId;
  return headers;
}

/** Build extra request headers needed for a given xAI model. */
export function xaiModelRequestHeaders(modelId: string, sessionId?: string): Record<string, string> {
  return isGrokCliProxyModel(modelId) ? grokCliProxyHeaders(modelId, sessionId) : {};
}

/** Return true when xAI accepts an explicit Responses reasoning effort. */
export function grokSupportsReasoningEffort(modelId: string): boolean {
  const normalized = normalizedXaiModelId(modelId);
  return (
    normalized.startsWith("grok-3-mini") ||
    normalized.startsWith("grok-4.20-multi-agent") ||
    normalized.startsWith("grok-4.3") ||
    normalized.startsWith("grok-4.5")
  );
}
