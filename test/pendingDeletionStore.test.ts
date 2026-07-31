import { assert } from "chai";
import {
  pendingDeletionStore,
  configurePendingDeletionFinalizers,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
  DELETION_UNDO_WINDOW_MS,
  MAX_FINALIZE_ATTEMPTS,
  PENDING_DELETIONS_TABLE,
} from "../src/core/conversations/pendingDeletionStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type FakeTimer = { fn: () => void; delayMs: number; cleared: boolean };

function installFakeEnv() {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const rows: Array<Record<string, unknown>> = [];
  const timers: FakeTimer[] = [];
  let nowMs = 1_000_000;
  globalScope.Zotero = {
    ...(originalZotero || {}),
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.trimStart().toUpperCase().startsWith("SELECT")) return rows;
        return [];
      },
    },
  };
  configurePendingDeletionStoreEnv({
    now: () => nowMs,
    setTimer: (fn, delayMs) => {
      const t: FakeTimer = { fn, delayMs, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (handle) => {
      const t = handle as FakeTimer | null;
      if (t) t.cleared = true;
    },
    log: () => {},
  });
  return {
    queries,
    rows,
    timers,
    advance(ms: number) {
      nowMs += ms;
    },
    fireLastTimer() {
      const live = timers.filter((t) => !t.cleared);
      const t = live[live.length - 1];
      assert.isOk(t, "expected a live timer");
      t!.cleared = true;
      t!.fn();
    },
  };
}

function conversationInput(key: number, overrides: Record<string, unknown> = {}) {
  return {
    conversationKind: "global" as const,
    conversationID: `lfz:test:upstream:global:lib-1:paper-0:legacy-${key}`,
    conversationKey: key,
    libraryID: 1,
    system: "upstream" as const,
    title: `Chat ${key}`,
    wasActive: false,
    ...overrides,
  };
}

describe("pendingDeletionStore", function () {
  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("queue writes the row before notifying and hides the conversation", async function () {
    const env = installFakeEnv();
    const events: string[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    const stop = pendingDeletionStore.subscribe((e) => {
      const inserted = env.queries.some((q) =>
        q.sql.includes(`INSERT INTO ${PENDING_DELETIONS_TABLE}`),
      );
      events.push(`${e.type}:${inserted ? "after-insert" : "BEFORE-INSERT"}`);
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    stop();
    assert.isOk(entry);
    assert.equal(entry!.expiresAt, entry!.queuedAt + DELETION_UNDO_WINDOW_MS);
    assert.deepEqual(events, ["queued:after-insert"]);
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.isTrue(pendingDeletionStore.getPendingConversationKeys().has(42));
  });

  it("undo removes the row, never calls the finalizer, and restores visibility", async function () {
    const env = installFakeEnv();
    let finalized = 0;
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        finalized += 1;
        return true;
      },
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    const undone = await pendingDeletionStore.undo(entry!.id);
    assert.equal(undone!.id, entry!.id);
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.isTrue(
      env.queries.some((q) =>
        q.sql.includes(`DELETE FROM ${PENDING_DELETIONS_TABLE}`),
      ),
    );
    const liveTimers = env.timers.filter((t) => !t.cleared);
    assert.lengthOf(liveTimers, 0);
    assert.equal(finalized, 0);
    assert.isNull(pendingDeletionStore.getLatestPending());
  });

  it("timer expiry finalizes exactly once and deletes the row", async function () {
    const env = installFakeEnv();
    let finalized = 0;
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        finalized += 1;
        return true;
      },
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    env.advance(DELETION_UNDO_WINDOW_MS + 1);
    env.fireLastTimer();
    await pendingDeletionStore.finalize(entry!.id, "test-again");
    assert.equal(finalized, 1);
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.isTrue(
      env.queries.some((q) =>
        q.sql.includes(`DELETE FROM ${PENDING_DELETIONS_TABLE}`),
      ),
    );
  });

  it("queueing a different conversation supersedes (finalizes) the previous pending", async function () {
    installFakeEnv();
    const finalizedKeys: number[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async (entry) => {
        finalizedKeys.push(entry.conversationKey);
        return true;
      },
      finalizeTurn: async () => true,
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    await pendingDeletionStore.queueConversationDeletion(conversationInput(2));
    assert.deepEqual(finalizedKeys, [1]);
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(1));
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(2));
  });

  it("re-queueing the same conversation returns the existing entry", async function () {
    installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    const a = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(7),
    );
    const b = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(7),
    );
    assert.equal(a!.id, b!.id);
  });

  it("INSERT failure yields null and no pending state", async function () {
    const env = installFakeEnv();
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (sql.includes("INSERT INTO")) throw new Error("disk full");
        return [];
      };
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(9),
    );
    assert.isNull(entry);
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(9));
    assert.lengthOf(
      env.timers.filter((t) => !t.cleared),
      0,
    );
  });

  it("turn entries expose message-level hiding", async function () {
    installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 111,
      assistantTimestamp: 222,
    });
    assert.isOk(entry);
    assert.isTrue(pendingDeletionStore.isMessageInPendingTurn(5, 111));
    assert.isTrue(pendingDeletionStore.isMessageInPendingTurn(5, 222.9));
    assert.isFalse(pendingDeletionStore.isMessageInPendingTurn(5, 333));
    assert.isFalse(pendingDeletionStore.isMessageInPendingTurn(6, 111));
    assert.isOk(pendingDeletionStore.findPendingTurn(5, 111, 222));
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(5));
  });

  it("finalize is idempotent for unknown ids", async function () {
    installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    assert.isTrue(await pendingDeletionStore.finalize("nope", "test"));
  });
});
