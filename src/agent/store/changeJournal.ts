/**
 * A durable record of what the agent changed, and how to put it back.
 *
 * Undo was ten JavaScript closures in RAM, per conversation, wiped by a
 * restart — against a runtime that permits 192 to 320 tool calls per run, and
 * a batch job that can touch thousands of items. Five of fifteen operations
 * recorded nothing at all. That is survivable when every write stops at a
 * confirmation card; it is not survivable once `yolo` lets a job run
 * unattended, which is why this lands with that capability rather than after
 * it.
 *
 * ## Where the entries come from
 *
 * Pre-images are captured **at the call site**, before the write. They cannot
 * come from a `Zotero.Notifier` observer: notifications are queued to
 * transaction commit, so by the time an observer runs, reading the item
 * returns the *new* state. A delete is worse — its payload carries neither a
 * pre-image nor an object type.
 *
 * The notifier is therefore used for a different job: an independent audit of
 * *what* changed, which catches writes made through paths that never call the
 * mutation service (a raw `zotero_script`, say). An entry with an observed
 * change and no inverse is recorded as `irreversible` with a reason — an
 * honest gap beats a silent one.
 */

const JOURNAL_TABLE = "llm_for_zotero_agent_change_journal";

export type JournalEntryStatus = "reversible" | "irreversible" | "reverted";

export type ChangeJournalEntry = {
  entryId: string;
  runId: string;
  conversationKey: number;
  /** Matrix operation name, e.g. "addToCollection". */
  operation: string;
  /** Human summary shown in the history panel. */
  description: string;
  /** Serialized inverse, replayed by the reverter. */
  inverseJson?: string;
  /** Why no inverse exists, when there is none. */
  irreversibleReason?: string;
  itemCount: number;
  status: JournalEntryStatus;
  createdAt: number;
};

type JournalRow = {
  entry_id: string;
  run_id: string;
  conversation_key: number;
  operation: string;
  description: string;
  inverse_json: string | null;
  irreversible_reason: string | null;
  item_count: number;
  status: string;
  created_at: number;
};

function hasDb(): boolean {
  try {
    return Boolean(
      (Zotero as unknown as { DB?: { queryAsync?: unknown } }).DB?.queryAsync,
    );
  } catch {
    return false;
  }
}

function normalizeStatus(value: unknown): JournalEntryStatus {
  return value === "irreversible" || value === "reverted" ? value : "reversible";
}

function toEntry(row: JournalRow): ChangeJournalEntry {
  return {
    entryId: row.entry_id,
    runId: row.run_id,
    conversationKey: Number(row.conversation_key) || 0,
    operation: row.operation,
    description: row.description,
    inverseJson: row.inverse_json ?? undefined,
    irreversibleReason: row.irreversible_reason ?? undefined,
    itemCount: Number(row.item_count) || 0,
    status: normalizeStatus(row.status),
    createdAt: Number(row.created_at) || 0,
  };
}

export async function initAgentChangeJournal(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
        entry_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        operation TEXT NOT NULL,
        description TEXT NOT NULL,
        inverse_json TEXT,
        irreversible_reason TEXT,
        item_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reversible','irreversible','reverted')),
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${JOURNAL_TABLE}_run_idx
       ON ${JOURNAL_TABLE} (conversation_key, created_at DESC)`,
    );
  });
}

export async function recordChange(entry: {
  entryId: string;
  runId: string;
  conversationKey: number;
  operation: string;
  description: string;
  inverse?: unknown;
  irreversibleReason?: string;
  itemCount: number;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  const reversible = entry.inverse !== undefined && !entry.irreversibleReason;
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${JOURNAL_TABLE}
      (entry_id, run_id, conversation_key, operation, description, inverse_json,
       irreversible_reason, item_count, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.entryId,
      entry.runId,
      entry.conversationKey,
      entry.operation,
      entry.description,
      reversible ? JSON.stringify(entry.inverse) : null,
      entry.irreversibleReason ?? null,
      entry.itemCount,
      reversible ? "reversible" : "irreversible",
      entry.now,
    ],
  );
}

/**
 * The history a user sees, newest first. Reverted entries stay listed —
 * hiding them would make the panel disagree with what actually happened.
 */
export async function listChangeJournal(params: {
  conversationKey: number;
  limit?: number;
}): Promise<ChangeJournalEntry[]> {
  if (!hasDb()) return [];
  const limit =
    Number.isFinite(params.limit) && Number(params.limit) > 0
      ? Math.floor(Number(params.limit))
      : 50;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${JOURNAL_TABLE}
     WHERE conversation_key = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    [params.conversationKey, limit],
  )) as unknown as JournalRow[] | null;
  return Array.isArray(rows) ? rows.map(toEntry) : [];
}

export async function listRunChangeJournal(
  runId: string,
): Promise<ChangeJournalEntry[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${JOURNAL_TABLE} WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
    [runId],
  )) as unknown as JournalRow[] | null;
  return Array.isArray(rows) ? rows.map(toEntry) : [];
}

export async function markChangeReverted(
  entryId: string,
  now: number,
): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${JOURNAL_TABLE} SET status = 'reverted', created_at = created_at WHERE entry_id = ?`,
    [entryId],
  );
  void now;
}

export async function clearAgentChangeJournal(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(`DELETE FROM ${JOURNAL_TABLE}`);
}
