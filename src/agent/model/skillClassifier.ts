/**
 * Skill intent classifier — runs ONCE per user turn.
 *
 * Architecture note: when the user sends a message, this module is called
 * exactly once (before the agent loop starts) to decide which skills apply.
 * The returned skill IDs flow into current-turn guidance, and that guidance is
 * reused across every model inference the agent performs to fulfil the request.
 * There is no per-model-call classifier cost.
 *
 * The classifier uses the user's configured primary model (via
 * `request.model` / `request.apiBase` / `request.apiKey`) and a small
 * structured prompt listing each skill's `id` + `description`. On any error
 * — network failure, malformed JSON, unconfigured model — it falls back to
 * the per-skill regex `match:` patterns so the agent still works.
 */
import {
  callUtilityLLM,
  logUtilityLLMFailure,
  type UtilityLLMFailureReason,
  type UtilityLLMParams,
} from "../../utils/utilityLLM";
import { resolveSkillRequestContext } from "../skills/contextEligibility";
import { matchesSkill } from "../skills/skillLoader";
import type { AgentSkill } from "../skills/skillLoader";
import type { AgentRuntimeRequest, ClassifiedTurnIntent } from "../types";
import {
  inferActionIntentsFromRequest,
  mergeActionIntents,
  parseActionIntents,
} from "./actionIntent";
export { inferActionIntentsFromRequest } from "./actionIntent";

/**
 * Pseudo-skill ID the classifier can return when none of the real skills
 * apply. Giving the LLM an explicit "no-match" label to commit to works
 * better than asking it to return an empty array — empty arrays read as
 * uncertainty and bias the LLM toward populating them with weak matches.
 * Translated back to `[]` by `parseClassifierResponse`.
 */
const UNMATCHED_ID = "unmatched";

// Generous enough for reasoning providers whose hidden thinking regularly
// exceeds 10s to completion; the runtime abort signal still cancels early.
export const TURN_INTENT_TIMEOUT_MS = 20_000;

export type DetectTurnIntentResult = {
  skillIds: string[];
  /** Null whenever classification degraded — callers keep regex behavior. */
  classifiedIntent: ClassifiedTurnIntent | null;
  /**
   * True when a usable model config was present but the LLM call failed or
   * returned malformed output — the silent-regression case worth surfacing.
   */
  degraded: boolean;
  /** Detailed reason for a degraded or skipped classifier attempt. */
  failureReason?: UtilityLLMFailureReason | "unparseable";
};

/**
 * Classify skills AND language-independent turn intent in one bounded LLM
 * call. Never throws — any failure falls back to regex skill matching with a
 * null intent, which downstream consumers treat as exactly today's behavior.
 */
export async function detectTurnIntent(
  request: AgentRuntimeRequest,
  skills: AgentSkill[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    llmCall?: UtilityLLMParams["llmCall"];
  } = {},
): Promise<DetectTurnIntentResult> {
  if (skills.length === 0) {
    return { skillIds: [], classifiedIntent: null, degraded: false };
  }
  const userText = (request.userText || "").trim();
  if (!userText) {
    return {
      skillIds: regexFallback(skills, request),
      classifiedIntent: null,
      degraded: false,
    };
  }
  if (!canUseSkillClassifierModel(request)) {
    return {
      skillIds: regexFallback(skills, request),
      classifiedIntent: null,
      degraded: false,
      failureReason: "not_configured",
    };
  }

  const prompt = buildClassifierPrompt(skills, request);

  const result = await callUtilityLLM({
    prompt,
    model: request.model,
    apiBase: request.apiBase,
    apiKey: request.apiKey,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
    jsonBudget: 300,
    temperature: 0,
    signal: options.signal,
    timeoutMs: options.timeoutMs || TURN_INTENT_TIMEOUT_MS,
    llmCall: options.llmCall,
  });
  if (!result.ok) {
    logUtilityLLMFailure(
      "Skill classifier LLM call failed, falling back to regex",
      result,
    );
    return {
      skillIds: regexFallback(skills, request),
      classifiedIntent: null,
      degraded: true,
      failureReason: result.reason,
    };
  }
  const raw = result.text;

  const parsedIntent = parseClassifiedTurnIntent(raw);
  const classifiedIntent = parsedIntent
    ? {
        ...parsedIntent,
        actionIntents: mergeActionIntents(
          parsedIntent.actionIntents,
          inferActionIntentsFromRequest(request),
        ),
      }
    : null;
  const parsed = parseClassifierResponse(raw, skills);
  if (parsed === null) {
    (
      globalThis as typeof globalThis & {
        Zotero?: { debug?: (message: string) => void };
      }
    ).Zotero?.debug?.(
      `[llm-for-zotero] Skill classifier returned malformed JSON, falling back to regex. Raw: ${raw.slice(0, 200)}`,
    );
    return {
      skillIds: regexFallback(skills, request),
      classifiedIntent,
      degraded: true,
      failureReason: "unparseable",
    };
  }
  return { skillIds: parsed, classifiedIntent, degraded: false };
}

