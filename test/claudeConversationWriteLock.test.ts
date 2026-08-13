import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  appendClaudeConversationMessageWithinWriteLock,
  updateLatestClaudeConversationAssistantMessageWithinWriteLock,
  updateLatestClaudeConversationUserMessageWithinWriteLock,
} from "../src/claudeCode/runtime";
import { CLAUDE_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import {
  resetConversationWriteFenceForTests,
  withConversationWriteLock,
} from "../src/shared/conversationWriteFence";

describe("Claude conversation write locking", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    resetConversationWriteFenceForTests();
    globalScope.Zotero = originalZotero;
  });

  it("persists Claude turns while the send path owns the write lock", async function () {
    const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 91;
    const queries: string[] = [];
    const summaryRow = {
      conversationID: "lfz:test:claude-write-lock",
      instanceID: "instance-claude-write-lock",
      conversationKey,
      libraryID: 1,
      kind: "global",
      paperItemID: null,
      createdAt: 100,
      updatedAt: 100,
      title: null,
      providerSessionId: null,
      scopedConversationKey: null,
      scopeType: null,
      scopeId: null,
      scopeLabel: null,
      cwd: null,
      modelName: null,
      effort: null,
      userTurnCount: 0,
    };
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string) => {
          queries.push(sql);
          return sql.includes("FROM llm_for_zotero_claude_conversations c") &&
            sql.includes("WHERE c.conversation_key = ?")
            ? [summaryRow]
            : [];
        },
        executeTransaction: async <T>(task: () => Promise<T>) => await task(),
      },
      debug: () => undefined,
      Profile: { dir: "/tmp/llm-for-zotero-claude-write-lock-test" },
      Utilities: { randomString: () => "write-lock-test" },
    };

    const completion = withConversationWriteLock(conversationKey, async () => {
      await appendClaudeConversationMessageWithinWriteLock(conversationKey, {
        role: "user",
        text: "initial question",
        timestamp: 200,
        modelName: "claude-sonnet-4-5",
      });
      await updateLatestClaudeConversationUserMessageWithinWriteLock(
        conversationKey,
        {
          text: "edited question",
          timestamp: 201,
        },
      );
      await updateLatestClaudeConversationAssistantMessageWithinWriteLock(
        conversationKey,
        {
          text: "answer",
          timestamp: 202,
          modelName: "claude-sonnet-4-5",
        },
      );
      return "completed";
    });
    const outcome = await Promise.race([
      completion,
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 1_000),
      ),
    ]);

    assert.equal(
      outcome,
      "completed",
      "Claude persistence must not reacquire its caller's conversation lock",
    );
    assert.isTrue(
      queries.some((sql) =>
        sql.includes("INSERT INTO llm_for_zotero_claude_messages"),
      ),
      "the regression must exercise the real Claude message store",
    );
  });
});
