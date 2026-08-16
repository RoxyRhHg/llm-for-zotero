import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { locateQuoteInPageTexts } from "../src/modules/contextPanel/livePdfSelectionLocator";
import { summarizeQuoteTextSupport } from "../src/modules/contextPanel/quoteTextSearch";

/**
 * A quote a model wrote by stitching two passages of one paper together. This
 * is the ordinary case, not an edge case: writers quote by cutting.
 */
const FIRST_PASSAGE =
  "long-timescale changes in population activity occur orthogonally to the representation of context in network space";
const SECOND_PASSAGE =
  "allowing for a consistent readout of contextual information across many weeks of recording";
const STITCHED_QUOTE = `"${FIRST_PASSAGE}… ${SECOND_PASSAGE}."`;

function page(pageIndex: number, text: string) {
  return { pageIndex, pageLabel: `${pageIndex + 1}`, text };
}

const SOURCE_PAPER = [
  page(
    0,
    "Introduction. Representational drift has been reported across many cortical areas and in hippocampus.",
  ),
  page(
    1,
    `Results. We found that ${FIRST_PASSAGE}. Population geometry was preserved throughout. Across sessions this meant ${SECOND_PASSAGE}, which we quantified below.`,
  ),
  page(2, "Discussion. These results constrain models of stable readout."),
];

/** Shares one long phrase with the source, as a citing paper would. */
const DECOY_PAPER = [
  page(
    0,
    `Prior work showed that ${FIRST_PASSAGE}, a result we build on here with a different preparation and a different task.`,
  ),
  page(1, "We instead measured tuning stability under anaesthesia."),
];

describe("stitched quote navigation", function () {
  describe("summarizeQuoteTextSupport", function () {
    it("credits a paper for every piece of a stitched quote, not just the longest", function () {
      const support = summarizeQuoteTextSupport(
        SOURCE_PAPER.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        STITCHED_QUOTE,
      );

      assert.isAtLeast(
        support.coverage,
        0.8,
        "the source paper accounts for the whole quote",
      );
    });

    it("pools pieces that straddle a page break", function () {
      const split = [
        page(0, `Results. We found that ${FIRST_PASSAGE}.`),
        page(1, `Across sessions this meant ${SECOND_PASSAGE}.`),
      ];

      const support = summarizeQuoteTextSupport(
        split.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        STITCHED_QUOTE,
      );

      assert.isAtLeast(
        support.coverage,
        0.8,
        "a quote cut across a page break is still fully accounted for",
      );
    });

    it("does not credit a paper that only shares one passage", function () {
      const support = summarizeQuoteTextSupport(
        DECOY_PAPER.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        STITCHED_QUOTE,
      );

      assert.isBelow(
        support.coverage,
        0.8,
        "sharing one phrase must not make a paper the source",
      );
      assert.isAbove(support.coverage, 0, "the shared phrase is still counted");
    });

    it("reports nothing for a quote no source contains", function () {
      const support = summarizeQuoteTextSupport(
        SOURCE_PAPER.map((p) => ({ id: `page-${p.pageIndex}`, text: p.text })),
        '"the hippocampus maintains a dedicated subspace for grocery lists across decades"',
      );

      assert.equal(support.supportedQuoteTokenCount, 0);
      assert.equal(support.coverage, 0);
    });
  });

  describe("locateQuoteInPageTexts", function () {
    it("locates a stitched quote and reports how much of it the paper holds", function () {
      const result = locateQuoteInPageTexts(SOURCE_PAPER, STITCHED_QUOTE, null);

      assert.equal(result.status, "resolved");
      assert.equal(result.computedPageIndex, 1, "lands on the first piece");
      assert.isAtLeast(
        result.sourceMatchQuoteTokenSupportCoverage ?? 0,
        0.8,
        "the whole-document figure is what identifies the paper",
      );
    });

    it("still reports the weaker single-span figure alongside it", function () {
      const result = locateQuoteInPageTexts(SOURCE_PAPER, STITCHED_QUOTE, null);

      // Judging by this number alone is what wrongly rejected the real quote.
      const span = result.sourceMatchQuoteTokenCoverage;
      assert.isDefined(span);
      assert.isBelow(span as number, 1);
    });

    it("refuses a paper that merely quotes one of the passages", function () {
      const result = locateQuoteInPageTexts(DECOY_PAPER, STITCHED_QUOTE, null);

      const coverage =
        result.sourceMatchQuoteTokenSupportCoverage ??
        result.sourceMatchQuoteTokenCoverage ??
        1;
      assert.isBelow(
        coverage,
        0.8,
        "a shared passage must not authorise a jump",
      );
    });

    it("verifies an ellipsized quote piece by piece, landing on the first piece", function () {
      const first = "drift was confined to the null coding space throughout";
      const second =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, "Abstract. We summarise the main finding below."),
        page(1, `Results. We show that ${first}.`),
        page(2, `Discussion. Consequently ${second}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${first}… ${second}."`,
        null,
      );

      assert.equal(result.status, "resolved");
      assert.include(
        result.reason || "",
        "Every piece of the ellipsized quote",
      );
      assert.equal(
        result.computedPageIndex,
        1,
        "the reader lands where the quote starts",
      );
      assert.deepEqual(result.matchedPageIndexes, [1, 2]);
    });

    it("does not treat pieces found out of order as a verified assembly", function () {
      const first = "drift was confined to the null coding space throughout";
      const second =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, `Discussion. Consequently ${second}.`),
        page(1, `Results. We show that ${first}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${first}… ${second}."`,
        null,
      );

      assert.notInclude(
        result.reason || "",
        "Every piece of the ellipsized quote",
      );
    });

    it("does not treat an ambiguous piece as a verified assembly", function () {
      const repeated = "drift was confined to the null coding space throughout";
      const tail =
        "behavioural readout remained accurate over the full recording period";
      const pages = [
        page(0, `Abstract. We show that ${repeated}.`),
        page(1, `Results. We show that ${repeated}, and ${tail}.`),
      ];

      const result = locateQuoteInPageTexts(
        pages,
        `"${repeated}… ${tail}."`,
        null,
      );

      assert.notInclude(
        result.reason || "",
        "Every piece of the ellipsized quote",
        "a piece that appears twice cannot pin the assembly",
      );
    });
  });
});

