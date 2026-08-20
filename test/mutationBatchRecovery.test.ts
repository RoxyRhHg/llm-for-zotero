import { assert } from "chai";
import { executeAndRecordUndoBatch } from "../src/agent/tools/write/mutateLibraryShared";
import { clearUndoStack, peekUndoEntry } from "../src/agent/store/undoStore";
import type { AgentToolContext } from "../src/agent/types";

describe("multi-operation mutation recovery", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    clearUndoStack(41);
    globalThis.Zotero = originalZotero;
  });

  it("journals and registers undo for a successful prefix before a later failure", async function () {
    const journalWrites: unknown[][] = [];
    globalThis.Zotero = {
      DB: {
        queryAsync: async (_sql: string, params: unknown[]) => {
          journalWrites.push(params);
          return [];
        },
      },
    } as typeof Zotero;

    const reverted: number[] = [];
    let calls = 0;
    const mutationService = {
      executeOperation: async () => {
        calls += 1;
        if (calls === 2) throw new Error("second item is invalid");
        return {
          result: { itemId: 1 },
          undo: {
            toolName: "library_mutation",
            description: "restore item 1",
            inverseOperations: [
              {
                type: "update_metadata",
                itemId: 1,
                metadata: { title: "old" },
              },
            ],
            revert: async () => {
              reverted.push(1);
            },
          },
        };
      },
    };
    const context = {
      request: { conversationKey: 41, libraryID: 1 },
      modelName: "test-model",
    } as AgentToolContext;

    let message = "";
    try {
      await executeAndRecordUndoBatch(
        mutationService as never,
        [
          { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
          { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
        ],
        context,
        "update_metadata",
      );
      assert.fail("expected the second operation to fail");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.include(
      message,
      "1 operation was applied; available inverses were retained",
    );
    assert.lengthOf(journalWrites, 1, "the successful prefix is journalled");
    const undo = peekUndoEntry(41);
    assert.exists(undo, "the successful prefix remains undoable in-session");
    await undo?.revert();
    assert.deepEqual(reverted, [1]);
  });

  it("stops before the next mutation when durable journal persistence fails", async function () {
    globalThis.Zotero = {
      DB: {
        queryAsync: async () => {
          throw new Error("database is read-only");
        },
      },
    } as typeof Zotero;
    let calls = 0;
    const mutationService = {
      executeOperation: async () => {
        calls += 1;
        return {
          result: { itemId: calls },
          undo: {
            toolName: "library_mutation",
            description: `restore item ${calls}`,
            inverseOperations: [
              {
                type: "update_metadata",
                itemId: calls,
                metadata: { title: "old" },
              },
            ],
            revert: async () => undefined,
          },
        };
      },
    };
    const context = {
      request: { conversationKey: 41, libraryID: 1 },
      modelName: "test-model",
    } as AgentToolContext;

    let message = "";
    try {
      await executeAndRecordUndoBatch(
        mutationService as never,
        [
          { type: "update_metadata", itemId: 1, metadata: { title: "new" } },
          { type: "update_metadata", itemId: 2, metadata: { title: "new" } },
        ],
        context,
        "update_metadata",
      );
      assert.fail("expected journal failure to stop the batch");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.equal(calls, 1, "no unjournalled second write may start");
    assert.include(message, "durable undo record could not be saved");
    assert.include(
      message,
      "1 operation was applied; available inverses were retained",
    );
  });
});
