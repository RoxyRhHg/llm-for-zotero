import type { ConversationSystem } from "../../shared/types";

export const PENDING_DELETIONS_TABLE = "llm_for_zotero_pending_deletions";
export const DELETION_UNDO_WINDOW_MS = 6_000;
export const MAX_FINALIZE_ATTEMPTS = 5;
export const FINALIZE_RETRY_DELAY_MS = 6_000;

export type PendingConversationDeletionEntry = {
  id: string;
  kind: "conversation";
  conversationKind: "paper" | "global";
  conversationID?: string;
  // Immutable identity witness captured at queue time: the catalog row's
  // createdAt. Conversation keys are recycled and conversation IDs are a
  // deterministic hash of the scope, so a recycled key reproduces a
  // byte-identical ID. This is the only value that can prove, at finalize
  // time, that the row about to be destroyed is still the row the user asked
  // to delete. 0 means "no witness" (a row written by an older build) and must
  // fail closed.
  catalogCreatedAt: number;
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
  // True when the intent was DROPPED rather than applied — the conversation
  // still exists (a stale intent, or a row from a build with no identity
  // witness). Surfaces must not treat this as a deletion: leaving the chat and
  // tombstoning its key would evict the user from a conversation that is very
  // much alive.
  dropped?: boolean;
};

export type PendingFinalizeOutcome = { ok: boolean; dropped?: boolean };

