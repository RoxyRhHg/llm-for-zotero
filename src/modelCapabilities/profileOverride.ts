/**
 * User-authored per-model capability overrides.
 *
 * Every heuristic for inferring what a model can do — name regexes, hosted
 * profiles, what a server volunteers — goes stale as models ship. Rather than
 * chase that, the user gets the last word: an override sits on top of the
 * detected profile and wins.
 *
 * The shape deliberately reuses `RegistryModelEntry` minus its `match` (the
 * model is implied by where the override is stored), so there is no second
 * schema to maintain and the same merge machinery applies.
 *
 * **Trust boundary.** The registry allowlist in `registry.ts` exists because
 * the remote registry is fetched over the network. A user editing their own
 * provider is a different domain: local-model users need `top_k`,
 * `repeat_penalty`, `stop` and friends, all of which that allowlist blocks. So
 * arbitrary keys are permitted here — but path segments that would let a value
 * escape into the prototype chain are not.
 */

import type {
  ModelFeatureCapabilities,
  ModelInputCapabilities,
  ModelCapabilityLimits,
  ModelReasoningCapability,
  ModelSamplingCapability,
} from "./types";

export type ModelProfileOverride = {
  limits?: ModelCapabilityLimits;
  reasoning?: ModelReasoningCapability;
  sampling?: ModelSamplingCapability;
  inputs?: Partial<ModelInputCapabilities>;
  features?: Partial<ModelFeatureCapabilities>;
  /** Extra request-body parameters, expressed as dot-paths. */
  extraBody?: Record<string, unknown>;
};

/**
 * Path segments that must never be walked when expanding a dot-path.
 *
 * A naive walker resolves `__proto__` to `Object.prototype` and then writes
 * through it, which mutates every object in the runtime. `constructor` and
 * `prototype` reach the same place by a longer route. The symptom — a global
 * built-in quietly disappearing — is impossible to trace back to a parameter
 * the user typed, so it is refused rather than debugged later.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export function isForbiddenPathSegment(segment: string): boolean {
  return FORBIDDEN_PATH_SEGMENTS.has(segment);
}

/** Serialized size ceiling; the override is read on every capability resolve. */
export const MAX_PROFILE_OVERRIDE_BYTES = 16 * 1024;

/**
 * Request-envelope keys a user parameter must never occupy.
 *
 * Payload builders spread the user's extra parameters into the request body,
 * most of them after the envelope, so a parameter named `messages`, `tools` or
 * `stream` would replace the conversation, drop every tool definition, or turn
 * off streaming. Each fails in a way that looks nothing like "the parameter I
 * typed was wrong", so the editor refuses them outright.
 */
const RESERVED_REQUEST_KEYS = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "contents",
  "system",
  "prompt",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
]);

export function isReservedRequestKey(key: string): boolean {
  return RESERVED_REQUEST_KEYS.has(key);
}

export type DotPathEntry = { key: string; value: unknown };

/**
 * Expand `{"a.b.c": v}` into `{a: {b: {c: v}}}`.
 *
 * Intermediates are created with a null prototype so there is nothing to walk
 * into even if a guard is ever missed; the result is round-tripped through
 * JSON at the end so consumers receive ordinary objects.
 */
export function expandDotPaths(
  entries: DotPathEntry[],
): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null);
  for (const entry of entries) {
    const key = (entry.key || "").trim();
    if (!key) continue;
    const segments = key.split(".").filter(Boolean);
    if (!segments.length) continue;
    if (segments.some(isForbiddenPathSegment)) continue;
    let cursor = root;
    let usable = true;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      const next = cursor[segment];
      if (next === undefined || next === null) {
        const created: Record<string, unknown> = Object.create(null);
        cursor[segment] = created;
        cursor = created;
        continue;
      }
      if (typeof next !== "object" || Array.isArray(next)) {
        // A scalar already occupies this path; a deeper write would silently
        // discard it, so drop the conflicting entry instead.
        usable = false;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    if (!usable) continue;
    cursor[segments[segments.length - 1]] = entry.value;
  }
  return JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
}

/** Flatten a nested body back into dot-path rows for the editor. */
export function flattenToDotPaths(
  value: Record<string, unknown> | undefined,
  prefix = "",
): DotPathEntry[] {
  if (!value) return [];
  const rows: DotPathEntry[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      rows.push(...flattenToDotPaths(entry as Record<string, unknown>, path));
      continue;
    }
    rows.push({ key: path, value: entry });
  }
  return rows;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Infer a scalar's type from the text the user typed, so a simple
 * `key=value` field needs no separate type picker.
 */
export function coerceParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return raw;
}

/**
 * Parse a comma-separated `key=value` list into a request-body patch.
 *
 * Used for the reasoning-level parameter field, which is nearly always a
 * single short pair such as `think=high` — JSON braces there would be noise.
 * Nested keys still work through dot paths (`chat_template_kwargs.enable_thinking=true`).
 */
