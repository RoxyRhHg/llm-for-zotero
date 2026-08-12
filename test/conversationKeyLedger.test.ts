import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  allocateConversationKeyInTransaction,
  assertConversationKeyLiveInTransaction,
  ensureConversationKeyLedgerEntryInTransaction,
  getConversationKeyLedgerEntry,
  initConversationKeyLedgerStore,
  installConversationKeyLedgerCatalogTriggers,
  installConversationKeyLedgerAgentTriggers,
  installConversationKeyLedgerMessageTriggers,
  retireConversationKeyInTransaction,
  seedConversationKeyLedgerFromTombstones,
  reserveOrphanConversationMessageKeys,
  updateConversationKeyLedgerConversationIDInTransaction,
  ConversationRetiredError,
} from "../src/shared/conversationKeyLedger";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

describe("permanent conversation key ledger", function () {
  let db: DatabaseSync;

  beforeEach(function () {
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (Array.isArray(params) ? params : []).map((value) =>
        value === undefined ? null : value,
      ) as never[];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Profile: { dir: "/tmp/permanent-key-ledger-test" },
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const normalizedSql = sql.trimStart().toUpperCase();
          if (
            normalizedSql.startsWith("SELECT") ||
            normalizedSql.startsWith("PRAGMA") ||
            normalizedSql.startsWith("WITH")
          ) {
            return statement.all(...bindable(params));
          }
          statement.run(...bindable(params));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
    };
  });

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("retires a key permanently and allocates the next high-water key", async function () {
    await initConversationKeyLedgerStore();
    const first = (globalScope.Zotero as any).DB;
    const allocated = await first.executeTransaction(() =>
      allocateConversationKeyInTransaction({
        range: {
          system: "upstream",
          kind: "global",
          start: 1000,
          endExclusive: 1100,
        },
        libraryID: 1,
      }),
    );
    await first.executeTransaction(() =>
      updateConversationKeyLedgerConversationIDInTransaction({
        conversationKey: allocated.conversationKey,
        instanceID: allocated.instanceID,
        conversationID: "conversation-a",
      }),
    );
    await first.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: allocated.conversationKey,
        instanceID: allocated.instanceID,
      }),
    );

    try {
      await first.executeTransaction(() =>
        assertConversationKeyLiveInTransaction({
          conversationKey: allocated.conversationKey,
          instanceID: allocated.instanceID,
        }),
      );
      assert.fail("expected ConversationRetiredError");
    } catch (error) {
      assert.instanceOf(error, ConversationRetiredError);
    }

    const next = await first.executeTransaction(() =>
      allocateConversationKeyInTransaction({
        range: {
          system: "upstream",
          kind: "global",
          start: 1000,
          endExclusive: 1100,
        },
        libraryID: 1,
      }),
    );
    assert.equal(allocated.conversationKey, 1000);
    assert.equal(next.conversationKey, 1001);
  });

  it("rejects raw catalog and message writes for a retired identity", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE test_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE test_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        conversation_instance_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL
      )`,
    );
    await installConversationKeyLedgerCatalogTriggers(["test_catalog"]);
    await installConversationKeyLedgerMessageTriggers({
      messageTable: "test_messages",
      system: "upstream",
      catalogTables: ["test_catalog"],
    });
    const instanceID = "instance-a";
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 2000,
        instanceID,
        conversationID: "conversation-a",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `INSERT INTO test_catalog
       (conversation_key, conversation_instance_id, conversation_id)
       VALUES (?, ?, ?)`,
      [2000, instanceID, "conversation-a"],
    );
    await zotero.DB.queryAsync(
      `INSERT INTO test_messages
       (conversation_key, conversation_instance_id, conversation_id, text)
       VALUES (?, ?, ?, ?)`,
      [2000, instanceID, "conversation-a", "before"],
    );
    await zotero.DB.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: 2000,
        instanceID,
      }),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO test_catalog
           (conversation_key, conversation_instance_id, conversation_id)
           VALUES (?, ?, ?)`,
          )
          .run(2000, instanceID, "conversation-a"),
      /conversation key is not issued and live/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO test_messages
           (conversation_key, conversation_instance_id, conversation_id, text)
           VALUES (?, ?, ?, ?)`,
          )
          .run(2000, instanceID, "conversation-a", "after"),
      /message conversation identity is not live/,
    );
  });

  it("restarts cleanly when a tombstone already has a real ledger witness", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    const instanceID = "instance-restarted";
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 3000,
        instanceID,
        conversationID: "conversation-real-id",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_conversation_deletion_tombstones (
        identity_digest TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO llm_for_zotero_conversation_deletion_tombstones
        (identity_digest, conversation_key, instance_id, deleted_at)
       VALUES (?, ?, ?, ?)`,
      ["digest", 3000, instanceID, 2],
    );

    await seedConversationKeyLedgerFromTombstones();

    const entry = await getConversationKeyLedgerEntry(3000);
    assert.equal(entry?.conversationID, "conversation-real-id");
    assert.equal(entry?.instanceID, instanceID);
    assert.isNumber(entry?.retiredAt);
  });

  it("rejects late agent, coverage, and attachment writes for a retired key", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        question_excerpt TEXT NOT NULL,
        tools_used_json TEXT NOT NULL,
        answer_excerpt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_agent_coverage (
        scope_key TEXT NOT NULL,
        coverage_key TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        durable INTEGER NOT NULL,
        origin_conversation_key INTEGER,
        entry_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(scope_key, coverage_key)
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE llm_for_zotero_attachment_refs (
        owner_type TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        blob_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner_type, owner_id, blob_hash)
      )`,
    );
    await installConversationKeyLedgerAgentTriggers();
    await zotero.DB.executeTransaction(() =>
      ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: 4000,
        instanceID: "instance-agent",
        conversationID: "conversation-agent",
        system: "upstream",
        kind: "global",
        profileSignature: "profile-test",
        libraryID: 1,
        issuedAt: 1,
      }),
    );
    await zotero.DB.executeTransaction(() =>
      retireConversationKeyInTransaction({
        conversationKey: 4000,
        instanceID: "instance-agent",
      }),
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_agent_memory
             (conversation_key, question_excerpt, tools_used_json, answer_excerpt, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(4000, "late", "[]", "late", 1),
      /conversation key is permanently retired/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_agent_coverage
             (scope_key, coverage_key, resource_key, durable, origin_conversation_key, entry_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("paper:x", "coverage", "paper:x", 1, 4000, "{}", 1),
      /conversation key is permanently retired/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_attachment_refs
             (owner_type, owner_id, blob_hash, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run("conversation", 4000, "a".repeat(64), 1),
      /conversation key is permanently retired/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO llm_for_zotero_attachment_refs
             (owner_type, owner_id, blob_hash, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run("conversation", 4999, "b".repeat(64), 1),
      /conversation attachment owner is not live/,
    );
  });

  it("burns legacy message-only keys before allocation can adopt them", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_catalog (
        conversation_key INTEGER PRIMARY KEY,
        conversation_instance_id TEXT,
        conversation_id TEXT,
        library_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key INTEGER NOT NULL,
        text TEXT NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO orphan_messages (conversation_key, text)
       VALUES (?, ?)`,
      [5000, "legacy transcript"],
    );
    await reserveOrphanConversationMessageKeys({
      messageTable: "orphan_messages",
      catalogTables: ["orphan_catalog"],
      system: "upstream",
    });
    const entry = await getConversationKeyLedgerEntry(5000);
    assert.equal(entry?.retiredAt, entry?.issuedAt);
    assert.equal(entry?.retirementReason, "orphan-message-row-without-catalog");
    const next = await zotero.DB.executeTransaction(() =>
      allocateConversationKeyInTransaction({
        range: {
          system: "upstream",
          kind: "global",
          start: 5000,
          endExclusive: 5003,
        },
        libraryID: 1,
      }),
    );
    assert.equal(next.conversationKey, 5001);
  });

  it("burns orphan owner rows that use a nonstandard conversation-key column", async function () {
    await initConversationKeyLedgerStore();
    const zotero = globalScope.Zotero as any;
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_catalog (
        conversation_key INTEGER PRIMARY KEY
      )`,
    );
    await zotero.DB.queryAsync(
      `CREATE TABLE orphan_coverage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        origin_conversation_key INTEGER NOT NULL
      )`,
    );
    await zotero.DB.queryAsync(
      `INSERT INTO orphan_coverage (origin_conversation_key) VALUES (?)`,
      [6000],
    );

    await reserveOrphanConversationMessageKeys({
      catalogTables: ["orphan_catalog"],
      sourceTables: [
        { table: "orphan_coverage", column: "origin_conversation_key" },
      ],
      system: "upstream",
    });

    const entry = await getConversationKeyLedgerEntry(6000);
    assert.equal(entry?.retiredAt, entry?.issuedAt);
    assert.equal(entry?.retirementReason, "orphan-message-row-without-catalog");
  });
});
