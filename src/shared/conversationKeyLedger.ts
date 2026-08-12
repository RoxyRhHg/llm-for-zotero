import type { ConversationSystem } from "./types";
import { classifyConversationKey } from "./conversationKeySpace";

export type ConversationKeyLedgerKind = "global" | "paper";

export type ConversationKeyLedgerEntry = {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
  system: ConversationSystem;
  kind: ConversationKeyLedgerKind;
  profileSignature: string;
  libraryID: number;
  paperItemID?: number;
  issuedAt: number;
  retiredAt?: number;
  retirementReason?: string;
};

export type ConversationKeyRange = {
  system: ConversationSystem;
  kind: ConversationKeyLedgerKind;
  profileSignature?: string;
  start: number;
  endExclusive: number;
};

export class ConversationRetiredError extends Error {
  readonly conversationKey: number;
  readonly instanceID: string;

  constructor(conversationKey: number, instanceID = "") {
    super(`Conversation ${conversationKey} is permanently retired`);
    this.name = "ConversationRetiredError";
    this.conversationKey = conversationKey;
    this.instanceID = instanceID;
  }
}

const KEY_LEDGER_TABLE = "llm_for_zotero_conversation_key_ledger";
const KEY_COUNTERS_TABLE = "llm_for_zotero_conversation_key_counters";
const KEY_QUARANTINE_TABLE =
  "llm_for_zotero_conversation_key_identity_quarantine";
const KEY_LEDGER_SYSTEM_INDEX =
  "llm_for_zotero_conversation_key_ledger_system_idx";
const KEY_LEDGER_INSTANCE_INDEX =
  "llm_for_zotero_conversation_key_ledger_instance_idx";
let keyLedgerStoreInitialized = false;
let initializedDbRef: ZoteroDb | null = null;
const retiredConversationKeys = new Set<number>();

type ZoteroDb = {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: <T>(task: () => Promise<T>) => Promise<T>;
};

function getDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

