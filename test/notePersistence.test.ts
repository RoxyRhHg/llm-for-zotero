import { assert } from "chai";
import { createFinalizedZoteroNote } from "../src/modules/contextPanel/notePersistence";

describe("finalized Zotero note persistence", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: {
      Notifier?: {
        Queue: new () => FakeNotifierQueue;
        commit: (queue: FakeNotifierQueue) => Promise<void>;
      };
    };
  };
  const originalZotero = globalScope.Zotero;

  class FakeNotifierQueue {
    readonly events: Array<() => Promise<void>> = [];
  }

  class PersistentNote {
    id = 0;
    libraryID = 1;
    parentID?: number;
    noteHtml = "";
    persistedHtml = "";
    saveCalls = 0;
    skipPersistOnSaveCall = 0;
    returnFalseOnSaveCall = 0;
    observer?: () => Promise<void>;

    setNote(html: string): boolean {
      if (html === this.noteHtml) return false;
      this.noteHtml = html;
      return true;
    }

    getNote(): string {
      return this.noteHtml;
    }

    async saveTx(options?: {
      notifierQueue?: FakeNotifierQueue;
    }): Promise<number | boolean> {
      this.saveCalls += 1;
      const isNew = !this.id;
      if (isNew) this.id = 41;
      if (this.saveCalls !== this.skipPersistOnSaveCall) {
        this.persistedHtml = this.noteHtml;
      }
      if (isNew && options?.notifierQueue && this.observer) {
        options.notifierQueue.events.push(this.observer);
      }
      if (!isNew && this.saveCalls === this.returnFalseOnSaveCall) {
        return false;
      }
      return isNew ? this.id : true;
    }

    async reload(): Promise<void> {
      this.noteHtml = this.persistedHtml;
    }
  }

  beforeEach(function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Notifier: {
        Queue: FakeNotifierQueue,
        commit: async (queue) => {
          for (const event of queue.events) await event();
        },
      },
    };
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("persists text once and notifies observers only after final content exists", async function () {
    const note = new PersistentNote();
    const observedHtml: string[] = [];
    note.observer = async () => {
      observedHtml.push(note.persistedHtml);
    };

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Complete text note</p>",
    });

    assert.equal(result.noteId, 41);
    assert.equal(note.saveCalls, 1);
    assert.equal(note.persistedHtml, "<p>Complete text note</p>");
    assert.deepEqual(observedHtml, ["<p>Complete text note</p>"]);
  });

  it("hides useful fallback and final asset writes behind one notification queue", async function () {
    const note = new PersistentNote();
    const observedHtml: string[] = [];
    note.observer = async () => {
      observedHtml.push(note.persistedHtml);
    };

    await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Complete text without the image</p>",
      finalize: async () =>
        '<p>Complete text <img data-attachment-key="A1" /></p>',
    });

    assert.equal(note.saveCalls, 2);
    assert.equal(
      note.persistedHtml,
      '<p>Complete text <img data-attachment-key="A1" /></p>',
    );
    assert.deepEqual(observedHtml, [
      '<p>Complete text <img data-attachment-key="A1" /></p>',
    ]);
  });

  it("detects a silent lost final write and retries after a forced reload", async function () {
    const note = new PersistentNote();
    note.skipPersistOnSaveCall = 2;

    await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Text fallback</p>",
      finalize: async () => "<p>Final note with image</p>",
    });

    assert.equal(note.saveCalls, 3);
    assert.equal(note.persistedHtml, "<p>Final note with image</p>");
  });

  it("treats a false save result as unverified when reload is unavailable", async function () {
    const note = new PersistentNote();
    note.skipPersistOnSaveCall = 2;
    note.returnFalseOnSaveCall = 2;
    (note as PersistentNote & { reload?: undefined }).reload = undefined;

    await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Text fallback</p>",
      finalize: async () => "<p>Final note with image</p>",
    });

    assert.equal(note.saveCalls, 3);
    assert.equal(note.persistedHtml, "<p>Final note with image</p>");
  });

  it("keeps useful text and reports a warning when asset finalization throws", async function () {
    const note = new PersistentNote();

    const result = await createFinalizedZoteroNote({
      note: note as unknown as Zotero.Item,
      initialHtml: "<p>Useful text fallback</p>",
      finalize: async () => {
        throw new Error("image import failed");
      },
      log: () => {
        throw new Error("diagnostic logger failed");
      },
    });

    assert.equal(note.saveCalls, 1);
    assert.equal(note.persistedHtml, "<p>Useful text fallback</p>");
    assert.deepEqual(result.warnings, [
      "Note asset finalization failed: image import failed",
    ]);
  });
});
