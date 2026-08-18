import { assert } from "chai";
import {
  buildLibraryOverviewSection,
  renderLibraryOverviewSection,
  setLibraryOverviewGateway,
} from "../src/agent/context/libraryOverview";
import {
  applySort,
  applyOffset,
} from "../src/agent/services/libraryQueryService";

/**
 * The system prompt described the user's machine in concrete detail — shell,
 * path separator, a worked `ls` example — and said nothing about the Zotero
 * library. Every request therefore started with a guess about which folders
 * exist and what they are called, which is why the agent ended up asking
 * users for a collection ID that Zotero itself never displays (issue #374).
 */
describe("library perception", function () {
  afterEach(function () {
    setLibraryOverviewGateway(null);
  });

  const gateway = {
    listAllLibraries: () => [
      { libraryID: 1, name: "My Library", editable: true },
      { libraryID: 4, name: "Lab Group", editable: false },
    ],
    listCollectionSummaries: () => [
      { collectionId: 12, name: "Neuroscience", libraryID: 1, path: "Neuroscience" },
      { collectionId: 13, name: "Methods", libraryID: 1, path: "Neuroscience > Methods" },
    ],
  } as never;

  it("names the active library and its collections with IDs", function () {
    const section = buildLibraryOverviewSection(gateway, 1);
    assert.include(section, "My Library");
    assert.include(section, "libraryID=1");
    assert.include(
      section,
      "Neuroscience (id=12)",
      "the ID is what stops the agent asking the user for a number",
    );
  });

  it("flags a read-only library the agent must not try to write to", function () {
    const section = buildLibraryOverviewSection(gateway, 4);
    assert.include(section, "READ-ONLY");
  });

  it("lists top-level collections only, pointing at the tree tool for depth", function () {
    const section = buildLibraryOverviewSection(gateway, 1);
    assert.include(section, "Neuroscience (id=12)");
    assert.notInclude(
      section,
      "Methods (id=13)",
      "nested collections belong to the tree tool, not the standing header",
    );
  });

  it("degrades to nothing when no gateway is registered", function () {
    setLibraryOverviewGateway(null);
    assert.equal(
      renderLibraryOverviewSection(1),
      "",
      "a missing enhancement must never be able to fail a turn",
    );
  });
});

/**
 * "The 50 most recently added papers" was not expressible: there was no sort
 * of any kind, and the limit was a head slice.
 */
describe("library_search ordering and paging", function () {
  const rows = [
    { itemId: 1, dateAdded: "2026-01-01", title: "Beta" },
    { itemId: 2, dateAdded: "2026-08-01", title: "Alpha" },
    { itemId: 3, dateAdded: "2026-04-01", title: "Gamma" },
  ];

  it("sorts newest first by default", function () {
    assert.deepEqual(
      applySort(rows, "dateAdded", undefined).map((r) => r.itemId),
      [2, 3, 1],
    );
  });

  it("honours an ascending request", function () {
    assert.deepEqual(
      applySort(rows, "dateAdded", "asc").map((r) => r.itemId),
      [1, 3, 2],
    );
  });

  it("sorts titles alphabetically", function () {
    assert.deepEqual(
      applySort(rows, "title", undefined).map((r) => r.itemId),
      [2, 1, 3],
    );
  });

  it("leaves the order alone for an unknown sort key", function () {
    assert.deepEqual(
      applySort(rows, "nonsense", undefined).map((r) => r.itemId),
      [1, 2, 3],
    );
  });

  it("sorts undated rows last in both directions", function () {
    const withGap = [...rows, { itemId: 4, dateAdded: "", title: "Delta" }];
    assert.equal(applySort(withGap, "dateAdded", "asc").at(-1)?.itemId, 4);
    assert.equal(applySort(withGap, "dateAdded", "desc").at(-1)?.itemId, 4);
  });

  it("takes a window so a chain can walk past its first page", function () {
    assert.deepEqual(
      applyOffset(rows, 2).map((r) => r.itemId),
      [3],
    );
    assert.deepEqual(applyOffset(rows, 0).map((r) => r.itemId), [1, 2, 3]);
  });
});
