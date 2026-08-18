import { assert } from "chai";
import {
  appendAgentTranscriptMessages,
  loadAgentTranscriptSegment,
  clearAgentTranscriptStore,
} from "../src/agent/store/transcriptStore";
import type { AgentModelMessage } from "../src/agent/types";

/**
 * An assistant message carrying a round's whole tool_calls list is recorded
 * before the per-call loop runs, and that loop can bail mid-list — a denial
 * that ends the run, the error breaker, a declined review card. The
 * unanswered calls then sit in the transcript forever, and
 * OpenAI-compatible providers reject the next request with a 400.
 *
 * Persisting failed runs (Stage C) made this reachable on a second path, so
 * the invariant is enforced at the store where every producer passes through.
 */
describe("transcript orphan tool_calls", function () {
  beforeEach(function () {
    clearAgentTranscriptStore();
  });

  async function roundTrip(messages: AgentModelMessage[]) {
    await appendAgentTranscriptMessages({
      conversationKey: 4242,
      compatibilityKey: "test",
      messages,
    });
    const segment = await loadAgentTranscriptSegment({
      conversationKey: 4242,
      compatibilityKey: "test",
    });
    return segment.messages;
  }

  it("keeps a call that was answered", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
      { role: "tool", tool_call_id: "a", content: "ok" } as never,
    ]);
    const assistant = stored.find((m) => m.role === "assistant") as never as {
      tool_calls?: unknown[];
    };
    assert.lengthOf(assistant?.tool_calls || [], 1);
  });

  it("drops the unanswered half of a partially answered round", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
          {
            id: "b",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
      { role: "tool", tool_call_id: "a", content: "ok" } as never,
    ]);
    const assistant = stored.find((m) => m.role === "assistant") as never as {
      tool_calls?: Array<{ id: string }>;
    };
    assert.deepEqual(
      (assistant?.tool_calls || []).map((c) => c.id),
      ["a"],
      "an unanswered call 400s the next request on OpenAI-compatible providers",
    );
  });

  it("drops an assistant turn that only announced unanswered calls", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
    ]);
    assert.isUndefined(
      stored.find((m) => m.role === "assistant"),
      "nothing worth keeping remained on that turn",
    );
  });

  it("keeps the text when an assistant said something and its calls went unanswered", async function () {
    const stored = await roundTrip([
      {
        role: "assistant",
        content: "Let me file those.",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "t", arguments: "{}" },
          },
        ],
      } as never,
    ]);
    const assistant = stored.find((m) => m.role === "assistant") as never as {
      content?: string;
      tool_calls?: unknown[];
    };
    assert.equal(assistant?.content, "Let me file those.");
    assert.lengthOf(assistant?.tool_calls || [], 0);
  });
});
