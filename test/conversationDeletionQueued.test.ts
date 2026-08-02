import { assert } from "chai";
import {
  finalizeQueuedConversationDeletion,
  finalizeQueuedTurnDeletion,
} from "../src/modules/contextPanel/conversationDeletion";
import { chatHistory } from "../src/modules/contextPanel/state";
import type { Message } from "../src/modules/contextPanel/types";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

function message(role: "user" | "assistant", timestamp: number): Message {
  return { role, timestamp, text: `${role}@${timestamp}` } as Message;
}

describe("finalizeQueuedTurnDeletion", function () {
  afterEach(function () {
    chatHistory.clear();
    globalScope.Zotero = originalZotero;
  });

  it("deletes rows, drops the loaded in-memory pair, and reports success", async function () {
    const queries: string[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          queries.push(sql);
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
    chatHistory.set(5, [
      message("user", 100),
      message("assistant", 200),
      message("user", 300),
      message("assistant", 400),
    ]);
    const ok = await finalizeQueuedTurnDeletion({
      id: "pd-1",
      kind: "turn",
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
      queuedAt: 1,
      expiresAt: 2,
      attempts: 0,
    });
    assert.isTrue(ok);
    const remaining = chatHistory.get(5)!;
    assert.lengthOf(remaining, 2);
    assert.equal(remaining[0].timestamp, 300);
    assert.isTrue(
      queries.some((sql) => sql.includes("DELETE")),
      `expected a DELETE, got: ${queries.join(" | ")}`,
    );
  });

  it("returns false when the DB delete throws, leaving memory untouched", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("DELETE")) throw new Error("locked");
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
    chatHistory.set(5, [message("user", 100), message("assistant", 200)]);
    const ok = await finalizeQueuedTurnDeletion({
      id: "pd-2",
      kind: "turn",
      conversationKey: 5,
      system: "upstream",
      userTimestamp: 100,
      assistantTimestamp: 200,
      queuedAt: 1,
      expiresAt: 2,
      attempts: 0,
    });
    assert.isFalse(ok);
    assert.lengthOf(chatHistory.get(5)!, 2);
  });
});

describe("finalizeQueuedConversationDeletion stale-intent guards", function () {
  afterEach(function () {
    chatHistory.clear();
    globalScope.Zotero = originalZotero;
  });

  function baseEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "pd-c1",
      kind: "conversation" as const,
      conversationKind: "global" as const,
      conversationKey: 2_000_000_777,
      libraryID: 1,
      system: "upstream" as const,
      title: "Chat",
      wasActive: false,
      queuedAt: 1_000,
      expiresAt: 7_000,
      attempts: 0,
      ...overrides,
    };
  }

  it("drops a stale intent when the key is now registered to a different conversation", async function () {
    const destructive: string[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("llm_for_zotero_conversation_registry")) {
            if (sql.trimStart().toUpperCase().startsWith("SELECT")) {
              return [
                {
                  conversationID: "lfz:other:owner",
                  conversationKey: 2_000_000_777,
                  system: "upstream",
                  kind: "global",
                  profile_signature: "sig",
                  libraryID: 1,
                  paperItemID: null,
                  valid: 1,
                  invalidReason: null,
                },
              ];
            }
            return [];
          }
          if (sql.includes("DELETE")) destructive.push(sql);
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({ conversationID: "lfz:original:owner" }) as never,
    );
    assert.isTrue(ok, "stale intent must be treated as complete (drop row)");
    assert.lengthOf(destructive, 0, "the key's new owner must not be touched");
  });

  it("drops a stale ID-less intent when the catalog row was created after queueing", async function () {
    const destructive: string[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.trimStart().toUpperCase().startsWith("SELECT") &&
            sql.includes("llm_for_zotero_global_conversations")
          ) {
            return [
              {
                conversationID: "",
                conversationKey: 2_000_000_777,
                libraryID: 1,
                sessionVersion: 1,
                createdAt: 5_000, // AFTER queuedAt 1_000: a NEW conversation
                title: "New unrelated chat",
                lastActivityAt: 6_000,
                userTurnCount: 1,
              },
            ];
          }
          if (sql.includes("DELETE")) destructive.push(sql);
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
    };
    const ok = await finalizeQueuedConversationDeletion(
      baseEntry({ conversationID: undefined }) as never,
    );
    assert.isTrue(ok);
    assert.lengthOf(destructive, 0);
  });
});