/**
 * Classify which skills apply to the given request.
 *
 * Returns a list of skill IDs drawn from `skills`. Never throws — any
 * failure falls back to regex matching. Thin wrapper kept for consumers that
 * only need skill routing (e.g. the Codex native-skills path).
 */
export async function detectSkillIntent(
  request: AgentRuntimeRequest,
  skills: AgentSkill[],
  signal?: AbortSignal,
): Promise<string[]> {
  return (await detectTurnIntent(request, skills, { signal })).skillIds;
}

export function canUseSkillClassifierModel(
  request: Pick<AgentRuntimeRequest, "model" | "apiBase" | "authMode">,
): boolean {
  if (!request.model) return false;
  if (request.authMode === "codex_app_server") return false;
  if (request.apiBase) return true;
  return false;
}

function regexFallback(
  skills: AgentSkill[],
  request: Pick<AgentRuntimeRequest, "userText">,
): string[] {
  return skills
    .filter((skill) => matchesSkill(skill, request))
    .map((skill) => skill.id);
}

function buildClassifierPrompt(
  skills: AgentSkill[],
  request: AgentRuntimeRequest,
): string {
  const skillList = [
    `- ${UNMATCHED_ID}: Select this when the user's task is a direct Zotero operation (running a script, editing metadata, tagging, moving items) or otherwise does not clearly require any skill's specific playbook. Prefer this over a speculative match.`,
    ...skills.map(
      (skill) =>
        `- ${skill.id}: ${skill.description || "(no description)"} [contexts: ${(skill.contexts || ["any"]).join(",")}]`,
    ),
  ].join("\n");

  const context: string[] = [];
  const resolvedContext = resolveSkillRequestContext(request);
  context.push(
    `- Unique papers in context: ${resolvedContext.uniquePaperCount}`,
  );
  if (resolvedContext.hasLibraryCorpus)
    context.push("- Library/corpus context: yes");
  if (request.activeNoteContext) context.push("- Active note present: yes");
  if (request.selectedTexts?.length)
    context.push(`- Selected text snippets: ${request.selectedTexts.length}`);
  if (request.screenshots?.length)
    context.push(`- Screenshots attached: ${request.screenshots.length}`);
  if (request.fullTextPaperContexts?.length)
    context.push(
      `- Full-text papers marked: ${request.fullTextPaperContexts.length}`,
    );
  if (request.selectedCollectionContexts?.length) {
    context.push(
      `- Selected collection scopes: ${request.selectedCollectionContexts.length}`,
    );
  }
  if (request.selectedTagContexts?.length) {
    context.push(
      `- Selected tag scopes: ${request.selectedTagContexts.length}`,
    );
  }

  return [
    "You are a skill router for a Zotero research-assistant agent. Return a JSON array of skill IDs drawn from the list below.",
    "",
    `• Use ["${UNMATCHED_ID}"] when the user's task is a direct Zotero operation or does not clearly require any skill's playbook. This is the correct answer for most turns.`,
    "• Only include a specific skill ID when the user's message unambiguously aligns with that skill's primary purpose. Do not include a skill just because its description shares a word with the user's message.",
    '• When the user\'s message genuinely combines multiple distinct subtasks (e.g. "read this paper, analyze figure 1, and write a note"), return every skill ID that maps to a distinct subtask. Do NOT pad the list with tangentially related skills.',
    '• The user\'s message may be in any language (Chinese, Japanese, Korean, Spanish, French, German, Russian, Arabic, …). Match intent language-independently: a note request like "为这篇论文写阅读笔记" maps to the note-writing skill exactly as its English equivalent would.',
    '• retrievalIntent: how the question should read the library, in any language — "enumerate" for which/all/list/find-evidence questions, "verify" for exact presence/absence checks, "summarize" for themes/commonalities/comparisons/overviews across papers, "none" for pure operations (tagging, moving, editing) or single-paper reads.',
    '• externalSearchIntent: whether the answer needs live external evidence, in any language — "web" for general public web information, "literature" for scholarly discovery or external scholarly metadata, "both" when distinct parts need each source, and "none" when the available context or stable knowledge is sufficient. The tools are complementary, not mutually exclusive.',
    "• wantedSections: only the sections the user explicitly asks about (methods, results, limitations); otherwise an empty array.",
    '• queryLanguage: short language code of the user message, e.g. "en", "zh", "ja".',
    "• actionIntents: concrete actions the user requires, not suggestions. Each action has capability, coverage, targetKind, optional exact collection scope, scopeRole (source or destination), and optional constraints such as tagPrefix or collectionMode:'move'. Represent a move between named collections with separate source and destination intents. Use [] for a read-only question.",
    "• Exact collection scope means direct members only. Set includeDescendants:true only when the user explicitly asks for subcollections or descendants.",
    "",
    "Available skills:",
    skillList,
    "",
    "Runtime context:",
    ...context,
    "",
    "User message:",
    `"""`,
    request.userText,
    `"""`,
    "",
    'Reply with ONLY a JSON object in this exact shape, no prose, no code fences: {"skillIds": ["id1", "id2"], "retrievalIntent": "enumerate|verify|summarize|none", "externalSearchIntent": "none|web|literature|both", "wantedSections": [], "queryLanguage": "en", "actionIntents": [{"capability":"zotero.tags","coverage":"all","targetKind":"papers","scopeRole":"source","scope":{"kind":"collection","path":"Parent/Leaf","includeDescendants":false},"constraints":{"tagPrefix":"topic:"}}]}',
  ].join("\n");
}

