import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

// User actions (send/retry/edit) run against a conversation that can still be
// mounted in another panel while an undoable conversation deletion is pending.
// Those paths may only commit hidden TURN deletions; the conversation deletion
// itself must be restored (the action proves the user wants the chat alive),
// and the action must abort when the durable intent cannot be withdrawn.
describe("chat user actions vs pending deletions", function () {
  const chatSource = () =>
    readFileSync(resolve(here, "../src/modules/contextPanel/chat.ts"), "utf8");

  it("never uses the kind-agnostic finalizer from a user action", function () {
    assert.notInclude(
      chatSource(),
      "pendingDeletionStore.finalizeForConversation(",
      "chat.ts must use finalizeTurnsForConversation; the kind-agnostic " +
        "finalizer would commit a pending conversation deletion mid-undo-window",
    );
  });

  it("send finalizes turns only, restores pending conversation deletions, and aborts when restore fails", function () {
    const source = chatSource();
    const send = source.indexOf("export async function sendQuestion");
    assert.isAtLeast(send, 0);
    const nextExport = source.indexOf("\nexport ", send + 1);
    const body = source.slice(send, nextExport === -1 ? undefined : nextExport);
    assert.match(
      body,
      /pendingDeletionStore\.finalizeTurnsForConversation\(\s*pendingKey,\s*"send",?\s*\)/,
      "send must commit hidden turns",
    );
    assert.match(
      body,
      /!\(await pendingDeletionStore\.restoreConversationDeletionsFor\(\s*pendingKey,?\s*\)\)/,
      "send must restore a pending conversation deletion and abort on failure",
    );
  });

  it("retry and edit paths restore pending conversation deletions before acting", function () {
    const source = chatSource();
    for (const fn of [
      "export async function editLatestUserMessageAndRetry",
      "export async function retryLatestAssistantResponse",
      "export async function editUserTurnAndRetry",
    ]) {
      const start = source.indexOf(fn);
      assert.isAtLeast(start, 0, `${fn} must exist`);
      const nextExport = source.indexOf("\nexport ", start + 1);
      const body = source.slice(
        start,
        nextExport === -1 ? undefined : nextExport,
      );
      assert.include(
        body,
        "pendingDeletionStore.finalizeTurnsForConversation(",
        `${fn} must commit hidden turns only`,
      );
      assert.include(
        body,
        "pendingDeletionStore.restoreConversationDeletionsFor(",
        `${fn} must restore a pending conversation deletion, not commit it`,
      );
    }
  });
});
