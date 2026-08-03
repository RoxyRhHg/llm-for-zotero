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

function conversationInput(
  key: number,
  overrides: Record<string, unknown> = {},
) {
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
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

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

  it("failed finalize retries with attempts, then gives up at the cap and restores visibility", async function () {
    const env = installFakeEnv();
    let calls = 0;
    const events: string[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        calls += 1;
        return false;
      },
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    const stop = pendingDeletionStore.subscribe((e) => events.push(e.type));
    for (let round = 0; round < MAX_FINALIZE_ATTEMPTS; round++) {
      env.fireLastTimer();
      await pendingDeletionStore.finalize("flush-barrier", "noop");
    }
    stop();
    assert.equal(calls, MAX_FINALIZE_ATTEMPTS);
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.equal(events[events.length - 1], "gave-up");
    assert.isTrue(env.queries.some((q) => q.sql.includes("SET attempts = ?")));
    assert.isOk(entry);
  });

  it("sweepAllPersisted finalizes leftover rows from a previous session", async function () {
    const env = installFakeEnv();
    env.rows.push(
      {
        id: "pd-old-1",
        kind: "conversation",
        conversation_id: "lfz:x:upstream:global:lib-1:paper-0:legacy-11",
        conversation_key: 11,
        system: "upstream",
        payload: JSON.stringify({
          conversationKind: "global",
          libraryID: 1,
          title: "Leftover chat",
          wasActive: false,
        }),
        queued_at: 1,
        expires_at: 2,
        attempts: 0,
      },
      {
        id: "pd-old-2",
        kind: "turn",
        conversation_id: null,
        conversation_key: 12,
        system: "claude_code",
        payload: JSON.stringify({
          userTimestamp: 100,
          assistantTimestamp: 200,
        }),
        queued_at: 1,
        expires_at: 2,
        attempts: 0,
      },
    );
    const finalized: string[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async (entry) => {
        finalized.push(`conversation:${entry.conversationKey}`);
        return true;
      },
      finalizeTurn: async (entry) => {
        finalized.push(`turn:${entry.conversationKey}`);
        return true;
      },
    });
    await pendingDeletionStore.sweepAllPersisted("startup");
    assert.deepEqual(finalized, ["conversation:11", "turn:12"]);
    assert.isNull(pendingDeletionStore.getLatestPending());
    assert.isTrue(
      env.queries.filter((q) => q.sql.includes("DELETE FROM")).length >= 2,
    );
  });

  it("sweepExpired finalizes only entries past their window", async function () {
    const env = installFakeEnv();
    const finalizedKeys: number[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async (entry) => {
        finalizedKeys.push(entry.conversationKey);
        return true;
      },
      finalizeTurn: async () => true,
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(1));
    env.advance(DELETION_UNDO_WINDOW_MS + 1);
    await pendingDeletionStore.sweepExpired("opportunistic");
    assert.deepEqual(finalizedKeys, [1]);
    await pendingDeletionStore.queueConversationDeletion(conversationInput(2));
    await pendingDeletionStore.sweepExpired("opportunistic");
    assert.deepEqual(finalizedKeys, [1]);
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(2));
  });

  it("finalizeForConversation finalizes both kinds for that conversation only", async function () {
    installFakeEnv();
    const finalized: string[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async (entry) => {
        finalized.push(`conversation:${entry.conversationKey}`);
        return true;
      },
      finalizeTurn: async (entry) => {
        finalized.push(`turn:${entry.conversationKey}`);
        return true;
      },
    });
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 1,
      assistantTimestamp: 2,
    });
    await pendingDeletionStore.finalizeForConversation(5, "clear-button");
    await pendingDeletionStore.finalizeForConversation(99, "clear-button");
    assert.deepEqual(finalized, ["turn:5"]);
  });

  it("finalizeForConversation propagates failure and success", async function () {
    installFakeEnv();
    let fail = true;
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => !fail,
    });
    const entry = await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 7,
      system: "upstream",
      userTimestamp: 1,
      assistantTimestamp: 2,
    });
    assert.isOk(entry);
    assert.isFalse(
      await pendingDeletionStore.finalizeForConversation(7, "send"),
      "failed finalize must propagate false",
    );
    assert.lengthOf(
      pendingDeletionStore.getPendingTurnsForConversation(7),
      1,
      "failed entry stays pending",
    );
    fail = false;
    assert.isTrue(
      await pendingDeletionStore.finalizeForConversation(7, "send"),
      "successful finalize must propagate true",
    );
    assert.lengthOf(pendingDeletionStore.getPendingTurnsForConversation(7), 0);
    assert.isTrue(
      await pendingDeletionStore.finalizeForConversation(7, "send"),
      "no matching entries counts as finalized",
    );
  });
});

describe("pendingDeletionStore hardening", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  function installEnv() {
    const env = installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    return env;
  }

  it("undo keeps the entry pending and returns null when the row DELETE fails", async function () {
    const env = installEnv();
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (sql.includes("DELETE FROM")) throw new Error("disk error");
        return [];
      };
    const undone = await pendingDeletionStore.undo(entry!.id);
    assert.isNull(undone, "a failed withdraw must not look like a restore");
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "entry must stay pending so state matches the surviving row",
    );
    assert.isOk(pendingDeletionStore.getLatestPending());
  });

  it("finalize without configured finalizers re-arms a retry timer", async function () {
    // Env configured but finalizers deliberately left unset: the sweep loads
    // the row into memory, cannot finalize it, and must keep a heartbeat.
    const env3 = installFakeEnv();
    env3.rows.push({
      id: "pd-nofin",
      kind: "conversation",
      conversation_id: null,
      conversation_key: 7,
      system: "upstream",
      payload: JSON.stringify({
        conversationKind: "global",
        libraryID: 1,
        title: "x",
        wasActive: false,
      }),
      queued_at: 1,
      expires_at: 2,
      attempts: 0,
    });
    await pendingDeletionStore.sweepAllPersisted("startup");
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(7),
      "entry stays pending when no finalizers exist",
    );
    assert.isAtLeast(
      env3.timers.filter((t) => !t.cleared).length,
      1,
      "a retry timer must be re-armed so the entry cannot strand",
    );
  });

  it("role-aware turn hiding does not hide the other role on a timestamp collision", async function () {
    installEnv();
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
    });
    assert.isTrue(pendingDeletionStore.isMessageInPendingTurn(5, 100, "user"));
    assert.isFalse(
      pendingDeletionStore.isMessageInPendingTurn(5, 100, "assistant"),
      "an assistant message sharing the user timestamp stays visible",
    );
    assert.isTrue(
      pendingDeletionStore.isMessageInPendingTurn(5, 200, "assistant"),
    );
    assert.isFalse(pendingDeletionStore.isMessageInPendingTurn(5, 200, "user"));
    assert.isTrue(
      pendingDeletionStore.isMessageInPendingTurn(5, 100),
      "role-less lookup keeps matching either endpoint",
    );
  });

  it("getPendingTurnsForConversation returns retained entries for that conversation only", async function () {
    installEnv();
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
    });
    assert.lengthOf(pendingDeletionStore.getPendingTurnsForConversation(5), 1);
    assert.lengthOf(pendingDeletionStore.getPendingTurnsForConversation(6), 0);
  });
});
