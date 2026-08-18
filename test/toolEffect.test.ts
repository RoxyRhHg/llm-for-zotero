import { assert } from "chai";
import { deriveToolEffect } from "../src/agent/tools/effect";

/**
 * A write that changed nothing used to be indistinguishable from a write that
 * changed everything: the registry stamped `ok: true` and the trace showed a
 * constant "Library updated". `effect` is what makes them different — while
 * leaving `ok` alone, because `ok` gates the review loop and the error
 * breaker.
 */
describe("deriveToolEffect", function () {
  it("reads the per-row ledger the gateway already returns", function () {
    assert.equal(
      deriveToolEffect({
        items: [{ status: "moved" }, { status: "moved" }],
        movedCount: 2,
      }),
      "applied",
    );
    assert.equal(
      deriveToolEffect({
        items: [
          { status: "moved" },
          { status: "missing", reason: "wrong type" },
        ],
        movedCount: 1,
      }),
      "partial",
    );
    assert.equal(
      deriveToolEffect({
        items: [{ status: "missing" }, { status: "skipped" }],
        movedCount: 0,
      }),
      "none",
      "the zero-effect move that reported success in issue #374",
    );
  });

  it("unwraps the mutation service envelope, including nested results", function () {
    assert.equal(
      deriveToolEffect({
        operation: "move_to_collection",
        result: { items: [{ status: "missing" }], movedCount: 0 },
      }),
      "none",
    );
    assert.equal(
      deriveToolEffect({
        operation: "create_collection",
        result: {
          result: { collection: { collectionId: 3 } },
          status: "created",
        },
      }),
      "applied",
    );
  });

  it("falls back to counts when there is no row ledger", function () {
    assert.equal(deriveToolEffect({ trashedCount: 3 }), "applied");
    assert.equal(deriveToolEffect({ trashedCount: 0 }), "none");
    assert.equal(deriveToolEffect({ succeeded: 8, failed: 2 }), "partial");
    assert.equal(deriveToolEffect({ succeeded: 10, failed: 0 }), "applied");
    assert.equal(deriveToolEffect({ succeeded: 0, failed: 5 }), "none");
  });

  it("treats single-object statuses as applied", function () {
    assert.equal(
      deriveToolEffect({ status: "standalone_created", noteId: 5 }),
      "applied",
    );
    assert.equal(
      deriveToolEffect({ status: "deleted", collectionId: 9 }),
      "applied",
    );
  });

  it("returns undefined when nothing granular is reported", function () {
    assert.isUndefined(deriveToolEffect(null));
    assert.isUndefined(deriveToolEffect("done"));
    assert.isUndefined(deriveToolEffect({ someOtherShape: true }));
  });
});
