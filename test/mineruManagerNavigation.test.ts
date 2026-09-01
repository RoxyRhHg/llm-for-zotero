import { assert } from "chai";
import {
  clearMineruManagerNavigationForTests,
  collectMineruPdfAttachmentIds,
  hasPendingMineruManagerSelection,
  registerMineruManagerSelectionTarget,
  requestMineruManagerSelection,
} from "../src/modules/mineruManagerNavigation";

function attachment(id: number, contentType: string): Zotero.Item {
  return {
    id,
    isRegularItem: () => false,
    isAttachment: () => true,
    attachmentContentType: contentType,
  } as unknown as Zotero.Item;
}

function regularItem(id: number, attachmentIds: number[]): Zotero.Item {
  return {
    id,
    isRegularItem: () => true,
    isAttachment: () => false,
    getAttachments: () => attachmentIds,
  } as unknown as Zotero.Item;
}

describe("mineruManagerNavigation", function () {
  afterEach(function () {
    clearMineruManagerNavigationForTests();
  });

  it("collects PDF children and direct PDF selections without duplicates", function () {
    const pdfA = attachment(11, "application/pdf");
    const pdfB = attachment(12, "application/pdf");
    const html = attachment(13, "text/html");
    const itemById = new Map<number, Zotero.Item>([
      [11, pdfA],
      [12, pdfB],
      [13, html],
    ]);

    assert.deepEqual(
      collectMineruPdfAttachmentIds(
        [regularItem(1, [11, 12, 13]), pdfA],
        (id) => itemById.get(id),
      ),
      [11, 12],
    );
  });

  it("keeps a selection pending until a MinerU manager target is ready", function () {
    assert.isTrue(requestMineruManagerSelection([22, 21, 22]));
    assert.isTrue(hasPendingMineruManagerSelection());

    let received: readonly number[] = [];
    registerMineruManagerSelectionTarget((attachmentIds) => {
      received = [...attachmentIds];
      return true;
    });

    assert.deepEqual(received, [22, 21]);
    assert.isFalse(hasPendingMineruManagerSelection());
  });

  it("delivers a later selection immediately to an active manager", function () {
    const received: number[][] = [];
    const unregister = registerMineruManagerSelectionTarget((attachmentIds) => {
      received.push([...attachmentIds]);
      return true;
    });

    assert.isTrue(requestMineruManagerSelection([31, 32]));
    assert.deepEqual(received, [[31, 32]]);
    assert.isFalse(hasPendingMineruManagerSelection());

    unregister();
    assert.isTrue(requestMineruManagerSelection([33]));
    assert.isTrue(hasPendingMineruManagerSelection());
  });
});
