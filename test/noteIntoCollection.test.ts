import { assert } from "chai";
import { createEditCurrentNoteTool } from "../src/agent/tools/write/editCurrentNote";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import type { AgentToolContext } from "../src/agent/types";

/**
 * Issue #374: "save the answer as a note into a specific folder" put the note
 * in the My Library root, or nowhere at all.
 *
 * There were two independent causes. The classifier sent the request to the
 * filesystem (fixed in Stage A), and — even once it reached Zotero — no layer
 * of the note-writing chain could express a collection, and the created
 * note's id was discarded on the way back up so no follow-up was possible.
 */
describe("note into a collection (issue #374)", function () {
  const context: AgentToolContext = {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "save this answer as a note in the Neuroscience folder",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  function makeGateway() {
    const saved: Array<Record<string, unknown>> = [];
    const gateway = {
      getCollectionSummary: (collectionId: number) => ({
        collectionId,
        name: "Neuroscience",
        libraryID: 1,
        path: "Neuroscience",
      }),
      getItem: () => null,
      getActiveNoteSnapshot: () => null,
      saveAnswerToNote: async (params: Record<string, unknown>) => {
        saved.push(params);
        return {
          status: "standalone_created" as const,
          noteId: 555,
          collections: params.collections as number[] | undefined,
        };
      },
      trashItems: async () => ({ trashedCount: 1, items: [] }),
    };
    return { gateway, saved };
  }

  it("accepts a collection target on note_write", function () {
    const { gateway } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "standalone",
      collections: [88],
    });
    assert.isTrue(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(
      (result.value as { collections?: number[] }).collections,
      [88],
    );
  });

  it("names the destination collection on the confirmation card", function () {
    const { gateway } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "standalone",
      collections: [88],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;
    const pending = tool.createPendingAction?.(result.value, context);
    assert.include(
      pending?.description || "",
      "Neuroscience",
      "the user must see where the note is going before approving",
    );
  });

  it("files the note and returns its id through the mutation service", async function () {
    const { gateway, saved } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      {
        type: "save_note",
        content: "The answer.",
        target: "standalone",
        collections: [88],
      },
      context,
    );

    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].collections, [88], "the collection must reach the gateway");

    const result = (outcome.result as { result: Record<string, unknown> }).result;
    assert.equal(result.noteId, 555, "the note id must survive the trip back up");
    assert.deepEqual(result.collections, [88]);
    assert.exists(outcome.undo, "creating a note must be undoable");
  });

  it("treats a collection request as standalone even when target says item", async function () {
    const { gateway, saved } = makeGateway();
    const tool = createEditCurrentNoteTool(gateway as never);
    const result = tool.validate({
      mode: "create",
      content: "The answer.",
      target: "item",
      collections: [88],
    });
    assert.isTrue(result.ok);
    if (!result.ok) return;

    await tool.execute(result.value, context);

    assert.equal(saved.length, 1);
    assert.equal(
      saved[0].target,
      "standalone",
      "a child note cannot be a collection member, so the collection wins",
    );
    assert.deepEqual(saved[0].collections, [88]);
  });
});
