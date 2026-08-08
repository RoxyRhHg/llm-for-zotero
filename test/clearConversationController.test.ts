import { assert } from "chai";
import { createClearConversationController } from "../src/modules/contextPanel/setupHandlers/controllers/clearConversationController";

describe("clearConversationController", function () {
  it("clears the current conversation in place", async function () {
    const calls: string[] = [];
    let resetHistoryKey = 0;
    let markedLoadedKey = 0;
    let clearedComposeItemID = 0;
    let statusMessage = "";
    let statusLevel = "";

    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => 7001,
      getCurrentItemID: () => 7001,
      finalizePendingTurnDeletionsForConversation: async (conversationKey) => {
        calls.push(`turns:${conversationKey}`);
        return true;
      },
      restorePendingConversationDeletionsFor: async (conversationKey) => {
        calls.push(`restore:${conversationKey}`);
        return true;
      },
      clearTransientComposeStateForItem: (itemId) => {
        clearedComposeItemID = itemId;
        calls.push(`compose:${itemId}`);
      },
      resetComposePreviewUI: () => {
        calls.push("preview");
      },
      resetConversationHistory: (conversationKey) => {
        resetHistoryKey = conversationKey;
        calls.push(`history:${conversationKey}`);
      },
      markConversationLoaded: (conversationKey) => {
        markedLoadedKey = conversationKey;
        calls.push(`loaded:${conversationKey}`);
      },
      clearStoredConversation: async (conversationKey) => {
        calls.push(`stored:${conversationKey}`);
      },
      resetConversationTitle: async (conversationKey) => {
        calls.push(`title:${conversationKey}`);
      },
      clearOwnerAttachmentRefs: async (_ownerType, ownerKey) => {
        calls.push(`refs:${ownerKey}`);
      },
      removeConversationAttachmentFiles: async (conversationKey) => {
        calls.push(`files:${conversationKey}`);
      },
      refreshChatPreservingScroll: () => {
        calls.push("refresh");
      },
      refreshGlobalHistoryHeader: async () => {
        calls.push("history-header");
      },
      scheduleAttachmentGc: () => {
        calls.push("gc");
      },
      setStatusMessage: (message, level) => {
        statusMessage = message;
        statusLevel = level;
      },
    });

    await clearCurrentConversation();

    assert.equal(clearedComposeItemID, 7001);
    assert.equal(resetHistoryKey, 7001);
    assert.equal(markedLoadedKey, 7001);
    assert.equal(statusMessage, "Cleared");
    assert.equal(statusLevel, "ready");
    assert.deepEqual(calls, [
      "turns:7001",
      "restore:7001",
      "compose:7001",
      "history:7001",
      "loaded:7001",
      "preview",
      "stored:7001",
      "title:7001",
      "refs:7001",
      "files:7001",
      "refresh",
      "history-header",
      "gc",
    ]);
  });

  it("withdraws a pending conversation deletion instead of committing it", async function () {
    // Blocker: Clear used to run the kind-agnostic finalize, which committed a
    // conversation deletion queued from another surface and destroyed the
    // catalog row Clear exists to preserve.
    const calls: string[] = [];
    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => 7001,
      getCurrentItemID: () => 7001,
      finalizePendingTurnDeletionsForConversation: async (conversationKey) => {
        calls.push(`turns:${conversationKey}`);
        return true;
      },
      restorePendingConversationDeletionsFor: async (conversationKey) => {
        calls.push(`restore:${conversationKey}`);
        return true;
      },
      clearTransientComposeStateForItem: () => {},
      resetComposePreviewUI: () => {},
      resetConversationHistory: () => {},
      markConversationLoaded: () => {},
      clearStoredConversation: async () => {
        calls.push("stored");
      },
      resetConversationTitle: async () => {},
      clearOwnerAttachmentRefs: async () => {},
      removeConversationAttachmentFiles: async () => {},
      refreshChatPreservingScroll: () => {},
      refreshGlobalHistoryHeader: async () => {},
      scheduleAttachmentGc: () => {},
      setStatusMessage: () => {},
    });

    await clearCurrentConversation();

    assert.include(calls, "restore:7001", "the deletion must be withdrawn");
    assert.include(calls, "turns:7001", "hidden turns are still committed");
    assert.include(calls, "stored", "the clear itself still runs");
  });

  it("aborts the clear when a pending conversation deletion cannot be withdrawn", async function () {
    // If the durable intent survives, the next startup sweep would delete the
    // chat anyway — reporting "Cleared" would be a lie.
    const calls: string[] = [];
    let statusMessage = "";
    let statusLevel = "";
    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => 7001,
      getCurrentItemID: () => 7001,
      finalizePendingTurnDeletionsForConversation: async () => true,
      restorePendingConversationDeletionsFor: async () => false,
      clearTransientComposeStateForItem: () => {
        calls.push("compose");
      },
      resetComposePreviewUI: () => {},
      resetConversationHistory: () => {},
      markConversationLoaded: () => {},
      clearStoredConversation: async () => {
        calls.push("stored");
      },
      resetConversationTitle: async () => {},
      clearOwnerAttachmentRefs: async () => {},
      removeConversationAttachmentFiles: async () => {},
      refreshChatPreservingScroll: () => {},
      refreshGlobalHistoryHeader: async () => {},
      scheduleAttachmentGc: () => {},
      setStatusMessage: (message, level) => {
        statusMessage = message;
        statusLevel = level;
      },
    });

    await clearCurrentConversation();

    assert.notInclude(calls, "stored", "nothing destructive may run");
    assert.notInclude(calls, "compose", "the clear must abort early");
    assert.equal(statusMessage, "Failed to restore. Check logs.");
    assert.equal(statusLevel, "error");
  });

  it("does nothing when there is no active conversation", async function () {
    let called = false;
    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => null,
      getCurrentItemID: () => null,
      clearTransientComposeStateForItem: () => {
        called = true;
      },
      resetComposePreviewUI: () => {
        called = true;
      },
      resetConversationHistory: () => {
        called = true;
      },
      markConversationLoaded: () => {
        called = true;
      },
      clearStoredConversation: async () => {
        called = true;
      },
      resetConversationTitle: async () => {
        called = true;
      },
      clearOwnerAttachmentRefs: async () => {
        called = true;
      },
      removeConversationAttachmentFiles: async () => {
        called = true;
      },
      refreshChatPreservingScroll: () => {
        called = true;
      },
      refreshGlobalHistoryHeader: () => {
        called = true;
      },
      scheduleAttachmentGc: () => {
        called = true;
      },
    });

    await clearCurrentConversation();

    assert.isFalse(called);
  });

  it("does not clear stored rows when the registry scope is invalid", async function () {
    const calls: string[] = [];
    let statusMessage = "";
    const { clearCurrentConversation } = createClearConversationController({
      getConversationKey: () => 7001,
      getCurrentItemID: () => 7001,
      validateConversationScope: async () => false,
      clearTransientComposeStateForItem: () => {
        calls.push("compose");
      },
      resetComposePreviewUI: () => {
        calls.push("preview");
      },
      resetConversationHistory: (conversationKey) => {
        calls.push(`history:${conversationKey}`);
      },
      markConversationLoaded: (conversationKey) => {
        calls.push(`loaded:${conversationKey}`);
      },
      clearStoredConversation: async () => {
        calls.push("stored");
      },
      resetConversationTitle: async () => {
        calls.push("title");
      },
      clearOwnerAttachmentRefs: async () => {
        calls.push("refs");
      },
      removeConversationAttachmentFiles: async () => {
        calls.push("files");
      },
      refreshChatPreservingScroll: () => {
        calls.push("refresh");
      },
      refreshGlobalHistoryHeader: () => {
        calls.push("history-header");
      },
      scheduleAttachmentGc: () => {
        calls.push("gc");
      },
      setStatusMessage: (message) => {
        statusMessage = message;
      },
    });

    await clearCurrentConversation();

    assert.deepEqual(calls, ["history:7001", "loaded:7001"]);
    assert.equal(
      statusMessage,
      "Conversation identity mismatch; not clearing stored history.",
    );
  });
});
