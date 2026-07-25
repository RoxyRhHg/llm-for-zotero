import { assert } from "chai";

import type { AgentRuntime } from "../src/agent/runtime";
import type { AgentEngineDeps } from "../src/modules/contextPanel/agentMode/agentEngine";
import {
  retryAgentTurn,
  sendAgentTurn,
} from "../src/modules/contextPanel/agentMode/agentEngine";
import type {
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
} from "../src/agent/types";

function fakeItem(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    isAttachment: () => false,
  } as unknown as Zotero.Item;
}

function createFinalThenHangingRuntime(
  onFinalHandled: () => void,
): AgentRuntime {
  return {
    getCapabilities: () => ({
      streaming: true,
      toolCalls: true,
      multimodal: false,
    }),
    runTurn: async (params: {
      request: AgentRuntimeRequest;
      onStart?: (runId: string) => Promise<void> | void;
      onEvent?: (event: {
        type: "status" | "final";
        text: string;
      }) => Promise<void> | void;
    }): Promise<AgentRuntimeOutcome> => {
      await params.onStart?.("run-final-release");
      await params.onEvent?.({
        type: "status",
        text: "Continuing agent (2/24)",
      });
      await params.onEvent?.({
        type: "final",
        text: "Final answer.",
      });
      onFinalHandled();
      return new Promise<AgentRuntimeOutcome>(() => undefined);
    },
  } as unknown as AgentRuntime;
}

function createDeps(params: {
  runtime: AgentRuntime;
  pendingWrites: Array<[number, number]>;
  idleRestores: Array<[number, number]>;
  statuses: string[];
}): AgentEngineDeps {
  const chatHistory = new Map<number, any[]>();
  const abortControllers = new Map<number, AbortController | null>();
  const contextSnapshots = new Map<number, { contextTokens: number }>();
  return {
    chatHistory,
    agentRunTraceCache: new Map(),
    cancelledRequestId: () => 0,
    currentAbortController: (conversationKey) =>
      abortControllers.get(conversationKey) || null,
    setCurrentAbortController: (conversationKey, ctrl) => {
      abortControllers.set(conversationKey, ctrl);
    },
    getAbortControllerCtor: () => AbortController,
    nextRequestId: () => 77,
    setPendingRequestId: (conversationKey, id) => {
      params.pendingWrites.push([conversationKey, id]);
    },
    getPanelRequestUI: () => ({}),
    setRequestUIBusy: () => undefined,
    restoreRequestUIIdle: (_body, conversationKey, requestId) => {
      params.idleRestores.push([conversationKey, requestId]);
    },
    scheduleQueuedInputDrain: () => undefined,
    createPanelUpdateHelpers: () => ({
      refreshChatSafely: () => undefined,
      refreshAssistantMessageSafely: () => undefined,
      setStatusSafely: (text) => {
        params.statuses.push(text);
      },
    }),
    ensureConversationLoaded: async () => undefined,
    getConversationSystem: () => "upstream",
    accumulateSessionTokens: () => 0,
    getContextUsageSnapshot: (conversationKey) =>
      contextSnapshots.get(conversationKey),
    setContextUsageSnapshot: (conversationKey, snapshot) => {
      contextSnapshots.set(conversationKey, snapshot);
    },
    setTokenUsage: () => undefined,
    getConversationKey: (item) => Number(item.id || 0),
    buildLLMHistoryMessages: () => [],
    buildAgentRuntimeRequest: (requestParams) => ({
      conversationKey: requestParams.conversationKey,
      mode: "agent",
      userText: requestParams.userText,
      model: requestParams.effectiveRequestConfig.model,
      apiBase: requestParams.effectiveRequestConfig.apiBase,
      apiKey: requestParams.effectiveRequestConfig.apiKey,
      authMode: requestParams.effectiveRequestConfig.authMode,
      providerProtocol: requestParams.effectiveRequestConfig.providerProtocol,
      selectedTexts: requestParams.selectedTexts,
      selectedTextSources: requestParams.selectedTextSources,
      selectedTextNoteContexts: requestParams.selectedTextNoteContexts,
      selectedPaperContexts: requestParams.paperContexts,
      pdfPaperContexts: requestParams.pdfPaperContexts,
      fullTextPaperContexts: requestParams.fullTextPaperContexts,
      localDocuments: requestParams.localDocuments,
      attachments: requestParams.attachments,
      history: requestParams.history,
    }),
    resolveLocalPdfResources: async () => [],
    preflightLocalPdfCapability: async () => undefined,
    resolveEffectiveRequestConfig: () => ({
      model: "deepseek-v4-pro",
      apiBase: "https://example.invalid/v1",
      apiKey: "test",
      authMode: "api_key",
      providerProtocol: "openai_chat_compat",
      modelEntryId: "deepseek-v4-pro",
      modelProviderLabel: "DeepSeek",
    }),
    normalizeSelectedTexts: (selectedTexts) =>
      Array.isArray(selectedTexts) ? selectedTexts : [],
    normalizeSelectedTextSources: (sources) => sources || [],
    normalizeSelectedTextPaperContextsByIndex: () => [],
    normalizeSelectedTextNoteContextsByIndex: () => [],
    normalizePaperContexts: (paperContexts) =>
      Array.isArray(paperContexts) ? paperContexts : [],
    includeAutoLoadedPaperContext: (
      _item,
      paperContexts,
      fullTextPaperContexts,
    ) => ({
      paperContexts: paperContexts || [],
      fullTextPaperContexts: fullTextPaperContexts || [],
    }),
    findLatestRetryPair: () => null,
    reconstructRetryPayload: () => ({
      question: "",
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    }),
    isReasoningExpandedByDefault: () => false,
    createQueuedRefresh: (refresh) => refresh,
    waitForUiStep: async () => undefined,
    finalizeCancelledAssistantMessage: (message, fallbackText) => {
      message.text = fallbackText || "[Cancelled]";
    },
    sanitizeText: (text) => text,
    finalizeAssistantQuoteCitations: async () => undefined,
    appendReasoningPart: (base, next) => `${base || ""}${next || ""}`,
    persistConversationMessage: async () => undefined,
    updateStoredLatestUserMessage: async () => undefined,
    updateStoredLatestAssistantMessage: async () => undefined,
    sendChatFallback: async () => undefined,
    getAgentRuntime: () => params.runtime,
    maxSelectedImages: 4,
  } as AgentEngineDeps;
}

