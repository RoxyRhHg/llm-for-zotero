import { assert } from "chai";
import * as mineruProcessingStatus from "../src/modules/mineruProcessingStatus";
import {
  clearAllStatuses,
  getMineruStatus,
  setItemFailed,
  setItemProcessing,
} from "../src/modules/mineruProcessingStatus";
import { writeMineruCacheFiles } from "../src/modules/contextPanel/mineruCache";

type MockItem = {
  id: number;
  key: string;
  libraryID: number;
  attachmentContentType: string;
  isAttachment: () => boolean;
};

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "") || "/";
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function addDir(dirs: Set<string>, path: string): void {
  let current = normalizePath(path);
  const ancestors: string[] = [];
  while (current && current !== "/") {
    ancestors.push(current);
    current = parentPath(current);
  }
  ancestors.push("/");
  for (const dir of ancestors.reverse()) dirs.add(dir);
}

function createPdf(id = 42): MockItem {
  return {
    id,
    key: `PDF${id}`,
    libraryID: 1,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
  };
}

function setupZotero(item: MockItem): void {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  addDir(dirs, "/tmp/zotero");

  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Prefs: {
      get: (key: string) => {
        if (key.endsWith(".mineruSyncEnabled")) return false;
        return "";
      },
      set: () => undefined,
    },
    Items: {
      get: (id: number) => (id === item.id ? item : null),
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => undefined,
  };
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = {
    exists: async (path: string) => {
      const normalized = normalizePath(path);
      return files.has(normalized) || dirs.has(normalized);
    },
    read: async (path: string) => {
      const data = files.get(normalizePath(path));
      if (!data) throw new Error("missing");
      return data;
    },
    makeDirectory: async (path: string) => {
      addDir(dirs, path);
    },
    write: async (path: string, data: Uint8Array) => {
      const normalized = normalizePath(path);
      addDir(dirs, parentPath(normalized));
      files.set(normalized, data);
    },
  };
}

describe("mineruProcessingStatus", function () {
  afterEach(function () {
    clearAllStatuses();
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
  });

  it("reports cached when a stale failed status has a local cache", async function () {
    const pdf = createPdf();
    setupZotero(pdf);
    await writeMineruCacheFiles(pdf.id, "# Cached", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    setItemFailed(pdf.id, "previous parse failed");

    assert.equal(await getMineruStatus(pdf.id), "cached");
  });

  it("keeps active processing ahead of available cache", async function () {
    const pdf = createPdf();
    setupZotero(pdf);
    await writeMineruCacheFiles(pdf.id, "# Cached", [
      { relativePath: "content_list.json", data: bytes("[]") },
    ]);
    setItemProcessing(pdf.id);

    assert.equal(await getMineruStatus(pdf.id), "processing");
  });

  it("reports failed when no cache is available", async function () {
    const pdf = createPdf();
    setupZotero(pdf);
    setItemFailed(pdf.id, "parse failed");

    assert.equal(await getMineruStatus(pdf.id), "failed");
  });

  it("shares one in-flight attachment task across concurrent callers", async function () {
    const runOnce = (
      mineruProcessingStatus as unknown as {
        runMineruTaskOnce?: <T>(
          attachmentId: number,
          task: (report: (stage: string) => void) => Promise<T>,
          onProgress?: (stage: string) => void,
        ) => Promise<{ joined: boolean; value: T }>;
      }
    ).runMineruTaskOnce;
    assert.isFunction(runOnce);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const firstProgress: string[] = [];
    const secondProgress: string[] = [];
    const first = runOnce!(
      42,
      async (report) => {
        executions++;
        report("server processing");
        await gate;
        return "cached";
      },
      (stage) => firstProgress.push(stage),
    );
    await Promise.resolve();
    const second = runOnce!(
      42,
      async () => {
        executions++;
        return "duplicate";
      },
      (stage) => secondProgress.push(stage),
    );

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(executions, 1);
    assert.deepEqual(firstResult, { joined: false, value: "cached" });
    assert.deepEqual(secondResult, { joined: true, value: "cached" });
    assert.deepEqual(firstProgress, ["server processing"]);
    assert.deepEqual(secondProgress, ["server processing"]);
  });
});
