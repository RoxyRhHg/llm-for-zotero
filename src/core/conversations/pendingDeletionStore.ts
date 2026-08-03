import type { ConversationSystem } from "../../shared/types";

export const PENDING_DELETIONS_TABLE = "llm_for_zotero_pending_deletions";
export const DELETION_UNDO_WINDOW_MS = 6_000;
export const MAX_FINALIZE_ATTEMPTS = 5;
const FINALIZE_RETRY_DELAY_MS = 6_000;

export type PendingConversationDeletionEntry = {
  id: string;
  kind: "conversation";
  conversationKind: "paper" | "global";
  conversationID?: string;
  conversationKey: number;
  libraryID: number;
  system: ConversationSystem;
  paperItemID?: number;
  providerSessionId?: string;
  title: string;
  wasActive: boolean;
  queuedAt: number;
  expiresAt: number;
  attempts: number;
};

export type PendingTurnDeletionEntry = {
  id: string;
  kind: "turn";
  conversationKey: number;
  system: ConversationSystem;
  userTimestamp: number;
  assistantTimestamp: number;
  queuedAt: number;
  expiresAt: number;
  attempts: number;
};

export type PendingDeletionEntry =
  | PendingConversationDeletionEntry
  | PendingTurnDeletionEntry;

export type PendingDeletionEvent = {
  type: "queued" | "undone" | "finalized" | "finalize-failed" | "gave-up";
  entry: PendingDeletionEntry;
};

export type PendingDeletionFinalizers = {
  finalizeConversation: (
    entry: PendingConversationDeletionEntry,
  ) => Promise<boolean>;
  finalizeTurn: (entry: PendingTurnDeletionEntry) => Promise<boolean>;
};

export type PendingDeletionStoreEnv = {
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string, ...args: unknown[]) => void;
};

type ZoteroDbLike = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

function getZoteroDb(): ZoteroDbLike | null {
  const db = (globalThis as { Zotero?: { DB?: ZoteroDbLike } }).Zotero?.DB;
  return db?.queryAsync ? db : null;
}

function getMainWindow(): Window | null {
  return (
    (
      globalThis as {
        Zotero?: { getMainWindow?: () => Window | null };
      }
    ).Zotero?.getMainWindow?.() || null
  );
}

// The default timer binds its clearing host at ARM time. Resolving the host
// again at clear time could target a different window (main window closed and
// reopened mid-window) and cancel an unrelated timer there while leaking ours.
type BoundTimerHandle = { cancel: () => void };

function isBoundTimerHandle(handle: unknown): handle is BoundTimerHandle {
  return (
    typeof handle === "object" &&
    handle !== null &&
    typeof (handle as BoundTimerHandle).cancel === "function"
  );
}

function defaultSetTimer(fn: () => void, delayMs: number): unknown {
  const win = getMainWindow();
  if (win?.setTimeout) {
    const id = win.setTimeout(fn, delayMs);
    return {
      cancel: () => {
        try {
          win.clearTimeout(id);
        } catch {
          /* window already gone — its timers died with it */
        }
      },
    } satisfies BoundTimerHandle;
  }
  const id = setTimeout(fn, delayMs);
  return { cancel: () => clearTimeout(id) } satisfies BoundTimerHandle;
}

