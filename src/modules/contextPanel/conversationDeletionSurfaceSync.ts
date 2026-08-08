import type { ConversationSystem } from "../../shared/types";
import type { PendingDeletionEvent } from "../../core/conversations/pendingDeletionStore";

export type ConversationDeletionSurfaceSnapshot = {
  conversationKey: number;
  kind: "global" | "paper";
  system: ConversationSystem;
};

export type ConversationDeletionSurfaceEntry = {
  conversationKey: number;
  conversationKind: "global" | "paper";
  system: ConversationSystem;
  // Recorded on the persisted entry for the queueing surface's own bookkeeping;
  // deliberately NOT an input to the decision below, which keys off this
  // surface's own `surrendered` state.
  wasActive?: boolean;
};

export type ConversationDeletionSurfaceAction =
  | { type: "none" }
  | { type: "leave"; remember: boolean }
  | { type: "restore" }
  | { type: "forget" };

// Surface reactions can await fresh-chat creation or history navigation. Keep
// each mounted surface's event reactions in notification order so a quick Undo
// cannot run before the queued deletion has recorded that the surface left.
export function createSerializedConversationDeletionEventQueue(): (
  task: () => Promise<void>,
) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task) => {
    const next = chain.then(task);
    chain = next.catch(() => undefined);
    return next;
  };
}

/**
 * What one mounted surface (panel or standalone window) must do about a
 * conversation-deletion event. Every surface subscribes to the same store, so
 * this decision has to be made per surface rather than per deletion:
 *   - a surface showing the doomed chat leaves it, whoever queued the deletion;
 *   - only the surface that surrendered a chat goes back to it when the
 *     deletion is undone or abandoned — others keep their own place.
 */
export function resolveConversationDeletionSurfaceAction(params: {
  eventType: PendingDeletionEvent["type"];
  entry: ConversationDeletionSurfaceEntry;
  surface: ConversationDeletionSurfaceSnapshot | null;
  surrendered: boolean;
  // A "finalized" event whose intent was DROPPED (stale, or persisted without
  // an identity witness) means the conversation still exists. Treating it as a
  // deletion would evict the user from a live chat, so it resolves like the
  // other survival outcomes.
  dropped?: boolean;
}): ConversationDeletionSurfaceAction {
  const { entry, surface, surrendered } = params;
  // A DROPPED outcome means the intent was withdrawn without deleting anything
  // — the conversation is alive — so it resolves like the other survival
  // outcomes. Note this applies only when the finalizer explicitly said so; a
  // stale intent whose conversation is genuinely GONE reports a plain
  // completion and still resolves as a real deletion.
  const eventType =
    (params.eventType === "finalized" ||
      params.eventType === "finalize-failed") &&
    params.dropped
      ? "gave-up"
      : params.eventType;
  const showsEntry = Boolean(
    surface &&
    surface.conversationKey === entry.conversationKey &&
    surface.kind === entry.conversationKind &&
    surface.system === entry.system,
  );
  if (eventType === "queued" || eventType === "finalize-failed") {
    return showsEntry ? { type: "leave", remember: true } : { type: "none" };
  }
  if (eventType === "finalized") {
    // The chat is gone for good: leave, but there is nothing to return to.
    if (showsEntry) return { type: "leave", remember: false };
    return surrendered ? { type: "forget" } : { type: "none" };
  }
  // "undone" / "gave-up": the chat survived after all. The gate is
  // `surrendered` — a property of THIS surface — not entry.wasActive, which
  // describes the surface that QUEUED the deletion. A surface that stepped off
  // the chat in reaction to someone else's deletion (the deleter had it
  // inactive, so wasActive is false) must still be taken back; gating on
  // wasActive stranded it on the blank chat it was pushed onto.
  if (surrendered && !showsEntry) return { type: "restore" };
  return surrendered ? { type: "forget" } : { type: "none" };
}