function getCurrentProfileSignature(): string {
  const profileDir = String(
    (
      globalThis as typeof globalThis & {
        Zotero?: { Profile?: { dir?: unknown } };
      }
    ).Zotero?.Profile?.dir || "",
  )
    .trim()
    .replace(/\\/g, "/");
  if (!profileDir) return "profile-default";
  let hash = 2166136261;
  for (let i = 0; i < profileDir.length; i += 1) {
    hash ^= profileDir.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

function generateConversationInstanceID(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  if (typeof cryptoObject?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    cryptoObject.getRandomValues(values);
    return `instance-${Array.from(values, (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("")}`;
  }
  const zoteroRandomString = (
    globalThis as typeof globalThis & {
      Zotero?: { Utilities?: { randomString?: (length: number) => string } };
    }
  ).Zotero?.Utilities?.randomString;
  if (typeof zoteroRandomString === "function") {
    return `instance-${zoteroRandomString(32)}`;
  }
  throw new Error("Secure randomness unavailable for conversation identity");
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 256): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .trim()
        .slice(0, maxLength)
    : "";
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function normalizeKind(value: unknown): ConversationKeyLedgerKind | null {
  return value === "global" || value === "paper" ? value : null;
}

function normalizeRange(range: ConversationKeyRange): ConversationKeyRange {
  const start = normalizePositiveInt(range.start) || 0;
  const endExclusive = normalizePositiveInt(range.endExclusive) || 0;
  const system = normalizeSystem(range.system);
  const kind = normalizeKind(range.kind);
  if (!start || !endExclusive || endExclusive <= start || !system || !kind) {
    throw new Error("Invalid conversation key allocation range");
  }
  return {
    system,
    kind,
    profileSignature:
      normalizeText(range.profileSignature, 128) ||
      getCurrentProfileSignature(),
    start,
    endExclusive,
  };
}

function rangeID(range: ConversationKeyRange): string {
  const normalized = normalizeRange(range);
  // The numeric range, rather than only the profile hash, is authoritative.
  // Two profile signatures can hash into the same slot; they must still share
  // one allocator so they cannot issue the same key in one Zotero database.
  return [
    normalized.system,
    normalized.kind,
    normalized.start,
    normalized.endExclusive,
  ].join(":");
}

function normalizeEntry(
  entry: ConversationKeyLedgerEntry,
): ConversationKeyLedgerEntry {
  const conversationKey = normalizePositiveInt(entry.conversationKey);
  const instanceID = normalizeText(entry.instanceID, 128);
  const conversationID = normalizeText(entry.conversationID, 512);
  const system = normalizeSystem(entry.system);
  const kind = normalizeKind(entry.kind);
  const libraryID = normalizePositiveInt(entry.libraryID);
  const paperItemID = normalizePositiveInt(entry.paperItemID);
  if (
    !conversationKey ||
    !instanceID ||
    !conversationID ||
    !system ||
    !kind ||
    !libraryID ||
    (kind === "paper" && !paperItemID)
  ) {
    throw new Error("Invalid conversation key ledger entry");
  }
  return {
    conversationKey,
    instanceID,
    conversationID,
    system,
    kind,
    profileSignature:
      normalizeText(entry.profileSignature, 128) ||
      getCurrentProfileSignature(),
    libraryID,
    paperItemID: paperItemID || undefined,
    issuedAt: normalizePositiveInt(entry.issuedAt) || Date.now(),
    retiredAt: normalizePositiveInt(entry.retiredAt) || undefined,
    retirementReason: normalizeText(entry.retirementReason, 256) || undefined,
  };
}

export async function initConversationKeyLedgerStore(): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  keyLedgerStoreInitialized = false;
  initializedDbRef = null;
  // Rebuild the process-local fence from the durable ledger on every store
  // initialization.  Tests and profile migrations can replace rows while
  // keeping the same DB wrapper; retaining an old in-memory key would then
  // falsely retire a newly issued live key.
  retiredConversationKeys.clear();
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${KEY_LEDGER_TABLE} (
      conversation_key INTEGER PRIMARY KEY,
      instance_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')),
      kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
      profile_signature TEXT NOT NULL,
      library_id INTEGER NOT NULL,
      paper_item_id INTEGER,
      issued_at INTEGER NOT NULL,
      retired_at INTEGER,
      retirement_reason TEXT
    )`,
  );
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${KEY_COUNTERS_TABLE} (
      range_id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      kind TEXT NOT NULL,
      range_start INTEGER NOT NULL,
      range_end_exclusive INTEGER NOT NULL,
      next_key INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${KEY_QUARANTINE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key INTEGER NOT NULL,
      instance_id TEXT,
      conversation_id TEXT,
      system TEXT,
      kind TEXT,
      library_id INTEGER,
      paper_item_id INTEGER,
      reason TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    )`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${KEY_LEDGER_SYSTEM_INDEX}
     ON ${KEY_LEDGER_TABLE} (system, kind, retired_at, conversation_key)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${KEY_LEDGER_INSTANCE_INDEX}
     ON ${KEY_LEDGER_TABLE} (instance_id)`,
  );
  const retiredRows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE retired_at IS NOT NULL`,
  )) as Array<{ conversationKey?: unknown }> | undefined;
  for (const row of retiredRows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    if (key) retiredConversationKeys.add(key);
  }
  // Agent stores are lazy and may already exist when the ledger is restored
  // after a restart.  Install the database fence for any such tables now;
  // each lazy store also calls this helper after creating its own table.
  try {
    await installConversationKeyLedgerAgentTriggers();
  } catch (error) {
    // Ledger readiness is a safety claim: callers may only trust retired-key
    // writes after every discovered agent trigger has been installed.  Keep
    // the store unready so the next startup/lazy-store attempt retries rather
    // than silently running with a partial database fence.
    keyLedgerStoreInitialized = false;
    initializedDbRef = null;
    retiredConversationKeys.clear();
    throw error;
  }
  keyLedgerStoreInitialized = true;
  initializedDbRef = db;
}

export function isConversationKeyLedgerStoreInitialized(): boolean {
  return keyLedgerStoreInitialized && initializedDbRef === getDb();
}

/**
 * Fast process-local fence for callbacks that may arrive after the deletion
 * transaction has committed.  The database ledger remains authoritative; the
 * set only prevents an already-running callback from repopulating an in-memory
 * agent cache while its database write is being rejected by the ledger
 * triggers.
 */
export function isConversationKeyRetiredInMemory(
  conversationKey: number,
): boolean {
  const key = normalizePositiveInt(conversationKey);
  return Boolean(key && retiredConversationKeys.has(key));
}

export function rememberConversationKeyRetired(conversationKey: number): void {
  const key = normalizePositiveInt(conversationKey);
  if (key) retiredConversationKeys.add(key);
}

