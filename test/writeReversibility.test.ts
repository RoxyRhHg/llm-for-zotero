import { assert } from "chai";
import {
  isIrreversibleWrite,
  writeNeedsConfirmation,
} from "../src/agent/capabilities/writeReversibility";
import { normalizeAgentLibraryWriteMode } from "../src/shared/agentLibraryWriteMode";
import { createManageCollectionsTool } from "../src/agent/tools/write/manageCollections";

/**
 * The agent used to confirm every library write. One request that created a
 * collection and filed a paper into it raised TWO cards; a three-step request
 * raised three. That is a wizard, not an agent — and confirming everything
 * stopped buying much safety once every reversible write gained a journalled,
 * working inverse.
 *
 * So the burden is now proportional to reversibility. These tests pin the
 * line, because getting it wrong in the permissive direction costs a user
 * their data.
 */
describe("write reversibility policy", function () {
  describe("what still has to be asked about", function () {
    it("treats an unrecognised tool as irreversible", function () {
      // The allowlist direction is the whole safety property: a write tool
      // added later confirms until someone deliberately says otherwise, so
      // forgetting to update the list costs a prompt, not data.
      assert.isTrue(isIrreversibleWrite("some_future_tool", {}));
    });

    it("asks before a permanent erase", function () {
      assert.isFalse(
        isIrreversibleWrite("collection_update", { action: "delete" }),
        "trashing a collection is reversible",
      );
      assert.isTrue(
        isIrreversibleWrite("collection_update", {
          action: "delete",
          permanent: true,
        }),
      );
    });

    it("asks before deleting a tag library-wide", function () {
      // Restoring the tag would not restore which items carried it.
      assert.isTrue(
        isIrreversibleWrite("library_update", {
          kind: "tag",
          action: "delete",
        }),
      );
      assert.isTrue(isIrreversibleWrite("tag_update", { action: "delete" }));
      // Removing a tag FROM items is a different, reversible operation.
      assert.isFalse(
        isIrreversibleWrite("library_update", {
          kind: "tags",
          action: "remove",
        }),
      );
    });

    it("asks before a merge", function () {
      // Zotero moves children onto the survivor and dedupes attachments by
      // hash, so the originals no longer exist to give back.
      assert.isTrue(isIrreversibleWrite("library_delete", { mode: "merge" }));
      assert.isTrue(isIrreversibleWrite("tag_update", { action: "merge" }));
    });

    it("asks when no durable pre-image is guaranteed", function () {
      assert.isTrue(
        isIrreversibleWrite("saved_search_update", {
          operation: { type: "save_saved_search", savedSearchId: 7 },
        }),
      );
      assert.isTrue(
        isIrreversibleWrite("attachment_update", { action: "relink" }),
      );
      assert.isTrue(isIrreversibleWrite("tag_update", { action: "setColor" }));
      assert.isTrue(isIrreversibleWrite("annotate_pdf", {}));
    });

    it("sees irreversible operations behind a delegating facade", function () {
      assert.isTrue(
        isIrreversibleWrite("library_update", {
          delegateName: "tag_update",
          delegateInput: {
            operation: { type: "update_library_tag", action: "merge" },
          },
        }),
      );
      assert.isTrue(
        isIrreversibleWrite("library_delete", {
          delegateName: "merge_items",
          delegateInput: { operation: { type: "merge_items" } },
        }),
      );
      assert.isTrue(
        isIrreversibleWrite("attachment_update", {
          operation: { type: "relink_attachment" },
        }),
      );
    });

    it("asks before a script or a shell command", function () {
      // These can do anything, including things this layer cannot model.
      assert.isTrue(isIrreversibleWrite("zotero_script", { mode: "write" }));
      assert.isTrue(isIrreversibleWrite("run_command", {}));
      assert.isTrue(isIrreversibleWrite("file_io", {}));
    });
  });

  describe("what now applies without interrupting the user", function () {
    const reversible: Array<[string, unknown]> = [
      ["collection_update", { action: "create", name: "X" }],
      ["collection_update", { action: "rename", collectionId: 1 }],
      ["library_update", { kind: "collections", action: "add" }],
      ["library_update", { kind: "collections", mode: "move", from: "all" }],
      ["library_update", { kind: "tags", action: "add" }],
      ["library_update", { kind: "metadata" }],
      ["library_update", { kind: "parent" }],
      ["library_update", { kind: "related" }],
      ["note_write", { mode: "create" }],
      ["note_write_batch", {}],
      ["library_import", { kind: "manual" }],
      ["library_import", { kind: "identifiers" }],
      ["library_delete", { mode: "trash" }],
      ["library_delete", { mode: "restore" }],
      ["attachment_update", { action: "rename" }],
      ["saved_search_update", { action: "save" }],
    ];

    for (const [toolName, input] of reversible) {
      it(`${toolName} ${JSON.stringify(input)}`, function () {
        assert.isFalse(isIrreversibleWrite(toolName, input));
      });
    }
  });

  /**
   * The policy runs on the tool's VALIDATED input, not on the model's raw
   * arguments, and `validate()` reshapes them — `{action:'delete',
   * permanent:true}` becomes `{operation:{type:'delete_collection',
   * permanent:true}}`. Asserting against a hand-written shape hid that: the
   * first version of this policy read only the top level and let a permanent
   * erase through with no card, which only driving the real UI revealed.
   */
  describe("against the shape tools actually produce", function () {
    function validatedDeleteInput(args: Record<string, unknown>) {
      const tool = createManageCollectionsTool({
        getCollectionSummary: () => null,
        snapshotCollectionForDelete: () => null,
      } as never);
      const result = tool.validate(args);
      assert.isTrue(result.ok, JSON.stringify(result));
      if (!result.ok) throw new Error("unreachable");
      return result.value;
    }

    it("sees permanent nested inside the validated operation", function () {
      const input = validatedDeleteInput({
        action: "delete",
        collectionId: 42,
        permanent: true,
      });
      // The flag lives at input.operation.permanent, not input.permanent.
      assert.isTrue(
        isIrreversibleWrite("collection_update", input),
        "a permanent erase must still be confirmed after validation reshapes it",
      );
    });

    it("still lets an ordinary trash through after validation", function () {
      const input = validatedDeleteInput({
        action: "delete",
        collectionId: 42,
      });
      assert.isFalse(isIrreversibleWrite("collection_update", input));
    });
  });

  describe("the mode decides how much of that the user sees", function () {
    const call = { toolName: "collection_update", input: { action: "create" } };
    const erase = {
      toolName: "collection_update",
      input: { action: "delete", permanent: true },
    };

    it("safe still reviews every write", function () {
      assert.isTrue(writeNeedsConfirmation({ mode: "safe", ...call }));
      assert.isTrue(writeNeedsConfirmation({ mode: "safe", ...erase }));
    });

    it("auto asks only about what cannot be undone", function () {
      assert.isFalse(writeNeedsConfirmation({ mode: "auto", ...call }));
      assert.isTrue(writeNeedsConfirmation({ mode: "auto", ...erase }));
    });

    it("yolo asks about nothing, including the irreversible", function () {
      assert.isFalse(writeNeedsConfirmation({ mode: "yolo", ...call }));
      assert.isFalse(writeNeedsConfirmation({ mode: "yolo", ...erase }));
    });

    it("always asks before resuming an interrupted batch", function () {
      assert.isTrue(
        writeNeedsConfirmation({
          mode: "yolo",
          toolName: "library_batch",
          input: { kind: "resume", resumeJobId: "batch-auto_tag-1" },
        }),
      );
    });
  });

  describe("the stored preference", function () {
    it("defaults to auto", function () {
      assert.equal(normalizeAgentLibraryWriteMode(undefined), "auto");
      assert.equal(normalizeAgentLibraryWriteMode("nonsense"), "auto");
    });

    it("still honours an explicit safe or yolo", function () {
      assert.equal(normalizeAgentLibraryWriteMode("safe"), "safe");
      assert.equal(normalizeAgentLibraryWriteMode("yolo"), "yolo");
    });
  });
});
