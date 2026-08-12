import {
  getAnthropicReasoningProfileForModel,
  getDeepseekReasoningProfileForModel,
  getGeminiReasoningProfileForModel,
  getMimoReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getQwenReasoningProfileForModel,
  getRuntimeReasoningOptionsForModel,
  supportsReasoningForModel,
  type ReasoningProvider,
} from "../utils/reasoningProfiles";
import { MAX_ALLOWED_TOKENS } from "../utils/llmDefaults";
import { BUNDLED_MODEL_CAPABILITY_REGISTRY } from "./bundled";
import {
  inferProviderFromApiBase,
  inferProviderFromModelName,
} from "./providerInference";
import {
  applyControlPatch,
  cloneRegistry,
  findRegistryEntry,
  MODEL_CAPABILITY_MAX_TOKEN_LIMIT,
  MODEL_CAPABILITY_REGISTRY_MAX_BYTES,
  MODEL_CAPABILITY_REGISTRY_URL,
  removeControlRoots,
  validateRegistry,
} from "./registry";
import type {
  CapabilitySource,
  DiscoveredModel,
  ModelCapabilityIdentity,
  ModelCapabilityLimits,
  ModelCapabilityProvider,
  ModelCapabilityRefreshOptions,
  ModelCatalogIdentity,
  ModelControlPatch,
  ModelReasoningCapability,
  ModelSamplingCapability,
  RegistryModelEntry,
  ResolvedModelCapabilities,
} from "./types";

const REGISTRY_PREF_KEY =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistry";
const REGISTRY_TIMESTAMP_PREF_KEY =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistryFetchedAt";
const REGISTRY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CATALOG_TTL_MS = 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const FIRST_USE_PREFLIGHT_TIMEOUT_MS = 5_000;

type CatalogSnapshot = {
  models: DiscoveredModel[];
  fetchedAt: number;
  stale: boolean;
  error?: string;
};

type CapabilityRuntime = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Test/development override for the bundled environment guard. */
  environment?: "production" | "development" | "test";
};

let runtime: CapabilityRuntime = {};
let activeRegistry = cloneRegistry(BUNDLED_MODEL_CAPABILITY_REGISTRY);
let activeRegistrySource: CapabilitySource = "bundled";
let persistedRegistryLoaded = false;
let registryRefreshTask: Promise<boolean> | null = null;
const capabilityPreflightTasks = new Map<string, Promise<void>>();
const catalogRefreshTasks = new Map<string, Promise<DiscoveredModel[]>>();
const catalogSnapshots = new Map<string, CatalogSnapshot>();
const capabilityListeners = new Set<() => void>();

const LEGACY_INPUT_LIMIT_RULES: Array<[RegExp, number]> = [
  [/^qwen-long(?:[.-]|$)/, 10_000_000],
  [/^qwen-turbo(?:[.-]|$)/, 1_000_000],
  [/^qwen-max(?:-latest)?(?:[.-]|$)/, 129_024],
  [/^gemini-2[.-]?5(?:[.-]|$)/, 1_048_576],
  [/^gemini-3(?:[.-]|$)/, 1_000_000],
  [/^gemini-1[.-]?5(?:[.-]|$)/, 1_000_000],
  [/^gpt-4[.-]?1(?:[.-]|$)/, 1_047_576],
  [/^gpt-5\.4(?:[.-]|$)/, 1_050_000],
  [/^gpt-5(?:[.-]|$)/, 400_000],
  [/^o(?:3|1(?:-pro)?)(?:[.-]|$)/, 200_000],
  [/^gpt-4o(?:[.-]|$)/, 128_000],
  [/^claude(?:[.-]|$)/, 200_000],
  [/^grok-(?:4[.-]?1-fast|4-fast)(?:[.-]|$)/, 2_000_000],
  [/^grok-code-fast-1(?:[.-]|$)/, 256_000],
  [/^grok-4(?:[.-]|$)/, 256_000],
  [/^grok-3(?:[.-]|$)/, 131_072],
  [/^command-a(?:-reasoning)?(?:[.-]|$)/, 256_000],
  [/^command-r(?:\+|-plus)?(?:[.-]|$)/, 128_000],
  [/^mistral-large-3(?:[.-]|$)/, 256_000],
  [/^ministral-3(?:-14b)?(?:[.-]|$)/, 256_000],
  [/^mistral-medium-3(?:[.-]|$)/, 128_000],
  [/^mistral-small-3(?:[.-]|$)/, 128_000],
  [/^codestral(?:[.-]|$)/, 128_000],
  [/^deepseek-v4-(?:flash|pro)(?:[.-]|$)/, 1_000_000],
  [/^deepseek-(?:chat|reasoner)(?:[.-]|$)/, 1_000_000],
  [/^deepseek(?:[.-]|$)/, 128_000],
];