export async function getConversationKeyLedgerEntry(
  conversationKey: number,
): Promise<ConversationKeyLedgerEntry | null> {
  const db = getDb();
  const key = normalizePositiveInt(conversationKey);
  if (!db?.queryAsync || !key) return null;
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            instance_id AS instanceID,
            conversation_id AS conversationID,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            issued_at AS issuedAt,
            retired_at AS retiredAt,
            retirement_reason AS retirementReason
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ?
     LIMIT 1`,
    [key],
  )) as Array<Record<string, unknown>> | undefined;
  const row = rows?.[0];
  if (!row) return null;
  try {
    return normalizeEntry(row as ConversationKeyLedgerEntry);
  } catch (_error) {
    return null;
  }
}

export async function ensureConversationKeyLedgerEntryInTransaction(
  entry: ConversationKeyLedgerEntry,
): Promise<ConversationKeyLedgerEntry> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const normalized = normalizeEntry(entry);
  const existing = await getConversationKeyLedgerEntry(
    normalized.conversationKey,
  );
  if (existing) {
    if (
      existing.instanceID !== normalized.instanceID ||
      existing.conversationID !== normalized.conversationID ||
      existing.system !== normalized.system ||
      existing.kind !== normalized.kind
    ) {
      throw new Error(
        `Conversation key ${normalized.conversationKey} is already owned by another immutable identity`,
      );
    }
    if (existing.retiredAt && !normalized.retiredAt) {
      throw new ConversationRetiredError(
        normalized.conversationKey,
        normalized.instanceID,
      );
    }
    return existing;
  }
  await db.queryAsync(
    `INSERT INTO ${KEY_LEDGER_TABLE}
      (conversation_key, instance_id, conversation_id, system, kind,
       profile_signature, library_id, paper_item_id, issued_at, retired_at,
       retirement_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalized.conversationKey,
      normalized.instanceID,
      normalized.conversationID,
      normalized.system,
      normalized.kind,
      normalized.profileSignature,
      normalized.libraryID,
      normalized.paperItemID || null,
      normalized.issuedAt,
      normalized.retiredAt || null,
      normalized.retirementReason || null,
    ],
  );
  return normalized;
}

export async function ensureConversationKeyLedgerEntry(
  entry: ConversationKeyLedgerEntry,
): Promise<ConversationKeyLedgerEntry> {
  await initConversationKeyLedgerStore();
  const db = getDb();
  if (!db?.executeTransaction) {
    throw new Error("Conversation key ledger transaction DB is unavailable");
  }
  return db.executeTransaction(() =>
    ensureConversationKeyLedgerEntryInTransaction(entry),
  );
}

export async function allocateConversationKeyInTransaction(params: {
  range: ConversationKeyRange;
  instanceID?: string;
  conversationID?: string;
  libraryID: number;
  paperItemID?: number;
  issuedAt?: number;
}): Promise<ConversationKeyLedgerEntry> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const range = normalizeRange(params.range);
  const instanceID =
    normalizeText(params.instanceID, 128) || generateConversationInstanceID();
  const conversationID =
    normalizeText(params.conversationID, 512) ||
    `pending-conversation:${instanceID}`;
  const libraryID = normalizePositiveInt(params.libraryID);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  if (
    !conversationID ||
    !libraryID ||
    (range.kind === "paper" && !paperItemID)
  ) {
    throw new Error("Invalid conversation key allocation request");
  }
  const id = rangeID(range);
  const counterRows = (await db.queryAsync(
    `SELECT next_key AS nextKey
     FROM ${KEY_COUNTERS_TABLE}
     WHERE range_id = ?
     LIMIT 1`,
    [id],
  )) as Array<{ nextKey?: unknown }> | undefined;
  const maxRows = (await db.queryAsync(
    `SELECT MAX(conversation_key) AS maxKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key >= ?
       AND conversation_key < ?`,
    [range.start, range.endExclusive],
  )) as Array<{ maxKey?: unknown }> | undefined;
  let candidate = Math.max(
    range.start,
    Number(counterRows?.[0]?.nextKey) || 0,
    (Number(maxRows?.[0]?.maxKey) || range.start - 1) + 1,
  );
  while (candidate < range.endExclusive) {
    const usedRows = (await db.queryAsync(
      `SELECT 1 AS present
       FROM ${KEY_LEDGER_TABLE}
       WHERE conversation_key = ?
       LIMIT 1`,
      [candidate],
    )) as Array<{ present?: unknown }> | undefined;
    if (!usedRows?.length) break;
    candidate += 1;
  }
  if (candidate >= range.endExclusive) {
    throw new Error(
      `Conversation key range exhausted for ${range.system}/${range.kind}`,
    );
  }
  const entry = await ensureConversationKeyLedgerEntryInTransaction({
    conversationKey: candidate,
    instanceID,
    conversationID,
    system: range.system,
    kind: range.kind,
    profileSignature: range.profileSignature || getCurrentProfileSignature(),
    libraryID,
    paperItemID: paperItemID || undefined,
    issuedAt: params.issuedAt || Date.now(),
  });
  await db.queryAsync(
    `INSERT INTO ${KEY_COUNTERS_TABLE}
      (range_id, system, kind, range_start, range_end_exclusive, next_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(range_id) DO UPDATE SET
       next_key = MAX(${KEY_COUNTERS_TABLE}.next_key, excluded.next_key),
       updated_at = excluded.updated_at`,
    [
      id,
      range.system,
      range.kind,
      range.start,
      range.endExclusive,
      candidate + 1,
      Date.now(),
    ],
  );
  return entry;
}

/** Initialize/advance a high-water counter during migration.  This never
 * removes a counter and never moves it backwards, even when legacy rows have
 * holes or a preference was lost. */
