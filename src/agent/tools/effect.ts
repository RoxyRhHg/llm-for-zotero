import type { AgentToolEffect } from "../types";

/**
 * Derives what a write actually did from the per-row ledger the gateway
 * already produces.
 *
 * The gateway has always returned `{status, reason}` per item — `"moved"`,
 * `"skipped"`, `"missing"` — and the registry discarded it, stamping every
 * non-throwing execution as a success with a constant label. That is why a
 * move of zero items read identically to a move of fifty (issue #374).
 *
 * This is deliberately a derivation over known shapes rather than a new field
 * threaded through every tool: the shapes already exist and are stable, and a
 * tool that reports nothing recognisable simply gets `undefined`, which reads
 * as "no granular outcome" rather than a false claim either way.
 */

/** Row statuses that mean the object was changed. */
const APPLIED_STATUSES = new Set([
  "moved",
  "added",
  "removed",
  "trashed",
  "restored",
  "updated",
  "tagged",
  "imported",
  "created",
  "merged",
  "deleted",
  "renamed",
  "relinked",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The mutation service wraps results as `{operation, operationId, result}`,
 * and some cases nest a second `result`. Each level is evaluated in turn and
 * the first that carries a recognisable signal wins — descending blindly to
 * the innermost object would step past a status reported one level up.
 */
function candidateLevels(content: unknown): Array<Record<string, unknown>> {
  const levels: Array<Record<string, unknown>> = [];
  let record = asRecord(content);
  for (let depth = 0; depth < 3 && record; depth += 1) {
    levels.push(record);
    record = asRecord(record.result);
  }
  return levels;
}

function readCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fromCounts(record: Record<string, unknown>): AgentToolEffect | null {
  // Pairs of (changed, attempted). Order matters: the first pair whose
  // "changed" side is present wins.
  const pairs: Array<[string, string | null]> = [
    ["movedCount", "selectedCount"],
    ["trashedCount", null],
    ["updatedCount", null],
    ["removedCount", null],
    ["restoredCount", null],
    ["succeeded", "failed"],
  ];
  for (const [changedKey, otherKey] of pairs) {
    const changed = readCount(record, changedKey);
    if (changed === null) continue;
    if (changed === 0) return "none";
    if (otherKey) {
      const other = readCount(record, otherKey);
      if (other !== null) {
        // selectedCount is a total; succeeded/failed are disjoint.
        const attempted = otherKey === "failed" ? changed + other : other;
        return changed < attempted ? "partial" : "applied";
      }
    }
    return "applied";
  }
  return null;
}

export function deriveToolEffect(content: unknown): AgentToolEffect | undefined {
  for (const record of candidateLevels(content)) {
    const items = record.items;
    if (Array.isArray(items) && items.length) {
      let applied = 0;
      let recognised = 0;
      for (const entry of items) {
        const row = asRecord(entry);
        const status = row?.status;
        if (typeof status !== "string") continue;
        recognised += 1;
        if (APPLIED_STATUSES.has(status)) applied += 1;
      }
      if (recognised > 0) {
        if (applied === 0) return "none";
        return applied < recognised ? "partial" : "applied";
      }
    }

    const byCounts = fromCounts(record);
    if (byCounts) return byCounts;

    // Single-object operations report a bare status ("created", "deleted").
    const status = record.status;
    if (typeof status === "string") {
      if (APPLIED_STATUSES.has(status)) return "applied";
      if (status === "standalone_created" || status === "appended") {
        return "applied";
      }
    }
  }
  return undefined;
}

/**
 * Builds a trace summary that reports what actually happened.
 *
 * The labels this replaces were constant strings — "Library updated",
 * "Collection updated" — printed identically whether fifty items moved or
 * none did. When rows were skipped, their `reason` is the most useful thing
 * on screen, so the first distinct reason is surfaced.
 */
export function summarizeMutationOutcome(
  content: unknown,
  verbs: { applied: string; noun: string },
): string {
  const effect = deriveToolEffect(content);
  const counts = collectRowCounts(content);

  if (effect === "none") {
    const reason = counts.firstReason;
    return reason
      ? `No ${verbs.noun} changed — ${reason}`
      : `No ${verbs.noun} changed`;
  }
  if (effect === "partial" && counts.applied !== null && counts.total !== null) {
    const reason = counts.firstReason;
    return `${verbs.applied} ${counts.applied} of ${counts.total} ${verbs.noun}${
      reason ? ` — ${counts.total - counts.applied} skipped: ${reason}` : ""
    }`;
  }
  if (effect === "applied" && counts.applied !== null) {
    return `${verbs.applied} ${counts.applied} ${verbs.noun}`;
  }
  if (effect === "applied") {
    return `${verbs.applied} ${verbs.noun}`;
  }
  return "";
}

function collectRowCounts(content: unknown): {
  applied: number | null;
  total: number | null;
  firstReason: string | null;
} {
  for (const record of candidateLevels(content)) {
    const items = record.items;
    if (!Array.isArray(items) || !items.length) continue;
    let applied = 0;
    let total = 0;
    let firstReason: string | null = null;
    for (const entry of items) {
      const row = asRecord(entry);
      const status = row?.status;
      if (typeof status !== "string") continue;
      total += 1;
      if (APPLIED_STATUSES.has(status)) {
        applied += 1;
      } else if (!firstReason && typeof row?.reason === "string" && row.reason) {
        firstReason = row.reason;
      }
    }
    if (total > 0) return { applied, total, firstReason };
  }
  return { applied: null, total: null, firstReason: null };
}
