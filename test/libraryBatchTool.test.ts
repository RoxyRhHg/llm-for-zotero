import { assert } from "chai";
import { createLibraryBatchTool } from "../src/agent/tools/write/libraryBatch";
import { ActionRegistry } from "../src/agent/actions/registry";
import type { AgentToolContext } from "../src/agent/types";

/**
 * The batch engine was a complete propose/paginate/apply system that the
 * model could not name: its only entry points were the slash-command
 * controller and the public plugin API. So "tag my whole library" was not a
 * request the agent could accept at all.
 *
 * It runs unattended, so it is gated on the library write mode being "yolo".
 * A tool call cannot deliver per-page review — the runtime's confirmation
 * model is declarative and bracketing, and an action wants to block
 * mid-execution — so `safe` refuses and points at the surface that can.
 */
describe("library_batch", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  const context: AgentToolContext = {
    request: {
      conversationKey: 9,
      mode: "agent",
      userText: "tag my whole library",
      libraryID: 1,
      model: "gpt-4o-mini",
      apiBase: "https://api.openai.com/v1/chat/completions",
      apiKey: "test",
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  };

  function installMode(mode: string) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => mode },
      // No DB: the job store degrades to a no-op rather than failing the run.
      debug: () => undefined,
    };
  }

  function makeTool(execute?: (input: unknown, ctx: unknown) => unknown) {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute:
        execute ||
        (async () => ({
          ok: true,
          output: { tagged: 42, processed: 50 },
        })),
    } as never);
    return createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      services: {} as never,
      now: () => 1000,
    });
  }

  it("lists the available jobs when the name is unknown", function () {
    const tool = makeTool();
    const result = tool.validate({ job: "nonsense" });
    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "auto_tag");
  });

  it("refuses in safe mode and says where per-page review lives", async function () {
    installMode("safe");
    const tool = makeTool();
    const validated = tool.validate({ job: "auto_tag", jobArgs: { scope: "all" } });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    let message = "";
    try {
      await tool.execute(validated.value, context);
      assert.fail("expected safe mode to refuse");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "yolo");
    assert.include(message, "/auto_tag", "the user needs somewhere to go");
  });

  it("runs the job in yolo and reports real counts", async function () {
    installMode("yolo");
    const tool = makeTool();
    const validated = tool.validate({ job: "auto_tag", jobArgs: { scope: "all" } });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, context)) as Record<
      string,
      unknown
    >;
    assert.equal(output.appliedCount, 42, "the count must come from the action");
    assert.equal(output.job, "auto_tag");
    assert.deepEqual(output.output, { tagged: 42, processed: 50 });
  });

  it("auto-approves inner confirmations, since yolo means the model decides", async function () {
    installMode("yolo");
    let seenMode = "";
    const tool = makeTool(async (_input, ctx) => {
      seenMode = (ctx as { confirmationMode: string }).confirmationMode;
      return { ok: true, output: { tagged: 1 } };
    });
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    await tool.execute(validated.value, context);
    assert.equal(seenMode, "auto_approve");
  });

  it("surfaces the script arguments on the confirmation card", function () {
    installMode("yolo");
    const tool = makeTool();
    const validated = tool.validate({
      job: "auto_tag",
      jobArgs: { scope: "collection", collectionId: 12 },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const pending = tool.createPendingAction?.(validated.value, context);
    const preview = pending?.fields.find((f) => f.type === "code_preview");
    assert.include((preview as never as { value: string })?.value, "collectionId");
    assert.include(
      pending?.description || "",
      "reverted",
      "the user must know the run is recoverable before approving",
    );
  });

  it("propagates a failed job rather than reporting success", async function () {
    installMode("yolo");
    const tool = makeTool(async () => ({ ok: false, error: "model unreachable" }));
    const validated = tool.validate({ job: "auto_tag", jobArgs: {} });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    let message = "";
    try {
      await tool.execute(validated.value, context);
      assert.fail("expected the failure to propagate");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.include(message, "model unreachable");
  });

  /**
   * `discover_related` calls ctx.requestConfirmation directly — it is an
   * interactive review workflow, not a batch pass — so running it through a
   * tool call would throw partway, after some work had already happened.
   * Advertising a job that cannot work is the kind of lie this whole effort
   * exists to remove.
   */
  it("refuses an interactive-only job up front, with somewhere to go", function () {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "discover_related",
      description: "Find related papers",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      services: {} as never,
    });

    const result = tool.validate({ job: "discover_related" });
    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "interactive");
    assert.include(result.error, "/discover_related");
  });

  it("does not list an interactive-only job as available", function () {
    const actionRegistry = new ActionRegistry();
    actionRegistry.register({
      name: "discover_related",
      description: "Find related papers",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    actionRegistry.register({
      name: "auto_tag",
      description: "Tag papers",
      inputSchema: { type: "object" },
      execute: async () => ({ ok: true, output: {} }),
    } as never);
    const tool = createLibraryBatchTool({
      actionRegistry,
      toolRegistry: {} as never,
      zoteroGateway: {} as never,
      services: {} as never,
    });

    const result = tool.validate({ job: "" });
    assert.isFalse(result.ok);
    if (result.ok) return;
    assert.include(result.error, "auto_tag");
    assert.notInclude(result.error, "discover_related");
  });
});
