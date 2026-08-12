import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { buildConversationID } from "../src/shared/conversationRegistry";
import { rekeyConversationOwnedRowsInTransaction } from "../src/shared/conversationSchemaMigrations";

const FORK_LINKS_TABLE = "llm_for_zotero_conversation_fork_links";

const PROFILE_SIGNATURE = "profile-1f2";
const LIBRARY_ID = 1;
// Chosen so the paper item id repeats the legacy conversation key's digits —
// that overlap is the whole point of these tests.
const PAPER_ITEM_ID = 12345;

// 12 is a digit prefix of 123, 124 and 1234.  Every assertion in this file
// depends on that overlap, so the fixtures below are deliberately chosen to
// collide; `guards` re-checks the overlap so a future fixture edit cannot make
// the suite pass by no longer exercising the bug.
const LEGACY_KEY = 12;
const TARGET_KEY = 4001;

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  run: (sql: string, params?: unknown[]) => void;
};

function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  // Zotero 7's queryAsync wraps rows in a proxy that THROWS when code reads a
  // column the SELECT did not include (node:sqlite returns undefined). Mimic
  // that here or the suite silently passes on exactly the row-access bugs
  // that break the real plugin.
  const toZoteroRow = (row: Record<string, unknown>) =>
    new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const stmt = db.prepare(sql);
    if (
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH")
    ) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: LIBRARY_ID },
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => task(),
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
    run: (sql, params) => {
      db.prepare(sql).run(...((params || []) as never[]));
    },
  };
}

function conversationIDFor(conversationKey: number): string {
  return buildConversationID({
    conversationKey,
    system: "claude_code",
    kind: "paper",
    libraryID: LIBRARY_ID,
    paperItemID: PAPER_ITEM_ID,
    profileSignature: PROFILE_SIGNATURE,
  });
}

// Copied verbatim from initConversationForkLinksStore
// (src/shared/conversationForkLinks.ts).  Inlined rather than calling the store
// initializer because that helper memoizes its init promise at module scope,
// which would leak across the in-memory databases this suite creates.
function createForkLinksTable(harness: SqliteHarness): void {
  harness.run(
    `CREATE TABLE IF NOT EXISTS ${FORK_LINKS_TABLE} (
      target_conversation_key INTEGER PRIMARY KEY,
      target_instance_id TEXT,
      target_conversation_id TEXT,
      target_system TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      source_conversation_key INTEGER NOT NULL,
      source_instance_id TEXT,
      source_conversation_id TEXT,
      source_system TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_library_id INTEGER NOT NULL,
      source_paper_item_id INTEGER,
      source_assistant_timestamp INTEGER NOT NULL,
      target_anchor_assistant_timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
}

function insertForkLink(
  harness: SqliteHarness,
  targetKey: number,
  sourceKey: number,
): void {
  harness.run(
    `INSERT INTO ${FORK_LINKS_TABLE}
      (target_conversation_key, target_conversation_id, target_system, target_kind,
       source_conversation_key, source_conversation_id, source_system, source_kind,
       source_library_id, source_paper_item_id,
       source_assistant_timestamp, target_anchor_assistant_timestamp, created_at)
     VALUES (?, ?, 'claude_code', 'paper', ?, ?, 'claude_code', 'paper', ?, ?, 1, 1, 1)`,
    [
      targetKey,
      conversationIDFor(targetKey),
      sourceKey,
      conversationIDFor(sourceKey),
      LIBRARY_ID,
      PAPER_ITEM_ID,
    ],
  );
}

function forkLinkRow(harness: SqliteHarness, targetKey: number) {
  return harness.all(
    `SELECT target_conversation_key AS targetKey,
            target_conversation_id AS targetID,
            source_conversation_key AS sourceKey,
            source_conversation_id AS sourceID
     FROM ${FORK_LINKS_TABLE}
     WHERE target_conversation_key = ?`,
    [targetKey],
  )[0];
}

describe("conversation key remap identity", function () {
  let harness: SqliteHarness;

  beforeEach(function () {
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
  });

  describe("fixture guards", function () {
    it("uses fixtures that actually encode the digit-prefix collision", function () {
      // If these stop holding, the assertions below no longer reproduce the
      // bug and would pass against the broken implementation.
      assert.isTrue(String(123).startsWith(String(LEGACY_KEY)));
      assert.isTrue(String(1234).startsWith(String(LEGACY_KEY)));
      assert.include(conversationIDFor(123), `legacy-${LEGACY_KEY}`);
      assert.include(conversationIDFor(1234), `legacy-${LEGACY_KEY}`);
      assert.isTrue(conversationIDFor(LEGACY_KEY).endsWith(`:legacy-12`));
    });
  });

  describe("rekeyConversationOwnedRowsInTransaction — fork link identities", function () {
    beforeEach(function () {
      createForkLinksTable(harness);
      // Row A: the remapped conversation is the fork target.
      insertForkLink(harness, LEGACY_KEY, 500);
      // Row B: the remapped conversation is the fork source, and the target
      // key (123) is digit-prefixed by it.
      insertForkLink(harness, 123, LEGACY_KEY);
      // Row C: neither key is being remapped, but both IDs contain the
      // remapped key as a digit prefix.
      insertForkLink(harness, 124, 1234);
    });

    it("moves the remapped conversation's own identity to the new key", async function () {
      await rekeyConversationOwnedRowsInTransaction(LEGACY_KEY, TARGET_KEY);

      const rowA = forkLinkRow(harness, TARGET_KEY);
      assert.equal(rowA.targetKey, TARGET_KEY);
      assert.equal(rowA.targetID, conversationIDFor(TARGET_KEY));
      assert.equal(rowA.sourceKey, 500);
      assert.equal(rowA.sourceID, conversationIDFor(500));

      const rowB = forkLinkRow(harness, 123);
      assert.equal(rowB.sourceKey, TARGET_KEY);
      assert.equal(rowB.sourceID, conversationIDFor(TARGET_KEY));
    });

    it("leaves identities whose key is merely digit-prefixed by the remapped key untouched", async function () {
      await rekeyConversationOwnedRowsInTransaction(LEGACY_KEY, TARGET_KEY);

      // Old behaviour rewrote these to `legacy-40013` / `legacy-400134`, so
      // the string claimed one conversation while the numeric column still
      // named another.
      const rowB = forkLinkRow(harness, 123);
      assert.equal(rowB.targetKey, 123);
      assert.equal(rowB.targetID, conversationIDFor(123));

      const rowC = forkLinkRow(harness, 124);
      assert.equal(rowC.targetKey, 124);
      assert.equal(rowC.targetID, conversationIDFor(124));
      assert.equal(rowC.sourceKey, 1234);
      assert.equal(rowC.sourceID, conversationIDFor(1234));
    });

    it("keeps every numeric key and its identity string in agreement", async function () {
      await rekeyConversationOwnedRowsInTransaction(LEGACY_KEY, TARGET_KEY);

      const rows = harness.all(
        `SELECT target_conversation_key AS targetKey,
                target_conversation_id AS targetID,
                source_conversation_key AS sourceKey,
                source_conversation_id AS sourceID
         FROM ${FORK_LINKS_TABLE}`,
      );
      assert.lengthOf(rows, 3);
      for (const row of rows) {
        assert.equal(
          row.targetID,
          conversationIDFor(Number(row.targetKey)),
          `target identity disagrees with key ${row.targetKey}`,
        );
        assert.equal(
          row.sourceID,
          conversationIDFor(Number(row.sourceKey)),
          `source identity disagrees with key ${row.sourceKey}`,
        );
      }
    });
  });
});
