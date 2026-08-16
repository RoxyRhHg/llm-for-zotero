/**
 * Verify-before-navigate resolution for cited quotes.
 *
 * A citation label written by the model is a hint, not a key: it can name the
 * wrong author or year.  The quote text itself is the key — a verbatim span is
 * self-identifying even across a whole library.  So navigation never trusts a
 * candidate because it *looks* right; it reads the candidate's PDF text and
 * only jumps once the quote is actually found there.
 *
 * Because verification is the safety net, the search space can be wide: papers
 * carried by the conversation first, then papers found by searching the
 * library for the citation label.  Reading PDF text is the expensive part, so
 * candidates are checked in priority order under a fixed budget.
 */

export type QuoteTargetVerificationStatus =
  | "resolved"
  | "ambiguous"
  | "not-found"
  | "unavailable";

export type QuoteTargetVerification = {
  status: QuoteTargetVerificationStatus;
  /** Zero-based page the quote was found on. */
  pageIndex?: number | null;
  sourceMatchText?: string;
  sourceMatchPageOccurrence?: number;
  reason?: string;
};

export type QuoteTargetCandidate = {
  contextItemId: number;
  /**
   * True for papers the conversation itself carries (message contexts, quote
   * bindings, the open reader).  These are checked before papers that a
   * library search merely proposed.
   */
  authoritative: boolean;
  /** Higher means the citation label agrees more strongly with this paper. */
  labelRank: number;
};

export type QuoteTargetResolution =
  | {
      status: "resolved";
      contextItemId: number;
      pageIndex: number;
      quoteText: string;
      sourceMatchText?: string;
      sourceMatchPageOccurrence?: number;
      authoritative: boolean;
    }
  | { status: "ambiguous"; contextItemIds: number[] }
  | { status: "unverifiable"; contextItemIds: number[]; reason: string }
  | { status: "not-found"; reason: string };

/**
 * Upper bound on how many PDFs a single click may read.  Library chat can put
 * dozens of papers in range; reading them all would stall the panel.
 */
export const DEFAULT_QUOTE_TARGET_VERIFICATION_BUDGET = 12;

const DEFAULT_NOT_FOUND_REASON =
  "The cited quote was not found in any matching paper.";

type VerifiedMatch = {
  candidate: QuoteTargetCandidate;
  pageIndex: number;
  quoteText: string;
  sourceMatchText?: string;
  sourceMatchPageOccurrence?: number;
};

