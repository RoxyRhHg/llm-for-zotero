import type { AgentWriteToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  analyzeJournalActions,
  revertActions,
} from "../../services/changeReverter";
import {
  listJournalActions,
  type JournalActionWithSteps,
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
): AgentWriteToolDefinition<RevertChangesInput, unknown> {
  return {
    spec: {
      name: "revert_changes",
      description:
        "Undo recent durable actions recorded in the agent's change history. Use dryRun first to analyze conflicts. Each action's steps are reverted newest-first.",
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
          const reverted = Number(record.reverted) || 0;
          const partiallyReverted = Number(record.partiallyReverted) || 0;
          if (partiallyReverted) {
            return reverted
              ? `Undid ${reverted} change${reverted === 1 ? "" : "s"} fully and ${partiallyReverted} partially`
              : `Partially undid ${partiallyReverted} change${partiallyReverted === 1 ? "" : "s"}; some effects may remain`;
          }
          return `Undid ${reverted} change${reverted === 1 ? "" : "s"}`;
        },
      },
    },

    validate(args) {
      if (
        args !== undefined &&
        !validateObject<Record<string, unknown>>(args)
      ) {
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
      const entries = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: input.count,
        pendingOnly: true,
      });
      return entries.length > 0;
    },

    async planMutation(input, context) {
      if (input.dryRun) {
        return { effect: "none", reversibility: "full" };
      }
      const actions = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: input.count,
        pendingOnly: true,
      });
      return actions.length
        ? {
            effect: "write",
            reversibility: "none",
            reason:
              "Reverting history does not create redo entries, so the revert itself cannot be automatically undone.",
            requiresConfirmation: true,
          }
        : { effect: "none", reversibility: "full" };
    },

    async createPendingAction(input, context) {
      // pendingOnly at the SQL level: filtering after LIMIT would spend the
      // budget on rows a previous undo already reverted.
      const pending = await listJournalActions({
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
      const pending = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: input.count,
        pendingOnly: true,
      });

      if (input.dryRun) {
        const conflicts = await analyzeJournalActions({
          actions: pending,
          zoteroGateway,
          context,
        });
        return {
          content: {
            dryRun: true,
            changes: pending.map((action) => ({
              actionId: action.actionId,
              description: action.description,
              toolName: action.toolName,
              stepCount: action.steps.length,
              itemCount: action.affectedCount,
              reversibility: action.reversibility,
              reason: action.recovery,
            })),
            conflicts,
          },
          effect: "none",
        };
      }

      if (!pending.length) {
        return {
          content: {
            reverted: 0,
            partiallyReverted: 0,
            residuals: [],
            skipped: [],
            message: "There are no recorded changes left to undo.",
          },
          effect: "none",
        };
      }

      const outcome = await revertActions({
        actions: pending,
        zoteroGateway,
        context,
      });
      return {
        content: {
          reverted: outcome.reverted,
          partiallyReverted: outcome.partiallyReverted,
          residuals: outcome.residuals,
          // Named explicitly so the agent reports what it could NOT put back
          // rather than implying a clean rollback.
          skipped: outcome.skipped,
          conflicts: outcome.conflicts,
        },
        effect:
          outcome.reverted + outcome.partiallyReverted === 0
            ? "none"
            : outcome.partiallyReverted > 0 ||
                outcome.skipped.length > 0 ||
                outcome.conflicts.length > 0
              ? "partial"
              : "applied",
      };
    },
  };
}

function describeEntries(entries: JournalActionWithSteps[]): string {
  return entries
    .map((entry) => {
      const suffix =
        entry.reversibility === "none"
          ? ` — cannot be undone: ${entry.recovery || "no inverse recorded"}`
          : entry.reversibility === "partial"
            ? " — partially reversible"
            : "";
      return `• ${entry.description}${suffix}`;
    })
    .join("\n");
}
