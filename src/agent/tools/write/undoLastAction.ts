import type { AgentWriteToolDefinition } from "../../types";
import { ok } from "../shared";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { revertActions } from "../../services/changeReverter";
import { listJournalActions } from "../../store/changeJournal";

type UndoLastActionInput = Record<string, never>;

export function createUndoLastActionTool(
  zoteroGateway: ZoteroGateway,
): AgentWriteToolDefinition<UndoLastActionInput, unknown> {
  return {
    spec: {
      name: "undo_last_action",
      description:
        "Undo the most recent durable write action performed by the agent in this conversation. The history survives restart and an action's steps are reverted newest-first.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      mutability: "write",
      requiresConfirmation: true,
    },
    presentation: {
      label: "Undo Last Action",
      summaries: {
        onCall: "Preparing to undo the last action",
        onPending: "Waiting for your confirmation to undo",
        onApproved: "Approval received - undoing the action",
        onDenied: "Undo cancelled",
        onSuccess: ({ content }) => {
          const record =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const description = String(record.description || "");
          if (record.status === "partially_undone") {
            return description
              ? `Partially undone: ${description}; some effects may remain`
              : "The recorded inverse ran, but some effects may remain";
          }
          return description
            ? `Undone: ${description}`
            : "Last action undone successfully";
        },
      },
    },
    validate: (_args) => {
      return ok<UndoLastActionInput>({});
    },
    shouldRequireConfirmation: async (_input, context) => {
      const actions = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: 1,
        pendingOnly: true,
      });
      return actions.length > 0;
    },
    planMutation: async (_input, context) => {
      const actions = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: 1,
        pendingOnly: true,
      });
      return actions.length
        ? {
            effect: "write",
            reversibility: "none",
            reason:
              "Undo replays an inverse without creating a redo action, so the undo itself cannot be automatically undone.",
            requiresConfirmation: true,
          }
        : { effect: "none", reversibility: "full" };
    },
    createPendingAction: async (_input, context) => {
      const [action] = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: 1,
        pendingOnly: true,
      });
      return {
        toolName: "undo_last_action",
        title: action ? "Confirm undo" : "Nothing to undo",
        description: action?.description,
        confirmLabel: "Undo",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Action to undo",
            value: action ? action.description : "There is nothing to undo.",
          },
        ],
      };
    },
    execute: async (_input, context) => {
      const [action] = await listJournalActions({
        conversationKey: context.request.conversationKey,
        limit: 1,
        pendingOnly: true,
      });
      if (!action) {
        throw new Error("Nothing to undo in this conversation");
      }
      const outcome = await revertActions({
        actions: [action],
        zoteroGateway,
        context,
      });
      if (!outcome.reverted && !outcome.partiallyReverted) {
        throw new Error(
          outcome.skipped[0]?.reason ||
            "The latest action could not be safely undone",
        );
      }
      return {
        content: {
          status: outcome.partiallyReverted ? "partially_undone" : "undone",
          toolName: action.toolName,
          description: action.description,
          reverted: outcome.reverted,
          partiallyReverted: outcome.partiallyReverted,
          residuals: outcome.residuals,
        },
        effect: outcome.partiallyReverted ? "partial" : "applied",
      };
    },
  };
}
