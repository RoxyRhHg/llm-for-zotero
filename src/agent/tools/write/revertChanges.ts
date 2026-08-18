import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { revertEntries } from "../../services/changeReverter";
import {
  listChangeJournal,
  type ChangeJournalEntry,
} from "../../store/changeJournal";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";

type RevertChangesInput = {
  count: number;
  dryRun: boolean;
};

/**
 * Reverts the agent's recent library changes from the durable journal.
 *
 * This is not the old `undo_last_action`. That popped one entry off a
 * ten-deep stack of closures held in RAM, wiped by a restart, which five of
 * fifteen operations never pushed to at all. This reads the journal, so it
 * survives a restart, has no depth ceiling, and can report the changes it
 * *cannot* undo instead of silently doing nothing.
 *
 * Deliberately agent-callable as well as user-facing: after a partial
 * failure the agent needs to be able to put the library back rather than
 * leaving it half-changed and reporting a mess.
 */
export function createRevertChangesTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<RevertChangesInput, unknown> {
  return {
    spec: {
      name: "revert_changes",
      description:
        "Undo recent library changes recorded in the agent's change history. Use dryRun first to show the user what would be undone. Survives restarts, unlike undo_last_action.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: {
            type: "number",
            description:
              "How many of the most recent recorded changes to undo. Default 1.",
          },
          dryRun: {
            type: "boolean",
            description:
              "List what would be undone without changing anything. Prefer this before reverting more than one change.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Revert Changes",
      summaries: {
        onCall: "Preparing to undo recent library changes",
        onPending: "Waiting for confirmation to undo changes",
        onApproved: "Undoing changes",
        onDenied: "Undo cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (record.dryRun) return "Listed the changes that can be undone";
          const reverted = record.reverted;
          return typeof reverted === "number"
            ? `Undid ${reverted} change${reverted === 1 ? "" : "s"}`
            : "Undo finished";
        },
      },
    },

    validate(args) {
      if (args !== undefined && !validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object, for example { count: 1 }");
      }
      const record = (args || {}) as Record<string, unknown>;
      return ok({
        count: normalizePositiveInt(record.count) ?? 1,
        dryRun: record.dryRun === true,
      });
    },

    /**
     * A dry run changes nothing, so it needs no card; and there is nothing to
     * confirm when the journal has no pending entries.
     */
    async shouldRequireConfirmation(input, context) {
      if (input.dryRun) return false;
      const entries = await listChangeJournal({
        conversationKey: context.request.conversationKey,
        limit: input.count,
        pendingOnly: true,
      });
      return entries.length > 0;
    },

    async createPendingAction(input, context) {
      // pendingOnly at the SQL level: filtering after LIMIT would spend the
      // budget on rows a previous undo already reverted.
      const pending = await listChangeJournal({
        conversationKey: context.request.conversationKey,
        limit: input.count,
        pendingOnly: true,
      });
      return {
        toolName: "revert_changes",
        title: `Undo ${pending.length} change${pending.length === 1 ? "" : "s"}`,
        description: describeEntries(pending),
        confirmLabel: "Undo",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "summary",
            label: "Changes to undo",
            value: describeEntries(pending),
          },
        ],
      };
    },

    applyConfirmation(input) {
      return ok(input);
    },

    async execute(input, context) {
      const pending = await listChangeJournal({
        conversationKey: context.request.conversationKey,
        limit: input.count,
        pendingOnly: true,
      });

      if (input.dryRun) {
        return {
          dryRun: true,
          changes: pending.map((entry) => ({
            description: entry.description,
            operation: entry.operation,
            itemCount: entry.itemCount,
            reversible: entry.status === "reversible",
            reason: entry.irreversibleReason,
          })),
        };
      }

      if (!pending.length) {
        return {
          reverted: 0,
          skipped: [],
          message: "There are no recorded changes left to undo.",
        };
      }

      const outcome = await revertEntries({
        entries: pending,
        zoteroGateway,
        context,
      });
      return {
        reverted: outcome.reverted,
        // Named explicitly so the agent reports what it could NOT put back
        // rather than implying a clean rollback.
        skipped: outcome.skipped,
      };
    },
  };
}

function describeEntries(entries: ChangeJournalEntry[]): string {
  return entries
    .map((entry) => {
      const suffix =
        entry.status === "irreversible"
          ? ` — cannot be undone: ${entry.irreversibleReason || "no inverse recorded"}`
          : "";
      return `• ${entry.description}${suffix}`;
    })
    .join("\n");
}