const LEGACY_OUTPUT_LIMIT_RULES: Array<[RegExp, number]> = [
  [/(^|[/:.])claude-(?:opus-4-7|opus-4-6)(?:[.-]|$)/, 128_000],
  [/(^|[/:.])claude-(?:sonnet-4-6|haiku-4-5)(?:[.-]|$)/, 64_000],
  [/^deepseek-v4-(?:flash|pro)(?:[.-]|$)/, 384_000],
  [/^deepseek-(?:chat|reasoner)(?:[.-]|$)/, 384_000],
];

function now(): number {
  return runtime.now?.() || Date.now();
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getZoteroPrefs(): {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
} | null {
  return (
    (
      globalThis as unknown as {
        Zotero?: {
          Prefs?: {
            get?: (key: string, global?: boolean) => unknown;
            set?: (key: string, value: unknown, global?: boolean) => void;
          };
        };
      }
    ).Zotero?.Prefs || null
  );
}

function getFetch(): typeof fetch | undefined {
  if (runtime.fetch) return runtime.fetch;
  const globalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (globalFetch) return globalFetch.bind(globalThis);
  const toolkit = (
    globalThis as unknown as {
      ztoolkit?: { getGlobal?: (key: string) => unknown };
    }
  ).ztoolkit;
  const toolkitFetch = toolkit?.getGlobal?.("fetch") as
    | typeof fetch
    | undefined;
  return toolkitFetch;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function notify(): void {
  for (const listener of capabilityListeners) {
    try {
      listener();
    } catch {
      // A UI listener must never make capability resolution fail.
    }
  }
}

function providerFromIdentity(
  identity: ModelCapabilityIdentity,
): ModelCapabilityProvider {
  const explicit = normalize(identity.provider);
  if (explicit && explicit !== "customized" && explicit !== "unknown") {
    return explicit as ModelCapabilityProvider;
  }
  return (
    inferProviderFromApiBase(normalize(identity.apiBase)) ??
    // Relays and unrecognized hosts still serve recognizable models; the
    // model name keeps its provider family (and thus its reasoning profile).
    inferProviderFromModelName(normalize(identity.model)) ??
    "unknown"
  );
}

function legacyReasoningProvider(
  provider: ModelCapabilityProvider,
): ReasoningProvider | null {
  if (
    provider === "openai" ||
    provider === "gemini" ||
    provider === "deepseek" ||
    provider === "kimi" ||
    provider === "mimo" ||
    provider === "qwen" ||
    provider === "grok" ||
    provider === "anthropic"
  ) {
    return provider;
  }
  return null;
}

function legacyInputLimit(model: string): number | undefined {
  const normalized = normalize(model);
  const candidates = [normalized, normalized.split("/").pop() || normalized];
  for (const [pattern, limit] of LEGACY_INPUT_LIMIT_RULES) {
    if (candidates.some((candidate) => pattern.test(candidate))) return limit;
  }
  return undefined;
}

function legacyOutputLimit(model: string): number | undefined {
  const normalized = normalize(model);
  const candidates = [normalized, normalized.split("/").pop() || normalized];
  for (const [pattern, limit] of LEGACY_OUTPUT_LIMIT_RULES) {
    if (candidates.some((candidate) => pattern.test(candidate))) return limit;
  }
  return undefined;
}

function legacyReasoning(
  provider: ModelCapabilityProvider,
  model: string,
): ModelReasoningCapability {
  const legacyProviderName = legacyReasoningProvider(provider);
  if (
    !legacyProviderName ||
    !supportsReasoningForModel(legacyProviderName, model)
  ) {
    return { kind: "none", options: [] };
  }
  const options = getRuntimeReasoningOptionsForModel(legacyProviderName, model)
    .filter((option) => option.enabled)
    .map((option) => ({
      id: option.level,
      label: option.label || option.level,
      enabled: option.enabled,
    }));
  const defaultOptionId = options[0]?.id;
  return options.length
    ? {
        kind: options.length === 1 ? "fixed" : "select",
        options,
        defaultOptionId,
      }
    : { kind: "none", options: [] };
}

function legacyReasoningProfiles(
  provider: ModelCapabilityProvider,
  model: string,
): void {
  // Touching these profiles here keeps the adapter boundary explicit.  Their
  // detailed encoders remain in llmClient until all provider transports have
  // moved to declarative controls.
  if (provider === "openai" || provider === "grok")
    getOpenAIReasoningProfileForModel(model);
  if (provider === "gemini") getGeminiReasoningProfileForModel(model);
  if (provider === "anthropic") getAnthropicReasoningProfileForModel(model);
  if (provider === "qwen") getQwenReasoningProfileForModel(model);
  if (provider === "deepseek") getDeepseekReasoningProfileForModel(model);
  if (provider === "mimo") getMimoReasoningProfileForModel(model);
}

function buildCatalogKey(identity: ModelCapabilityIdentity): string {
  return [
    providerFromIdentity(identity),
    normalize(identity.apiBase),
    normalize(identity.protocol),
    normalize(identity.authMode),
    normalize(identity.scope),
  ].join("\u0000");
}

function buildCatalogBaseKey(identity: ModelCapabilityIdentity): string {
  return [
    providerFromIdentity(identity),
    normalize(identity.apiBase),
    normalize(identity.protocol),
    normalize(identity.authMode),
  ].join("\u0000");
}

function getCatalogSnapshot(
  identity: ModelCapabilityIdentity,
): CatalogSnapshot | undefined {
  const exact = catalogSnapshots.get(buildCatalogKey(identity));
  if (exact) return exact;
  const baseKey = buildCatalogBaseKey(identity);
  for (const [snapshotKey, snapshot] of catalogSnapshots) {
    if (snapshotKey.split("\u0000").slice(0, 4).join("\u0000") === baseKey) {
      return snapshot;
    }
  }
  return undefined;
}

function getLiveModel(
  identity: ModelCapabilityIdentity,
): DiscoveredModel | undefined {
  return getCatalogSnapshot(identity)?.models.find(
    (model) => model.id === identity.model,
  );
}

function mergeLimits(
  legacy: number | undefined,
  legacyOutput: number | undefined,
  entry: RegistryModelEntry | null,
  live: DiscoveredModel | undefined,
): { limits: ModelCapabilityLimits; source: CapabilitySource } {
  const entryLimits = entry?.limits;
  const liveLimits = live?.limits;
  const limits: ModelCapabilityLimits = {
    ...(legacy ? { contextWindowTokens: legacy, inputTokens: legacy } : {}),
    ...(legacyOutput ? { outputTokens: legacyOutput } : {}),
    ...(entryLimits || {}),
    ...(liveLimits || {}),
  };
  if (liveLimits?.contextWindowTokens && liveLimits.inputTokens === undefined) {
    // A live catalog's current context window supersedes stale bundled input
    // rules when the provider does not expose a separate input limit.
    limits.inputTokens = liveLimits.contextWindowTokens;
  }
  const source: CapabilitySource = liveLimits
    ? "live"
    : entryLimits
      ? activeRegistrySource
      : "legacy";
  return { limits, source };
}

function mergeReasoning(
  provider: ModelCapabilityProvider,
  model: string,
  entry: RegistryModelEntry | null,
  live: DiscoveredModel | undefined,
): { reasoning: ModelReasoningCapability; source: CapabilitySource } {
  const legacy = legacyReasoning(provider, model);
  legacyReasoningProfiles(provider, model);
  if (live?.reasoningSupported === false) {
    return { reasoning: { kind: "none", options: [] }, source: "live" };
  }
  if (entry?.reasoning) {
    return {
      reasoning: clone(entry.reasoning),
      source: live?.reasoningSupported ? "live" : activeRegistrySource,
    };
  }
  if (live?.reasoningSupported) {
    return {
      reasoning: legacy.options.length
        ? legacy
        : { kind: "server_default", options: [] },
      source: "live",
    };
  }
  return { reasoning: legacy, source: "legacy" };
}

function defaultInputs(
  provider: ModelCapabilityProvider,
): ResolvedModelCapabilities["inputs"] {
  return {
    text: true,
    image: true,
    video: provider === "gemini" || provider === "kimi",
    pdf: provider === "anthropic" || provider === "gemini",
  };
}

function defaultSampling(): ModelSamplingCapability {
  return {
    temperature: "configurable",
    minTemperature: 0,
    maxTemperature: 2,
  };
}

function loadPersistedRegistry(): void {
  if (persistedRegistryLoaded) return;
  persistedRegistryLoaded = true;
  const prefs = getZoteroPrefs();
  const raw = prefs?.get?.(REGISTRY_PREF_KEY, true);
  if (typeof raw !== "string" || !raw.trim()) return;
  try {
    const parsed = validateRegistry(JSON.parse(raw));
    if (parsed && parsed.revision >= activeRegistry.revision) {
      activeRegistry = parsed;
      activeRegistrySource = "remote";
    }
  } catch {
    // Ignore corrupt cached data and keep the bundled registry.
  }
}

export function configureModelCapabilityRuntime(next: CapabilityRuntime): void {
  runtime = { ...runtime, ...next };
}

function getRuntimeEnvironment(): CapabilityRuntime["environment"] {
  if (runtime.environment) return runtime.environment;
  try {
    return typeof __env__ === "string" ? __env__ : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Auth modes whose credentials or transports cannot use the generic
 * `/models` catalog fetch (dedicated token exchanges or no HTTP API at all).
 * Shared with the provider-group refresh so the boundary cannot drift.
 */
export const CATALOG_EXCLUDED_AUTH_MODES: ReadonlySet<string> = new Set([
  "codex_auth",
  "codex_app_server",
  "copilot_auth",
  "webchat",
]);

function canRunCapabilityPreflight(identity: ModelCatalogIdentity): boolean {
  const environment = getRuntimeEnvironment();
  if (environment !== "production" && environment !== "development") {
    return false;
  }
  if (!identity.model.trim() || !identity.apiBase?.trim()) return false;
  return !CATALOG_EXCLUDED_AUTH_MODES.has(normalize(identity.authMode));
}

/**
 * Best-effort first-use discovery. It never blocks a request for longer than
 * five seconds and failures deliberately leave the bundled/legacy fallback in
 * place. The underlying refresh may continue after the timeout so a later
 * request can use the completed snapshot.
 */
export async function ensureModelCapabilities(
  identity: ModelCatalogIdentity,
  options: ModelCapabilityRefreshOptions = {},
): Promise<void> {
  if (!canRunCapabilityPreflight(identity)) return;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Math.min(
    FIRST_USE_PREFLIGHT_TIMEOUT_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(1, Math.floor(requestedTimeout))
      : FIRST_USE_PREFLIGHT_TIMEOUT_MS,
  );
  const key = buildCatalogKey(identity);
  loadPersistedRegistry();
  const registryProbe = !findRegistryEntry(
    activeRegistry,
    providerFromIdentity(identity),
    identity.model,
  );
  let task = capabilityPreflightTasks.get(key);
  if (!task) {
    task = Promise.allSettled([
      refreshModelCapabilityRegistry({ timeoutMs, force: registryProbe }),
      refreshModelCatalog(identity, { timeoutMs }),
    ]).then(() => undefined);
    capabilityPreflightTasks.set(key, task);
    void task.then(
      () => {
        if (capabilityPreflightTasks.get(key) === task)
          capabilityPreflightTasks.delete(key);
      },
      () => {
        if (capabilityPreflightTasks.get(key) === task)
          capabilityPreflightTasks.delete(key);
      },
    );
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function getModelCapabilities(
  identity: ModelCapabilityIdentity,
): ResolvedModelCapabilities {
  loadPersistedRegistry();
  const provider = providerFromIdentity(identity);
  const model = identity.model.trim();
  const entry = findRegistryEntry(activeRegistry, provider, model);
  const live = getLiveModel(identity);
  const mergedLimits = mergeLimits(
    legacyInputLimit(model),
    legacyOutputLimit(model),
    entry,
    live,
  );
  const mergedReasoning = mergeReasoning(provider, model, entry, live);
  const source: CapabilitySource = live
    ? "live"
    : entry
      ? activeRegistrySource
      : "legacy";
  const snapshot: ResolvedModelCapabilities = {
    identity: { ...identity, model },
    provider,
    model,
    limits: mergedLimits.limits,
    reasoning: mergedReasoning.reasoning,
    sampling: entry?.sampling
      ? { ...defaultSampling(), ...clone(entry.sampling) }
      : defaultSampling(),
    inputs: {
      ...defaultInputs(provider),
      ...(entry?.inputs || {}),
      ...(live?.inputs || {}),
    },
    features: {
      tools: true,
      streaming: true,
      promptCache: false,
      ...(entry?.features || {}),
    },
    source,
    stale: Boolean(getCatalogSnapshot(identity)?.stale),
    resolvedAt: now(),
    provenance: {
      limits: mergedLimits.source,
      reasoning: mergedReasoning.source,
      ...(entry?.sampling ? { sampling: activeRegistrySource } : {}),
      ...(entry?.inputs || live?.inputs
        ? { inputs: live ? "live" : activeRegistrySource }
        : {}),
      ...(entry?.features ? { features: activeRegistrySource } : {}),
    },
  };
  return snapshot;
}

export function compileReasoningControls(
  capabilities: ResolvedModelCapabilities,
  selection: { level?: string; effort?: string },
): { extra: Record<string, unknown>; omitTemperature: boolean } | null {
  const reasoning = capabilities.reasoning;
  if (reasoning.kind === "none" || reasoning.kind === "server_default")
    return null;
  const requested = normalize(selection.effort || selection.level);
  if (!requested || requested === "auto" || requested === "none") return null;
  const option =
    reasoning.options.find(
      (candidate) => normalize(candidate.id) === requested,
    ) ||
    (requested === "minimal"
      ? reasoning.options.find((candidate) => normalize(candidate.id) === "off")
      : undefined) ||
    (requested === "default"
      ? reasoning.options.find(
          (candidate) => candidate.id === reasoning.defaultOptionId,
        ) || reasoning.options[0]
      : undefined);
  const controls = option?.controls || reasoning.controls;
  if (!option || option.enabled === false || !controls) return null;
  const extra = applyControlPatch({}, controls);
  removeControlRoots(extra, controls);
  return {
    extra,
    omitTemperature: Boolean(controls.omitTemperature),
  };
}

export function getRuntimeReasoningOptions(
  identity: ModelCapabilityIdentity,
): Array<{ level: string; label: string; enabled: boolean }> {
  const reasoning = getModelCapabilities(identity).reasoning;
  const options = [...reasoning.options].sort((left, right) => {
    if (left.id === reasoning.defaultOptionId) return -1;
    if (right.id === reasoning.defaultOptionId) return 1;
    return 0;
  });
  return options.map((option) => ({
    level: option.id,
    label: option.label,
    enabled: option.enabled !== false,
  }));
}

export function getModelOutputTokenLimit(
  model: string,
  identity?: Omit<ModelCapabilityIdentity, "model">,
): number {
  return (
    getModelCapabilities({ model, ...identity }).limits.outputTokens ||
    MAX_ALLOWED_TOKENS
  );
}

export function subscribeModelCapabilities(listener: () => void): () => void {
  capabilityListeners.add(listener);
  return () => capabilityListeners.delete(listener);
}

function getRegistryFetchedAt(): number {
  const value = getZoteroPrefs()?.get?.(REGISTRY_TIMESTAMP_PREF_KEY, true);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function persistRegistry(registry: typeof activeRegistry): void {
  try {
    const prefs = getZoteroPrefs();
    prefs?.set?.(REGISTRY_PREF_KEY, JSON.stringify(registry), true);
    prefs?.set?.(REGISTRY_TIMESTAMP_PREF_KEY, now(), true);
  } catch {
    // Persistence is an optimization; an unavailable preference service must
    // not discard a valid in-memory registry update.
  }
}

function getAbortController(): typeof AbortController | undefined {
  return (globalThis as unknown as { AbortController?: typeof AbortController })
    .AbortController;
}

export async function refreshModelCapabilityRegistry(
  options: ModelCapabilityRefreshOptions = {},
): Promise<boolean> {
  loadPersistedRegistry();
  if (
    !options.force &&
    now() - getRegistryFetchedAt() < REGISTRY_REFRESH_INTERVAL_MS
  ) {
    return false;
  }
  if (registryRefreshTask) return registryRefreshTask;
  registryRefreshTask = (async () => {
    const fetchFn = getFetch();
    if (!fetchFn) return false;
    const AbortControllerCtor = getAbortController();
    const controller = AbortControllerCtor
      ? new AbortControllerCtor()
      : undefined;
    const timer = controller
      ? setTimeout(
          () => controller.abort(),
          options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
        )
      : null;
    try {
      const response = await fetchFn(MODEL_CAPABILITY_REGISTRY_URL, {
        headers: { Accept: "application/json" },
        signal: controller?.signal,
      });
      if (!response.ok) return false;
      const text = await response.text();
      if (text.length > MODEL_CAPABILITY_REGISTRY_MAX_BYTES) return false;
      const parsed = validateRegistry(JSON.parse(text));
      if (!parsed || parsed.revision <= activeRegistry.revision) {
        persistRegistry(activeRegistry);
        return false;
      }
      activeRegistry = parsed;
      activeRegistrySource = "remote";
      persistRegistry(parsed);
      notify();
      return true;
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })();
  try {
    return await registryRefreshTask;
  } finally {
    registryRefreshTask = null;
  }
}

/**
 * Providers whose recommended chat base is an Anthropic-compatible proxy that
 * serves no `/models` route. Their OpenAI-compatible surface still lists
 * models (with plain Bearer auth), so catalog requests go there instead.
 */
const ANTHROPIC_COMPAT_CATALOG_ENDPOINTS: Partial<Record<string, string>> = {
  deepseek: "https://api.deepseek.com/models",
  glm: "https://open.bigmodel.cn/api/paas/v4/models",
  minimax: "https://api.minimax.io/v1/models",
};

function getAnthropicCompatCatalogEndpoint(
  identity: ModelCatalogIdentity,
): string | null {
  const override =
    ANTHROPIC_COMPAT_CATALOG_ENDPOINTS[providerFromIdentity(identity)];
  if (!override) return null;
  const base = normalize(identity.apiBase);
  return base.includes("anthropic") ? override : null;
}

function getCatalogEndpoint(identity: ModelCatalogIdentity): string | null {
  if (!identity.apiBase) return null;
  try {
    const url = new URL(identity.apiBase);
    const path = url.pathname.replace(/\/+$/, "");
    if (identity.protocol === "gemini_native") {
      url.pathname = (
        path.endsWith("/models") ? path : `${path || "/v1beta"}/models`
      ).replace(/\/\/+/g, "/");
      return url.toString();
    }
    if (path.endsWith("/models")) return url.toString();
    const marker = ["/chat/completions", "/responses", "/embeddings"].find(
      (suffix) => path.endsWith(suffix),
    );
    url.pathname = `${marker ? path.slice(0, -marker.length) : path}/models`
      .replace(/\/\/+/g, "/")
      .replace("https:/", "https://")
      .replace("http:/", "http://");
    return url.toString();
  } catch {
    return null;
  }
}

function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const rawModels =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : value &&
          typeof value === "object" &&
          Array.isArray((value as { models?: unknown }).models)
        ? (value as { models: unknown[] }).models
        : [];
  const models: DiscoveredModel[] = [];
  for (const raw of rawModels) {
    if (models.length >= 4096) break;
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    let id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id && typeof row.name === "string")
      id = row.name.trim().replace(/^models\//, "");
    if (!id || id.length > 256) continue;
    const context = Number(
      row.context_length ?? row.context_window ?? row.contextWindow,
    );
    const input = Number(
      row.max_input_tokens ??
        row.maxInputTokens ??
        row.input_token_limit ??
        row.inputTokenLimit ??
        row.inputTokens,
    );
    const output = Number(
      row.max_output_tokens ??
        row.maxOutputTokens ??
        row.output_token_limit ??
        row.outputTokenLimit ??
        row.outputTokens,
    );
    const limits: ModelCapabilityLimits = {};
    if (
      Number.isSafeInteger(context) &&
      context > 0 &&
      context <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    )
      limits.contextWindowTokens = context;
    if (
      Number.isSafeInteger(input) &&
      input > 0 &&
      input <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    )
      limits.inputTokens = input;
    if (
      Number.isSafeInteger(output) &&
      output > 0 &&
      output <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    )
      limits.outputTokens = output;
    const inputs: DiscoveredModel["inputs"] = {};
    const supportsImage =
      row.supports_image_in ?? row.supportsImageIn ?? row.supportsVision;
    const supportsVideo = row.supports_video_in ?? row.supportsVideoIn;
    if (typeof supportsImage === "boolean") inputs.image = supportsImage;
    if (typeof supportsVideo === "boolean") inputs.video = supportsVideo;
    const reasoningSupported =
      row.supports_reasoning ??
      row.supportsReasoning ??
      row.reasoning_supported ??
      row.reasoningSupported;
    models.push({
      id,
      ...(typeof row.owned_by === "string" ? { ownedBy: row.owned_by } : {}),
      ...(Number.isFinite(Number(row.created))
        ? { created: Number(row.created) }
        : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(Object.keys(inputs).length ? { inputs } : {}),
      ...(typeof reasoningSupported === "boolean"
        ? { reasoningSupported }
        : {}),
      source: "live",
    });
  }
  return models;
}

export async function refreshModelCatalog(
  identity: ModelCatalogIdentity,
  options: ModelCapabilityRefreshOptions = {},
): Promise<DiscoveredModel[]> {
  const key = buildCatalogKey(identity);
  const cached = catalogSnapshots.get(key);
  if (
    cached &&
    !options.force &&
    now() - cached.fetchedAt < PROVIDER_CATALOG_TTL_MS
  ) {
    return cached.models;
  }
  // Coalesce concurrent refreshes: several UI rows can ask for the same
  // provider catalog in the same tick and must share one network request.
  const inFlight = catalogRefreshTasks.get(key);
  if (inFlight && !options.force) return inFlight;
  const task = fetchModelCatalog(identity, options, key, cached);
  catalogRefreshTasks.set(key, task);
  try {
    return await task;
  } finally {
    if (catalogRefreshTasks.get(key) === task) catalogRefreshTasks.delete(key);
  }
}

async function fetchModelCatalog(
  identity: ModelCatalogIdentity,
  options: ModelCapabilityRefreshOptions,
  key: string,
  cached: CatalogSnapshot | undefined,
): Promise<DiscoveredModel[]> {
  const compatEndpoint = getAnthropicCompatCatalogEndpoint(identity);
  const endpoint = compatEndpoint || getCatalogEndpoint(identity);
  const fetchFn = getFetch();
  if (!endpoint || !fetchFn) return cached?.models || [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const AbortControllerCtor = getAbortController();
    const controller = AbortControllerCtor
      ? new AbortControllerCtor()
      : undefined;
    timer = controller
      ? setTimeout(
          () => controller.abort(),
          options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
        )
      : null;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (identity.apiKey && identity.authMode !== "codex_auth") {
      if (identity.protocol === "gemini_native") {
        // Header auth keeps the key out of URLs (and any proxy/server logs).
        headers["x-goog-api-key"] = identity.apiKey;
      } else if (
        identity.protocol === "anthropic_messages" &&
        !compatEndpoint
      ) {
        headers["x-api-key"] = identity.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.Authorization = `Bearer ${identity.apiKey}`;
      }
    }
    const response = await fetchFn(endpoint, {
      headers,
      signal: controller?.signal,
    });
    if (!response.ok)
      throw new Error(`catalog request failed: ${response.status}`);
    const models = parseDiscoveredModels(await response.json());
    catalogSnapshots.set(key, { models, fetchedAt: now(), stale: false });
    notify();
    return models;
  } catch (error) {
    const snapshot: CatalogSnapshot = {
      models: cached?.models || [],
      fetchedAt: cached?.fetchedAt || 0,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
    catalogSnapshots.set(key, snapshot);
    return snapshot.models;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function getDiscoveredModels(
  identity: ModelCapabilityIdentity,
): DiscoveredModel[] {
  return clone(catalogSnapshots.get(buildCatalogKey(identity))?.models || []);
}

export function getModelCatalogStatus(
  identity: ModelCapabilityIdentity,
): CatalogSnapshot | null {
  const snapshot = catalogSnapshots.get(buildCatalogKey(identity));
  return snapshot ? clone(snapshot) : null;
}

export async function refreshConfiguredModelCatalogs(
  identities: ModelCatalogIdentity[],
  options: ModelCapabilityRefreshOptions = {},
): Promise<void> {
  await Promise.allSettled(
    identities.map((identity) => refreshModelCatalog(identity, options)),
  );
}

export function resetModelCapabilityStateForTests(): void {
  activeRegistry = cloneRegistry(BUNDLED_MODEL_CAPABILITY_REGISTRY);
  activeRegistrySource = "bundled";
  persistedRegistryLoaded = false;
  registryRefreshTask = null;
  capabilityPreflightTasks.clear();
  catalogRefreshTasks.clear();
  catalogSnapshots.clear();
  runtime = {};
}

export function setModelCapabilityRegistryForTests(value: unknown): boolean {
  const parsed = validateRegistry(value);
  if (!parsed) return false;
  activeRegistry = parsed;
  activeRegistrySource = "remote";
  notify();
  return true;
}

export function getActiveModelCapabilityRegistryForTests(): typeof activeRegistry {
  return clone(activeRegistry);
}
