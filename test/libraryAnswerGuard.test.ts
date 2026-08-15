import { assert } from "chai";
import {
  findLibraryRetrieveShallowSignal,
  isEvidenceSeekingTurn,
} from "../src/agent/model/libraryAnswerGuard";

describe("libraryAnswerGuard", function () {
  describe("isEvidenceSeekingTurn", function () {
    it("detects English and CJK evidence questions heuristically", function () {
      assert.isTrue(
        isEvidenceSeekingTurn({
          userText: "Which papers use calcium imaging?",
        }),
      );
      assert.isTrue(
        isEvidenceSeekingTurn({ userText: "这些论文用了什么方法" }),
      );
      assert.isTrue(isEvidenceSeekingTurn({ userText: "총 요약해줘" }));
    });

    it("treats pure operations as non-evidence turns", function () {
      assert.isFalse(
        isEvidenceSeekingTurn({ userText: "tag every item with drift-2024" }),
      );
      assert.isFalse(isEvidenceSeekingTurn({ userText: "" }));
    });

    it("prefers the classified intent over heuristics", function () {
      assert.isFalse(
        isEvidenceSeekingTurn({
          userText: "Which papers use calcium imaging?",
          classifiedIntent: { retrievalIntent: "none", wantedSections: [] },
        }),
      );
      assert.isTrue(
        isEvidenceSeekingTurn({
          userText: "move these",
          classifiedIntent: {
            retrievalIntent: "enumerate",
            wantedSections: [],
          },
        }),
      );
    });
  });

  describe("findLibraryRetrieveShallowSignal", function () {
    it("reports no signal for an empty record list", function () {
      assert.deepEqual(findLibraryRetrieveShallowSignal([]), {
        ranRetrieveFamily: false,
        lastRetrieveShallow: false,
      });
    });

    it("counts successful retrieve-family tools and ignores failures", function () {
      const signal = findLibraryRetrieveShallowSignal([
        { name: "library_search", ok: true },
        { name: "library_retrieve", ok: false },
      ]);

      assert.isTrue(signal.ranRetrieveFamily);
      assert.isFalse(signal.lastRetrieveShallow);
    });

    it("flags the last retrieve as shallow when body coverage is zero with readable papers", function () {
      const signal = findLibraryRetrieveShallowSignal([
        {
          name: "library_retrieve",
          ok: true,
          content: {
            answerContract: { papersBodyRead: 0, papersPlanned: 5 },
            resourcePool: { states: { textAvailable: 5 } },
          },
        },
      ]);

      assert.isTrue(signal.lastRetrieveShallow);
    });

    it("does not flag body-covered retrieves", function () {
      const signal = findLibraryRetrieveShallowSignal([
        {
          name: "library_retrieve",
          ok: true,
          content: {
            answerContract: { papersBodyRead: 3, papersPlanned: 5 },
            resourcePool: { states: { textAvailable: 5 } },
          },
        },
      ]);

      assert.isFalse(signal.lastRetrieveShallow);
    });
  });
});
