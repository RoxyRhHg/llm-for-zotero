import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";

/**
 * `delete_collection` calls `eraseTx`, which is permanent — Zotero has no
 * trash for collections. It previously recorded no undo at all, so a
 * mis-targeted delete was unrecoverable.
 */
describe("delete_collection reversibility", function () {
  function makeGateway(overrides: Record<string, unknown> = {}) {
    const calls: { deleted: number[]; created: unknown[]; added: unknown[] } = {
      deleted: [],
      created: [],
      added: [],
    };
    const gateway = {
      snapshotCollectionForDelete: () => ({
        name: "Neuro",
        parentCollectionId: 5,
        libraryID: 1,
        itemIds: [11, 12],
        childCollectionCount: 0,
      }),
      deleteCollection: async ({ collectionId }: { collectionId: number }) => {
        calls.deleted.push(collectionId);
      },
      createCollection: async (params: unknown) => {
        calls.created.push(params);
        return { collectionId: 99, name: "Neuro", libraryID: 1, path: "Neuro" };
      },
      addItemsToCollections: async (params: unknown) => {
        calls.added.push(params);
        return {
          selectedCount: 2,
          movedCount: 2,
          skippedCount: 0,
          collections: [],
          items: [],
        };
      },
      ...overrides,
    };
    return { gateway, calls };
  }

  const context = { request: { conversationKey: 1, libraryID: 1 } } as never;

  it("records an undo that recreates the collection and its membership", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "delete_collection", collectionId: 42 },
      context,
    );

    assert.deepEqual(calls.deleted, [42]);
    assert.exists(outcome.undo, "a permanent delete must record an inverse");

    await outcome.undo?.revert();
    assert.deepEqual(calls.created, [
      { name: "Neuro", parentCollectionId: 5, libraryID: 1 },
    ]);
    assert.deepEqual(calls.added, [
      {
        assignments: [
          { itemId: 11, targetCollectionId: 99 },
          { itemId: 12, targetCollectionId: 99 },
        ],
      },
    ]);
  });

  it("refuses to delete a collection with subcollections it cannot restore", async function () {
    const { gateway, calls } = makeGateway({
      snapshotCollectionForDelete: () => ({
        name: "Parent",
        libraryID: 1,
        itemIds: [],
        childCollectionCount: 2,
      }),
    });
    const service = new LibraryMutationService(gateway as never);

    let message = "";
    try {
      await service.executeOperation(
        { type: "delete_collection", collectionId: 7 },
        context,
      );
      assert.fail("expected the delete to be refused");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    assert.include(message, "subcollection");
    assert.deepEqual(calls.deleted, [], "nothing may be erased on refusal");
  });
});
