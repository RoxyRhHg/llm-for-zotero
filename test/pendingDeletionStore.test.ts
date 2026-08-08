import { assert } from "chai";
import {
  pendingDeletionStore,
  configurePendingDeletionFinalizers,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
  DELETION_UNDO_WINDOW_MS,
  FINALIZE_RETRY_DELAY_MS,
  MAX_FINALIZE_ATTEMPTS,
  PENDING_DELETIONS_TABLE,
} from "../src/core/conversations/pendingDeletionStore";
import { resolveFreshConversationDraft } from "../src/modules/contextPanel/freshConversationDraft";
import {
  markConversationRecentlyDeleted,
  resetRecentlyDeletedConversationsForTests,
} from "../src/core/conversations/recentlyDeletedConversations";

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
    // Identity witness captured at queue time; queueing is refused without one.
    catalogCreatedAt: 1_700_000_000_000,
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
    resetRecentlyDeletedConversationsForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    resetRecentlyDeletedConversationsForTests();
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

  it("finalizeTurnsForConversation never touches a pending conversation deletion", async function () {
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
    await pendingDeletionStore.queueConversationDeletion(conversationInput(5));
    assert.isTrue(
      await pendingDeletionStore.finalizeTurnsForConversation(5, "send"),
    );
    assert.deepEqual(finalized, [], "no finalizer may run for a send");
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(5),
      "the conversation deletion must stay pending (undoable)",
    );
  });

  it("finalizeTurnsForConversation finalizes pending turns for that conversation only", async function () {
    installFakeEnv();
    const finalized: string[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
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
    assert.isTrue(
      await pendingDeletionStore.finalizeTurnsForConversation(99, "send"),
    );
    assert.lengthOf(pendingDeletionStore.getPendingTurnsForConversation(5), 1);
    assert.isTrue(
      await pendingDeletionStore.finalizeTurnsForConversation(5, "send"),
    );
    assert.deepEqual(finalized, ["turn:5"]);
    assert.lengthOf(pendingDeletionStore.getPendingTurnsForConversation(5), 0);
  });

  it("restoreConversationDeletionsFor withdraws the row and restores visibility without finalizing", async function () {
    const env = installFakeEnv();
    let finalized = 0;
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        finalized += 1;
        return true;
      },
      finalizeTurn: async () => true,
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    const events: string[] = [];
    const stop = pendingDeletionStore.subscribe((e) => events.push(e.type));
    assert.isTrue(
      await pendingDeletionStore.restoreConversationDeletionsFor(42),
    );
    stop();
    assert.deepEqual(events, ["undone"]);
    assert.equal(finalized, 0, "restore must never run the finalizer");
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.isTrue(
      env.queries.some((q) =>
        q.sql.includes(`DELETE FROM ${PENDING_DELETIONS_TABLE}`),
      ),
    );
    assert.lengthOf(
      env.timers.filter((t) => !t.cleared),
      0,
    );
    assert.isTrue(
      await pendingDeletionStore.restoreConversationDeletionsFor(42),
      "no matching entries counts as restored",
    );
  });

  it("restoreConversationDeletionsFor keeps the entry pending when the withdraw fails", async function () {
    const env = installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (sql.includes("DELETE FROM")) throw new Error("disk error");
        return [];
      };
    assert.isFalse(
      await pendingDeletionStore.restoreConversationDeletionsFor(42),
      "a failed withdraw must not look like a restore",
    );
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "entry must stay pending so state matches the surviving row",
    );
  });

  it("does not restore a stale item after a real deletion has committed", async function () {
    installFakeEnv();
    markConversationRecentlyDeleted(42);
    assert.isFalse(
      await pendingDeletionStore.restoreConversationDeletionsFor(42),
      "a surface left on a just-deleted key must abort its user action",
    );
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

  it("gave-up withdraws the row strictly; a failed withdraw keeps the entry hidden and retries", async function () {
    const env = installFakeEnv();
    const events: string[] = [];
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => false,
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    assert.isOk(entry);
    let deleteFails = true;
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (deleteFails && sql.includes("DELETE FROM"))
          throw new Error("disk error");
        return [];
      };
    const stop = pendingDeletionStore.subscribe((e) => events.push(e.type));
    for (let round = 0; round < MAX_FINALIZE_ATTEMPTS; round++) {
      env.fireLastTimer();
      await pendingDeletionStore.finalize("flush-barrier", "noop");
    }
    assert.notInclude(
      events,
      "gave-up",
      "give-up must not restore visibility while the write-ahead row survives",
    );
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "conversation must stay hidden while its write-ahead row survives",
    );
    assert.isAtLeast(
      env.timers.filter((t) => !t.cleared).length,
      1,
      "a retry timer must stay armed so the entry cannot strand",
    );
    deleteFails = false;
    env.fireLastTimer();
    await pendingDeletionStore.finalize("flush-barrier", "noop");
    stop();
    assert.include(
      events,
      "gave-up",
      "give-up completes once the row is withdrawn",
    );
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
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

describe("pendingDeletionStore identity witness and undo integrity", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  function installEnv(finalizers?: {
    finalizeConversation?: () => Promise<boolean>;
    finalizeTurn?: () => Promise<boolean>;
  }) {
    const env = installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: finalizers?.finalizeConversation
        ? finalizers.finalizeConversation
        : async () => true,
      finalizeTurn: finalizers?.finalizeTurn
        ? finalizers.finalizeTurn
        : async () => true,
    });
    return env;
  }

  it("refuses to queue a conversation deletion with no catalog identity witness", async function () {
    const env = installEnv();
    const queued = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42, { catalogCreatedAt: 0 }),
    );
    assert.isNull(queued, "an unverifiable delete intent must not be queued");
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.isEmpty(
      env.queries.filter((q) => q.sql.includes("INSERT INTO")),
      "nothing may be written ahead for an unverifiable intent",
    );
  });

  it("round-trips the identity witness through the persisted payload", async function () {
    const env = installEnv();
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    const insert = env.queries.find((q) => q.sql.includes("INSERT INTO"));
    assert.isOk(insert, "expected a write-ahead insert");
    const payload = JSON.parse(String(insert!.params?.[5] ?? "{}"));
    assert.equal(payload.catalogCreatedAt, 1_700_000_000_000);
  });

  it("loads a row persisted before the witness existed with catalogCreatedAt 0", async function () {
    const env = installFakeEnv();
    let seen: number | undefined;
    configurePendingDeletionFinalizers({
      finalizeConversation: async (entry) => {
        seen = entry.catalogCreatedAt;
        return true;
      },
      finalizeTurn: async () => true,
    });
    env.rows.push({
      id: "pd-legacy",
      kind: "conversation",
      conversation_id: "lfz:legacy",
      conversation_key: 7,
      system: "upstream",
      // Payload written by a build that had no witness concept.
      payload: JSON.stringify({
        conversationKind: "global",
        libraryID: 1,
        title: "legacy",
        wasActive: false,
      }),
      queued_at: 1,
      expires_at: 2,
      attempts: 0,
    });
    await pendingDeletionStore.sweepAllPersisted("startup");
    assert.equal(seen, 0, "a witness-less row must fail closed downstream");
  });

  it("keeps the entry pending and retries when the write-ahead row DELETE fails after a successful finalize", async function () {
    const env = installEnv();
    const events: string[] = [];
    pendingDeletionStore.subscribe((event) => events.push(event.type));
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    let failDelete = true;
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (failDelete && sql.includes("DELETE FROM")) {
          throw new Error("disk error");
        }
        return [];
      };
    await pendingDeletionStore.finalize(entry!.id, "timeout");
    assert.notInclude(
      events,
      "finalized",
      "completion must not be announced while the delete intent survives",
    );
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "the entry must stay tracked until its row is really gone",
    );
    failDelete = false;
    env.fireLastTimer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.include(events, "finalized");
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
  });

  it("never gives up (restoring a destroyed chat) when only the write-ahead removal fails", async function () {
    const env = installEnv();
    const events: string[] = [];
    pendingDeletionStore.subscribe((event) => events.push(event.type));
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (sql.includes("DELETE FROM")) throw new Error("disk error");
        return [];
      };
    for (let i = 0; i < MAX_FINALIZE_ATTEMPTS + 2; i++) {
      await pendingDeletionStore.finalize(entry!.id, "retry");
    }
    assert.notInclude(
      events,
      "gave-up",
      "the conversation's rows are already gone; visibility must not return",
    );
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(42));
  });

  it("a turn deletion does not commit a pending conversation deletion", async function () {
    // Blocker: supersede used to be kind-agnostic, so deleting any single turn
    // irreversibly finalized a conversation deletion still inside its undo
    // window.
    let conversationFinalized = 0;
    const env = installEnv({
      finalizeConversation: async () => {
        conversationFinalized += 1;
        return true;
      },
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 99,
      system: "upstream",
      userTimestamp: 10,
      assistantTimestamp: 11,
    });
    assert.equal(
      conversationFinalized,
      0,
      "queueing a turn deletion must not finalize a pending conversation",
    );
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "the conversation must still be undoable",
    );
    assert.isOk(env.queries.length);
  });

  it("still supersedes an older pending deletion of the same kind", async function () {
    // The single-slot-per-kind policy is deliberate and must be preserved.
    let conversationFinalized = 0;
    installEnv({
      finalizeConversation: async () => {
        conversationFinalized += 1;
        return true;
      },
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    await pendingDeletionStore.queueConversationDeletion(conversationInput(43));
    assert.equal(
      conversationFinalized,
      1,
      "a second conversation deletion commits the first",
    );
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(43));
  });

  it("a failed queue attempt leaves the previous pending deletion intact", async function () {
    // Blocker: supersede ran before the write-ahead insert, so a queue attempt
    // that then failed had already destroyed the prior undoable deletion.
    let conversationFinalized = 0;
    const env = installEnv({
      finalizeConversation: async () => {
        conversationFinalized += 1;
        return true;
      },
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (sql.includes("INSERT INTO")) throw new Error("db locked");
        return [];
      };
    const second = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(43),
    );
    assert.isNull(second, "the failed queue attempt must report failure");
    assert.equal(
      conversationFinalized,
      0,
      "a failed queue must not commit the previous pending deletion",
    );
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "the previous deletion must still be undoable",
    );
  });

  it("incidental sweeps do not consume the retry budget during backoff", async function () {
    // Blocker: panels sweep on every mount and remount as the user browses
    // items, so ordinary browsing burned all 5 attempts in seconds.
    let attempts = 0;
    const env = installEnv({
      finalizeConversation: async () => {
        attempts += 1;
        return false;
      },
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    assert.isOk(entry);
    env.advance(DELETION_UNDO_WINDOW_MS + 1);
    await pendingDeletionStore.finalize(entry!.id, "timeout");
    assert.equal(attempts, 1, "the scheduled attempt runs");
    for (let i = 0; i < MAX_FINALIZE_ATTEMPTS + 3; i++) {
      await pendingDeletionStore.sweepExpired("panel-init");
    }
    assert.equal(
      attempts,
      1,
      "sweeps during backoff must not re-attempt or burn the budget",
    );
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(42));
  });

  it("a sweep after the backoff elapses does re-attempt", async function () {
    let attempts = 0;
    const env = installEnv({
      finalizeConversation: async () => {
        attempts += 1;
        return false;
      },
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    env.advance(DELETION_UNDO_WINDOW_MS + 1);
    await pendingDeletionStore.finalize(entry!.id, "timeout");
    env.advance(FINALIZE_RETRY_DELAY_MS + 1);
    await pendingDeletionStore.sweepExpired("panel-init");
    assert.equal(attempts, 2, "the retry schedule must not stall the sweep");
  });
});

describe("pendingDeletionStore key-scoped ops do not inherit unrelated latency", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("finalizeTurnsForConversation resolves while an unrelated conversation finalize is still running", async function () {
    // Blocker: every store op shared one promise chain, so a send in chat B
    // waited for chat A's finalize — which can run to a 60s provider timeout.
    const env = installFakeEnv();
    let releaseSlowFinalize: (() => void) | undefined;
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        await new Promise<void>((resolve) => {
          releaseSlowFinalize = resolve;
        });
        return true;
      },
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    // Start the slow finalize but do NOT await it: it now occupies the chain.
    const slow = pendingDeletionStore.finalize(entry!.id, "timeout");
    let slowDone = false;
    void slow.then(() => {
      slowDone = true;
    });

    // An unrelated conversation's send path must not wait behind it.
    await pendingDeletionStore.finalizeTurnsForConversation(99, "send");
    assert.isFalse(
      slowDone,
      "the unrelated finalize must still be in flight — proving no chain join",
    );

    releaseSlowFinalize?.();
    await slow;
    assert.isOk(env.queries.length);
  });

  it("restoreConversationDeletionsFor still withdraws an intent that is queued but not yet recorded", async function () {
    // The race guard: a queue op requested but still waiting on the chain is
    // not visible in memory, so a naive short-circuit would answer "nothing to
    // withdraw" and the user would type into a chat deleted 6s later.
    installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    // Requested, deliberately not awaited: the op has not started yet.
    const queuePromise = pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    const restored =
      await pendingDeletionStore.restoreConversationDeletionsFor(42);
    await queuePromise;
    assert.isTrue(restored, "the withdraw must report success");
    assert.isFalse(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "the racing deletion intent must have been withdrawn, not missed",
    );
  });

  it("restoreConversationDeletionsFor short-circuits when nothing is pending", async function () {
    installFakeEnv();
    let releaseSlowFinalize: (() => void) | undefined;
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        await new Promise<void>((resolve) => {
          releaseSlowFinalize = resolve;
        });
        return true;
      },
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    // Occupy the shared chain with an unrelated slow finalize.
    const slow = pendingDeletionStore.finalize(entry!.id, "timeout");
    let slowDone = false;
    void slow.then(() => {
      slowDone = true;
    });
    // Nothing pending for 1234: this must answer without joining the chain.
    const restored =
      await pendingDeletionStore.restoreConversationDeletionsFor(1234);
    assert.isTrue(restored);
    assert.isFalse(
      slowDone,
      "answering must not have waited for the unrelated finalize",
    );
    releaseSlowFinalize?.();
    await slow;
  });

  it("restores a pending conversation without waiting for an unrelated finalizer", async function () {
    installFakeEnv();
    let releaseSlowFinalize: (() => void) | undefined;
    let markSlowFinalizeStarted: (() => void) | undefined;
    const slowFinalizeStarted = new Promise<void>((resolve) => {
      markSlowFinalizeStarted = resolve;
    });
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async (entry) => {
        if (entry.conversationKey !== 1) return true;
        markSlowFinalizeStarted?.();
        await new Promise<void>((resolve) => {
          releaseSlowFinalize = resolve;
        });
        return true;
      },
    });
    const conversation = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(2),
    );
    const turn = await pendingDeletionStore.queueTurnDeletion({
      conversationKey: 1,
      system: "upstream",
      userTimestamp: 111,
      assistantTimestamp: 222,
    });
    const slow = pendingDeletionStore.finalize(turn!.id, "timeout");
    await slowFinalizeStarted;

    assert.isTrue(
      await pendingDeletionStore.restoreConversationDeletionsFor(2),
      "the current chat must restore without joining the unrelated finalizer",
    );
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(2));

    releaseSlowFinalize?.();
    await slow;
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(1));
    assert.isOk(conversation);
  });

  it("fails restore when finalization is already destroying the same conversation", async function () {
    installFakeEnv();
    let releaseSlowFinalize: (() => void) | undefined;
    let markSlowFinalizeStarted: (() => void) | undefined;
    const slowFinalizeStarted = new Promise<void>((resolve) => {
      markSlowFinalizeStarted = resolve;
    });
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => {
        markSlowFinalizeStarted?.();
        await new Promise<void>((resolve) => {
          releaseSlowFinalize = resolve;
        });
        return true;
      },
      finalizeTurn: async () => true,
    });
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    const finalizing = pendingDeletionStore.finalize(entry!.id, "timeout");
    await slowFinalizeStarted;

    assert.isFalse(
      await pendingDeletionStore.restoreConversationDeletionsFor(42),
      "a restore request must abort once destructive finalization has started",
    );
    assert.isTrue(pendingDeletionStore.isConversationPendingDeletion(42));

    releaseSlowFinalize?.();
    assert.isTrue(await finalizing);
    assert.isFalse(pendingDeletionStore.isConversationPendingDeletion(42));
  });
});

