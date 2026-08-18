import { assert } from "chai";
import {
  LIBRARY_OBJECT_KINDS,
  LIBRARY_OPERATIONS,
  checkCapability,
  classifyLibraryItem,
  refusalFor,
} from "../src/agent/capabilities/libraryObjects";

/**
 * The point of the matrix is that it is *total*: every (operation x kind)
 * pair has a declared answer, so a capability nobody thought about fails
 * loudly here rather than silently doing nothing in production.
 */
describe("library capability matrix", function () {
  it("declares every operation for every object kind", function () {
    const undeclared: string[] = [];
    for (const kind of LIBRARY_OBJECT_KINDS) {
      for (const operation of LIBRARY_OPERATIONS) {
        if (checkCapability(operation, kind).status === "unmodelled") {
          undeclared.push(`${operation} x ${kind}`);
        }
      }
    }
    assert.deepEqual(
      undeclared,
      [],
      "every cell must be allowed or refused; add the missing ones to MATRIX",
    );
  });

  it("gives every refusal a non-empty, specific reason", function () {
    const vague: string[] = [];
    for (const kind of LIBRARY_OBJECT_KINDS) {
      for (const operation of LIBRARY_OPERATIONS) {
        const verdict = checkCapability(operation, kind);
        if (verdict.status !== "refused") continue;
        if (!verdict.reason || verdict.reason.length < 15) {
          vague.push(`${operation} x ${kind}: "${verdict.reason}"`);
        }
      }
    }
    assert.deepEqual(vague, [], "a refusal the agent cannot act on is a bug");
  });

  it("reports an undeclared pair as a gap, not as a policy refusal", function () {
    const verdict = checkCapability(
      "reparent" as never,
      "somethingNew" as never,
    );
    assert.equal(verdict.status, "unmodelled");
    assert.include(
      verdict.status === "unmodelled" ? verdict.reason : "",
      "zotero_script",
    );
  });

  describe("the cells issue #374 turned on", function () {
    it("lets a standalone note into a collection", function () {
      assert.equal(
        checkCapability("addToCollection", "standaloneNote").status,
        "allowed",
      );
    });

    it("lets a standalone attachment into a collection", function () {
      assert.equal(
        checkCapability("addToCollection", "standaloneAttachment").status,
        "allowed",
      );
    });

    it("refuses a child attachment with the data-model reason, not a redirect", function () {
      const verdict = checkCapability("addToCollection", "childAttachment");
      assert.equal(verdict.status, "refused");
      assert.include(
        verdict.status === "refused" ? verdict.reason : "",
        "top-level",
        "the old behaviour silently filed the PARENT instead",
      );
    });

    it("allows updating a child attachment, which carries its own tags", function () {
      assert.equal(
        checkCapability("update", "childAttachment").status,
        "allowed",
      );
    });
  });

  describe("classifyLibraryItem", function () {
    const item = (over: Record<string, unknown>) =>
      ({
        isAnnotation: () => false,
        isNote: () => false,
        isAttachment: () => false,
        isRegularItem: () => false,
        ...over,
      }) as never;

    it("splits notes and attachments by whether they are top-level", function () {
      assert.equal(classifyLibraryItem(item({ isNote: () => true })), "standaloneNote");
      assert.equal(
        classifyLibraryItem(item({ isNote: () => true, parentID: 5 })),
        "childNote",
      );
      assert.equal(
        classifyLibraryItem(item({ isAttachment: () => true })),
        "standaloneAttachment",
      );
      assert.equal(
        classifyLibraryItem(item({ isAttachment: () => true, parentID: 5 })),
        "childAttachment",
      );
    });

    it("checks annotations before attachments, since annotations report a parent", function () {
      assert.equal(
        classifyLibraryItem(
          item({ isAnnotation: () => true, isAttachment: () => true, parentID: 9 }),
        ),
        "annotation",
      );
    });

    it("returns null rather than guessing when nothing matches", function () {
      assert.isNull(classifyLibraryItem(item({})));
      assert.isNull(classifyLibraryItem(null));
    });
  });

  describe("refusalFor", function () {
    it("distinguishes a missing item from a wrong-kind item", function () {
      assert.include(refusalFor("addToCollection", null, 42) || "", "No item with ID 42");
      const childNote = {
        isAnnotation: () => false,
        isNote: () => true,
        isAttachment: () => false,
        isRegularItem: () => false,
        parentID: 7,
      } as never;
      const reason = refusalFor("addToCollection", childNote, 8) || "";
      assert.include(reason, "top-level");
      assert.notInclude(reason, "not found", "the item exists; saying otherwise is a lie");
    });

    it("returns null when the operation is allowed", function () {
      const note = {
        isAnnotation: () => false,
        isNote: () => true,
        isAttachment: () => false,
        isRegularItem: () => false,
      } as never;
      assert.isNull(refusalFor("addToCollection", note, 8));
    });
  });
});
