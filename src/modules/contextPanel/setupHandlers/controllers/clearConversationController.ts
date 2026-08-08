import { t } from "../../../../utils/i18n";

type StatusLevel = "ready" | "warning" | "error";

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
  restorePendingConversationDeletionsFor?: (
    conversationKey: number,
  ) => Promise<boolean>;
  validateConversationScope?: (conversationKey: number) => Promise<boolean>;
  clearTransientComposeStateForItem: (itemId: number) => void;
  resetComposePreviewUI: () => void;
  resetConversationHistory: (conversationKey: number) => void;
  markConversationLoaded: (conversationKey: number) => void;
  invalidateConversationSession?: (conversationKey: number) => Promise<void>;
  clearStoredConversation: (conversationKey: number) => Promise<void>;
  resetConversationTitle: (conversationKey: number) => Promise<void>;
  clearOwnerAttachmentRefs: (
    ownerType: "conversation",
    ownerKey: number,
  ) => Promise<void>;
  removeConversationAttachmentFiles: (conversationKey: number) => Promise<void>;
  refreshChatPreservingScroll: () => void;
  refreshGlobalHistoryHeader: () => void | Promise<void>;
  scheduleAttachmentGc: () => void;
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
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

    const normalizedConversationKey = Math.floor(conversationKey as number);
    const normalizedItemID = Math.floor(currentItemID as number);
    if (deps.validateConversationScope) {
      const validScope = await deps.validateConversationScope(
        normalizedConversationKey,
      );
      if (!validScope) {
        deps.resetConversationHistory(normalizedConversationKey);
        deps.markConversationLoaded(normalizedConversationKey);
        deps.setStatusMessage?.(
          "Conversation identity mismatch; not clearing stored history.",
          "error",
        );
        return;
      }
    }

    // Clear empties a chat but PRESERVES its identity — resetConversationTitle
    // below assumes the catalog row still exists. Commit hidden TURN deletions
    // only: a kind-agnostic flush would commit a still-undoable CONVERSATION
    // deletion queued from another surface (the standalone window switches only
    // itself away, leaving the main panel mounted on that key) and destroy the
    // very row Clear exists to keep.
    try {
      await deps.finalizePendingTurnDeletionsForConversation?.(
        normalizedConversationKey,
      );
    } catch (err) {
      deps.logError?.("LLM: Failed to finalize pending turn deletions", err);
    }
    // Clearing a chat is a user action inside it, so it proves the user wants
    // this chat alive (just empty): withdraw a pending conversation deletion
    // instead of letting it commit. If the durable intent cannot be withdrawn,
    // abort before anything destructive runs — the next startup sweep would
    // delete the chat anyway and "Cleared" would be a lie. This runs before the
    // in-flight request is cancelled so an aborted clear leaves the streaming
    // response alone.
    let conversationDeletionRestored = true;
    try {
      conversationDeletionRestored =
        (await deps.restorePendingConversationDeletionsFor?.(
          normalizedConversationKey,
        )) ?? true;
    } catch (err) {
      deps.logError?.(
        "LLM: Failed to restore pending conversation deletion",
        err,
      );
      conversationDeletionRestored = false;
    }
    if (!conversationDeletionRestored) {
      // setStatusMessage does not translate (setupHandlers passes the message
      // straight through), and every other site emits this string via t().
      deps.setStatusMessage?.(t("Failed to restore. Check logs."), "error");
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
    deps.clearTransientComposeStateForItem(normalizedItemID);
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
      await deps.invalidateConversationSession?.(normalizedConversationKey);
    } catch (err) {
      deps.logError?.(
        "LLM: Failed to invalidate Claude conversation session",
        err,
      );
    }
    try {
      await deps.clearStoredConversation(normalizedConversationKey);
    } catch (err) {
      deps.logError?.("LLM: Failed to clear persisted chat history", err);
    }
    try {
      await deps.resetConversationTitle(normalizedConversationKey);
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
      await deps.removeConversationAttachmentFiles(normalizedConversationKey);
    } catch (err) {
      deps.logError?.("LLM: Failed to clear chat attachment files", err);
    }

    deps.refreshChatPreservingScroll();
    await deps.refreshGlobalHistoryHeader();
    deps.scheduleAttachmentGc();
    deps.setStatusMessage?.("Cleared", "ready");
  };

  return { clearCurrentConversation };
}
