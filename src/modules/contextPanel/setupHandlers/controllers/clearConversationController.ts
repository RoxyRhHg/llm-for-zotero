import { t } from "../../../../utils/i18n";
import type { ConversationCleanupProviderScope } from "../../../../core/conversations/conversationCleanupJobs";

type StatusLevel = "ready" | "warning" | "error";

type ClearConversationIdentity = {
  instanceID?: string;
  conversationID?: string;
  providerSessionId?: string;
  providerScope?: ConversationCleanupProviderScope;
  conversationKind?: "global" | "paper";
  libraryID?: number;
  paperItemID?: number;
};

type ClearConversationControllerDeps = {
  getConversationKey: () => number | null;
  getCurrentItemID: () => number | null;
  getPendingRequestId?: (conversationKey: number) => number;
  getAbortController?: (conversationKey: number) => AbortController | null;
  setCancelledRequestId?: (conversationKey: number, requestId: number) => void;
  setPendingRequestId?: (conversationKey: number, requestId: number) => void;
  setAbortController?: (
    conversationKey: number,
    value: AbortController | null,
  ) => void;
  finalizePendingTurnDeletionsForConversation?: (
    conversationKey: number,
  ) => Promise<boolean>;
  isConversationPendingDeletion?: (conversationKey: number) => boolean;
  validateConversationScope?: (conversationKey: number) => Promise<boolean>;
  getConversationIdentity?: (
    conversationKey: number,
  ) => Promise<ClearConversationIdentity | null>;
  clearTransientComposeStateForItem: (itemId: number) => void;
  /** Identity-owned runtime purge; preferred over the legacy item hook. */
  clearConversationOwnedRuntimeState?: (conversationKey: number) => void;
  freezeConversationWrites?: (conversationKey: number) => void;
  unfreezeConversationWrites?: (conversationKey: number) => void;
  bumpConversationWriteGeneration?: (conversationKey: number) => number;
  resetConversationSessionTokens?: (conversationKey: number) => void;
  resetComposePreviewUI: () => void;
  resetConversationHistory: (conversationKey: number) => void;
  markConversationLoaded: (conversationKey: number) => void;
  invalidateConversationSession?: (
    conversationKey: number,
    expectedProviderSessionId?: string,
    expectedInstanceID?: string,
  ) => Promise<void>;
  clearStoredConversation: (
    conversationKey: number,
    identity?: Pick<ClearConversationIdentity, "instanceID" | "conversationID">,
    onBeforeCommit?: () => Promise<void>,
  ) => Promise<void>;
  resetConversationTitle: (
    conversationKey: number,
    identity?: Pick<ClearConversationIdentity, "instanceID" | "conversationID">,
  ) => Promise<void>;
  clearOwnerAttachmentRefs: (
    ownerType: "conversation",
    ownerKey: number,
  ) => Promise<void>;
  removeConversationAttachmentFiles: (
    conversationKey: number,
    expectedInstanceID?: string,
  ) => Promise<void>;
  refreshChatPreservingScroll: () => void;
  refreshGlobalHistoryHeader: () => void | Promise<void>;
  scheduleAttachmentGc: () => void;
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
  releaseClaudeRuntimeForConversation?: (
    conversationKey: number,
  ) => Promise<void> | void;
  /** Persistent agent/ref/fork/provider cleanup joined to the Clear transaction. */
  /** Prepare schemas before clearStoredConversation opens its transaction. */
  preparePersistentConversationClear?: () => Promise<void>;
  clearPersistedConversationRowsInTransaction?: (
    conversationKey: number,
    identity?: ClearConversationIdentity,
  ) => Promise<void>;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  logError?: (message: string, error: unknown) => void;
  isWebChatActive?: () => boolean; // [webchat]
  getWebChatHost?: () => string; // [webchat]
  markNextWebChatSendAsNewChat?: () => void; // [webchat]
};