describe("pendingDeletionStore identity witness stability", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("a conversation awaiting deletion is never adopted as a reusable draft", async function () {
    // Adopting it would rewrite its catalog createdAt (the identity witness),
    // and the queued deletion would then be classified stale and silently
    // abandoned — the user's delete would simply not happen.
    installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    await pendingDeletionStore.queueConversationDeletion(conversationInput(42));
    assert.isTrue(
      pendingDeletionStore.isConversationPendingDeletion(42),
      "precondition: the deletion is queued",
    );
    let createdKey = 0;
    const result = await resolveFreshConversationDraft({
      system: "upstream",
      kind: "global",
      libraryID: 1,
      repository: {
        getCatalogEntry: async () => null,
        listCatalogEntries: async () => [
          {
            conversationID: "lfz:doomed",
            conversationKey: 42,
            system: "upstream",
            kind: "global",
            libraryID: 1,
            createdAt: 1_000,
            lastActivityAt: 1_000,
            userTurnCount: 0,
          },
        ],
        createCatalogEntry: async () => {
          createdKey = 777;
          return {
            conversationID: "lfz:new",
            conversationKey: 777,
            system: "upstream",
            kind: "global",
            libraryID: 1,
            createdAt: 2_000,
            lastActivityAt: 2_000,
            userTurnCount: 0,
          };
        },
        loadMessages: async () => [],
      } as never,
    });
    assert.notEqual(
      result.conversationKey,
      42,
      "the chat queued for deletion must not be handed back as a fresh draft",
    );
    assert.equal(createdKey, 777, "a genuinely new draft is created instead");
  });
});

