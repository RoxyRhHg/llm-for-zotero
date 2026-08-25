import { assert } from "chai";
import {
  CODEX_DIRECT_MODELS_URL,
  CODEX_DIRECT_RESPONSES_URL,
  fetchWithCodexAuth,
} from "../src/codexAuth/auth";
import {
  assertCodexDirectModelAvailable,
  getCodexDirectReasoningChoices,
  loadCodexDirectCatalog,
  normalizeCodexDirectCatalog,
  resetCodexDirectCatalogForTests,
} from "../src/codexAuth/modelCatalog";
import { runCodexDirectConnectionTest } from "../src/utils/providerConnectionTest";

const AUTH_JSON = JSON.stringify({
  preserved: { keep: true },
  tokens: {
    access_token: "access-old",
    refresh_token: "refresh-old",
    account_id: "account-123",
  },
});
const TEST_AUTH_PATH = "/test/codex/auth.json";

function catalogResponse(model = "gpt-codex"): Response {
  return new Response(
    JSON.stringify({
      models: [
        {
          slug: model,
          display_name: "GPT Codex",
          description: "Coding model",
          visibility: "list",
          priority: 10,
          context_window: 200000,
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Faster" },
            { effort: "medium", description: "Balanced" },
            { effort: "ultra", description: "Hidden in direct mode" },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Codex Direct auth and catalog", function () {
  beforeEach(function () {
    resetCodexDirectCatalogForTests();
  });

  afterEach(function () {
    resetCodexDirectCatalogForTests();
  });

  it("normalizes visible ChatGPT models, priority, metadata, and stable ties", function () {
    const models = normalizeCodexDirectCatalog({
      models: [
        {
          slug: "tie-first",
          display_name: "Tie First",
          visibility: "list",
          priority: 10,
          supported_in_api: false,
          context_window: 128000,
          default_reasoning_level: "high",
          supported_reasoning_levels: [
            { effort: "high", description: "Thorough" },
          ],
        },
        {
          slug: "TIE-FIRST",
          display_name: "Duplicate",
          visibility: "list",
          priority: 100,
        },
        {
          slug: "tie-second",
          display_name: "Tie Second",
          visibility: "list",
          priority: 10,
          supported_reasoning_levels: ["low"],
        },
        {
          slug: "highest",
          display_name: "Highest",
          visibility: "list",
          priority: 20,
          supported_reasoning_levels: [],
        },
        {
          slug: "hidden",
          display_name: "Hidden",
          visibility: "hide",
          priority: 99,
        },
      ],
    });

    assert.deepEqual(
      models.map((model) => model.model),
      ["highest", "tie-first", "tie-second"],
    );
    assert.equal(models[1].displayName, "Tie First");
    assert.equal(models[1].contextWindow, 128000);
    assert.equal(
      models[1].supportedReasoningEfforts[0].description,
      "Thorough",
    );
    assert.equal(models[2].supportedReasoningEfforts[0].value, "low");
  });

  it("uses the fixed catalog endpoint and filters Ultra from direct choices", async function () {
    let requestedUrl = "";
    const snapshot = await loadCodexDirectCatalog({
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn: (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return catalogResponse();
      }) as typeof fetch,
    });

    assert.equal(requestedUrl, CODEX_DIRECT_MODELS_URL);
    assert.equal(snapshot.models[0].contextWindow, 200000);
    assert.deepEqual(getCodexDirectReasoningChoices("GPT-CODEX"), [
      { value: "auto", label: "Auto (Medium)" },
      { value: "low", label: "Low", description: "Faster" },
      { value: "medium", label: "Medium", description: "Balanced" },
    ]);
    assert.throws(
      () => assertCodexDirectModelAvailable("saved-missing"),
      "not available in the current catalog",
    );
  });

  it("sends account auth, refreshes once on 401, and preserves auth fields", async function () {
    const writes: string[] = [];
    const backendHeaders: Headers[] = [];
    let backendCalls = 0;
    const response = await fetchWithCodexAuth(
      CODEX_DIRECT_RESPONSES_URL,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      {
        authPath: TEST_AUTH_PATH,
        readText: async () => AUTH_JSON,
        writeText: async (_path, content) => writes.push(content),
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url) === "https://auth.openai.com/oauth/token") {
            return new Response(
              JSON.stringify({
                access_token: "access-new",
                refresh_token: "refresh-new",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          backendCalls += 1;
          backendHeaders.push(new Headers(init?.headers));
          return new Response(backendCalls === 1 ? "unauthorized" : "ok", {
            status: backendCalls === 1 ? 401 : 200,
          });
        }) as typeof fetch,
      },
    );

    assert.equal(response.status, 200);
    assert.equal(backendCalls, 2);
    assert.equal(backendHeaders[0].get("Authorization"), "Bearer access-old");
    assert.equal(backendHeaders[1].get("Authorization"), "Bearer access-new");
    assert.equal(backendHeaders[1].get("ChatGPT-Account-ID"), "account-123");
    assert.lengthOf(writes, 1);
    const persisted = JSON.parse(writes[0]) as Record<string, unknown>;
    assert.deepEqual(persisted.preserved, { keep: true });
    assert.include(writes[0], "refresh-new");
  });

  it("refuses to send Codex credentials to configurable origins", async function () {
    try {
      await fetchWithCodexAuth(
        "https://example.com/v1/responses",
        {},
        {
          readText: async () => AUTH_JSON,
          fetchFn: (async () => new Response("never")) as typeof fetch,
        },
      );
      assert.fail("expected untrusted URL rejection");
    } catch (error) {
      assert.include(String(error), "untrusted URL");
    }
  });

  it("caches successful results, coalesces requests, and force refreshes", async function () {
    let fetchCalls = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchFn = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) await firstGate;
      return catalogResponse(`model-${fetchCalls}`);
    }) as typeof fetch;
    const options = {
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn,
      now: () => 1000,
    };

    const first = loadCodexDirectCatalog(options);
    const concurrent = loadCodexDirectCatalog(options);
    releaseFirst?.();
    const [firstResult, concurrentResult] = await Promise.all([
      first,
      concurrent,
    ]);
    assert.equal(fetchCalls, 1);
    assert.equal(firstResult.models[0].model, concurrentResult.models[0].model);

    await loadCodexDirectCatalog({ ...options, now: () => 2000 });
    assert.equal(fetchCalls, 1);
    const forced = await loadCodexDirectCatalog({ ...options, force: true });
    assert.equal(fetchCalls, 2);
    assert.equal(forced.models[0].model, "model-2");
  });

  it("reports timeouts and preserves a successful empty-catalog state", async function () {
    try {
      await loadCodexDirectCatalog({
        authPath: TEST_AUTH_PATH,
        readText: async () => AUTH_JSON,
        fetchFn: (async () =>
          new Promise<Response>(() => undefined)) as typeof fetch,
        timeoutMs: 1,
      });
      assert.fail("expected timeout");
    } catch (error) {
      assert.include(String(error), "timed out");
    }

    resetCodexDirectCatalogForTests();
    const empty = await loadCodexDirectCatalog({
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn: (async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });
    assert.equal(empty.status, "ready");
    assert.deepEqual(empty.models, []);
  });

  it("tests the catalog and a minimal Auto-reasoning inference separately", async function () {
    let inferenceBody: Record<string, unknown> | undefined;
    const result = await runCodexDirectConnectionTest({
      authPath: TEST_AUTH_PATH,
      readText: async () => AUTH_JSON,
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === CODEX_DIRECT_MODELS_URL) return catalogResponse();
        inferenceBody = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return new Response('data: {"delta":"OK"}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as typeof fetch,
    });

    assert.deepEqual(result, {
      catalogCount: 1,
      modelName: "gpt-codex",
      reply: "OK",
    });
    assert.equal(inferenceBody?.model, "gpt-codex");
    for (const key of [
      "reasoning",
      "temperature",
      "max_output_tokens",
      "tools",
    ]) {
      assert.notProperty(inferenceBody || {}, key);
    }
  });
});