function defaultClearTimer(handle: unknown): void {
  if (handle === null || handle === undefined) return;
  if (isBoundTimerHandle(handle)) {
    handle.cancel();
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultEnv(): Required<PendingDeletionStoreEnv> {
  return {
    now: () => Date.now(),
    setTimer: defaultSetTimer,
    clearTimer: defaultClearTimer,
    log: () => {},
  };
}

let finalizers: PendingDeletionFinalizers | null = null;
let env: Required<PendingDeletionStoreEnv> = defaultEnv();

const entries = new Map<string, PendingDeletionEntry>();
const timers = new Map<string, unknown>();
const listeners = new Set<(event: PendingDeletionEvent) => void>();
let queueOrder: string[] = [];
let initialized = false;
let opChain: Promise<unknown> = Promise.resolve();
let idCounter = 0;

export function configurePendingDeletionFinalizers(
  next: PendingDeletionFinalizers,
): void {
  finalizers = next;
}

export function configurePendingDeletionStoreEnv(
  next: PendingDeletionStoreEnv,
): void {
  const defaults = defaultEnv();
  env = {
    now: next.now || defaults.now,
    setTimer: next.setTimer || defaults.setTimer,
    clearTimer: next.clearTimer || defaults.clearTimer,
    log: next.log || defaults.log,
  };
}

export function resetPendingDeletionStoreForTests(): void {
  for (const handle of timers.values()) env.clearTimer(handle);
  timers.clear();
  entries.clear();
  listeners.clear();
  queueOrder = [];
  initialized = false;
  finalizers = null;
  opChain = Promise.resolve();
  env = defaultEnv();
}

function enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => undefined);
  return run;
}

function notify(event: PendingDeletionEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (err) {
      env.log("LLM: pending deletion listener failed", err);
    }
  }
}

function generateId(): string {
  idCounter += 1;
  return `pd-${env.now().toString(36)}-${idCounter.toString(36)}`;
}

function clearEntryTimer(id: string): void {
  const handle = timers.get(id);
  if (handle !== undefined) {
    env.clearTimer(handle);
    timers.delete(id);
  }
}

function armTimer(id: string, delayMs: number): void {
  clearEntryTimer(id);
  timers.set(
    id,
    env.setTimer(
      () => {
        timers.delete(id);
        void pendingDeletionStore.finalize(id, "timeout");
      },
      Math.max(0, delayMs),
    ),
  );
}

function removeEntry(id: string): void {
  clearEntryTimer(id);
  entries.delete(id);
  queueOrder = queueOrder.filter((entryId) => entryId !== id);
}

function serializePayload(entry: PendingDeletionEntry): string {
  if (entry.kind === "conversation") {
    return JSON.stringify({
      conversationKind: entry.conversationKind,
      libraryID: entry.libraryID,
      paperItemID: entry.paperItemID,
      providerSessionId: entry.providerSessionId,
      title: entry.title,
      wasActive: entry.wasActive,
    });
  }
  return JSON.stringify({
    userTimestamp: entry.userTimestamp,
    assistantTimestamp: entry.assistantTimestamp,
  });
}

