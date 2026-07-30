import { assert } from "chai";
import { describe, it } from "mocha";
import {
  buildClaudeModelPreferenceOptions,
  buildClaudeRuntimeModelEntries,
  CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY,
  fetchClaudeModelCatalog,
  normalizeClaudeModelCatalog,
  resolveClaudeModelPreferenceSelection,
  shouldPreserveClaudeCustomModelDraft,
} from "../src/claudeCode/modelCatalog";

describe("Claude Code model catalog", function () {
  it("prefers structured metadata and preserves opaque future model values", function () {
    const catalog = normalizeClaudeModelCatalog({
      models: ["default", "legacy-only"],
      modelInfos: [
        {
          value: "opus[1m]",
          resolvedModel: "claude-opus-5[1m]",
          displayName: "Opus 1M",
          description: "Long-context Opus",
          supportsEffort: true,
          supportedEffortLevels: ["low", "xhigh", "low"],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
          supportsAutoMode: true,
        },
        {
          value: "FutureModel-V7[2m]",
          displayName: "Future Model",
        },
        {
          value: "opus[1m]",
          displayName: "Duplicate",
        },
      ],
    });

    assert.isFalse(catalog.legacy);
    assert.deepEqual(catalog.models, [
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Opus 1M",
        description: "Long-context Opus",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
        supportsAutoMode: true,
      },
      {
        value: "FutureModel-V7[2m]",
        displayName: "Future Model",
        description: "",
        supportedEffortLevels: [],
      },
    ]);
  });

  it("accepts the legacy string response without changing case or suffixes", function () {
    const catalog = normalizeClaudeModelCatalog({
      models: ["default", "claude-fable-5[1m]", "FutureModel", "FutureModel"],
    });

    assert.isTrue(catalog.legacy);
    assert.deepEqual(
      catalog.models.map((model) => model.value),
      ["default", "claude-fable-5[1m]", "FutureModel"],
    );
  });

  it("treats an explicit empty structured catalog as authoritative", function () {
    const catalog = normalizeClaudeModelCatalog({
      models: ["default", "sonnet"],
      modelInfos: [],
    });

    assert.isFalse(catalog.legacy);
    assert.deepEqual(catalog.models, []);
  });

  it("keeps the selected custom model as the exact first wire value", function () {
    const entries = buildClaudeRuntimeModelEntries({
      models: normalizeClaudeModelCatalog({
        modelInfos: [
          {
            value: "opus[1m]",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Opus 1M",
          },
          {
            value: "claude-fable-5[1m]",
            displayName: "Fable",
          },
        ],
      }).models,
      selectedModel: "claude-opus-5[1m]",
    });

    assert.deepEqual(
      entries.map((entry) => ({
        entryId: entry.entryId,
        model: entry.model,
        label: entry.displayModelLabel,
      })),
      [
        {
          entryId: "claude_runtime::claude-opus-5[1m]",
          model: "claude-opus-5[1m]",
          label: "Opus 1M (claude-opus-5[1m])",
        },
        {
          entryId: "claude_runtime::opus[1m]",
          model: "opus[1m]",
          label: "Opus 1M",
        },
        {
          entryId: "claude_runtime::claude-fable-5[1m]",
          model: "claude-fable-5[1m]",
          label: "Fable",
        },
      ],
    );
  });

  it("requests models with the selected setting sources", async function () {
    let requestedUrl = "";
    const catalog = await fetchClaudeModelCatalog({
      bridgeUrl: "http://127.0.0.1:19787/",
      settingSources: ["project", "local"],
      fetchImpl: (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            models: ["default"],
            modelInfos: [{ value: "default", displayName: "Default" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    assert.equal(
      requestedUrl,
      "http://127.0.0.1:19787/models?settingSources=project%2Clocal",
    );
    assert.deepEqual(
      catalog.models.map((model) => model.value),
      ["default"],
    );
  });

  it("requests the catalog for the active conversation scope", async function () {
    let requestedUrl = "";
    await fetchClaudeModelCatalog({
      bridgeUrl: "http://127.0.0.1:19787",
      settingSources: ["user", "project", "local"],
      context: {
        conversationKey: 42,
        scopeType: "paper",
        scopeId: "profile-test:1:42",
        scopeLabel: "Paper 42",
      },
      fetchImpl: (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ models: [], modelInfos: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    assert.equal(
      requestedUrl,
      "http://127.0.0.1:19787/models?settingSources=user%2Cproject%2Clocal&conversationKey=42&scopeType=paper&scopeId=profile-test%3A1%3A42&scopeLabel=Paper+42",
    );
  });

  it("builds ordered preference choices without using model values as UI keys", function () {
    const options = buildClaudeModelPreferenceOptions(
      normalizeClaudeModelCatalog({
        modelInfos: [
          {
            value: "default",
            resolvedModel: "claude-opus-5[1m]",
            displayName: "Default",
          },
          {
            value: "customized",
            displayName: "Provider Customized",
          },
        ],
      }).models,
    );

    assert.deepEqual(options, [
      {
        key: "catalog:0",
        model: "default",
        label: "Default — claude-opus-5[1m]",
        description: "",
      },
      {
        key: "catalog:1",
        model: "customized",
        label: "Provider Customized — customized",
        description: "",
      },
    ]);
    assert.notEqual(options[1]?.key, CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY);
  });

  it("selects exact catalog models and sends missing values through Customized", function () {
    const options = buildClaudeModelPreferenceOptions(
      normalizeClaudeModelCatalog({
        modelInfos: [
          { value: "default", displayName: "Default" },
          { value: "FutureModel-V7[2m]", displayName: "Future Model" },
        ],
      }).models,
    );

    assert.deepEqual(
      resolveClaudeModelPreferenceSelection({
        options,
        selectedModel: "FutureModel-V7[2m]",
      }),
      {
        selectedKey: "catalog:1",
        customized: false,
        customValue: "",
      },
    );
    assert.deepEqual(
      resolveClaudeModelPreferenceSelection({
        options,
        selectedModel: "Provider/Exact-Model[1m]",
      }),
      {
        selectedKey: CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY,
        customized: true,
        customValue: "Provider/Exact-Model[1m]",
      },
    );
  });

  it("preserves only focused or unsaved Customized drafts during refresh", function () {
    assert.isFalse(
      shouldPreserveClaudeCustomModelDraft({
        customized: true,
        draftValue: "Provider/Stored",
        selectedModel: "Provider/Stored",
        focused: false,
      }),
    );
    assert.isTrue(
      shouldPreserveClaudeCustomModelDraft({
        customized: true,
        draftValue: "Provider/Unsaved",
        selectedModel: "Provider/Stored",
        focused: false,
      }),
    );
    assert.isTrue(
      shouldPreserveClaudeCustomModelDraft({
        customized: true,
        draftValue: "",
        selectedModel: "Provider/Stored",
        focused: true,
      }),
    );
    assert.isFalse(
      shouldPreserveClaudeCustomModelDraft({
        customized: false,
        draftValue: "Provider/Unsaved",
        selectedModel: "Provider/Stored",
        focused: true,
      }),
    );
  });

  it("marks force-refresh catalog requests explicitly", async function () {
    let requestedUrl = "";
    await fetchClaudeModelCatalog({
      bridgeUrl: "http://127.0.0.1:19787",
      settingSources: ["user"],
      forceRefresh: true,
      fetchImpl: (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ models: [], modelInfos: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    assert.equal(
      requestedUrl,
      "http://127.0.0.1:19787/models?settingSources=user&refresh=1",
    );
  });
});