export function parseKeyValueField(raw: string): {
  value: Record<string, unknown>;
  rejected: string[];
} {
  const entries: DotPathEntry[] = [];
  const rejected: string[] = [];
  for (const pair of (raw || "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const key = separator > 0 ? trimmed.slice(0, separator).trim() : "";
    if (
      !key ||
      key.split(".").some(isForbiddenPathSegment) ||
      isReservedRequestKey(key)
    ) {
      rejected.push(trimmed);
      continue;
    }
    entries.push({
      key,
      value: coerceParameterValue(trimmed.slice(separator + 1)),
    });
  }
  return { value: expandDotPaths(entries), rejected };
}

/** Render a request-body patch back into the `key=value` field. */
export function stringifyKeyValueField(
  value: Record<string, unknown> | undefined,
): string {
  return flattenToDotPaths(value)
    .map((entry) => `${entry.key}=${String(entry.value)}`)
    .join(", ");
}

/**
 * Parse a JSON object the user typed into a parameter field.
 *
 * Blank is not an error — it means "no parameters" — so the caller can tell an
 * empty field from a malformed one and report only the latter. The parsed
 * object is run through the same sanitizer as stored input, because
 * `JSON.parse` happily creates an own `__proto__` key that a later deep merge
 * would walk into.
 */
export function parseJsonObjectField(raw: string): {
  value?: Record<string, unknown>;
  error?: string;
} {
  const trimmed = (raw || "").trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(parsed)) {
    return { error: "expected a JSON object" };
  }
  const reserved = Object.keys(parsed).filter(isReservedRequestKey);
  if (reserved.length) {
    return {
      error: `${reserved.join(", ")} cannot be set here — the request builds these`,
    };
  }
  return { value: sanitizeBody(parsed) || {} };
}

/** Render a parameter object back into the editor's JSON field. */
export function stringifyJsonObjectField(
  value: Record<string, unknown> | undefined,
): string {
  if (!value || !Object.keys(value).length) return "";
  return JSON.stringify(value, null, 2);
}

/**
 * Drop empty sections so an override is never stored as `{}`.
 *
 * Absent and empty must stay distinguishable: an empty object would read as
 * "override every field to nothing", which is exactly what a user pressing
 * Reset does not mean.
 */
export function pruneProfileOverride(
  override: ModelProfileOverride | undefined,
): ModelProfileOverride | undefined {
  if (!override) return undefined;
  const pruned: ModelProfileOverride = {};
  if (override.limits && Object.keys(override.limits).length) {
    pruned.limits = { ...override.limits };
  }
  if (override.reasoning?.options?.length || override.reasoning?.kind) {
    pruned.reasoning = override.reasoning;
  }
  if (override.sampling && Object.keys(override.sampling).length) {
    pruned.sampling = override.sampling;
  }
  if (override.inputs && Object.keys(override.inputs).length) {
    pruned.inputs = { ...override.inputs };
  }
  if (override.features && Object.keys(override.features).length) {
    pruned.features = { ...override.features };
  }
  if (override.extraBody && Object.keys(override.extraBody).length) {
    pruned.extraBody = override.extraBody;
  }
  return Object.keys(pruned).length ? pruned : undefined;
}

function sanitizeBody(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const rows = flattenToDotPaths(value).filter(
    (row) => !row.key.split(".").some(isForbiddenPathSegment),
  );
  const expanded = expandDotPaths(rows);
  return Object.keys(expanded).length ? expanded : undefined;
}

function sanitizeNumber(value: unknown): number | undefined {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Validate a stored override. Unknown body keys are allowed (that is the
 * point); structurally impossible values are dropped so a corrupt pref can
 * never break request building.
 */
export function normalizeProfileOverride(
  value: unknown,
): ModelProfileOverride | undefined {
  if (!isPlainObject(value)) return undefined;
  if (JSON.stringify(value).length > MAX_PROFILE_OVERRIDE_BYTES) {
    return undefined;
  }
  const result: ModelProfileOverride = {};

  if (isPlainObject(value.limits)) {
    const limits: ModelCapabilityLimits = {};
    const context = sanitizeNumber(value.limits.contextWindowTokens);
    const input = sanitizeNumber(value.limits.inputTokens);
    const output = sanitizeNumber(value.limits.outputTokens);
    if (context !== undefined) limits.contextWindowTokens = context;
    if (input !== undefined) limits.inputTokens = input;
    if (output !== undefined) limits.outputTokens = output;
    if (Object.keys(limits).length) result.limits = limits;
  }

  if (
    isPlainObject(value.reasoning) &&
    Array.isArray(value.reasoning.options)
  ) {
    const options = value.reasoning.options
      .filter(isPlainObject)
      .map((option) => {
        const body = sanitizeBody(
          isPlainObject(option.controls) ? option.controls.body : undefined,
        );
        return {
          id: String(option.id || "").trim(),
          label: String(option.label || option.id || "").trim(),
          enabled: option.enabled !== false,
          ...(body ? { controls: { body } } : {}),
        };
      })
      .filter((option) => Boolean(option.id));
    if (options.length) {
      result.reasoning = {
        kind: "select",
        options,
        ...(typeof value.reasoning.defaultOptionId === "string"
          ? { defaultOptionId: value.reasoning.defaultOptionId }
          : {}),
      };
    } else if (value.reasoning.kind === "none") {
      result.reasoning = { kind: "none", options: [] };
    }
  }

  if (isPlainObject(value.sampling)) {
    const temperature = value.sampling.temperature;
    if (
      temperature === "configurable" ||
      temperature === "fixed" ||
      temperature === "unsupported"
    ) {
      result.sampling = { temperature };
    }
  }

  for (const section of ["inputs", "features"] as const) {
    const raw = value[section];
    if (!isPlainObject(raw)) continue;
    const flags: Record<string, boolean> = {};
    const allowed =
      section === "inputs"
        ? ["text", "image", "video", "pdf"]
        : ["tools", "streaming", "promptCache"];
    for (const key of allowed) {
      if (typeof raw[key] === "boolean") flags[key] = raw[key];
    }
    if (Object.keys(flags).length) {
      result[section] = flags as never;
    }
  }

  const extraBody = sanitizeBody(value.extraBody);
  if (extraBody) result.extraBody = extraBody;

  return pruneProfileOverride(result);
}