describe("citation navigation contracts", function () {
  const source = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../src/modules/contextPanel/assistantCitationLinks.ts",
    ),
    "utf8",
  );

  it("asks the answer's own run before searching the library", function () {
    const navigateSection = source.slice(
      source.indexOf("async function navigateUntrustedQuoteCitation(params: {"),
      source.indexOf(
        "async function resolveAndNavigateAssistantCitation(params: {",
      ),
    );

    assert.include(navigateSection, "resolveRecordedQuoteSourceCandidate");
    // The recorded paper replaces the candidate list outright; nothing else is
    // read when the answer already said where the quote came from.
    assert.include(
      navigateSection,
      "recordedCandidate\n    ? [recordedCandidate]",
    );
    assert.isBelow(
      navigateSection.indexOf("resolveRecordedQuoteSourceCandidate"),
      navigateSection.indexOf("resolveCandidatesForCitationNavigation"),
    );
  });

  it("checks the chat's own collection before the rest of the library", function () {
    const searchSection = source.slice(
      source.indexOf(
        "async function resolveCitationCandidatesFromLibrarySearch(",
      ),
      source.indexOf("async function buildOrderedCitationCandidates("),
    );

    assert.include(searchSection, "scopeCollectionIds");
    assert.include(searchSection, "group.collectionIds.some(");
    // Scope outranks label agreement in the ordering.
    assert.isBelow(
      searchSection.indexOf("const scopeDelta"),
      searchSection.indexOf("const rankDelta"),
    );
  });

  it("judges a candidate on how much of the quote it accounts for", function () {
    const verifySection = source.slice(
      source.indexOf("function quoteSupportCoverage("),
      source.indexOf("async function locateQuoteByOpeningCitationCandidates("),
    );

    assert.include(
      verifySection,
      "sourceMatchQuoteTokenSupportCoverage",
      "the pooled figure, not the single longest span",
    );
    assert.include(verifySection, "MIN_NEAR_COMPLETE_QUOTE_SUPPORT_COVERAGE");
  });
});
