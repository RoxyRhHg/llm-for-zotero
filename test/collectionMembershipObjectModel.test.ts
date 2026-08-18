import { assert } from "chai";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";

/**
 * The behaviour the capability matrix changed, at the layer a user feels it.
 *
 * Before: collection membership ran every item through a regular-item filter.
 * A standalone note was reported "Item not found" though it plainly existed,
 * and a child attachment silently filed its *parent* — a wrong-object write,
 * since Zotero collections hold top-level items only.
 */
describe("collection membership follows the object model", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  function makeItem(over: Record<string, unknown>) {
    const collections = new Set<number>();
    return {
      id: over.id,
      libraryID: 1,
      isAnnotation: () => false,
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => false,
      getDisplayTitle: () => `Item ${over.id}`,
      getField: () => "",
      getAttachments: () => [],
      getNotes: () => [],
      inCollection: (id: number) => collections.has(id),
      addToCollection: (id: number) => collections.add(id),
      removeFromCollection: (id: number) => collections.delete(id),
      saveTx: async () => undefined,
      collectionsSet: collections,
      ...over,
    };
  }

  function installZotero(items: Record<number, unknown>) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: { get: (id: number) => items[id] || null },
      Collections: {
        get: (id: number) =>
          id === 88
            ? {
                id: 88,
                name: "Target",
                libraryID: 1,
                parentID: undefined,
              }
            : null,
      },
    };
  }

  it("files a standalone note, which the old filter rejected outright", async function () {
    const note = makeItem({ id: 11, isNote: () => true });
    installZotero({ 11: note });

    const result = await new ZoteroGateway().addItemsToCollections({
      assignments: [{ itemId: 11, targetCollectionId: 88 }],
    });

    assert.equal(result.movedCount, 1, "a standalone note is a legal member");
    assert.isTrue(note.collectionsSet.has(88));
    assert.equal(result.items[0]?.status, "moved");
  });

  it("files a standalone attachment", async function () {
    const attachment = makeItem({ id: 12, isAttachment: () => true });
    installZotero({ 12: attachment });

    const result = await new ZoteroGateway().addItemsToCollections({
      assignments: [{ itemId: 12, targetCollectionId: 88 }],
    });

    assert.equal(result.movedCount, 1);
    assert.isTrue(attachment.collectionsSet.has(88));
  });

  it("refuses a child attachment instead of silently filing its parent", async function () {
    const parent = makeItem({ id: 20, isRegularItem: () => true });
    const child = makeItem({
      id: 21,
      isAttachment: () => true,
      parentID: 20,
    });
    installZotero({ 20: parent, 21: child });

    const result = await new ZoteroGateway().addItemsToCollections({
      assignments: [{ itemId: 21, targetCollectionId: 88 }],
    });

    assert.equal(result.movedCount, 0);
    assert.isFalse(
      parent.collectionsSet.has(88),
      "the parent must not be filed in the child's place",
    );
    const reason = result.items[0]?.reason || "";
    assert.include(reason, "parent item");
    assert.notInclude(
      reason,
      "not found",
      "the item exists; the old reason said otherwise",
    );
  });

  it("still files an ordinary regular item", async function () {
    const paper = makeItem({ id: 30, isRegularItem: () => true });
    installZotero({ 30: paper });

    const result = await new ZoteroGateway().addItemsToCollections({
      assignments: [{ itemId: 30, targetCollectionId: 88 }],
    });

    assert.equal(result.movedCount, 1);
    assert.isTrue(paper.collectionsSet.has(88));
  });

  it("reports a genuinely missing item as missing", async function () {
    installZotero({});

    const result = await new ZoteroGateway().addItemsToCollections({
      assignments: [{ itemId: 99, targetCollectionId: 88 }],
    });

    assert.equal(result.movedCount, 0);
    assert.include(result.items[0]?.reason || "", "No item with ID 99");
  });
});
