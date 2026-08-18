import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";

/**
 * The mode is enforced at `prepareExecution` — the one point the in-plugin
 * runtime, MCP and the external bridge all pass through — rather than in the
 * tool listing. A gate that only hides a tool is decoration: `exposure` is
 * checked when listing and deliberately not when executing, because
 * seventeen internal tools are called by name through this same method.
 */
describe("library write mode gate", function () {
  const originalZotero = (
    globalThis as typeof globalThis & { Zotero?: unknown }
  ).Zotero;

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  function installMode(mode: string) {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Prefs: { get: () => mode },
      debug: () => undefined,
    };
  }

  const context: AgentToolContext = {
    request: { conversationKey: 1, mode: "agent", userText: "go", libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test",
  };

  function makeRegistry() {
    const registry = new AgentToolRegistry();
    let ran = false;
    registry.register({
      spec: {
        name: "library_batch",
        description: "batch",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args as never }),
      async execute() {
        ran = true;
        return { ok: true };
      },
    } as never);
    return { registry, didRun: () => ran };
  }

  const call = { id: "c1", name: "library_batch", arguments: {} };

  it("refuses a yolo-only tool in safe mode, at execution", async function () {
    installMode("safe");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context);
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isFalse(prepared.execution.result.ok);
    assert.isFalse(didRun(), "the tool must not have run");
    assert.include(
      String((prepared.execution.result.content as { error?: string })?.error),
      "yolo",
    );
  });

  it("allows it in yolo", async function () {
    installMode("yolo");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context);
    assert.equal(prepared.kind, "result");
    assert.isTrue(didRun());
  });

  it("does not gate a slash command, which is its own consent", async function () {
    installMode("safe");
    const { registry, didRun } = makeRegistry();
    const prepared = await registry.prepareExecution(call, context, {
      callerKind: "action",
    });
    assert.equal(prepared.kind, "result");
    assert.isTrue(
      didRun(),
      "an explicit user gesture is not the model acting on its own",
    );
  });

  it("defaults an undeclared caller to the stricter treatment", async function () {
    installMode("safe");
    const { registry, didRun } = makeRegistry();
    await registry.prepareExecution(call, context, {});
    assert.isFalse(didRun());
  });

  it("leaves ordinary write tools alone — they already stop at a card", async function () {
    installMode("safe");
    const registry = new AgentToolRegistry();
    let ran = false;
    registry.register({
      spec: {
        name: "library_update",
        description: "update",
        inputSchema: { type: "object" },
        mutability: "write",
        requiresConfirmation: false,
      },
      validate: (args) => ({ ok: true, value: args as never }),
      async execute() {
        ran = true;
        return { ok: true };
      },
    } as never);
    await registry.prepareExecution(
      { id: "c2", name: "library_update", arguments: {} },
      context,
    );
    assert.isTrue(ran, "gating these would duplicate a control the user has");
  });
});
