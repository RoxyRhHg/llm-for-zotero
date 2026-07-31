import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

declare const Zotero: any;

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

// Errors serialized across the Zotero/runner boundary lose their message;
// surface them through the assertion's `actual` field, which is printed.
async function surfacing(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const detail = String(
      (err as Error)?.stack || (err as Error)?.message || err,
    );
    assert.equal(detail, "OK", "step failed");
  }
}

describe("deletion lifecycle", function () {
  this.timeout(30000);

  it("delete → remount (user switches) → undo from the new panel restores the chat", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Lifecycle Paper A",
        pdfTitle: "deletion-a.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredUserMessage(panel.panelId, "hello world");
        const diagnostics = await api.getDiagnostics(panel.panelId);
        const conversationKey = diagnostics.conversationKey!;
        assert.isOk(conversationKey);

        // A second conversation so the first becomes a deletable history row.
        await api.startNewPanelConversation(panel.panelId);
        await api.seedPanelStoredUserMessage(panel.panelId, "second chat");

        await api.deletePanelHistoryConversation(
          panel.panelId,
          conversationKey,
        );
        let state = await api.getPendingDeletionState();
        assert.include(state.pendingConversationKeys, conversationKey);
        assert.equal(state.persistedRowCount, 1, "intent must be durable");
        assert.isTrue(await api.isPanelUndoToastVisible(panel.panelId));
        const hiddenHistory = await api.listPanelHistory(panel.panelId);
        assert.notInclude(
          hiddenHistory.map((h) => h.conversationKey),
          conversationKey,
          "queued row must be hidden immediately",
        );

        // The user switches away: the panel is torn down and rebuilt.
        const remounted = await api.remountPanel(panel.panelId);
        assert.isTrue(
          await api.isPanelUndoToastVisible(remounted.panelId),
          "undo toast must survive the remount",
        );
        const history = await api.listPanelHistory(remounted.panelId);
        assert.notInclude(
          history.map((h) => h.conversationKey),
          conversationKey,
          "queued row must stay hidden after remount",
        );

        await api.clickPanelUndo(remounted.panelId);
        state = await api.getPendingDeletionState();
        assert.equal(state.persistedRowCount, 0, "undo must clear the intent");
        const restored = await api.listPanelHistory(remounted.panelId);
        assert.include(
          restored.map((h) => h.conversationKey),
          conversationKey,
          "undone conversation must reappear",
        );
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });

  it("delete → no undo → the chat is really gone, even across a simulated restart", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Lifecycle Paper B",
        pdfTitle: "deletion-b.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        await api.seedPanelStoredUserMessage(panel.panelId, "doomed chat");
        const conversationKey = (await api.getDiagnostics(panel.panelId))
          .conversationKey!;
        await api.startNewPanelConversation(panel.panelId);
        await api.seedPanelStoredUserMessage(panel.panelId, "survivor chat");
        const survivorKey = (await api.getDiagnostics(panel.panelId))
          .conversationKey!;
        assert.notEqual(conversationKey, survivorKey);

        await api.deletePanelHistoryConversation(
          panel.panelId,
          conversationKey,
        );
        // Simulate "user quit during the cooldown": go straight to the sweep
        // that runs on next startup, without waiting for the live timer.
        await api.sweepPendingDeletionsAsRestart();

        const state = await api.getPendingDeletionState();
        assert.equal(state.persistedRowCount, 0);
        const history = await api.listPanelHistory(panel.panelId);
        const keys = history.map((h) => h.conversationKey);
        assert.notInclude(
          keys,
          conversationKey,
          "intended delete must complete",
        );
        assert.include(keys, survivorKey, "unintended chat must survive");
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });

  it("turn delete → undo restores the turn; turn delete → sweep removes only that turn", async function () {
    await surfacing(async () => {
      const api = getWorkflowTestApi();
      await api.reset();
      const fixture = await api.createPaperWithPdfFixture({
        title: "Deletion Lifecycle Paper C",
        pdfTitle: "deletion-c.pdf",
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const keptTurn = await api.seedPanelStoredTurn(
          panel.panelId,
          "keep question",
          "keep answer",
        );
        const doomedTurn = await api.seedPanelStoredTurn(
          panel.panelId,
          "doomed question",
          "doomed answer",
        );
        assert.equal(keptTurn.conversationKey, doomedTurn.conversationKey);
        const fullCount = await api.getPanelVisibleMessageCount(panel.panelId);
        assert.isAtLeast(fullCount, 4);

        // Queue the second turn for deletion, then undo — everything is back.
        await api.deletePanelTurn(
          panel.panelId,
          doomedTurn.userTimestamp,
          doomedTurn.assistantTimestamp,
        );
        assert.equal(
          await api.getPanelVisibleMessageCount(panel.panelId),
          fullCount - 2,
          "queued turn must be hidden from the render",
        );
        assert.isTrue(await api.isPanelUndoToastVisible(panel.panelId));
        await api.clickPanelUndo(panel.panelId);
        assert.equal(
          await api.getPanelVisibleMessageCount(panel.panelId),
          fullCount,
          "undone turn must reappear",
        );

        // Queue again, then simulate quit + restart sweep — the turn is gone
        // for real while the kept turn survives.
        await api.deletePanelTurn(
          panel.panelId,
          doomedTurn.userTimestamp,
          doomedTurn.assistantTimestamp,
        );
        await api.sweepPendingDeletionsAsRestart();
        const state = await api.getPendingDeletionState();
        assert.equal(state.persistedRowCount, 0);
        const remounted = await api.remountPanel(panel.panelId);
        const countAfter = await api.getPanelVisibleMessageCount(
          remounted.panelId,
        );
        assert.equal(
          countAfter,
          fullCount - 2,
          "swept turn must stay deleted after a rebuild",
        );
      } finally {
        await api.cleanupFixture(fixture);
      }
    });
  });
});