export async function initializeConversationKeyCounterInTransaction(
  range: ConversationKeyRange,
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const normalized = normalizeRange(range);
  const id = rangeID(normalized);
  const maxRows = (await db.queryAsync(
    `SELECT MAX(conversation_key) AS maxKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key >= ? AND conversation_key < ?`,
    [normalized.start, normalized.endExclusive],
  )) as Array<{ maxKey?: unknown }> | undefined;
  const existingRows = (await db.queryAsync(
    `SELECT next_key AS nextKey
     FROM ${KEY_COUNTERS_TABLE}
     WHERE range_id = ? LIMIT 1`,
    [id],
  )) as Array<{ nextKey?: unknown }> | undefined;
  const nextKey = Math.max(
    normalized.start,
    Number(existingRows?.[0]?.nextKey) || 0,
    (Number(maxRows?.[0]?.maxKey) || normalized.start - 1) + 1,
  );
  await db.queryAsync(
    `INSERT INTO ${KEY_COUNTERS_TABLE}
      (range_id, system, kind, range_start, range_end_exclusive, next_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(range_id) DO UPDATE SET
       next_key = MAX(${KEY_COUNTERS_TABLE}.next_key, excluded.next_key),
       updated_at = excluded.updated_at`,
    [
      id,
      normalized.system,
      normalized.kind,
      normalized.start,
      normalized.endExclusive,
      nextKey,
      Date.now(),
    ],
  );
}

/**
 * Recover a crash between provider-store key allocation and catalog commit.
 * A live ledger row with no matching catalog witness is not a conversation;
 * retire it permanently so startup can never expose or allocate it again.
 */