describe("agent engine final UI release", function () {
  it("releases the request UI when a final event arrives before runtime bookkeeping settles", async function () {
    const conversationKey = 123;
    const pendingWrites: Array<[number, number]> = [];
    const idleRestores: Array<[number, number]> = [];
    const statuses: string[] = [];
    let resolveFinalHandled: () => void = () => undefined;
    const finalHandled = new Promise<void>((resolve) => {
      resolveFinalHandled = resolve;
    });
    const runtime = createFinalThenHangingRuntime(resolveFinalHandled);
    const deps = createDeps({
      runtime,
      pendingWrites,
      idleRestores,
      statuses,
    });

    void sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "write a review",
      },
      deps,
    );

    await finalHandled;

    assert.deepInclude(pendingWrites, [conversationKey, 0]);
    assert.deepInclude(idleRestores, [conversationKey, 77]);
    assert.include(statuses, "Ready");
  });

  it("forwards note-edit selected text contexts into the runtime request", async function () {
    const conversationKey = 3703;
    const noteContext = {
      libraryID: 1,
      noteItemKey: "NOTEKEY",
      noteItemId: 3703,
      parentItemId: 3612,
      noteKind: "item" as const,
      title: "Ajemian et al., 2013 - MD",
    };
    let capturedRequest: AgentRuntimeRequest | null = null;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: { request: AgentRuntimeRequest }) => {
        capturedRequest = params.request;
        return {
          kind: "completed",
          runId: "run-note-edit",
          text: "Done.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.normalizeSelectedTextNoteContextsByIndex = () => [noteContext];

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "help me rewrite this sentence",
        selectedTexts: ["Panel A illustrates the stability problem."],
        selectedTextSources: ["note-edit"],
        selectedTextNoteContexts: [noteContext],
      },
      deps,
    );

    assert.deepEqual(capturedRequest?.selectedTextSources, ["note-edit"]);
    assert.deepEqual(capturedRequest?.selectedTextNoteContexts, [noteContext]);
  });

  it("preserves raw PDF identity in every initial full-row lifecycle update", async function () {
    const conversationKey = 4701;
    const pdfContext = {
      itemId: 10,
      contextItemId: 12,
      title: "Selected raw PDF",
      contentSourceMode: "pdf" as const,
    };
    const storedUpdates: Array<Record<string, unknown>> = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        onStart?: (runId: string) => Promise<void> | void;
        onEvent?: (event: any) => Promise<void> | void;
      }) => {
        await params.onStart?.("run-pdf-initial");
        await params.onEvent?.({
          type: "tool_result",
          callId: "paper-read",
          name: "paper_read",
          ok: true,
          content: {
            paperContext: {
              itemId: 99,
              contextItemId: 100,
              title: "Tool citation",
              contentSourceMode: "text",
            },
          },
        });
        return {
          kind: "completed",
          runId: "run-pdf-initial",
          text: "Done.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.updateStoredLatestUserMessage = async (_key, update) => {
      storedUpdates.push(update as unknown as Record<string, unknown>);
    };

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "Analyze the selected PDF.",
        pdfPaperContexts: [pdfContext],
        localDocuments: [
          {
            kind: "local_pdf",
            sourceKey: "zotero-pdf:10:12",
            itemId: 10,
            contextItemId: 12,
            title: "Selected raw PDF",
            name: "selected.pdf",
            mimeType: "application/pdf",
            absolutePath: "/papers/selected.pdf",
          },
        ],
      },
      deps,
    );

    assert.isAtLeast(storedUpdates.length, 3);
    for (const update of storedUpdates) {
      assert.deepEqual(update.pdfPaperContexts, [pdfContext]);
    }
  });

  it("preserves raw PDF identity in retry start and tool-result full-row updates", async function () {
    const conversationKey = 4702;
    const pdfContext = {
      itemId: 20,
      contextItemId: 22,
      title: "Retry raw PDF",
      contentSourceMode: "pdf" as const,
    };
    const userMessage = {
      role: "user" as const,
      text: "Analyze the selected PDF.",
      timestamp: 100,
      runMode: "agent" as const,
      pdfPaperContexts: [pdfContext],
    };
    const assistantMessage = {
      role: "assistant" as const,
      text: "Old answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    const storedUpdates: Array<Record<string, unknown>> = [];
    let capturedRuntimeRequest: Record<string, unknown> | undefined;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        request?: Record<string, unknown>;
        onStart?: (runId: string) => Promise<void> | void;
        onEvent?: (event: any) => Promise<void> | void;
      }) => {
        capturedRuntimeRequest = params.request;
        await params.onStart?.("run-pdf-retry");
        await params.onEvent?.({
          type: "tool_result",
          callId: "paper-read",
          name: "paper_read",
          ok: true,
          content: {
            paperContext: {
              itemId: 199,
              contextItemId: 200,
              title: "Retry tool citation",
              contentSourceMode: "text",
            },
          },
        });
        return {
          kind: "completed",
          runId: "run-pdf-retry",
          text: "New answer.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: userMessage.pdfPaperContexts || [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.resolveLocalPdfResources = async () => [
      {
        kind: "local_pdf",
        sourceKey: "zotero-pdf:20:22",
        itemId: 20,
        contextItemId: 22,
        title: "Retry raw PDF",
        name: "retry.pdf",
        mimeType: "application/pdf",
        absolutePath: "/papers/retry.pdf",
      },
    ];
    deps.getConversationSystem = () => "claude_code";
    deps.updateStoredLatestUserMessage = async (_key, update) => {
      storedUpdates.push(update as unknown as Record<string, unknown>);
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.lengthOf(storedUpdates, 2);
    for (const update of storedUpdates) {
      assert.deepEqual(update.pdfPaperContexts, [pdfContext]);
    }
    assert.deepEqual(capturedRuntimeRequest?.paperContexts || [], []);
    assert.deepEqual(capturedRuntimeRequest?.pdfPaperContexts, [pdfContext]);
    assert.lengthOf(
      (capturedRuntimeRequest?.localDocuments as unknown[]) || [],
      1,
    );
  });

  it("keeps native-provider PDF retries on their stored model attachments", async function () {
    const conversationKey = 4703;
    const pdfContext = {
      itemId: 30,
      contextItemId: 32,
      title: "Native retry PDF",
      contentSourceMode: "pdf" as const,
    };
    const pdfAttachment = {
      id: "pdf-paper-32-1",
      name: "native-retry.pdf",
      mimeType: "application/pdf",
      sizeBytes: 128,
      category: "pdf" as const,
      storedPath: "/tmp/native-retry.pdf",
    };
    const userMessage = {
      role: "user" as const,
      text: "Analyze the selected PDF.",
      timestamp: 100,
      runMode: "agent" as const,
      pdfPaperContexts: [pdfContext],
      modelAttachments: [pdfAttachment],
    };
    const assistantMessage = {
      role: "assistant" as const,
      text: "Old answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    let localResolutionCount = 0;
    let capturedRuntimeRequest: AgentRuntimeRequest | undefined;
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: true,
      }),
      runTurn: async (params: { request: AgentRuntimeRequest }) => {
        capturedRuntimeRequest = params.request;
        return {
          kind: "completed",
          runId: "run-native-pdf-retry",
          text: "New answer.",
          usedFallback: false,
        } as AgentRuntimeOutcome;
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.resolveLocalPdfResources = async () => {
      localResolutionCount += 1;
      throw new Error("Native attachment retries must not resolve raw paths.");
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.equal(localResolutionCount, 0);
    assert.isUndefined(capturedRuntimeRequest?.localDocuments);
    assert.deepEqual(capturedRuntimeRequest?.attachments, [pdfAttachment]);
  });

  it("preserves the previous assistant response when raw PDF retry preflight fails", async function () {
    const conversationKey = 4812;
    const pendingWrites: Array<[number, number]> = [];
    const assistantMessage = {
      role: "assistant" as const,
      text: "Previous grounded answer.",
      timestamp: 200,
      runMode: "agent" as const,
    };
    const userMessage = {
      role: "user" as const,
      text: "Analyze this PDF.",
      timestamp: 100,
      runMode: "agent" as const,
      pdfPaperContexts: [
        {
          itemId: 10,
          contextItemId: 11,
          title: "Exact PDF",
          contentSourceMode: "pdf" as const,
        },
      ],
    };
    const deps = createDeps({
      runtime: createFinalThenHangingRuntime(() => undefined),
      pendingWrites,
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: userMessage.pdfPaperContexts,
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.getConversationSystem = () => "claude_code";
    deps.resolveLocalPdfResources = async () => {
      throw new Error("Selected PDF file is missing or unreadable.");
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.equal(assistantMessage.text, "Previous grounded answer.");
    assert.deepEqual(pendingWrites, []);
  });

  it("preserves partial text and flags interruption when the runtime drops mid-stream", async function () {
    const conversationKey = 555;
    const statuses: string[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async (params: {
        onEvent?: (event: any) => Promise<void> | void;
      }) => {
        await params.onEvent?.({
          type: "message_delta",
          text: "Partial answer that ",
        });
        await params.onEvent?.({
          type: "message_delta",
          text: "streamed before the drop.",
        });
        throw new Error("Error in input stream");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses,
    });
    // Production seeds the conversation history before a turn starts.
    const history: any[] = [];
    (deps as any).chatHistory.set(conversationKey, history);

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "summarize the methods",
      },
      deps,
    );

    const assistantMessage = history[history.length - 1];
    assert.strictEqual(
      assistantMessage.text,
      "Partial answer that streamed before the drop.",
    );
    assert.isTrue(assistantMessage.interrupted);
    assert.isUndefined(assistantMessage.pendingFinalText);
    assert.isFalse(Boolean(assistantMessage.streaming));
    assert.include(statuses.join("\n"), "Error: Error in input stream");
  });

  it("keeps the bare error text when nothing streamed before the failure", async function () {
    const conversationKey = 556;
    const statuses: string[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () => {
        throw new Error("boom");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses,
    });
    // Production seeds the conversation history before a turn starts.
    const history: any[] = [];
    (deps as any).chatHistory.set(conversationKey, history);

    await sendAgentTurn(
      {
        body: {} as Element,
        item: fakeItem(conversationKey),
        question: "summarize the methods",
      },
      deps,
    );

    const assistantMessage = history[history.length - 1];
    assert.strictEqual(assistantMessage.text, "Error: boom");
    assert.isFalse(Boolean(assistantMessage.interrupted));
  });

  it("does not resurrect rolled-back text in the preserved partial", async function () {
    const conversationKey = 557;
    const retracted = "Thinking about which tool to use. ";
    // The rollback handler consults a Zotero pref (block-streaming toggle).
    const zoteroBefore = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { Prefs: { get: () => true } };
    try {
      const runtime = {
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
        }),
        runTurn: async (params: {
          onEvent?: (event: any) => Promise<void> | void;
        }) => {
          // Round 1 streams intermediate text the runtime then retracts
          // (message_rollback), exactly like a tool-call round does.
          await params.onEvent?.({ type: "message_delta", text: retracted });
          await params.onEvent?.({
            type: "message_rollback",
            length: retracted.length,
          });
          // Round 2 streams part of the real answer, then the stream drops.
          await params.onEvent?.({
            type: "message_delta",
            text: "Real partial answer",
          });
          throw new Error("Error in input stream");
        },
      } as unknown as AgentRuntime;
      const deps = createDeps({
        runtime,
        pendingWrites: [],
        idleRestores: [],
        statuses: [],
      });
      const history: any[] = [];
      (deps as any).chatHistory.set(conversationKey, history);

      await sendAgentTurn(
        {
          body: {} as Element,
          item: fakeItem(conversationKey),
          question: "summarize the methods",
        },
        deps,
      );

      const assistantMessage = history[history.length - 1];
      assert.strictEqual(assistantMessage.text, "Real partial answer");
      assert.isTrue(assistantMessage.interrupted);
    } finally {
      if (zoteroBefore === undefined) delete (globalThis as any).Zotero;
      else (globalThis as any).Zotero = zoteroBefore;
    }
  });

  it("restores the previous assistant message when a retry fails before streaming", async function () {
    const conversationKey = 558;
    const userMessage = {
      role: "user" as const,
      text: "summarize",
      timestamp: 100,
      runMode: "agent" as const,
    };
    const assistantMessage: any = {
      role: "assistant" as const,
      text: "Preserved partial answer.",
      timestamp: 200,
      runMode: "agent" as const,
      interrupted: true,
    };
    const assistantStoreWrites: unknown[] = [];
    const runtime = {
      getCapabilities: () => ({
        streaming: true,
        toolCalls: true,
        multimodal: false,
      }),
      runTurn: async () => {
        throw new Error("NetworkError when attempting to fetch resource.");
      },
    } as unknown as AgentRuntime;
    const deps = createDeps({
      runtime,
      pendingWrites: [],
      idleRestores: [],
      statuses: [],
    });
    deps.chatHistory.set(conversationKey, [userMessage, assistantMessage]);
    deps.findLatestRetryPair = () => ({
      userIndex: 0,
      userMessage,
      assistantMessage,
    });
    deps.reconstructRetryPayload = () => ({
      question: userMessage.text,
      screenshotImages: [],
      paperContexts: [],
      pdfPaperContexts: [],
      fullTextPaperContexts: [],
      selectedCollectionContexts: [],
      selectedTagContexts: [],
    });
    deps.updateStoredLatestAssistantMessage = async (_key, update) => {
      assistantStoreWrites.push(update);
    };

    await retryAgentTurn(
      {} as Element,
      fakeItem(conversationKey),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    );

    assert.strictEqual(assistantMessage.text, "Preserved partial answer.");
    assert.isTrue(assistantMessage.interrupted);
    assert.isFalse(Boolean(assistantMessage.streaming));
    // The stored row must keep the partial — no error-text write.
    assert.lengthOf(assistantStoreWrites, 0);
  });
});