describe("pendingDeletionStore dropped-outcome propagation", function () {
  beforeEach(function () {
    resetPendingDeletionStoreForTests();
  });

  afterEach(function () {
    resetPendingDeletionStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("carries dropped onto the retry notification when the row withdrawal fails", async function () {
    // A dropped intent means the conversation is still ALIVE. If the retry
    // notification loses that bit, every surface showing the chat treats the
    // retry as a deletion and evicts the user from a live conversation.
    const env = installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => ({ ok: true, dropped: true }),
      finalizeTurn: async () => true,
    });
    const events: Array<{ type: string; dropped?: boolean }> = [];
    pendingDeletionStore.subscribe((event) =>
      events.push({ type: event.type, dropped: event.dropped }),
    );
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    (globalScope.Zotero as { DB: { queryAsync: unknown } }).DB.queryAsync =
      async (sql: string) => {
        env.queries.push({ sql });
        if (sql.includes("DELETE FROM")) throw new Error("db busy");
        return [];
      };
    await pendingDeletionStore.finalize(entry!.id, "timeout");
    const failed = events.find((e) => e.type === "finalize-failed");
    assert.isOk(failed, "a retry notification must be emitted");
    assert.isTrue(
      failed!.dropped,
      "the retry must still say the conversation is alive",
    );
  });

  it("reports a genuine deletion as not dropped", async function () {
    installFakeEnv();
    configurePendingDeletionFinalizers({
      finalizeConversation: async () => true,
      finalizeTurn: async () => true,
    });
    const events: Array<{ type: string; dropped?: boolean }> = [];
    pendingDeletionStore.subscribe((event) =>
      events.push({ type: event.type, dropped: event.dropped }),
    );
    const entry = await pendingDeletionStore.queueConversationDeletion(
      conversationInput(42),
    );
    await pendingDeletionStore.finalize(entry!.id, "timeout");
    const finalized = events.find((e) => e.type === "finalized");
    assert.isOk(finalized);
    assert.isNotTrue(
      finalized!.dropped,
      "a real deletion must not claim the chat survived — surfaces tombstone on this",
    );
  });
});
