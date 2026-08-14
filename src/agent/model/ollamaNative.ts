/**
 * Agent adapter for Ollama's native `/api/chat` endpoint.
 *
 * Mirrors {@link OpenAIChatCompatAgentAdapter} in structure, with three wire
 * differences that make a separate adapter necessary:
 *
 *  - The stream is NDJSON (one JSON object per line), not SSE.
 *  - `message.thinking` is a distinct field from `message.content`. Ollama's
 *    OpenAI-compatible endpoint collapses these for some models and returns an
 *    empty answer (see #363); the native endpoint keeps them apart.
 *  - `tool_calls[].function.arguments` is already a JSON object rather than a
 *    JSON string, and tool results are correlated by `tool_name` instead of a
 *    server-issued `tool_call_id`.
 */

import {
  buildReasoningPayload,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  AgentToolCall,
} from "../types";
import type { AgentModelAdapter, AgentStepParams } from "./adapter";
import { buildAgentModelCapabilities } from "./contentCapabilities";
import { resolveRequestContentInputs } from "./messageBuilder";
import {
  buildOpenAIFunctionTools,
  createFallbackToolCallId,
  parseToolCallArguments,
} from "./shared";
import { resolveContentParts } from "./adapterUtils";

type OllamaRequestMessage = {
  role: string;
  content: string;
  images?: string[];
  thinking?: string;
  tool_name?: string;
  tool_calls?: Array<{
    function: { name: string; arguments: unknown };
  }>;
};

