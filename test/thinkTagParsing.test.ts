import { assert } from "chai";
import { callLLMStream } from "../src/utils/llmClient";

/**
 * Inline reasoning tags in the content stream.
 *
 * llama.cpp and vLLM without a reasoning parser pass the model's raw template
 * output straight through, so `<think>…</think>` arrives inside `content`
 * rather than in a dedicated field.
 */
describe("inline reasoning tag parsing", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  /** Build an SSE stream whose content deltas are the given strings. */
  function contentStream(parts: string[]): ReadableStream<Uint8Array> {
    return sseStream([
      ...parts.map(
        (part) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`,
      ),
      "data: [DONE]\n\n",
    ]);
  }

  function mockFetch(body: () => ReadableStream<Uint8Array>) {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) =>
        name === "fetch"
          ? async () => ({
              ok: true,
              status: 200,
              statusText: "OK",
              body: body(),
              json: async () => ({}),
              text: async () => "",
            })
          : undefined,
      log: () => undefined,
    };
  }

  async function run(parts: string[]) {
    const reasoning: string[] = [];
    mockFetch(() => contentStream(parts));
    const answer = await callLLMStream(
      {
        prompt: "x",
        model: "qwen3-14b",
        apiBase: "http://localhost:8080/v1",
        providerProtocol: "openai_chat_compat",
      },
      () => undefined,
      (event) => reasoning.push(event.details || ""),
    );
    return { answer, reasoning: reasoning.join("") };
  }

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  for (const tag of ["thought", "think", "reasoning"]) {
    it(`routes <${tag}> content to reasoning, not the answer`, async function () {
      const { answer, reasoning } = await run([
        `<${tag}>weighing options</${tag}>The answer is 4.`,
      ]);
      assert.equal(answer, "The answer is 4.");
      assert.equal(reasoning, "weighing options");
    });
  }

  it("handles a tag split across stream chunks", async function () {
    const { answer, reasoning } = await run([
      "<thi",
      "nk>plan</thi",
      "nk>done",
    ]);
    assert.equal(answer, "done");
    assert.equal(reasoning, "plan");
  });

  it("keeps text before and after a reasoning block", async function () {
    const { answer } = await run(["before <think>mid</think> after"]);
    assert.equal(answer, "before  after");
  });

  it("does not let a mismatched closing tag end the block early", async function () {
    const { answer, reasoning } = await run([
      "<thought>a</think>still thinking</thought>answer",
    ]);
    assert.equal(answer, "answer");
    assert.equal(reasoning, "a</think>still thinking");
  });

  it("keeps an unterminated block as reasoning", async function () {
    // Reasoning is emitted as it arrives so the Thinking panel stays live,
    // which means an unterminated block cannot be reclassified afterwards
    // without showing the same text twice. Documented, not accidental.
    const { answer, reasoning } = await run([
      "<think>the whole response, never closed",
    ]);
    assert.equal(answer, "");
    assert.equal(reasoning, "the whole response, never closed");
  });

  it("keeps an unclosed trailer as reasoning when an answer already streamed", async function () {
    const { answer, reasoning } = await run([
      "Here is the answer.<think>afterthought",
    ]);
    assert.equal(answer, "Here is the answer.");
    assert.equal(reasoning, "afterthought");
  });

  it("leaves ordinary content with angle brackets alone", async function () {
    const { answer } = await run(["use <div> and <thinking-cap> markup"]);
    assert.equal(answer, "use <div> and <thinking-cap> markup");
  });
});
