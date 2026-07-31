import { assert } from "chai";
import { finalizeQueuedTurnDeletion } from "../src/modules/contextPanel/conversationDeletion";
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