const VALID_RETRIEVAL_INTENTS = new Set([
  "enumerate",
  "verify",
  "summarize",
  "none",
]);
const VALID_EXTERNAL_SEARCH_INTENTS = new Set([
  "none",
  "web",
  "literature",
  "both",
]);
const VALID_WANTED_SECTIONS = new Set(["methods", "results", "limitations"]);

/**
 * Parse the language-independent intent fields out of the classifier reply.
 * Strict on the enum: anything unexpected returns null so downstream
 * consumers keep exactly the pre-classifier behavior. Unknown wantedSections
 * entries are dropped (they are additive hints, not a contract).
 */
export function parseClassifiedTurnIntent(
  raw: string,
): ClassifiedTurnIntent | null {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as {
    retrievalIntent?: unknown;
    externalSearchIntent?: unknown;
    wantedSections?: unknown;
    queryLanguage?: unknown;
    actionIntents?: unknown;
  };
  const retrievalIntent =
    typeof record.retrievalIntent === "string"
      ? record.retrievalIntent.trim()
      : "";
  if (!VALID_RETRIEVAL_INTENTS.has(retrievalIntent)) return null;
  const externalSearchIntent =
    typeof record.externalSearchIntent === "string" &&
    VALID_EXTERNAL_SEARCH_INTENTS.has(record.externalSearchIntent.trim())
      ? (record.externalSearchIntent.trim() as NonNullable<
          ClassifiedTurnIntent["externalSearchIntent"]
        >)
      : undefined;
  const wantedSections = Array.isArray(record.wantedSections)
    ? record.wantedSections
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value): value is "methods" | "results" | "limitations" =>
          VALID_WANTED_SECTIONS.has(value),
        )
    : [];
  const queryLanguage =
    typeof record.queryLanguage === "string" && record.queryLanguage.trim()
      ? record.queryLanguage.trim().toLowerCase().slice(0, 12)
      : undefined;
  return {
    retrievalIntent: retrievalIntent as ClassifiedTurnIntent["retrievalIntent"],
    ...(externalSearchIntent ? { externalSearchIntent } : {}),
    wantedSections,
    queryLanguage,
    actionIntents: parseActionIntents(record.actionIntents),
  };
}

/**
 * Parse the classifier's response into a list of valid skill IDs.
 * Returns null if the response cannot be interpreted (caller falls back to
 * regex). An empty array return is a positive "no skill applies" answer —
 * the caller should NOT fall back in that case.
 */
export function parseClassifierResponse(
  raw: string,
  skills: AgentSkill[],
): string[] | null {
  if (!raw) return null;
  // Tolerate code fences or surrounding prose — extract the first {…} blob.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const ids = (parsed as { skillIds?: unknown }).skillIds;
  if (!Array.isArray(ids)) return null;

  const validIds = new Set(skills.map((s) => s.id));
  const rawStrings = ids
    .filter((value): value is string => typeof value === "string")
    .map((s) => s.trim());
  const hasUnmatched = rawStrings.includes(UNMATCHED_ID);
  const realIds = rawStrings.filter(
    (id) => id !== UNMATCHED_ID && validIds.has(id),
  );

  // Hedge case: model returned both "unmatched" and real skill IDs. Trust
  // the real picks — the model found something worth loading. Drop
  // "unmatched".
  if (realIds.length > 0) return realIds;
  // Explicit no-match: model chose only "unmatched", or returned an empty
  // array. Both are valid "no skills apply" responses.
  if (hasUnmatched || rawStrings.length === 0) return [];
  // Fallthrough: only invalid skill IDs (hallucinated names). Treat as
  // unmatched so we don't load anything bogus.
  return [];
}