export function createClearConversationController(
  deps: ClearConversationControllerDeps,
): {
  clearCurrentConversation: () => Promise<void>;
} {
  const clearCurrentConversation = async () => {
    const conversationKey = deps.getConversationKey();
    const currentItemID = deps.getCurrentItemID();
    if (
      !Number.isFinite(conversationKey) ||
      (conversationKey as number) <= 0 ||
      !Number.isFinite(currentItemID) ||
      (currentItemID as number) <= 0
    ) {
      return;
    }

    if (deps.isConversationPendingDeletion?.(conversationKey as number)) {
      deps.setStatusMessage?.(
        t("Deletion pending; retrying safely"),
        "warning",
      );
      return;
    }

    const normalizedConversationKey = Math.floor(conversationKey as number);
    const normalizedItemID = Math.floor(currentItemID as number);
    const releaseFailedClearFence = () => {
      // A failed Clear may have installed process-local deletion markers before
      // its DB transaction rolled back. Advance the generation before opening
      // the key again so those markers/callbacks cannot suppress or mutate the
      // restored live conversation.
      deps.bumpConversationWriteGeneration?.(normalizedConversationKey);
      deps.unfreezeConversationWrites?.(normalizedConversationKey);
    };
    // Freeze before validation and provider identity capture so an awaited
    // witness read cannot race a new provider session into this Clear.
    deps.freezeConversationWrites?.(normalizedConversationKey);
    deps.bumpConversationWriteGeneration?.(normalizedConversationKey);
    if (deps.validateConversationScope) {
      let validScope = false;
      try {
        validScope = await deps.validateConversationScope(
          normalizedConversationKey,
        );
      } catch (err) {
        deps.logError?.(
          "LLM: Failed to validate Clear conversation scope",
          err,
        );
        releaseFailedClearFence();
        return;
      }
      if (!validScope) {
        releaseFailedClearFence();
        deps.resetConversationHistory(normalizedConversationKey);
        deps.markConversationLoaded(normalizedConversationKey);
        deps.setStatusMessage?.(
          "Conversation identity mismatch; not clearing stored history.",
          "error",
        );
        return;
      }
    }

    // Capture the immutable identity and provider session before any local
    // mutation.  A recycled numeric key must never let Clear target a newer
    // catalog instance or detach its provider session.
    let identity: ClearConversationIdentity | undefined;
    if (deps.getConversationIdentity) {
      try {
        identity =
          (await deps.getConversationIdentity(normalizedConversationKey)) ||
          undefined;
      } catch (err) {
        deps.logError?.(
          "LLM: Failed to capture Clear conversation identity",
          err,
        );
        deps.setStatusMessage?.(
          "Clear blocked; conversation identity could not be verified.",
          "error",
        );
        releaseFailedClearFence();
        return;
      }
      if (!identity?.instanceID || !identity.conversationID) {
        deps.setStatusMessage?.(
          "Clear blocked; conversation identity could not be verified.",
          "error",
        );
        releaseFailedClearFence();
        return;
      }
    }

    // Clear empties a chat but PRESERVES its identity — resetConversationTitle
    // below assumes the catalog row still exists. Commit hidden TURN deletions
    // only: a kind-agnostic flush would commit a still-undoable CONVERSATION
    // deletion queued from another surface (the standalone window switches only
    // itself away, leaving the main panel mounted on that key) and destroy the
    // very row Clear exists to keep.
    let pendingTurnsFinalized = true;
    try {
      const finalized =
        await deps.finalizePendingTurnDeletionsForConversation?.(
          normalizedConversationKey,
        );
      // A timed-out/provider-failed turn finalizer keeps its write-ahead row
      // for retry.  Clear must not proceed past that boundary: its later
      // unfreeze would allow a new turn while the retry still owns the same
      // conversation key, and the retry's conversation-scoped agent purge
      // could then delete the new turn's state.
      pendingTurnsFinalized = finalized !== false;
    } catch (err) {
      pendingTurnsFinalized = false;
      deps.logError?.("LLM: Failed to finalize pending turn deletions", err);
    }
    if (!pendingTurnsFinalized) {
      const pendingRequestId =
        deps.getPendingRequestId?.(normalizedConversationKey) || 0;
      if (pendingRequestId > 0) {
        const ctrl = deps.getAbortController?.(normalizedConversationKey);
        if (ctrl) ctrl.abort();
        deps.setCancelledRequestId?.(
          normalizedConversationKey,
          pendingRequestId,
        );
        deps.setPendingRequestId?.(normalizedConversationKey, 0);
        deps.setAbortController?.(normalizedConversationKey, null);
      }
      // Keep the write fence held.  The durable turn intent will retry and
      // the user can retry Clear once provider cleanup has completed.
      deps.setStatusMessage?.(
        "Clear waiting for pending turn cleanup; please retry.",
        "warning",
      );
      return;
    }
    // Another surface may have queued a whole-conversation delete while the
    // identity/provider reads above were awaiting.  Clear must not commit an
    // empty identity and then reopen writes underneath that durable intent.
    if (deps.isConversationPendingDeletion?.(normalizedConversationKey)) {
      deps.setStatusMessage?.(
        t("Deletion pending; retrying safely"),
        "warning",
      );
      return;
    }
    const pendingRequestId =
      deps.getPendingRequestId?.(normalizedConversationKey) || 0;
    if (pendingRequestId > 0) {
      const ctrl = deps.getAbortController?.(normalizedConversationKey);
      if (ctrl) ctrl.abort();
      deps.setCancelledRequestId?.(normalizedConversationKey, pendingRequestId);
      deps.setPendingRequestId?.(normalizedConversationKey, 0);
      deps.setAbortController?.(normalizedConversationKey, null);
    }
    try {
      // Schema creation is deliberately outside the content transaction.  The
      // callback below is invoked while that transaction is open and must only
      // issue direct DELETE statements; nested DDL/transactions can otherwise
      // commit or fail independently of the Clear commit.
      await deps.preparePersistentConversationClear?.();
      if (deps.isConversationPendingDeletion?.(normalizedConversationKey)) {
        deps.setStatusMessage?.(
          t("Deletion pending; retrying safely"),
          "warning",
        );
        return;
      }
      await deps.clearStoredConversation(
        normalizedConversationKey,
        identity,
        deps.clearPersistedConversationRowsInTransaction
          ? () =>
              deps.clearPersistedConversationRowsInTransaction!(
                normalizedConversationKey,
                identity,
              )
          : undefined,
      );
    } catch (err) {
      deps.logError?.("LLM: Failed to clear persisted chat history", err);
      // Never hide or purge runtime state when the local commit failed.  The
      // user's content is still present and remains recoverable on retry.
      releaseFailedClearFence();
      deps.setStatusMessage?.(
        "Clear failed; content preserved. Please retry.",
        "warning",
      );
      return;
    }

    // Local Clear is authoritative.  Only after the persisted content commit
    // succeeds may the mounted UI, agent state, title, attachments, or native
    // provider session be detached.
    if (deps.clearConversationOwnedRuntimeState) {
      deps.clearConversationOwnedRuntimeState(normalizedConversationKey);
    } else {
      // Compatibility for headless/test callers that predate the identity
      // scoped runtime purge.
      deps.clearTransientComposeStateForItem(normalizedItemID);
    }
    deps.resetConversationSessionTokens?.(normalizedConversationKey);
    deps.resetConversationHistory(normalizedConversationKey);
    deps.markConversationLoaded(normalizedConversationKey);
    deps.clearAgentToolCaches?.(normalizedConversationKey);
    deps.resetComposePreviewUI();

    try {
      await deps.clearAgentConversationState?.(normalizedConversationKey);
    } catch (err) {
      deps.logError?.("LLM: Failed to clear agent conversation state", err);
    }
    try {
      await deps.releaseClaudeRuntimeForConversation?.(
        normalizedConversationKey,
      );
    } catch (err) {
      deps.logError?.("LLM: Failed to release Claude runtime retention", err);
    }
    // Local Clear is authoritative. Detach the exact native session only
    // after the local content commit so provider failures cannot block or
    // resurrect the empty conversation.
    try {
      await deps.invalidateConversationSession?.(
        normalizedConversationKey,
        identity?.providerSessionId,
        identity?.instanceID,
      );
    } catch (err) {
      deps.logError?.(
        "LLM: Failed to invalidate Claude conversation session",
        err,
      );
    }
    try {
      await deps.resetConversationTitle(normalizedConversationKey, identity);
    } catch (err) {
      deps.logError?.("LLM: Failed to reset conversation title", err);
    }
    try {
      await deps.clearOwnerAttachmentRefs(
        "conversation",
        normalizedConversationKey,
      );
    } catch (err) {
      deps.logError?.("LLM: Failed to clear conversation attachment refs", err);
    }
    try {
      await deps.removeConversationAttachmentFiles(
        normalizedConversationKey,
        identity?.instanceID,
      );
    } catch (err) {
      deps.logError?.("LLM: Failed to clear chat attachment files", err);
    }

    deps.refreshChatPreservingScroll();
    await deps.refreshGlobalHistoryHeader();
    deps.scheduleAttachmentGc();
    // All post-commit local cleanup is complete.  Only now may a new request
    // begin on the empty conversation; callbacks from the old generation were
    // rejected while this fence was held.
    deps.unfreezeConversationWrites?.(normalizedConversationKey);
    deps.setStatusMessage?.("Cleared", "ready");
  };

  return { clearCurrentConversation };
}
