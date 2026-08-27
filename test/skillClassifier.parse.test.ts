import { assert } from "chai";
import {
  canUseSkillClassifierModel,
  detectTurnIntent,
  parseClassifiedTurnIntent,
  parseClassifierResponse,
} from "../src/agent/model/skillClassifier";
import { resolveSkillRouting } from "../src/agent/skills/routing";
import type { AgentSkill } from "../src/agent/skills/skillLoader";

const SKILLS: AgentSkill[] = [
  {
    id: "write-note",
    description: "Create or edit notes",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
  {
    id: "compare-papers",
    description: "Compare two papers",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
  {
    id: "analyze-figures",
    description: "Analyze figures",
    version: 1,
    patterns: [],
    contexts: ["any"],
    activation: "auto",
    instruction: "",
    source: "system",
  },
];

describe("parseClassifierResponse", function () {
  it("returns the listed skill IDs for a clean JSON response", function () {
    const raw = '{"skillIds": ["write-note", "analyze-figures"]}';
    const result = parseClassifierResponse(raw, SKILLS);
    assert.deepEqual(result, ["write-note", "analyze-figures"]);
  });

  it("returns an empty array when the classifier says no skills apply", function () {
    const raw = '{"skillIds": []}';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), []);
  });

  it("tolerates surrounding prose or code fences", function () {
    const raw =
      'Sure, here is the classification:\n```json\n{"skillIds": ["compare-papers"]}\n```';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), ["compare-papers"]);
  });

  it("drops IDs that aren't in the known skill set", function () {
    const raw =
      '{"skillIds": ["write-note", "made-up-skill", "analyze-figures"]}';
    const result = parseClassifierResponse(raw, SKILLS);
    assert.deepEqual(result, ["write-note", "analyze-figures"]);
  });

  it("returns null for completely malformed input (caller should fall back)", function () {
    assert.isNull(parseClassifierResponse("not JSON at all", SKILLS));
    assert.isNull(parseClassifierResponse("", SKILLS));
    assert.isNull(parseClassifierResponse('{"wrongKey": []}', SKILLS));
    assert.isNull(
      parseClassifierResponse('{"skillIds": "not-an-array"}', SKILLS),
    );
  });

  it("strips non-string entries from the skillIds array", function () {
    const raw = '{"skillIds": ["write-note", 42, null, "compare-papers"]}';
    assert.deepEqual(parseClassifierResponse(raw, SKILLS), [
      "write-note",
      "compare-papers",
    ]);
  });

  it("does not route Codex app-server skill classification through the generic LLM client", function () {
    assert.isFalse(
      canUseSkillClassifierModel({
        model: "gpt-5.4",
        apiBase: "",
        authMode: "codex_app_server",
      }),
    );
    assert.isFalse(
      canUseSkillClassifierModel({
        model: "gpt-5.4",
        apiBase: "",
        authMode: "api_key",
      }),
    );
  });
});

describe("parseClassifierResponse unmatched pseudo-skill", function () {
  it("maps a lone unmatched to a positive empty match", function () {
    assert.deepEqual(
      parseClassifierResponse('{"skillIds": ["unmatched"]}', SKILLS),
      [],
    );
  });

  it("lets real picks win over a hedged unmatched", function () {
    assert.deepEqual(
      parseClassifierResponse(
        '{"skillIds": ["unmatched", "write-note"]}',
        SKILLS,
      ),
      ["write-note"],
    );
  });

  it("collapses hallucinated-only IDs to an empty match", function () {
    assert.deepEqual(
      parseClassifierResponse('{"skillIds": ["bogus-only"]}', SKILLS),
      [],
    );
  });
});

describe("parseClassifiedTurnIntent", function () {
  it("parses a valid full intent object", function () {
    const result = parseClassifiedTurnIntent(
      '{"skillIds":[],"retrievalIntent":"summarize","wantedSections":["methods"],"queryLanguage":"zh"}',
    );

    assert.deepEqual(result, {
      retrievalIntent: "summarize",
      wantedSections: ["methods"],
      queryLanguage: "zh",
      actionIntents: [],
    });
  });

  it("returns null when retrievalIntent is missing or invalid", function () {
    assert.isNull(parseClassifiedTurnIntent('{"skillIds":[]}'));
    assert.isNull(parseClassifiedTurnIntent('{"retrievalIntent":"browse"}'));
    assert.isNull(parseClassifiedTurnIntent("not json"));
  });

  it("filters unknown wantedSections entries", function () {
    const result = parseClassifiedTurnIntent(
      '{"retrievalIntent":"enumerate","wantedSections":["methods","bogus"]}',
    );

    assert.deepEqual(result?.wantedSections, ["methods"]);
  });
});

describe("detectTurnIntent", function () {
  it("falls back to regex skills with a null intent when no model config is available", async function () {
    const result = await detectTurnIntent(
      {
        userText: "compare these papers",
        model: "some-model",
        apiBase: "",
      } as any,
      SKILLS,
    );

    assert.deepEqual(result, {
      skillIds: [],
      classifiedIntent: null,
      degraded: false,
      failureReason: "not_configured",
    });
  });

  it("passes the profile to a provider-safe utility classifier call", async function () {
    let captured: Record<string, unknown> = {};
    const profileOverride = {
      forModel: "gpt-5.4",
      limits: { outputTokens: 2_000 },
    };
    const result = await detectTurnIntent(
      {
        userText: "compare these papers",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
        advanced: {
          temperature: 0,
          maxTokens: 4_000,
          profileOverride,
        },
      } as any,
      SKILLS,
      {
        llmCall: async (params) => {
          captured = params as unknown as Record<string, unknown>;
          return '{"skillIds":["unmatched"],"retrievalIntent":"none","wantedSections":[],"queryLanguage":"en"}';
        },
      },
    );

    assert.isFalse(result.degraded);
    assert.deepEqual(captured.reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.deepEqual(captured.profileOverride, profileOverride);
  });

  it("records unparseable classifier output as a distinct degradation reason", async function () {
    const result = await detectTurnIntent(
      {
        userText: "compare these papers",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
      } as any,
      SKILLS,
      { llmCall: async () => "not JSON" },
    );

    assert.isTrue(result.degraded);
    assert.equal(result.failureReason, "unparseable");
  });
});

describe("resolveSkillRouting classified summarize force", function () {
  const LIBRARY_ANALYSIS_SKILL: AgentSkill = {
    id: "library-analysis",
    description: "Analyze your whole library or collection with statistics",
    version: 1,
    patterns: [],
    contexts: ["library-corpus"],
    activation: "auto",
    instruction: "",
    source: "system",
  };

  it("forces library-analysis for a classified summarize over a selected collection", function () {
    const resolution = resolveSkillRouting(
      {
        userText: "总结这个文件夹的研究主题",
        selectedCollectionContexts: [
          { collectionId: 1, name: "C", libraryID: 1 },
        ],
        classifiedIntent: {
          retrievalIntent: "summarize",
          wantedSections: [],
        },
        forcedSkillIds: [],
      } as any,
      [LIBRARY_ANALYSIS_SKILL],
      [],
    );

    assert.include(resolution.matchedSkillIds, "library-analysis");
  });

  it("does not force library-analysis without a selected scope", function () {
    const resolution = resolveSkillRouting(
      {
        userText: "总结这个文件夹的研究主题",
        classifiedIntent: {
          retrievalIntent: "summarize",
          wantedSections: [],
        },
        forcedSkillIds: [],
      } as any,
      [LIBRARY_ANALYSIS_SKILL],
      [],
    );

    assert.notInclude(resolution.matchedSkillIds, "library-analysis");
  });
});
