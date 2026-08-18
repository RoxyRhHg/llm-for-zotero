import { assert } from "chai";
import { createZoteroScriptTool } from "../src/agent/tools/write/zoteroScript";
import type { AgentToolContext } from "../src/agent/types";

/**
 * The script's only channel back to the model was `env.log`, capped at 8000
 * characters, and its actual return value was discarded — `raceResult` was
 * only ever compared to `"timeout"`. A step that enumerated 400 ids reported
 * roughly 180 of them and nothing said the rest were missing, which is what
 * made multi-step work over a real library impossible.
 */
describe("zotero_script chaining", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: { conversationKey: 3, mode: "agent", userText: "list", libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  function run(script: string) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: { get: () => null },
      debug: () => undefined,
    };
    const tool = createZoteroScriptTool();
    const validated = tool.validate({
      mode: "read",
      script,
      description: "enumerate",
    });
    assert.isTrue(validated.ok, JSON.stringify(validated));
    if (!validated.ok) throw new Error("unreachable");
    return tool.execute(validated.value, context) as Promise<
      Record<string, unknown>
    >;
  }

  it("delivers the script's return value in full", async function () {
    const ids = Array.from({ length: 400 }, (_v, i) => i + 1);
    const result = await run(`return ${JSON.stringify(ids)};`);
    assert.deepEqual(
      result.returnValue,
      ids,
      "all 400 ids must survive; the log cap is what used to lose them",
    );
  });

  it("returns structured data, not just strings", async function () {
    const result = await run(
      "return { total: 2, items: [{ id: 1 }, { id: 2 }] };",
    );
    assert.deepEqual(result.returnValue, {
      total: 2,
      items: [{ id: 1 }, { id: 2 }],
    });
  });

  it("flags a truncated log instead of silently dropping it", async function () {
    const result = await run(
      "for (let i = 0; i < 2000; i += 1) env.log('a'.repeat(20)); return 'done';",
    );
    assert.isTrue(
      result.outputTruncated,
      "a silently truncated log is how a chain loses data without noticing",
    );
    assert.include(String(result.output), "log truncated");
    assert.equal(
      result.returnValue,
      "done",
      "the return value is unaffected by the log cap",
    );
  });
});
