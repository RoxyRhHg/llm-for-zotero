import { assert } from "chai";
import { revertEntries } from "../src/agent/services/changeReverter";
import type { ChangeJournalEntry } from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";

/**
 * Undo used to be ten JavaScript closures in RAM, per conversation, wiped by
 * a restart — and five of fifteen operations never pushed one at all. That is
 * survivable when every write stops at a card. It is not survivable once
 * `yolo` lets a batch job run unattended, which is why the journal ships with
 * that capability rather than after it.
 *
 * The inverse is stored as a mutation *operation*, not a closure, so replay
 * takes the same path — and the same refusals — as a forward write.
 */
describe("change journal revert", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context = {
    request: { conversationKey: 1, libraryID: 1 },
  } as never as AgentToolContext;

  function entry(over: Partial<ChangeJournalEntry>): ChangeJournalEntry {
    return {
      entryId: "e1",
      runId: "conv-1",
      conversationKey: 1,
      operation: "move_to_collection",
      description: "Filed 2 papers",
      itemCount: 2,
      status: "reversible",
      createdAt: 1000,
      ...over,
    };
  }

  function makeGateway() {
    const removed: Array<{ itemId: number; collectionId: number }> = [];
    // No DB, so markChangeReverted degrades to a no-op.
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      debug: () => undefined,
    };
    return {
      removed,
      gateway: {
        removeItemFromCollection: async (p: {
          itemId: number;
          collectionId: number;
        }) => {
          removed.push(p);
          return { removed: true };
        },
      } as never,
    };
  }

  it("replays a stored inverse as a real operation", async function () {
    const { gateway, removed } = makeGateway();
    const outcome = await revertEntries({
      entries: [
        entry({
          inverseJson: JSON.stringify([
            {
              type: "remove_from_collection",
              itemIds: [1, 2],
              collectionId: 88,
            },
          ]),
        }),
      ],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.deepEqual(removed, [
      { itemId: 1, collectionId: 88 },
      { itemId: 2, collectionId: 88 },
    ]);
  });

  it("reports what it could not undo instead of implying a clean rollback", async function () {
    const { gateway } = makeGateway();
    const outcome = await revertEntries({
      entries: [
        entry({
          entryId: "e2",
          status: "irreversible",
          irreversibleReason: "Renaming a file on disk cannot be undone",
        }),
      ],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 0);
    assert.lengthOf(outcome.skipped, 1);
    assert.include(outcome.skipped[0].reason, "cannot be undone");
  });

  it("keeps going when one entry fails rather than stranding the rest", async function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      debug: () => undefined,
    };
    const removed: number[] = [];
    const gateway = {
      removeItemFromCollection: async (p: { itemId: number }) => {
        if (p.itemId === 1) throw new Error("item is gone");
        removed.push(p.itemId);
        return { removed: true };
      },
    } as never;

    const outcome = await revertEntries({
      entries: [
        entry({
          entryId: "a",
          createdAt: 2000,
          inverseJson: JSON.stringify([
            { type: "remove_from_collection", itemIds: [1], collectionId: 88 },
          ]),
        }),
        entry({
          entryId: "b",
          createdAt: 1000,
          inverseJson: JSON.stringify([
            { type: "remove_from_collection", itemIds: [2], collectionId: 88 },
          ]),
        }),
      ],
      zoteroGateway: gateway,
      context,
    });

    assert.equal(outcome.reverted, 1);
    assert.lengthOf(outcome.skipped, 1);
    assert.deepEqual(removed, [2], "the second entry still ran");
  });

  it("reverts newest first, since a later change can depend on an earlier one", async function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      debug: () => undefined,
    };
    const order: number[] = [];
    const gateway = {
      removeItemFromCollection: async (p: { itemId: number }) => {
        order.push(p.itemId);
        return { removed: true };
      },
    } as never;

    await revertEntries({
      entries: [
        entry({
          entryId: "older",
          createdAt: 1000,
          inverseJson: JSON.stringify([
            { type: "remove_from_collection", itemIds: [10], collectionId: 88 },
          ]),
        }),
        entry({
          entryId: "newer",
          createdAt: 5000,
          inverseJson: JSON.stringify([
            { type: "remove_from_collection", itemIds: [50], collectionId: 88 },
          ]),
        }),
      ],
      zoteroGateway: gateway,
      context,
    });

    assert.deepEqual(order, [50, 10]);
  });

  it("skips entries already reverted", async function () {
    const { gateway, removed } = makeGateway();
    const outcome = await revertEntries({
      entries: [entry({ status: "reverted", inverseJson: "[]" })],
      zoteroGateway: gateway,
      context,
    });
    assert.equal(outcome.reverted, 0);
    assert.lengthOf(removed, 0);
  });
});
