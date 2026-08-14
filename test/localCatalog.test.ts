import { assert } from "chai";
import {
  buildDiscoveredModelFromShow,
  fetchOllamaCatalog,
  fetchOllamaModelDetail,
  fetchOllamaModelList,
  readArchitecture,
  readContextLength,
  usesOllamaCatalog,
} from "../src/modelCapabilities/localCatalog";

describe("local model catalog (Ollama)", function () {
  /** Minimal /api/show payload in the shape Ollama actually returns. */
  function showPayload(overrides: Record<string, unknown> = {}) {
    return {
      capabilities: ["completion", "tools", "thinking"],
      details: { family: "qwen3", parameter_size: "8.2B" },
      model_info: {
        "general.architecture": "qwen3",
        "qwen3.context_length": 40960,
        "qwen3.attention.head_count": 32,
      },
      ...overrides,
    };
  }

  function jsonResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => "application/json" },
    } as unknown as Response;
  }

  describe("readContextLength", function () {
    it("reads the architecture-prefixed key", function () {
      assert.equal(readContextLength(showPayload().model_info), 40960);
      assert.equal(readArchitecture(showPayload().model_info), "qwen3");
    });

    it("falls back to any *.context_length when architecture is missing", function () {
      assert.equal(
        readContextLength({ "llama.context_length": 8192 }),
        8192,
        "an unfamiliar architecture must still resolve a window",
      );
    });

    it("returns undefined rather than throwing when nothing is reported", function () {
      assert.isUndefined(readContextLength(undefined));
      assert.isUndefined(readContextLength({}));
      assert.isUndefined(readContextLength({ "general.architecture": "x" }));
    });

    it("rejects absurd or malformed values", function () {
      assert.isUndefined(readContextLength({ "a.context_length": -1 }));
      assert.isUndefined(readContextLength({ "a.context_length": "many" }));
      assert.isUndefined(readContextLength({ "a.context_length": 1e12 }));
    });
  });

  describe("buildDiscoveredModelFromShow", function () {
    it("maps capabilities and the context window", function () {
      const model = buildDiscoveredModelFromShow({
        id: "qwen3:8b",
        show: showPayload(),
      });
      assert.equal(model.id, "qwen3:8b");
      assert.equal(model.limits?.contextWindowTokens, 40960);
      assert.equal(model.features?.tools, true);
      assert.equal(model.inputs?.image, false);
      assert.equal(model.reasoningSupported, true);
      assert.equal(model.source, "live");
    });

    it("reports vision from the capabilities array", function () {
      const model = buildDiscoveredModelFromShow({
        id: "llava",
        show: showPayload({ capabilities: ["completion", "vision"] }),
      });
      assert.equal(model.inputs?.image, true);
      assert.equal(model.features?.tools, false);
      assert.equal(model.reasoningSupported, false);
    });

    it("marks a non-thinking model so no reasoning control is offered", function () {
      const model = buildDiscoveredModelFromShow({
        id: "gemma3",
        show: showPayload({ capabilities: ["completion"] }),
      });
      assert.equal(
        model.reasoningSupported,
        false,
        "false is authoritative: it suppresses the control even if the name looks like a reasoning model",
      );
    });
  });

  describe("fetchOllamaModelList", function () {
    it("reads model ids from /api/tags", async function () {
      let requestedUrl = "";
      const models = await fetchOllamaModelList({
        fetchFn: (async (url: string) => {
          requestedUrl = url;
          return jsonResponse({
            models: [
              {
                name: "qwen3:8b",
                modified_at: "2026-05-10T08:06:48Z",
                details: { family: "qwen3", parameter_size: "8.2B" },
              },
              { name: "gemma3:latest" },
            ],
          });
        }) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
      });

      assert.equal(requestedUrl, "http://localhost:11434/api/tags");
      assert.deepEqual(
        models.map((m) => m.id),
        ["qwen3:8b", "gemma3:latest"],
      );
      assert.equal(models[0].modifiedAt, "2026-05-10T08:06:48Z");
      assert.equal(models[0].parameterSize, "8.2B");
    });

    it("skips malformed rows instead of failing the whole list", async function () {
      const models = await fetchOllamaModelList({
        fetchFn: (async () =>
          jsonResponse({
            models: [
              { name: "" },
              null,
              { name: "a".repeat(300) },
              { name: "ok" },
            ],
          })) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
      });
      assert.deepEqual(
        models.map((m) => m.id),
        ["ok"],
      );
    });

    it("returns an empty list when the server reports no models", async function () {
      const models = await fetchOllamaModelList({
        fetchFn: (async () => jsonResponse({})) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
      });
      assert.deepEqual(models, []);
    });
  });

  describe("fetchOllamaModelDetail", function () {
    it("posts the model name to /api/show", async function () {
      let requestedUrl = "";
      let body: Record<string, unknown> = {};
      const detail = await fetchOllamaModelDetail({
        fetchFn: (async (url: string, init?: RequestInit) => {
          requestedUrl = url;
          body = JSON.parse(String(init?.body || "{}"));
          return jsonResponse(showPayload());
        }) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
        model: "qwen3:8b",
      });

      assert.equal(requestedUrl, "http://localhost:11434/api/show");
      assert.equal(body.model, "qwen3:8b");
      assert.equal(detail?.limits?.contextWindowTokens, 40960);
    });

    it("degrades to null when the model cannot be described", async function () {
      const detail = await fetchOllamaModelDetail({
        fetchFn: (async () => ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          json: async () => ({}),
          text: async () => "",
        })) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
        model: "ghost",
      });
      assert.isNull(detail);
    });
  });

  describe("fetchOllamaCatalog", function () {
    it("describes only the selected model, not every installed one", async function () {
      const showCalls: string[] = [];
      const models = await fetchOllamaCatalog({
        fetchFn: (async (url: string, init?: RequestInit) => {
          if (url.endsWith("/api/tags")) {
            return jsonResponse({
              models: [
                { name: "qwen3:8b" },
                { name: "gemma3:latest" },
                { name: "llama3.2:3b" },
              ],
            });
          }
          showCalls.push(
            String(
              (JSON.parse(String(init?.body || "{}")) as { model?: string })
                .model,
            ),
          );
          return jsonResponse(showPayload());
        }) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
        detailModel: "qwen3:8b",
      });

      assert.deepEqual(
        showCalls,
        ["qwen3:8b"],
        "a large library must not trigger one POST per model",
      );
      assert.equal(models.length, 3);
      assert.equal(models[0].limits?.contextWindowTokens, 40960);
      assert.isUndefined(models[1].limits);
    });

    it("issues no /api/show call when no model is selected", async function () {
      let showCalls = 0;
      await fetchOllamaCatalog({
        fetchFn: (async (url: string) => {
          if (url.endsWith("/api/show")) showCalls += 1;
          return jsonResponse({ models: [{ name: "qwen3:8b" }] });
        }) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
      });
      assert.equal(showCalls, 0);
    });

    it("propagates a tags failure so the snapshot is marked stale", async function () {
      let threw = false;
      try {
        await fetchOllamaCatalog({
          fetchFn: (async () => ({
            ok: false,
            status: 500,
            statusText: "Server Error",
            json: async () => ({}),
            text: async () => "",
          })) as unknown as typeof fetch,
          apiBase: "http://localhost:11434",
        });
      } catch (_error) {
        threw = true;
      }
      assert.isTrue(threw);
    });

    it("sends a bearer token only when one is configured", async function () {
      let sawAuth: string | undefined;
      await fetchOllamaCatalog({
        fetchFn: (async (_url: string, init?: RequestInit) => {
          sawAuth = (init?.headers as Record<string, string>)?.Authorization;
          return jsonResponse({ models: [] });
        }) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
      });
      assert.isUndefined(sawAuth);

      await fetchOllamaCatalog({
        fetchFn: (async (_url: string, init?: RequestInit) => {
          sawAuth = (init?.headers as Record<string, string>)?.Authorization;
          return jsonResponse({ models: [] });
        }) as unknown as typeof fetch,
        apiBase: "http://localhost:11434",
        apiKey: "proxy-secret",
      });
      assert.equal(sawAuth, "Bearer proxy-secret");
    });
  });

  describe("usesOllamaCatalog", function () {
    it("claims only the native protocol", function () {
      assert.isTrue(usesOllamaCatalog("ollama_native"));
      assert.isFalse(usesOllamaCatalog("openai_chat_compat"));
      assert.isFalse(usesOllamaCatalog(undefined));
    });
  });
});