type OllamaStreamChunk = {
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

async function buildMessagesPayload(
  messages: AgentModelMessage[],
): Promise<OllamaRequestMessage[]> {
  const result: OllamaRequestMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // Ollama correlates tool results by name, not by a call id.
      result.push({
        role: "tool",
        content: message.content,
        tool_name: message.name,
      });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      result.push({
        role: "assistant",
        content:
          typeof message.content === "string"
            ? message.content
            : await flattenToText(message),
        ...(message.reasoning_content
          ? { thinking: message.reasoning_content }
          : {}),
        tool_calls: message.tool_calls.map((call) => ({
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    const resolved = await resolveContentParts(message);
    const textParts: string[] = [];
    const images: string[] = [];
    for (const part of resolved) {
      if (part.type === "text") {
        textParts.push(part.text);
        continue;
      }
      if (part.type === "image") {
        if (part.mimeType.trim().toLowerCase() === "application/pdf") {
          throw new Error(
            "Ollama chat cannot send PDF content as an image. Render the PDF to page images first.",
          );
        }
        // Ollama takes bare base64, not a data: URL and not a content part.
        images.push(part.base64);
        continue;
      }
      throw new Error(
        "Ollama chat cannot send unresolved file_ref attachments. Render them to page images first.",
      );
    }
    result.push({
      role: message.role,
      content: textParts.join("\n"),
      ...(images.length ? { images } : {}),
    });
  }
  return result;
}

async function flattenToText(message: AgentModelMessage): Promise<string> {
  const resolved = await resolveContentParts(message);
  return resolved
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function parseOllamaChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta?: (delta: string) => void | Promise<void>,
  onReasoning?: (event: {
    summary?: string;
    details?: string;
  }) => void | Promise<void>,
  onUsage?: AgentStepParams["onUsage"],
): Promise<{
  text: string;
  toolCalls: AgentToolCall[];
  reasoningText: string;
}> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let reasoningText = "";
  const toolCalls: AgentToolCall[] = [];

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: OllamaStreamChunk;
    try {
      parsed = JSON.parse(trimmed) as OllamaStreamChunk;
    } catch (err) {
      ztoolkit.log("LLM: Malformed NDJSON line in Ollama stream", err);
      return;
    }
    if (parsed.error) throw new Error(`Ollama error: ${parsed.error}`);

    const thinkingDelta = toText(parsed.message?.thinking);
    if (thinkingDelta) {
      reasoningText += thinkingDelta;
      if (onReasoning) await onReasoning({ details: thinkingDelta });
    }

    const textDelta = toText(parsed.message?.content);
    if (textDelta) {
      fullText += textDelta;
      if (onTextDelta) await onTextDelta(textDelta);
    }

    // Ollama emits each tool call complete in a single chunk, so there is no
    // per-index accumulator to maintain the way the OpenAI stream needs.
    if (Array.isArray(parsed.message?.tool_calls)) {
      for (const call of parsed.message.tool_calls) {
        const name = call?.function?.name?.trim();
        if (!name) continue;
        toolCalls.push({
          id: createFallbackToolCallId("ollama-tool", toolCalls.length),
          name,
          arguments: parseToolCallArguments(call.function?.arguments),
        });
      }
    }

    if (parsed.done && onUsage) {
      const promptTokens = parsed.prompt_eval_count ?? 0;
      const completionTokens = parsed.eval_count ?? 0;
      const totalTokens = promptTokens + completionTokens;
      if (totalTokens > 0) {
        await onUsage({
          promptTokens,
          completionTokens,
          totalTokens,
          contextTokens: promptTokens,
          contextWindowIsAuthoritative: promptTokens > 0,
        });
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) await handleLine(line);
    }
    if (buffer.trim()) await handleLine(buffer);
  } finally {
    reader.releaseLock();
  }

  return { text: fullText, toolCalls, reasoningText };
}

export class OllamaNativeAgentAdapter implements AgentModelAdapter {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: true,
      contentInputs: resolveRequestContentInputs(request),
      fileInputs: false,
      reasoning: true,
    });
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    const request = params.request;
    const auth = await resolveRequestAuthState({
      authMode: request.authMode || "api_key",
      apiKey: request.apiKey || "",
      signal: params.signal,
    });
    const url = resolveProviderTransportEndpoint({
      protocol: "ollama_native",
      apiBase: request.apiBase || "",
      authMode: request.authMode,
    });
    const resolvedMessages = await buildMessagesPayload(params.messages);
    const tools = buildOpenAIFunctionTools(params.tools);
    const response = await postWithReasoningFallback({
      url,
      auth,
      modelName: request.model,
      initialReasoning: request.reasoning,
      buildPayload: (reasoningOverride) => {
        const reasoningPayload = buildReasoningPayload(
          reasoningOverride,
          false,
          request.model,
          request.apiBase,
          "ollama_native",
          { profileOverride: request.advanced?.profileOverride },
        );
        const options: Record<string, unknown> = {};
        if (!reasoningPayload.omitTemperature) {
          options.temperature = normalizeTemperature(
            request.advanced?.temperature,
          );
        }
        // num_predict is left unset so Ollama applies its own unlimited
        // default: capping output makes a thinking model spend the budget on
        // thought and return nothing.
        const { options: extraOptions, ...extraTop } =
          reasoningPayload.extra as { options?: unknown } & Record<
            string,
            unknown
          >;
        const mergedOptions = isPlainRecord(extraOptions)
          ? { ...options, ...extraOptions }
          : options;
        return {
          model: request.model,
          messages: resolvedMessages,
          stream: true,
          ...(tools.length ? { tools } : {}),
          ...(Object.keys(mergedOptions).length
            ? { options: mergedOptions }
            : {}),
          ...extraTop,
        };
      },
      signal: params.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${response.status} ${response.statusText} - ${errorText}`,
      );
    }
    if (!response.body) {
      throw new Error("Ollama returned an empty response body.");
    }

    const result = await parseOllamaChatCompletionStream(
      response.body,
      params.onTextDelta,
      params.onReasoning,
      params.onUsage,
    );

    if (result.toolCalls.length) {
      return {
        kind: "tool_calls",
        calls: result.toolCalls,
        assistantMessage: {
          role: "assistant",
          content: result.text,
          ...(result.reasoningText.trim()
            ? { reasoning_content: result.reasoningText.trim() }
            : {}),
          tool_calls: result.toolCalls,
        },
      };
    }
    return {
      kind: "final",
      text: result.text,
      assistantMessage: {
        role: "assistant",
        content: result.text,
      },
    };
  }
}