function normalizeContextItemId(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeLabelRank(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePageIndex(value: unknown): number | null {
  // Number(null) and Number("") are 0, which would silently become page 1.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Collapse repeated attachments and order the survivors so the cheapest, most
 * likely wins come first: conversation papers before library guesses, and
 * within each group the strongest label agreement first.  Order is otherwise
 * stable so a click is deterministic.
 */
function prioritizeCandidates(
  candidates: readonly QuoteTargetCandidate[],
): QuoteTargetCandidate[] {
  const byContextItemId = new Map<number, QuoteTargetCandidate>();
  for (const candidate of candidates || []) {
    const contextItemId = normalizeContextItemId(candidate?.contextItemId);
    if (!contextItemId) continue;
    const normalized: QuoteTargetCandidate = {
      contextItemId,
      authoritative: Boolean(candidate.authoritative),
      labelRank: normalizeLabelRank(candidate.labelRank),
    };
    const existing = byContextItemId.get(contextItemId);
    if (!existing) {
      byContextItemId.set(contextItemId, normalized);
      continue;
    }
    // The same attachment can arrive from several sources; keep its strongest
    // standing so one weak duplicate cannot demote it out of the budget.
    byContextItemId.set(contextItemId, {
      contextItemId,
      authoritative: existing.authoritative || normalized.authoritative,
      labelRank: Math.max(existing.labelRank, normalized.labelRank),
    });
  }
  return Array.from(byContextItemId.values())
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const authoritativeDelta =
        Number(right.candidate.authoritative) -
        Number(left.candidate.authoritative);
      if (authoritativeDelta !== 0) return authoritativeDelta;
      const labelDelta = right.candidate.labelRank - left.candidate.labelRank;
      if (labelDelta !== 0) return labelDelta;
      return left.index - right.index;
    })
    .map((entry) => entry.candidate);
}

function normalizeSearchTexts(searchTexts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const searchText of searchTexts || []) {
    const text = typeof searchText === "string" ? searchText.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Pick a winner among papers that all contain the quote.  Near-duplicates
 * (preprint plus published version) are common in a library, so a clear label
 * winner is preferred over refusing to move.  Only a genuine tie is ambiguous.
 */
function selectBestMatch(matches: VerifiedMatch[]): VerifiedMatch | null {
  if (matches.length <= 1) return matches[0] || null;
  const bestRank = Math.max(
    ...matches.map((match) => match.candidate.labelRank),
  );
  const leaders = matches.filter(
    (match) => match.candidate.labelRank === bestRank,
  );
  return leaders.length === 1 ? leaders[0] : null;
}

export async function resolveVerifiedQuoteTarget(params: {
  candidates: readonly QuoteTargetCandidate[];
  searchTexts: readonly string[];
  verify: (
    contextItemId: number,
    quoteText: string,
  ) => Promise<QuoteTargetVerification>;
  verificationBudget?: number;
}): Promise<QuoteTargetResolution> {
  const searchTexts = normalizeSearchTexts(params.searchTexts);
  if (!searchTexts.length) {
    return { status: "not-found", reason: "No quote text was available." };
  }

  const budgetInput = Number(params.verificationBudget);
  const budget =
    Number.isFinite(budgetInput) && budgetInput > 0
      ? Math.floor(budgetInput)
      : DEFAULT_QUOTE_TARGET_VERIFICATION_BUDGET;

  const candidates = prioritizeCandidates(params.candidates);
  const unverifiableContextItemIds: number[] = [];
  let unverifiableReason = "";
  let lastReason = "";
  let spent = 0;

  // Conversation papers are settled before library guesses are read at all, so
  // a paper the answer actually used always wins over a same-label lookalike.
  for (const tier of [true, false]) {
    const tierCandidates = candidates.filter(
      (candidate) => candidate.authoritative === tier,
    );
    const matches: VerifiedMatch[] = [];
    for (const candidate of tierCandidates) {
      if (spent >= budget) break;
      spent += 1;
      for (const quoteText of searchTexts) {
        let verification: QuoteTargetVerification;
        try {
          verification = await params.verify(
            candidate.contextItemId,
            quoteText,
          );
        } catch (_err) {
          void _err;
          verification = {
            status: "unavailable",
            reason: "Could not read this PDF's text.",
          };
        }
        if (verification?.reason) lastReason = verification.reason;
        if (verification?.status === "unavailable") {
          if (!unverifiableContextItemIds.includes(candidate.contextItemId)) {
            unverifiableContextItemIds.push(candidate.contextItemId);
          }
          if (!unverifiableReason && verification.reason) {
            unverifiableReason = verification.reason;
          }
          break;
        }
        if (verification?.status !== "resolved") continue;
        const pageIndex = normalizePageIndex(verification.pageIndex);
        if (pageIndex === null) continue;
        matches.push({
          candidate,
          pageIndex,
          quoteText,
          sourceMatchText: verification.sourceMatchText,
          sourceMatchPageOccurrence: verification.sourceMatchPageOccurrence,
        });
        break;
      }
      // Two hits are enough to know the label has to arbitrate; reading more
      // PDFs cannot change that verdict.
      if (matches.length > 1) break;
    }

    const best = selectBestMatch(matches);
    if (best) {
      return {
        status: "resolved",
        contextItemId: best.candidate.contextItemId,
        pageIndex: best.pageIndex,
        quoteText: best.quoteText,
        sourceMatchText: best.sourceMatchText,
        sourceMatchPageOccurrence: best.sourceMatchPageOccurrence,
        authoritative: best.candidate.authoritative,
      };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        contextItemIds: matches.map((match) => match.candidate.contextItemId),
      };
    }
  }

  if (unverifiableContextItemIds.length) {
    return {
      status: "unverifiable",
      contextItemIds: unverifiableContextItemIds,
      reason:
        unverifiableReason || "Could not read the cited paper's PDF text.",
    };
  }
  return {
    status: "not-found",
    reason: lastReason || DEFAULT_NOT_FOUND_REASON,
  };
}
