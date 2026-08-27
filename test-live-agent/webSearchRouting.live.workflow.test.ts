import { assert } from "chai";
import { hasTavilyApiKey } from "../src/webAccess/prefs";
import {
  resolveLiveAgentCredentials,
  type LiveAgentCredentials,
} from "./liveAgentCredentials";

declare const Zotero: any;

describe("live multilingual external-search routing", function () {
  this.timeout(240000);

  let creds: LiveAgentCredentials | null = null;

  async function runTurn(userText: string) {
    const api = Zotero.LLMForZotero?.api?.agent;
    assert.isOk(api, "agent API must be installed");
    assert.isOk(creds, "model credentials must be resolved before a live turn");
    const toolCalls: string[] = [];
    const conversationKey = Math.floor(Math.random() * 1_000_000) + 1_200_000;

    const result = await api.runTurn(
      {
        conversationKey,
        mode: "agent",
        conversationKind: "global",
        userText,
        libraryID: Zotero.Libraries.userLibraryID,
        model: creds?.model,
        apiBase: creds?.apiBase,
        apiKey: creds?.apiKey,
        providerProtocol: creds?.providerProtocol,
        ...(creds?.reasoningLevel
          ? {
              reasoning: {
                provider: "deepseek",
                level: creds.reasoningLevel,
              },
            }
          : {}),
      },
      (event: any) => {
        if (event?.type === "tool_call" && event.name) {
          toolCalls.push(String(event.name));
        }
      },
    );

    assert.notEqual(
      result?.kind,
      "fallback",
      `agent fell back instead of running: ${result?.kind === "fallback" ? result.reason : ""}`,
    );
    return toolCalls;
  }

  before(async function () {
    creds = await resolveLiveAgentCredentials();
    if (!creds || !hasTavilyApiKey()) this.skip();
  });

  it("answers a stable conceptual question without external search", async function () {
    const calls = await runTurn(
      "Explain in two sentences how a median differs from a mean.",
    );

    assert.notInclude(calls, "web_search", calls.join(" → "));
    assert.notInclude(calls, "web_read", calls.join(" → "));
    assert.notInclude(calls, "literature_search", calls.join(" → "));
  });

  it("uses web search for a non-English current public fact", async function () {
    const calls = await runTurn(
      "请查明 Zotero 官方网站目前列出的最新稳定版本号，并提供准确答案和官方来源。",
    );

    assert.include(calls, "web_search", calls.join(" → "));
    assert.notInclude(calls, "literature_search", calls.join(" → "));
  });

  it("uses literature search for non-English scholarly discovery", async function () {
    const calls = await runTurn(
      "Busca en la literatura académica dos artículos recientes sobre la deriva representacional neuronal y cita las fuentes.",
    );

    assert.include(calls, "literature_search", calls.join(" → "));
    assert.notInclude(calls, "web_search", calls.join(" → "));
  });

  it("uses both sources for distinct scholarly and current-documentation needs", async function () {
    const calls = await runTurn(
      "查找两篇关于检索增强生成的最新学术论文，并查阅目前 Tavily 官方文档中 search depth 的说明，然后比较论文方法与产品文档中的检索设置。",
    );

    assert.include(calls, "literature_search", calls.join(" → "));
    assert.include(calls, "web_search", calls.join(" → "));
  });
});