export type PendingDeletionFinalizers = {
  finalizeConversation: (
    entry: PendingConversationDeletionEntry,
  ) => Promise<boolean | PendingFinalizeOutcome>;
  finalizeTurn: (
    entry: PendingTurnDeletionEntry,
  ) => Promise<boolean | PendingFinalizeOutcome>;
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
// When each entry's own timer is next due. Session-local and deliberately NOT
// persisted: a restart is meant to re-attempt every leftover row at once.
const retryNotBefore = new Map<string, number>();
const listeners = new Set<(event: PendingDeletionEvent) => void>();
let queueOrder: string[] = [];
let initialized = false;
let opChain: Promise<unknown> = Promise.resolve();
let idCounter = 0;
// Queue intents that have been REQUESTED but are not yet visible in `entries`,
// counted per conversation key. The short-circuits below read `entries`
// synchronously; without this a restore/finalize could answer "nothing to do"
// while a queue op for that key was still pending, and the caller would write
// into a chat that is about to be hidden. Keyed (not global) so an unrelated
// conversation's queue op cannot force every send onto the shared chain, and
// released only once the intent is recorded — or has definitively failed.
const unrecordedQueueIntents = new Map<number, number>();

function retainQueueIntent(conversationKey: number): void {
  unrecordedQueueIntents.set(
    conversationKey,
    (unrecordedQueueIntents.get(conversationKey) || 0) + 1,
  );
}

function releaseQueueIntent(conversationKey: number): void {
  const next = (unrecordedQueueIntents.get(conversationKey) || 0) - 1;
  if (next > 0) unrecordedQueueIntents.set(conversationKey, next);
  else unrecordedQueueIntents.delete(conversationKey);
}

function hasUnrecordedQueueIntent(conversationKey: number): boolean {
  return (unrecordedQueueIntents.get(conversationKey) || 0) > 0;
}

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

// Production wires only the logger: the plugin runtime must keep the default
// main-window-bound timers while still leaving a diagnostic trail. Without this
// the store's log is a no-op in the shipping plugin, and every toast that says
// "Check logs" points at nothing.
export function setPendingDeletionStoreLogger(
  log: (message: string, ...args: unknown[]) => void,
): void {
  env.log = log;
}

export function resetPendingDeletionStoreForTests(): void {
  for (const handle of timers.values()) env.clearTimer(handle);
  timers.clear();
  retryNotBefore.clear();
  entries.clear();
  listeners.clear();
  queueOrder = [];
  initialized = false;
  finalizers = null;
  opChain = Promise.resolve();
  unrecordedQueueIntents.clear();
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
  retryNotBefore.delete(id);
}

function armTimer(id: string, delayMs: number): void {
  clearEntryTimer(id);
  const delay = Math.max(0, delayMs);
  retryNotBefore.set(id, env.now() + delay);
  timers.set(
    id,
    env.setTimer(() => {
      timers.delete(id);
      void pendingDeletionStore.finalize(id, "timeout");
    }, delay),
  );
}

function removeEntry(id: string): void {
  clearEntryTimer(id);
  entries.delete(id);
  queueOrder = queueOrder.filter((entryId) => entryId !== id);
}

// A failed finalize schedules its own retry; incidental sweeps must respect
// that schedule instead of racing it. Panels sweep on every mount and panels
// remount whenever the user browses items, so without this guard ordinary
// browsing burned the whole MAX_FINALIZE_ATTEMPTS budget in seconds instead of
// over the intended retry window. Entries with no schedule (rows loaded by the
// startup sweep) are never held back.
function isInRetryBackoff(id: string, now: number): boolean {
  const notBefore = retryNotBefore.get(id);
  return notBefore !== undefined && notBefore > now;
}

function serializePayload(entry: PendingDeletionEntry): string {
  if (entry.kind === "conversation") {
    return JSON.stringify({
      conversationKind: entry.conversationKind,
      catalogCreatedAt: entry.catalogCreatedAt,
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

// Key-scoped ops answer from these synchronous reads when nothing matches, so
// they never join the single shared op chain — an unrelated conversation's slow
// finalize (a codex thread archive can hold the chain for up to its 60s request
// timeout) must not stall a send in a different chat.
function hasEntriesForConversation(conversationKey: number): boolean {
  for (const entry of entries.values()) {
    if (entry.conversationKey === conversationKey) return true;
  }
  return false;
}

function hasTurnEntriesForConversation(conversationKey: number): boolean {
  for (const entry of entries.values()) {
    if (entry.kind === "turn" && entry.conversationKey === conversationKey) {
      return true;
    }
  }
  return false;
}

// Supersede is deliberately KIND-SCOPED. A second conversation deletion commits
// the first (one conversation undo slot), and a second turn deletion commits the
// first, but a turn deletion must never commit a pending CONVERSATION deletion:
// they are independent user intents over disjoint data, and the conversation is
// still inside its undo window. Same rule as finalizeTurnsForConversation.
async function supersedeOthers(
  kind: PendingDeletionEntry["kind"],
  keepId: string | null,
): Promise<void> {
  const others = queueOrder.filter(
    (id) => id !== keepId && entries.get(id)?.kind === kind,
  );
  for (const id of others) {
    await finalizeInternal(id, "superseded");
  }
}

async function undoInternal(id: string): Promise<PendingDeletionEntry | null> {
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
  let dropped = false;
  try {
    const outcome =
      entry.kind === "conversation"
        ? await finalizers.finalizeConversation(entry)
        : await finalizers.finalizeTurn(entry);
    if (typeof outcome === "boolean") {
      ok = outcome;
    } else {
      ok = Boolean(outcome?.ok);
      dropped = Boolean(outcome?.dropped);
    }
  } catch (err) {
    env.log("LLM: pending deletion finalize threw", { id, reason, err });
    ok = false;
  }
  if (ok) {
    // The destructive work is done; a surviving write-ahead row is a live
    // delete intent that the next startup sweep would replay against whatever
    // conversation owns the key by then. Same invariant as undo and give-up:
    // never report completion while the row survives. Attempts are NOT
    // incremented here — hitting the give-up cap would restore visibility of a
    // conversation whose rows are already gone, so this retries until the row
    // is really removed. Any replay is non-destructive: the catalog row is
    // gone, so the staleness check classifies the entry as stale.
    try {
      await deleteRowStrict(id);
    } catch (err) {
      env.log(
        "LLM: failed to withdraw pending-deletion row after finalize; retrying",
        { id, reason, err },
      );
      armTimer(id, FINALIZE_RETRY_DELAY_MS);
      // Carry `dropped` through: for an intent that was dropped (the chat is
      // alive), surfaces must not react to this retry by evicting the user.
      notify({ type: "finalize-failed", entry, dropped });
      return false;
    }
    removeEntry(id);
    notify({ type: "finalized", entry, dropped });
    return true;
  }
  entry.attempts += 1;
  if (entry.attempts >= MAX_FINALIZE_ATTEMPTS) {
    // Giving up restores the conversation's visibility, so the durable intent
    // must be withdrawn first — a surviving row would let the next startup
    // sweep destroy the chat the user believes was restored (same invariant
    // as undo). If the withdraw fails, stay hidden and keep retrying.
    try {
      await deleteRowStrict(id);
    } catch (err) {
      env.log(
        "LLM: failed to withdraw pending-deletion row while giving up; retrying",
        { id, reason, attempts: entry.attempts, err },
      );
      await persistAttempts(entry);
      armTimer(id, FINALIZE_RETRY_DELAY_MS);
      notify({ type: "finalize-failed", entry });
      return false;
    }
    env.log(
      "LLM: giving up on pending deletion after repeated failures; restoring visibility",
      { id, reason, attempts: entry.attempts },
    );
    removeEntry(id);
    notify({ type: "gave-up", entry });
    return false;
  }
  env.log("LLM: pending deletion finalize failed; scheduling retry", {
    id,
    reason,
    attempts: entry.attempts,
    maxAttempts: MAX_FINALIZE_ATTEMPTS,
    retryInMs: FINALIZE_RETRY_DELAY_MS,
  });
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
    // Absent for rows persisted before the witness existed; 0 makes the
    // finalize-time check fail closed instead of trusting the recycled key.
    catalogCreatedAt: Math.floor(Number(payload.catalogCreatedAt || 0)) || 0,
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
    // Retained synchronously at CALL time and released only once the op has
    // FINISHED. Releasing when the op merely started still left a window as
    // wide as the DB insert during which the intent was invisible to the
    // synchronous short-circuits below.
    retainQueueIntent(input.conversationKey);
    return enqueueOp(async () => {
      try {
        const catalogCreatedAt = Math.floor(
          Number(input.catalogCreatedAt || 0),
        );
        if (!(catalogCreatedAt > 0)) {
          // Without a witness the intent could never be proven, at finalize time,
          // to still target the user's conversation — keys are recycled and
          // conversation IDs are deterministic. Refuse up front so the caller
          // reports the failure, instead of persisting a delete intent that can
          // only ever be dropped or (worse) misapplied.
          env.log(
            "LLM: refusing to queue conversation deletion without a catalog identity witness",
            {
              conversationKey: input.conversationKey,
              conversationID: input.conversationID,
            },
          );
          return null;
        }
        const existing = Array.from(entries.values()).find(
          (entry) =>
            entry.kind === "conversation" &&
            entry.conversationKey === input.conversationKey,
        ) as PendingConversationDeletionEntry | undefined;
        if (existing) return existing;
        const queuedAt = env.now();
        const entry: PendingConversationDeletionEntry = {
          ...input,
          catalogCreatedAt,
          id: generateId(),
          kind: "conversation",
          queuedAt,
          expiresAt: queuedAt + DELETION_UNDO_WINDOW_MS,
          attempts: 0,
        };
        // Write-ahead FIRST. Superseding before the insert destroyed the prior
        // pending deletion even when this queue attempt then failed; a failed
        // queue must leave every existing pending entry exactly as it was.
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
        // Only once the new intent is fully live do we commit the older one, so a
        // supersede failure can never strand the deletion the user just made.
        await supersedeOthers("conversation", entry.id);
        return entry;
      } finally {
        releaseQueueIntent(input.conversationKey);
      }
    });
  },

  queueTurnDeletion(
    input: Omit<
      PendingTurnDeletionEntry,
      "id" | "kind" | "queuedAt" | "expiresAt" | "attempts"
    >,
  ): Promise<PendingTurnDeletionEntry | null> {
    // Same contract as queueConversationDeletion: a turn intent must be visible
    // to finalizeTurnsForConversation's short-circuit from the moment it is
    // requested, not merely from when its op starts.
    retainQueueIntent(input.conversationKey);
    return enqueueOp(async () => {
      try {
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
        // Write-ahead FIRST (see queueConversationDeletion), and supersede only
        // other TURN entries — a turn deletion must never commit a conversation
        // deletion that is still undoable.
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
        await supersedeOthers("turn", entry.id);
        return entry;
      } finally {
        releaseQueueIntent(input.conversationKey);
      }
    });
  },

  undo(id: string): Promise<PendingDeletionEntry | null> {
    return enqueueOp(() => undoInternal(id));
  },

  finalize(id: string, reason: string): Promise<boolean> {
    return enqueueOp(() => finalizeInternal(id, reason));
  },

  finalizeForConversation(
    conversationKey: number,
    reason: string,
  ): Promise<boolean> {
    // Nothing queued for this key: answer without joining the shared chain.
    // Same answer the queued path gives ("no matching entries counts as
    // finalized"), without inheriting an unrelated conversation's latency.
    if (
      !hasUnrecordedQueueIntent(conversationKey) &&
      !hasEntriesForConversation(conversationKey)
    ) {
      return Promise.resolve(true);
    }
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

  // Turn-only variant for user-action paths (send/retry/edit). Those actions
  // commit hidden-turn removals, but must never commit a pending CONVERSATION
  // deletion: the same chat can still be mounted elsewhere while its deletion
  // is undoable, and the action would otherwise destroy it as a side effect.
  finalizeTurnsForConversation(
    conversationKey: number,
    reason: string,
  ): Promise<boolean> {
    // See finalizeForConversation: no pending turns means no work, and the user
    // path must not queue behind another conversation's finalize.
    if (
      !hasUnrecordedQueueIntent(conversationKey) &&
      !hasTurnEntriesForConversation(conversationKey)
    ) {
      return Promise.resolve(true);
    }
    return enqueueOp(async () => {
      const matching = Array.from(entries.values()).filter(
        (entry) =>
          entry.kind === "turn" && entry.conversationKey === conversationKey,
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

  // A user action inside a conversation whose deletion is still undoable means
  // the user wants the chat alive: withdraw the queued deletion instead of
  // letting it commit underneath them. Returns false when a durable intent
  // could not be withdrawn — callers must abort rather than write into a chat
  // whose write-ahead deletion row survives.
  restoreConversationDeletionsFor(conversationKey: number): Promise<boolean> {
    // Nothing to withdraw AND no deletion intent still waiting to be recorded:
    // answer without joining the shared chain. The counter is what makes this
    // safe — a queue op that has been requested but not yet run would not be
    // visible in `entries`, and skipping the chain would let the caller write
    // into a chat that is about to be hidden.
    if (
      !hasUnrecordedQueueIntent(conversationKey) &&
      !pendingDeletionStore.isConversationPendingDeletion(conversationKey)
    ) {
      return Promise.resolve(true);
    }
    return enqueueOp(async () => {
      const matching = Array.from(entries.values()).filter(
        (entry) =>
          entry.kind === "conversation" &&
          entry.conversationKey === conversationKey,
      );
      let allRestored = true;
      for (const entry of matching) {
        if (!(await undoInternal(entry.id))) {
          allRestored = false;
        }
      }
      return allRestored;
    });
  },

  getLatestPending(): PendingDeletionEntry | null {
    const lastId = queueOrder[queueOrder.length - 1];
    return (lastId && entries.get(lastId)) || null;
  },

  // Conversation and turn deletions can now be pending at the same time. A
  // surface that renders only one of them (the standalone window's conversation
  // toast) must fall back to the newest entry of THAT kind rather than going
  // blank because a turn deletion happens to be newer.
  getLatestPendingOfKind<K extends PendingDeletionEntry["kind"]>(
    kind: K,
  ): Extract<PendingDeletionEntry, { kind: K }> | null {
    for (let i = queueOrder.length - 1; i >= 0; i--) {
      const entry = entries.get(queueOrder[i]);
      if (entry && entry.kind === kind) {
        return entry as Extract<PendingDeletionEntry, { kind: K }>;
      }
    }
    return null;
  },

  // Includes intents that have been REQUESTED but are not yet recorded, so
  // callers guarding destructive/adopting behaviour (fresh-draft reuse, the
  // created_at touch) cannot act inside the insert window.
  isConversationPendingDeletion(conversationKey: number): boolean {
    if (hasUnrecordedQueueIntent(conversationKey)) return true;
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
        (entry) => entry.expiresAt <= now && !isInRetryBackoff(entry.id, now),
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
