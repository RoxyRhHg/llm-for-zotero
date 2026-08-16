/**
 * Ask the answer where a quote came from, instead of searching for it.
 *
 * When an agent answers a library question it reads passages from papers and
 * is shown each one together with the item and attachment it came from.  That
 * pairing is persisted verbatim in the run's tool results, so the source of a
 * displayed quote is already recorded — there is no need to re-derive it at
 * click time from a citation label the model may have written incorrectly.
 *
 * This resolves a quote against those recorded passages.  It is exact, costs
 * no PDF read and no library search, and works on conversations recorded long
 * before the click is made.
 */

import { listAgentRunEvents } from "../../agent/store/traceStore";
import { MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE } from "./quoteCitations";
import { summarizeQuoteTextSupport } from "./quoteTextSearch";
import { sanitizeText } from "./textUtils";

export type QuoteEvidenceProvenance = {
  itemId: number;
  contextItemId: number;
  /** Fraction of the quote the recorded passages account for, 0..1. */
  coverage: number;
};

type EvidencePassage = {
  itemId: number;
  contextItemId: number;
  text: string;
};

/** Depth bound for walking an arbitrary tool result. */
const MAX_TOOL_CONTENT_DEPTH = 8;

/**
 * Passages beyond this are ignored.  A single retrieval returns at most a few
 * hundred; this only guards against a pathological run.
 */
const MAX_EVIDENCE_PASSAGES = 1000;

const runEvidenceCache = new Map<string, EvidencePassage[]>();

function normalizePositiveInt(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Every recorded rendering of a passage, not just the first: a tool often
 * stores both a trimmed excerpt and the surrounding text it was cut from, and
 * a quote can straddle the trim point.  They are pooled per paper anyway, so
 * keeping all of them can only improve what the paper is credited with.
 */
function readPassageTexts(record: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of ["snippet", "text", "surroundingText"]) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(value);
  }
  return out;
}

/**
 * Collect every recorded passage that names both the paper and the attachment
 * it came from.  The shape differs per tool — `library_retrieve` exposes them
 * on `snippets`, `paper_read` on `results` — so this walks the payload rather
 * than a list of key names that goes stale as tools gain result shapes.
 */
function collectEvidencePassages(content: unknown): EvidencePassage[] {
  const out: EvidencePassage[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number) => {
    if (depth > MAX_TOOL_CONTENT_DEPTH || !value || typeof value !== "object") {
      return;
    }
    if (out.length >= MAX_EVIDENCE_PASSAGES) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const itemId = normalizePositiveInt(record.itemId);
    const contextItemId = normalizePositiveInt(record.contextItemId);
    if (itemId && contextItemId) {
      for (const text of readPassageTexts(record)) {
        out.push({ itemId, contextItemId, text });
      }
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(content, 0);
  return out;
}

async function loadRunEvidencePassages(
  agentRunId: string,
): Promise<EvidencePassage[]> {
  const cached = runEvidenceCache.get(agentRunId);
  if (cached) return cached;
  let passages: EvidencePassage[] = [];
  try {
    const events = await listAgentRunEvents(agentRunId);
    for (const event of events) {
      if (event.eventType !== "tool_result") continue;
      const record = event.payload as Record<string, unknown> | null;
      // A failed tool call proves nothing about where a quote came from.
      if (!record || record.ok === false) continue;
      passages.push(...collectEvidencePassages(record.content));
      passages.push(...collectEvidencePassages(record.artifacts));
      if (passages.length >= MAX_EVIDENCE_PASSAGES) {
        passages = passages.slice(0, MAX_EVIDENCE_PASSAGES);
        break;
      }
    }
  } catch (error) {
    // A missing or unreadable trace is normal for old or pruned runs; the
    // caller falls back to searching for the paper.
    ztoolkit.log("LLM quote provenance: could not read agent run trace", error);
    passages = [];
  }
  runEvidenceCache.set(agentRunId, passages);
  return passages;
}

export function clearQuoteEvidenceProvenanceCacheForTests(): void {
  runEvidenceCache.clear();
}

/**
 * Resolve a displayed quote to the paper the agent actually read it from.
 *
 * Passages are pooled per paper before judging, so a quote stitched from two
 * passages of one paper is recognised as fully accounted for by that paper.
 * The threshold is the one the answer-time quote gate already uses, so a quote
 * and its source are judged the same way wherever the question is asked.
 */
export async function resolveQuoteEvidenceProvenance(params: {
  agentRunId: string | undefined | null;
  quoteText: string;
}): Promise<QuoteEvidenceProvenance | null> {
  const agentRunId = sanitizeText(params.agentRunId || "").trim();
  const quoteText = sanitizeText(params.quoteText || "").trim();
  if (!agentRunId || !quoteText) return null;

  const passages = await loadRunEvidencePassages(agentRunId);
  if (!passages.length) return null;

  const byPaper = new Map<string, EvidencePassage[]>();
  for (const passage of passages) {
    const key = `${passage.itemId}:${passage.contextItemId}`;
    const group = byPaper.get(key);
    if (group) group.push(passage);
    else byPaper.set(key, [passage]);
  }

  let best: QuoteEvidenceProvenance | null = null;
  for (const group of byPaper.values()) {
    const support = summarizeQuoteTextSupport(
      group.map((passage, index) => ({
        id: `passage-${index}`,
        text: passage.text,
      })),
      quoteText,
    );
    if (support.coverage < MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE) continue;
    if (best && best.coverage >= support.coverage) continue;
    best = {
      itemId: group[0].itemId,
      contextItemId: group[0].contextItemId,
      coverage: support.coverage,
    };
  }
  return best;
}