async function insertRow(entry: PendingDeletionEntry): Promise<void> {
  const db = getZoteroDb();
  if (!db) throw new Error("Zotero DB unavailable");
  await pendingDeletionStore.init();
  await db.queryAsync(
    `INSERT INTO ${PENDING_DELETIONS_TABLE}
      (id, kind, conversation_id, conversation_key, system, payload, queued_at, expires_at, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.kind,
      entry.kind === "conversation" ? entry.conversationID || null : null,
      entry.conversationKey,
      entry.system,
      serializePayload(entry),
      entry.queuedAt,
      entry.expiresAt,
      entry.attempts,
    ],
  );
}

async function deleteRow(id: string): Promise<void> {
  const db = getZoteroDb();
  if (!db) return;
  try {
    await db.queryAsync(`DELETE FROM ${PENDING_DELETIONS_TABLE} WHERE id = ?`, [
      id,
    ]);
  } catch (err) {
    env.log("LLM: failed to delete pending-deletion row", { id, err });
  }
}

// Undo must never LOOK successful while the write-ahead row survives — the
// next startup sweep would finalize the row and destroy the "restored" chat.
async function deleteRowStrict(id: string): Promise<void> {
  const db = getZoteroDb();
  if (!db) throw new Error("Zotero DB unavailable");
  await db.queryAsync(`DELETE FROM ${PENDING_DELETIONS_TABLE} WHERE id = ?`, [
    id,
  ]);
}

async function persistAttempts(entry: PendingDeletionEntry): Promise<void> {
  const db = getZoteroDb();
  if (!db) return;
  try {
    await db.queryAsync(
      `UPDATE ${PENDING_DELETIONS_TABLE} SET attempts = ? WHERE id = ?`,
      [entry.attempts, entry.id],
    );
  } catch (err) {
    env.log("LLM: failed to persist pending-deletion attempts", {
      id: entry.id,
      err,
    });
  }
}

async function supersedeOthers(keepId: string | null): Promise<void> {
  const others = queueOrder.filter((id) => id !== keepId);
  for (const id of others) {
    await finalizeInternal(id, "superseded");
  }
}

async function finalizeInternal(id: string, reason: string): Promise<boolean> {
  const entry = entries.get(id);
  if (!entry) return true;
  clearEntryTimer(id);
  if (!finalizers) {
    env.log("LLM: pending deletion finalizers not configured", { id, reason });
    // Keep the retry heartbeat alive — without it the entry would sit hidden
    // forever with a dead undo window until the next sweep.
    armTimer(id, FINALIZE_RETRY_DELAY_MS);
    return false;
  }
  let ok = false;
  try {
    ok =
      entry.kind === "conversation"
        ? await finalizers.finalizeConversation(entry)
        : await finalizers.finalizeTurn(entry);
  } catch (err) {
    env.log("LLM: pending deletion finalize threw", { id, reason, err });
    ok = false;
  }
  if (ok) {
    removeEntry(id);
    await deleteRow(id);
    notify({ type: "finalized", entry });
    return true;
  }
  entry.attempts += 1;
  if (entry.attempts >= MAX_FINALIZE_ATTEMPTS) {
    env.log(
      "LLM: giving up on pending deletion after repeated failures; restoring visibility",
      { id, reason, attempts: entry.attempts },
    );
    removeEntry(id);
    await deleteRow(id);
    notify({ type: "gave-up", entry });
    return false;
  }
  await persistAttempts(entry);
  armTimer(id, FINALIZE_RETRY_DELAY_MS);
  notify({ type: "finalize-failed", entry });
  return false;
}

function rowToEntry(row: Record<string, unknown>): PendingDeletionEntry | null {
  const id = typeof row.id === "string" ? row.id : "";
  const kind = row.kind === "turn" ? "turn" : "conversation";
  const conversationKey = Math.floor(Number(row.conversation_key || 0));
  const system = String(row.system || "") as ConversationSystem;
  if (!id || !conversationKey || !system) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(row.payload || "{}")) as Record<
      string,
      unknown
    >;
  } catch {
    payload = {};
  }
  const queuedAt = Math.floor(Number(row.queued_at || 0));
  const expiresAt = Math.floor(Number(row.expires_at || 0));
  const attempts = Math.floor(Number(row.attempts || 0));
  if (kind === "turn") {
    const userTimestamp = Math.floor(Number(payload.userTimestamp || 0));
    const assistantTimestamp = Math.floor(
      Number(payload.assistantTimestamp || 0),
    );
    if (!userTimestamp || !assistantTimestamp) return null;
    return {
      id,
      kind,
      conversationKey,
      system,
      userTimestamp,
      assistantTimestamp,
      queuedAt,
      expiresAt,
      attempts,
    };
  }
  return {
    id,
    kind,
    conversationKind: payload.conversationKind === "paper" ? "paper" : "global",
    conversationID:
      typeof row.conversation_id === "string" && row.conversation_id
        ? row.conversation_id
        : undefined,
    conversationKey,
    libraryID: Math.floor(Number(payload.libraryID || 0)) || 0,
    system,
    paperItemID: Math.floor(Number(payload.paperItemID || 0)) || undefined,
    providerSessionId:
      typeof payload.providerSessionId === "string" && payload.providerSessionId
        ? payload.providerSessionId
        : undefined,
    title: typeof payload.title === "string" ? payload.title : "",
    wasActive: Boolean(payload.wasActive),
    queuedAt,
    expiresAt,
    attempts,
  };
}

export const pendingDeletionStore = {
  async init(): Promise<void> {
    if (initialized) return;
    const db = getZoteroDb();
    if (!db) return;
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PENDING_DELETIONS_TABLE} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('conversation', 'turn')),
        conversation_id TEXT,
        conversation_key INTEGER NOT NULL,
        system TEXT NOT NULL,
        payload TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`,
    );
    initialized = true;
  },

  queueConversationDeletion(
    input: Omit<
      PendingConversationDeletionEntry,
      "id" | "kind" | "queuedAt" | "expiresAt" | "attempts"
    >,
  ): Promise<PendingConversationDeletionEntry | null> {
    return enqueueOp(async () => {
      const existing = Array.from(entries.values()).find(
        (entry) =>
          entry.kind === "conversation" &&
          entry.conversationKey === input.conversationKey,
      ) as PendingConversationDeletionEntry | undefined;
      if (existing) return existing;
      const queuedAt = env.now();
      const entry: PendingConversationDeletionEntry = {
        ...input,
        id: generateId(),
        kind: "conversation",
        queuedAt,
        expiresAt: queuedAt + DELETION_UNDO_WINDOW_MS,
        attempts: 0,
      };
      await supersedeOthers(null);
      try {
        await insertRow(entry);
      } catch (err) {
        env.log("LLM: failed to persist pending conversation deletion", err);
        return null;
      }
      entries.set(entry.id, entry);
      queueOrder.push(entry.id);
      armTimer(entry.id, entry.expiresAt - env.now());
      notify({ type: "queued", entry });
      return entry;
    });
  },

  queueTurnDeletion(
    input: Omit<
      PendingTurnDeletionEntry,
      "id" | "kind" | "queuedAt" | "expiresAt" | "attempts"
    >,
  ): Promise<PendingTurnDeletionEntry | null> {
    return enqueueOp(async () => {
      const existing = Array.from(entries.values()).find(
        (entry) =>
          entry.kind === "turn" &&
          entry.conversationKey === input.conversationKey &&
          entry.userTimestamp === Math.floor(input.userTimestamp) &&
          entry.assistantTimestamp === Math.floor(input.assistantTimestamp),
      ) as PendingTurnDeletionEntry | undefined;
      if (existing) return existing;
      const queuedAt = env.now();
      const entry: PendingTurnDeletionEntry = {
        ...input,
        userTimestamp: Math.floor(input.userTimestamp),
        assistantTimestamp: Math.floor(input.assistantTimestamp),
        id: generateId(),
        kind: "turn",
        queuedAt,
        expiresAt: queuedAt + DELETION_UNDO_WINDOW_MS,
        attempts: 0,
      };
      await supersedeOthers(null);
      try {
        await insertRow(entry);
      } catch (err) {
        env.log("LLM: failed to persist pending turn deletion", err);
        return null;
      }
      entries.set(entry.id, entry);
      queueOrder.push(entry.id);
      armTimer(entry.id, entry.expiresAt - env.now());
      notify({ type: "queued", entry });
      return entry;
    });
  },

  undo(id: string): Promise<PendingDeletionEntry | null> {
    return enqueueOp(async () => {
      const entry = entries.get(id);
      if (!entry) return null;
      try {
        await deleteRowStrict(id);
      } catch (err) {
        // The durable intent could not be withdrawn; leave the entry (and its
        // timer) in place so state stays consistent, and let the caller
        // surface the failure instead of claiming "restored".
        env.log("LLM: undo failed to withdraw pending-deletion row", {
          id,
          err,
        });
        return null;
      }
      removeEntry(id);
      notify({ type: "undone", entry });
      return entry;
    });
  },

  finalize(id: string, reason: string): Promise<boolean> {
    return enqueueOp(() => finalizeInternal(id, reason));
  },

  finalizeForConversation(
    conversationKey: number,
    reason: string,
  ): Promise<boolean> {
    return enqueueOp(async () => {
      const matching = Array.from(entries.values()).filter(
        (entry) => entry.conversationKey === conversationKey,
      );
      let allFinalized = true;
      for (const entry of matching) {
        if (!(await finalizeInternal(entry.id, reason))) {
          allFinalized = false;
        }
      }
      return allFinalized;
    });
  },

  getLatestPending(): PendingDeletionEntry | null {
    const lastId = queueOrder[queueOrder.length - 1];
    return (lastId && entries.get(lastId)) || null;
  },

  isConversationPendingDeletion(conversationKey: number): boolean {
    for (const entry of entries.values()) {
      if (
        entry.kind === "conversation" &&
        entry.conversationKey === conversationKey
      ) {
        return true;
      }
    }
    return false;
  },

  getPendingConversationKeys(): Set<number> {
    const keys = new Set<number>();
    for (const entry of entries.values()) {
      if (entry.kind === "conversation") keys.add(entry.conversationKey);
    }
    return keys;
  },

  isMessageInPendingTurn(
    conversationKey: number,
    timestamp: number,
    role?: "user" | "assistant",
  ): boolean {
    const normalized = Math.floor(timestamp);
    for (const entry of entries.values()) {
      if (entry.kind !== "turn") continue;
      if (entry.conversationKey !== conversationKey) continue;
      const matchesUser =
        entry.userTimestamp === normalized && role !== "assistant";
      const matchesAssistant =
        entry.assistantTimestamp === normalized && role !== "user";
      if (matchesUser || matchesAssistant) {
        return true;
      }
    }
    return false;
  },

  getPendingTurnsForConversation(
    conversationKey: number,
  ): PendingTurnDeletionEntry[] {
    const matching: PendingTurnDeletionEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.kind === "turn" && entry.conversationKey === conversationKey) {
        matching.push(entry);
      }
    }
    return matching;
  },

  findPendingTurn(
    conversationKey: number,
    userTimestamp: number,
    assistantTimestamp: number,
  ): PendingTurnDeletionEntry | null {
    for (const entry of entries.values()) {
      if (
        entry.kind === "turn" &&
        entry.conversationKey === conversationKey &&
        entry.userTimestamp === Math.floor(userTimestamp) &&
        entry.assistantTimestamp === Math.floor(assistantTimestamp)
      ) {
        return entry;
      }
    }
    return null;
  },

  subscribe(listener: (event: PendingDeletionEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  sweepExpired(reason: string): Promise<void> {
    return enqueueOp(async () => {
      const now = env.now();
      const expired = Array.from(entries.values()).filter(
        (entry) => entry.expiresAt <= now,
      );
      for (const entry of expired) {
        await finalizeInternal(entry.id, reason);
      }
    });
  },

  sweepAllPersisted(reason: string): Promise<void> {
    return enqueueOp(async () => {
      const db = getZoteroDb();
      if (!db) return;
      await pendingDeletionStore.init();
      const rows = (await db.queryAsync(
        `SELECT id, kind, conversation_id, conversation_key, system, payload, queued_at, expires_at, attempts
         FROM ${PENDING_DELETIONS_TABLE}`,
      )) as Array<Record<string, unknown>> | undefined;
      for (const row of rows || []) {
        const entry = rowToEntry(row);
        if (!entry) {
          const rowId = typeof row.id === "string" ? row.id : "";
          env.log("LLM: dropping unreadable pending-deletion row", { rowId });
          if (rowId) await deleteRow(rowId);
          continue;
        }
        if (!entries.has(entry.id)) {
          entries.set(entry.id, entry);
          queueOrder.push(entry.id);
        }
        await finalizeInternal(entry.id, reason);
      }
    });
  },
};