export async function retireOrphanedConversationLedgerEntries(params: {
  system: ConversationSystem;
  kind: ConversationKeyLedgerKind;
  catalogTables: readonly string[];
}): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) return;
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            instance_id AS instanceID
     FROM ${KEY_LEDGER_TABLE}
     WHERE system = ? AND kind = ? AND retired_at IS NULL`,
    [params.system, params.kind],
  )) as Array<{ conversationKey?: unknown; instanceID?: unknown }> | undefined;
  for (const row of rows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    const instanceID = normalizeText(row.instanceID, 128);
    if (!key || !instanceID) continue;
    let hasCatalogWitness = false;
    for (const table of params.catalogTables) {
      const safeTable = table.replace(/[^A-Za-z0-9_]/g, "");
      try {
        const witnessRows = (await db.queryAsync(
          `SELECT 1 AS present
           FROM ${safeTable}
           WHERE conversation_key = ?
             AND conversation_instance_id = ?
           LIMIT 1`,
          [key, instanceID],
        )) as Array<{ present?: unknown }> | undefined;
        if (witnessRows?.length) {
          hasCatalogWitness = true;
          break;
        }
      } catch (error) {
        if (
          /no such table|no such column|unknown column/i.test(String(error))
        ) {
          continue;
        }
        throw error;
      }
    }
    if (hasCatalogWitness) continue;
    await retireConversationKeyInTransaction({
      conversationKey: key,
      instanceID,
      reason: "orphaned-ledger-allocation-after-crash",
    });
    rememberConversationKeyRetired(key);
    try {
      await db.queryAsync(
        `DELETE FROM llm_for_zotero_conversation_registry
         WHERE legacy_conversation_key = ? AND instance_id = ?`,
        [key, instanceID],
      );
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }
  }
}

export async function updateConversationKeyLedgerConversationIDInTransaction(params: {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
}): Promise<void> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  const conversationID = normalizeText(params.conversationID, 512);
  if (!db?.queryAsync || !key || !instanceID || !conversationID) {
    throw new Error("Invalid conversation key ledger identity update");
  }
  await db.queryAsync(
    `UPDATE ${KEY_LEDGER_TABLE}
     SET conversation_id = ?
     WHERE conversation_key = ?
       AND instance_id = ?`,
    [conversationID, key, instanceID],
  );
}

export async function retireConversationKeyInTransaction(params: {
  conversationKey: number;
  instanceID: string;
  reason?: string;
  retiredAt?: number;
}): Promise<void> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  if (!db?.queryAsync || !key || !instanceID) {
    throw new Error("Invalid conversation key retirement request");
  }
  const rows = (await db.queryAsync(
    `SELECT instance_id AS instanceID
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ?
     LIMIT 1`,
    [key],
  )) as Array<{ instanceID?: unknown }> | undefined;
  if (rows?.length && normalizeText(rows[0]?.instanceID, 128) !== instanceID) {
    throw new Error(
      `Refused to retire conversation key ${key}: identity mismatch`,
    );
  }
  if (!rows?.length) {
    throw new Error(
      `Refused to retire conversation key ${key}: ledger entry missing`,
    );
  }
  await db.queryAsync(
    `UPDATE ${KEY_LEDGER_TABLE}
     SET retired_at = COALESCE(retired_at, ?),
         retirement_reason = COALESCE(retirement_reason, ?)
     WHERE conversation_key = ?
       AND instance_id = ?`,
    [
      normalizePositiveInt(params.retiredAt) || Date.now(),
      normalizeText(params.reason, 256) || "conversation-deleted",
      key,
      instanceID,
    ],
  );
}

export async function assertConversationKeyLiveInTransaction(params: {
  conversationKey: number;
  instanceID: string;
}): Promise<void> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  if (!db?.queryAsync || !key || !instanceID) {
    throw new Error("Invalid conversation identity");
  }
  const rows = (await db.queryAsync(
    `SELECT 1 AS live
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ?
       AND instance_id = ?
       AND retired_at IS NULL
     LIMIT 1`,
    [key, instanceID],
  )) as Array<{ live?: unknown }> | undefined;
  if (!rows?.length) {
    throw new ConversationRetiredError(key, instanceID);
  }
}

export async function installConversationKeyLedgerCatalogTriggers(
  catalogTables: readonly string[],
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  for (const table of catalogTables) {
    const safeTable = table.replace(/[^A-Za-z0-9_]/g, "");
    const insertTrigger = `${safeTable}_conversation_key_ledger_insert`;
    const updateTrigger = `${safeTable}_conversation_key_ledger_update`;
    await db.queryAsync(
      `CREATE TRIGGER IF NOT EXISTS ${insertTrigger}
       BEFORE INSERT ON ${safeTable}
       WHEN NOT EXISTS (
         SELECT 1
         FROM ${KEY_LEDGER_TABLE} l
         WHERE l.conversation_key = NEW.conversation_key
           AND l.instance_id = NEW.conversation_instance_id
           AND l.retired_at IS NULL
       )
       BEGIN
         SELECT RAISE(ABORT, 'conversation key is not issued and live');
       END`,
    );
    await db.queryAsync(
      `CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
       BEFORE UPDATE OF conversation_key, conversation_instance_id ON ${safeTable}
       WHEN NOT EXISTS (
         SELECT 1
         FROM ${KEY_LEDGER_TABLE} l
         WHERE l.conversation_key = NEW.conversation_key
           AND l.instance_id = NEW.conversation_instance_id
           AND l.retired_at IS NULL
       )
       BEGIN
         SELECT RAISE(ABORT, 'conversation key identity cannot be changed');
       END`,
    );
  }
}

/**
 * Prevent message rows from outliving (or bypassing) their exact catalog
 * identity.  These triggers are deliberately database-level guards: runtime
 * fences protect normal code paths, while the trigger also protects repair
 * scripts, stale callbacks, and direct SQL writes.
 */
export async function installConversationKeyLedgerMessageTriggers(params: {
  messageTable: string;
  system: ConversationSystem;
  catalogTables: readonly string[];
}): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) {
    throw new Error("Conversation key ledger DB is unavailable");
  }
  const messageTable = params.messageTable.replace(/[^A-Za-z0-9_]/g, "");
  const catalogTables = params.catalogTables.map((table) =>
    table.replace(/[^A-Za-z0-9_]/g, ""),
  );
  if (!messageTable || !catalogTables.length) return;
  const catalogWitness = catalogTables
    .map(
      (table) =>
        `SELECT conversation_key, conversation_instance_id FROM ${table}`,
    )
    .join(" UNION ALL ");
  const predicate = `
    EXISTS (
      SELECT 1
      FROM ${KEY_LEDGER_TABLE} l
      JOIN (${catalogWitness}) c
        ON c.conversation_key = NEW.conversation_key
       AND c.conversation_instance_id = NEW.conversation_instance_id
      WHERE l.conversation_key = NEW.conversation_key
        AND l.instance_id = NEW.conversation_instance_id
        AND l.system = '${params.system}'
        AND l.retired_at IS NULL
    )`;
  const insertTrigger = `${messageTable}_conversation_identity_insert`;
  const updateTrigger = `${messageTable}_conversation_identity_update`;
  await db.queryAsync(
    `CREATE TRIGGER IF NOT EXISTS ${insertTrigger}
     BEFORE INSERT ON ${messageTable}
     WHEN NOT ${predicate}
     BEGIN
       SELECT RAISE(ABORT, 'message conversation identity is not live');
     END`,
  );
  await db.queryAsync(
    `CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
     BEFORE UPDATE OF conversation_key, conversation_instance_id ON ${messageTable}
     WHEN NOT ${predicate}
     BEGIN
       SELECT RAISE(ABORT, 'message conversation identity cannot be changed');
     END`,
  );
}

/**
 * Install a single database-level fence for every conversation-owned agent
 * table.  These stores predate immutable instance IDs and therefore retain
 * their numeric key columns for compatibility; permanent key retirement is
 * the safety boundary for those legacy rows.  A late callback can still run,
 * but SQLite rejects it once the ledger marks the key retired.
 */
export async function installConversationKeyLedgerAgentTriggers(): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) return;
  let rows: Array<{ name?: unknown }> | undefined;
  try {
    rows = (await db.queryAsync(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    )) as Array<{ name?: unknown }> | undefined;
  } catch {
    // Non-SQLite test doubles and older Zotero DB wrappers do not expose the
    // catalog query.  Their normal runtime fences remain in effect.
    return;
  }
  const tables = new Set(
    (rows || [])
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
  const keyTables = [
    "llm_for_zotero_agent_memory",
    "llm_for_zotero_agent_transcript",
    "llm_for_zotero_agent_tool_result_handles",
    "llm_for_zotero_agent_evidence",
    "llm_for_zotero_agent_runs",
    "llm_for_zotero_agent_trace_exports",
  ];
  for (const table of keyTables) {
    if (!tables.has(table)) continue;
    const safe = table.replace(/[^A-Za-z0-9_]/g, "");
    try {
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${safe}_retired_key_insert
         BEFORE INSERT ON ${safe}
         WHEN EXISTS (
           SELECT 1 FROM ${KEY_LEDGER_TABLE} l
           WHERE l.conversation_key = NEW.conversation_key
             AND l.retired_at IS NOT NULL
         )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${safe}_retired_key_update
         BEFORE UPDATE OF conversation_key ON ${safe}
         WHEN EXISTS (
           SELECT 1 FROM ${KEY_LEDGER_TABLE} l
           WHERE l.conversation_key = NEW.conversation_key
             AND l.retired_at IS NOT NULL
         )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }

  const coverageTable = "llm_for_zotero_agent_coverage";
  if (tables.has(coverageTable)) {
    try {
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${coverageTable}_retired_origin_insert
         BEFORE INSERT ON ${coverageTable}
         WHEN NEW.origin_conversation_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.origin_conversation_key
              AND l.retired_at IS NOT NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${coverageTable}_retired_origin_update
         BEFORE UPDATE OF origin_conversation_key ON ${coverageTable}
         WHEN NEW.origin_conversation_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.origin_conversation_key
              AND l.retired_at IS NOT NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }

  const eventsTable = "llm_for_zotero_agent_run_events";
  const runsTable = "llm_for_zotero_agent_runs";
  if (tables.has(eventsTable) && tables.has(runsTable)) {
    try {
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${eventsTable}_live_run_insert
         BEFORE INSERT ON ${eventsTable}
         WHEN NOT EXISTS (
           SELECT 1
           FROM ${runsTable} r
           JOIN ${KEY_LEDGER_TABLE} l
             ON l.conversation_key = r.conversation_key
            AND l.retired_at IS NULL
           WHERE r.run_id = NEW.run_id
         )
         BEGIN
           SELECT RAISE(ABORT, 'agent run is not live');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${eventsTable}_live_run_update
         BEFORE UPDATE OF run_id ON ${eventsTable}
         WHEN NOT EXISTS (
           SELECT 1
           FROM ${runsTable} r
           JOIN ${KEY_LEDGER_TABLE} l
             ON l.conversation_key = r.conversation_key
            AND l.retired_at IS NULL
           WHERE r.run_id = NEW.run_id
         )
         BEGIN
           SELECT RAISE(ABORT, 'agent run is not live');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }

  const refsTable = "llm_for_zotero_attachment_refs";
  if (tables.has(refsTable)) {
    try {
      // Attachment references predate immutable instance IDs, but a numeric
      // owner key is still unsafe when it has never been issued.  The legacy
      // retired-key trigger below protects only one half of that boundary;
      // this v2 fence rejects both unknown and retired conversation owners so
      // an orphan ref cannot be adopted by a future allocation.
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${refsTable}_issued_conversation_insert
         BEFORE INSERT ON ${refsTable}
         WHEN NEW.owner_type = 'conversation'
          AND NOT EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.owner_id
              AND l.retired_at IS NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation attachment owner is not live');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${refsTable}_issued_conversation_update
         BEFORE UPDATE OF owner_type, owner_id ON ${refsTable}
         WHEN NEW.owner_type = 'conversation'
          AND NOT EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.owner_id
              AND l.retired_at IS NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation attachment owner is not live');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${refsTable}_live_conversation_insert
         BEFORE INSERT ON ${refsTable}
         WHEN NEW.owner_type = 'conversation'
          AND EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.owner_id
              AND l.retired_at IS NOT NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${refsTable}_live_conversation_update
         BEFORE UPDATE OF owner_type, owner_id ON ${refsTable}
         WHEN NEW.owner_type = 'conversation'
          AND EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.owner_id
              AND l.retired_at IS NOT NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }
}

export async function seedConversationKeyLedgerFromCatalogs(
  catalogs: ReadonlyArray<{
    table: string;
    system: ConversationSystem;
    kind: ConversationKeyLedgerKind;
    kindColumn?: boolean;
  }>,
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  for (const catalog of catalogs) {
    const table = catalog.table.replace(/[^A-Za-z0-9_]/g, "");
    let rows: Array<Record<string, unknown>> | undefined;
    try {
      rows = (await db.queryAsync(
        `SELECT conversation_key AS conversationKey,
                conversation_instance_id AS instanceID,
                conversation_id AS conversationID,
                library_id AS libraryID,
                ${catalog.kind === "paper" ? "paper_item_id" : "NULL"} AS paperItemID,
                COALESCE(last_activity_at, created_at, updated_at) AS issuedAt
         FROM ${table}${catalog.kindColumn ? " WHERE kind = ?" : ""}`,
        catalog.kindColumn ? [catalog.kind] : undefined,
      )) as Array<Record<string, unknown>> | undefined;
    } catch (error) {
      if (/no such table|no table/i.test(String(error))) continue;
      if (!/no such column|unknown column/i.test(String(error))) throw error;
      rows = (await db.queryAsync(
        `SELECT conversation_key AS conversationKey,
                conversation_instance_id AS instanceID,
                conversation_id AS conversationID,
                library_id AS libraryID,
                ${catalog.kind === "paper" ? "paper_item_id" : "NULL"} AS paperItemID,
                created_at AS issuedAt
         FROM ${table}${catalog.kindColumn ? " WHERE kind = ?" : ""}`,
        catalog.kindColumn ? [catalog.kind] : undefined,
      )) as Array<Record<string, unknown>> | undefined;
    }
    for (const row of rows || []) {
      const key = normalizePositiveInt(row.conversationKey);
      const libraryID = normalizePositiveInt(row.libraryID);
      if (!key || !libraryID) continue;
      const instanceID =
        normalizeText(row.instanceID, 128) ||
        `legacy-instance:${catalog.system}:${catalog.kind}:${key}`;
      const conversationID =
        normalizeText(row.conversationID, 512) ||
        `legacy-conversation:${catalog.system}:${catalog.kind}:${key}`;
      const paperItemID = normalizePositiveInt(row.paperItemID) || undefined;
      try {
        await ensureConversationKeyLedgerEntryInTransaction({
          conversationKey: key,
          instanceID,
          conversationID,
          system: catalog.system,
          kind: catalog.kind,
          profileSignature: getCurrentProfileSignature(),
          libraryID,
          paperItemID,
          issuedAt: normalizePositiveInt(row.issuedAt) || Date.now(),
        });
      } catch (error) {
        // Two legacy witnesses claiming one numeric key cannot be repaired
        // safely. Preserve the conflicting witness durably and keep the
        // allocator moving; later identity repair can quarantine the owning
        // catalog without deleting user data or silently choosing a winner.
        await db.queryAsync(
          `INSERT INTO ${KEY_QUARANTINE_TABLE}
            (conversation_key, instance_id, conversation_id, system, kind,
             library_id, paper_item_id, reason, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            instanceID,
            conversationID,
            catalog.system,
            catalog.kind,
            libraryID,
            paperItemID || null,
            `conflicting-legacy-identity:${String(error)}`.slice(0, 512),
            Date.now(),
          ],
        );
      }
    }
  }
}

