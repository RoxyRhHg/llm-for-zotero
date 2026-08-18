import type { LibraryMutationOperation } from "./libraryMutationService";
import { LibraryMutationService } from "./libraryMutationService";
import type { ZoteroGateway } from "./zoteroGateway";
import type { AgentToolContext } from "../types";
import {
  listRunChangeJournal,
  markChangeReverted,
  type ChangeJournalEntry,
} from "../store/changeJournal";

/**
 * Replays journalled inverses.
 *
 * Inverses are stored as serialized mutation operations rather than as
 * closures, which is the whole point: a closure dies with the process, and
 * the old undo stack was ten of them in RAM. A serialized operation survives
 * a restart and can be replayed by the same service that made the original
 * change, so revert takes exactly the same path — and the same refusals — as
 * a forward write.
 *
 * Order matters: entries are reverted newest-first, because a later change
 * may depend on an earlier one (filing an item into a collection that an
 * earlier entry created).
 */
export type RevertOutcome = {
  reverted: number;
  skipped: Array<{ entryId: string; reason: string }>;
};

export async function revertRun(params: {
  runId: string;
  zoteroGateway: ZoteroGateway;
  context: AgentToolContext;
  now?: () => number;
}): Promise<RevertOutcome> {
  const now = params.now ?? (() => Date.now());
  const entries = await listRunChangeJournal(params.runId);
  return revertEntries({ ...params, entries, now });
}

export async function revertEntries(params: {
  entries: ChangeJournalEntry[];
  zoteroGateway: ZoteroGateway;
  context: AgentToolContext;
  now?: () => number;
}): Promise<RevertOutcome> {
  const now = params.now ?? (() => Date.now());
  const service = new LibraryMutationService(params.zoteroGateway);
  const skipped: Array<{ entryId: string; reason: string }> = [];
  let reverted = 0;

  // Newest first: a later change can depend on an earlier one.
  const ordered = [...params.entries].sort((a, b) => b.createdAt - a.createdAt);

  for (const entry of ordered) {
    if (entry.status === "reverted") {
      continue;
    }
    if (entry.status === "irreversible" || !entry.inverseJson) {
      skipped.push({
        entryId: entry.entryId,
        reason:
          entry.irreversibleReason ||
          "No inverse was recorded for this change",
      });
      continue;
    }
    // An inverse is stored as an ARRAY of operations: undoing one change can
    // take several (recreating a collection and refilling it, say). Parsing
    // it as a single operation made `executeOperation` fall through its
    // switch and report success having done nothing.
    let operations: LibraryMutationOperation[];
    try {
      const parsed = JSON.parse(entry.inverseJson);
      operations = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      skipped.push({
        entryId: entry.entryId,
        reason: "The recorded inverse could not be read",
      });
      continue;
    }
    if (!operations.length || !operations.every(isMutationOperation)) {
      skipped.push({
        entryId: entry.entryId,
        reason: "The recorded inverse was not a usable operation",
      });
      continue;
    }
    try {
      for (const operation of operations) {
        await service.executeOperation(operation, params.context);
      }
      await markChangeReverted(entry.entryId, now());
      reverted += 1;
    } catch (error) {
      // Keep going. One entry that cannot be put back should not strand the
      // rest of the run in a half-reverted state with no report.
      skipped.push({
        entryId: entry.entryId,
        reason: error instanceof Error ? error.message : "Revert failed",
      });
    }
  }

  return { reverted, skipped };
}

/**
 * A parsed inverse must actually look like an operation. Without this an
 * unrecognised shape reached `executeOperation`, fell through its switch, and
 * was counted as a successful revert.
 */
function isMutationOperation(value: unknown): value is LibraryMutationOperation {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}
