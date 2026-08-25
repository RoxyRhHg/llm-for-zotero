import { assert } from "chai";
import {
  libraryMutationHandlers,
  type LibraryMutationOperationType,
} from "../src/agent/services/libraryMutation/handlerRegistry";

describe("library mutation handler registry", function () {
  const operationTypes = [
    "update_metadata",
    "apply_tags",
    "remove_tags",
    "move_to_collection",
    "remove_from_collection",
    "create_collection",
    "set_item_collections",
    "save_notes_batch",
    "save_saved_search",
    "delete_saved_search",
    "update_collection",
    "update_library_tag",
    "set_item_tags",
    "create_items",
    "reparent_items",
    "relate_items",
    "delete_collection",
    "save_note",
    "import_identifiers",
    "trash_items",
    "restore_from_trash",
    "merge_items",
    "delete_attachment",
    "rename_attachment",
    "relink_attachment",
    "import_local_files",
  ] satisfies LibraryMutationOperationType[];

  it("registers every operation exactly once with its safety capabilities", function () {
    assert.sameMembers(Object.keys(libraryMutationHandlers), operationTypes);
    for (const type of operationTypes) {
      const handler = libraryMutationHandlers[type];
      assert.strictEqual(handler.type, type);
      assert.isFunction(handler.validate);
      assert.isFunction(handler.targetCount);
      assert.isFunction(handler.affectedCount);
      assert.isFunction(handler.atomize);
      assert.isArray(handler.stateSections);
      assert.isFunction(handler.deferredInverse);
      assert.isFunction(handler.planInverse);
      assert.isFunction(handler.inverseSatisfied);
      assert.isFunction(handler.execute);
      assert.include(["state-aware", "forward-only"], handler.replay);
      assert.include(
        [
          "item-metadata-tags-relations",
          "collection-search-structure",
          "notes-lifecycle",
          "attachments-imports",
        ],
        handler.executionDomain,
      );
    }
  });
});