/** Reserve keys recorded by the durable deletion tombstone table even when
 * their catalog row was removed before this migration first ran. */
export async function seedConversationKeyLedgerFromTombstones(): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  let rows: Array<Record<string, unknown>> | undefined;
  try {
    rows = (await db.queryAsync(
      `SELECT conversation_key AS conversationKey,
              instance_id AS instanceID,
              deleted_at AS deletedAt
       FROM llm_for_zotero_conversation_deletion_tombstones`,
    )) as Array<Record<string, unknown>> | undefined;
  } catch (error) {
    if (/no such table|no table/i.test(String(error))) return;
    throw error;
  }
  for (const row of rows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    const classification = key ? classifyConversationKey(key) : null;
    if (!key || !classification) continue;
    const instanceID =
      normalizeText(row.instanceID, 128) || `legacy-retired-instance:${key}`;
    const paperItemID = classification.kind === "paper" ? 1 : undefined;
    const existing = await getConversationKeyLedgerEntry(key);
    if (existing && existing.instanceID !== instanceID) {
      // A tombstone is evidence that this numeric key is retired, not a
      // license to overwrite the immutable ledger owner.  Preserve the
      // existing witness and leave the conflict for the quarantine sweep.
      await db.queryAsync(
        `INSERT INTO ${KEY_QUARANTINE_TABLE}
          (conversation_key, instance_id, conversation_id, system, kind,
           library_id, paper_item_id, reason, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          instanceID,
          null,
          classification.system,
          classification.kind,
          1,
          paperItemID || null,
          "tombstone-instance-conflicts-with-ledger-owner",
          Date.now(),
        ],
      );
      continue;
    }
    if (!existing) {
      await ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: key,
        instanceID,
        conversationID: `legacy-retired-conversation:${key}`,
        system: classification.system,
        kind: classification.kind,
        profileSignature: getCurrentProfileSignature(),
        libraryID: 1,
        paperItemID,
        issuedAt: normalizePositiveInt(row.deletedAt) || Date.now(),
        retiredAt: normalizePositiveInt(row.deletedAt) || Date.now(),
        retirementReason: "legacy-deletion-tombstone",
      });
    }
    await retireConversationKeyInTransaction({
      conversationKey: key,
      instanceID,
      reason: "legacy-deletion-tombstone",
      retiredAt: normalizePositiveInt(row.deletedAt) || Date.now(),
    });
    rememberConversationKeyRetired(key);
  }
}

/**
 * Burn legacy message-only keys before any catalog/provisioning path can
 * allocate them.  A message row without a matching catalog is an
 * unverifiable ownership witness: it is preserved for forensic recovery, but
 * it must never be adopted by a newer conversation instance.
 */
export async function reserveOrphanConversationMessageKeys(params: {
  messageTable?: string;
  sourceTables?: ReadonlyArray<{
    table: string;
    column?: string;
    whereSql?: string;
  }>;
  catalogTables: string[];
  system: ConversationSystem;
}): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const sourceTables = [
    ...(params.messageTable
      ? [{ table: params.messageTable, column: "conversation_key" }]
      : []),
    ...(params.sourceTables || []),
  ]
    .map((source) => ({
      table: source.table.replace(/[^A-Za-z0-9_]/g, ""),
      column: (source.column || "conversation_key").replace(
        /[^A-Za-z0-9_]/g,
        "",
      ),
      whereSql: source.whereSql || "",
    }))
    .filter((source) => source.table && source.column);
  const catalogTables = params.catalogTables
    .map((table) => table.replace(/[^A-Za-z0-9_]/g, ""))
    .filter(Boolean);
  const system = normalizeSystem(params.system);
  if (!sourceTables.length || !catalogTables.length || !system) return;
  const keys = new Set<number>();
  for (const source of sourceTables) {
    // Source stores do not all use the canonical `conversation_key` column:
    // coverage uses `origin_conversation_key`, attachment refs use `owner_id`,
    // and registry/search/fork tables use legacy/source/target witnesses.
    // Build the catalog anti-join against the normalized source column rather
    // than a hard-coded alias, otherwise those rows silently evade quarantine
    // (the query would fail with "no such column" and be treated as an absent
    // optional table/column).
    const catalogPredicate = catalogTables
      .map(
        (table) =>
          `NOT EXISTS (SELECT 1 FROM ${table} c${table} WHERE c${table}.conversation_key = s.${source.column})`,
      )
      .join(" AND ");
    let rows: Array<{ conversationKey?: unknown }> | undefined;
    try {
      rows = (await db.queryAsync(
        `SELECT DISTINCT s.${source.column} AS conversationKey
         FROM ${source.table} s
         WHERE s.${source.column} IS NOT NULL
           ${source.whereSql ? `AND ${source.whereSql}` : ""}
           AND ${catalogPredicate.replaceAll("m.", "s.")}`,
      )) as Array<{ conversationKey?: unknown }> | undefined;
    } catch (error) {
      if (/no such table|no table/i.test(String(error))) continue;
      if (/no such column|unknown column/i.test(String(error))) continue;
      throw error;
    }
    for (const row of rows || []) {
      const key = normalizePositiveInt(row.conversationKey);
      if (key) keys.add(key);
    }
  }
  for (const key of keys) {
    const classification = key ? classifyConversationKey(key) : null;
    if (!key || !classification || classification.system !== system) continue;
    const kind = classification.kind;
    const instanceID = `quarantined-orphan:${system}:${key}`;
    const conversationID = `quarantined-orphan-conversation:${system}:${key}`;
    const paperItemID = kind === "paper" ? 1 : undefined;
    const existing = await getConversationKeyLedgerEntry(key);
    if (existing) {
      if (!existing.retiredAt) {
        await db.queryAsync(
          `INSERT INTO ${KEY_QUARANTINE_TABLE}
            (conversation_key, instance_id, conversation_id, system, kind,
             library_id, paper_item_id, reason, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            existing.instanceID,
            existing.conversationID,
            existing.system,
            existing.kind,
            existing.libraryID,
            existing.paperItemID || null,
            "orphan-message-row-without-catalog",
            Date.now(),
          ],
        );
      }
      continue;
    }
    await ensureConversationKeyLedgerEntryInTransaction({
      conversationKey: key,
      instanceID,
      conversationID,
      system,
      kind,
      profileSignature: getCurrentProfileSignature(),
      libraryID: 1,
      paperItemID,
      issuedAt: Date.now(),
      retiredAt: Date.now(),
      retirementReason: "orphan-message-row-without-catalog",
    });
    rememberConversationKeyRetired(key);
  }
}

export const CONVERSATION_KEY_LEDGER_TABLE = KEY_LEDGER_TABLE;
export const CONVERSATION_KEY_COUNTERS_TABLE = KEY_COUNTERS_TABLE;
export const CONVERSATION_KEY_QUARANTINE_TABLE = KEY_QUARANTINE_TABLE;
