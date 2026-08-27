import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentTraceDetail,
} from "../../types";
import type { WebAccessDepth, WebReadResponse } from "../../../webAccess/types";
import { normalizePublicWebUrl } from "../../../webAccess/tavilyClient";
import {
  applyRunSourceIds,
  assertWebReadUrlsFromSearch,
} from "../../../webAccess/runSources";
import { fail, ok, validateObject } from "../shared";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
  type WebAccessProviderFactory,
  webCitationInstruction,
} from "./webAccessShared";

export type WebReadInput = {
  urls: string[];
  query: string;
  depth: WebAccessDepth;
  chunksPerSource: number;
};

export type WebReadToolResult = WebReadResponse & {
  citation: ReturnType<typeof webCitationInstruction>;
};

export function validateWebReadInput(
  args: unknown,
): AgentToolInputValidation<WebReadInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("web_read expects an object input");
  }
  if (
    !Array.isArray(args.urls) ||
    args.urls.length < 1 ||
    args.urls.length > 5
  ) {
    return fail("urls must contain between 1 and 5 public HTTP(S) URLs");
  }
  const urls: string[] = [];
  try {
    for (const value of args.urls) urls.push(normalizePublicWebUrl(value));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const uniqueUrls = Array.from(new Set(urls));
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return fail("query is required");
  if (query.length > 2_000)
    return fail("query must be 2,000 characters or less");
  if (
    args.depth !== undefined &&
    args.depth !== "basic" &&
    args.depth !== "advanced"
  ) {
    return fail("depth must be one of: basic, advanced");
  }
  const chunksRaw = args.chunksPerSource ?? 3;
  const chunksPerSource = Number(chunksRaw);
  if (
    !Number.isInteger(chunksPerSource) ||
    chunksPerSource < 1 ||
    chunksPerSource > 5
  ) {
    return fail("chunksPerSource must be an integer from 1 to 5");
  }
  return ok({
    urls: uniqueUrls,
    query,
    depth: args.depth === "advanced" ? "advanced" : "basic",
    chunksPerSource,
  });
}

function buildReadTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input = validateWebReadInput(args);
  const result =
    content && typeof content === "object"
      ? (content as Partial<WebReadToolResult>)
      : {};
  const details: AgentTraceDetail[] = [];
  if (input.ok) {
    details.push({ label: "Reading for", value: input.value.query });
    details.push({ label: "Depth", value: input.value.depth });
    details.push({
      label: "Chunks per page",
      value: String(input.value.chunksPerSource),
    });
  }
  for (const [index, page] of (result.pages || []).entries()) {
    details.push({
      label: `Page ${index + 1}`,
      value: `${page.organization} — ${page.title}`,
    });
    details.push({ label: `Hostname ${index + 1}`, value: page.hostname });
    details.push({ label: `URL ${index + 1}`, value: page.url, kind: "url" });
    if (page.content) {
      details.push({ label: `Extract ${index + 1}`, value: page.content });
    }
  }
  for (const [index, failure] of (result.failedResults || []).entries()) {
    details.push({
      label: `Failed page ${index + 1}`,
      value: `${failure.url}\n${failure.error}`,
    });
  }
  if (result.usage) {
    details.push({
      label: "Credits used",
      value: String(result.usage.credits),
    });
  }
  if (result.requestId) {
    details.push({ label: "Request ID", value: result.requestId });
  }
  return details;
}

export function createWebReadTool(
  providerFactory: WebAccessProviderFactory = createConfiguredWebAccessProvider,
): AgentToolDefinition<WebReadInput, WebReadToolResult> {
  return {
    spec: {
      name: "web_read",
      description:
        "Read query-relevant passages from one to five public web pages with Tavily. Use URLs returned by web_search when their snippets are not sufficient for the answer.",
      inputSchema: {
        type: "object",
        required: ["urls", "query"],
        additionalProperties: false,
        properties: {
          urls: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
          query: {
            type: "string",
            description: "What information to extract from the pages.",
          },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description:
              "basic is the default. Use advanced only for complex or JavaScript-heavy pages.",
          },
          chunksPerSource: {
            type: "integer",
            minimum: 1,
            maximum: 5,
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      localAgentOnly: true,
    },
    isAvailable: isWebAccessToolAvailable,
    presentation: {
      label: "Read Web Pages",
      mergeResultIntoCallTrace: true,
      buildTraceSummary: ({ args, content }) => {
        const input = validateWebReadInput(args);
        const result = content as Partial<WebReadToolResult> | undefined;
        if (!input.ok || !result) return null;
        const success = Array.isArray(result.pages) ? result.pages.length : 0;
        const failed = Array.isArray(result.failedResults)
          ? result.failedResults.length
          : 0;
        const credits = result.usage?.credits ?? 0;
        return `Read ${input.value.urls.length} page${input.value.urls.length === 1 ? "" : "s"} · ${success} successful · ${failed} failed · ${input.value.depth} · ${credits} credit${credits === 1 ? "" : "s"}`;
      },
      summaries: {
        onCall: ({ args }) => {
          const validated = validateWebReadInput(args);
          if (!validated.ok) return "Reading web pages";
          const count = validated.value.urls.length;
          return `Reading ${count} web page${count === 1 ? "" : "s"}`;
        },
        onSuccess: ({ content }) => {
          const result = content as Partial<WebReadToolResult> | undefined;
          const success = Array.isArray(result?.pages)
            ? result.pages.length
            : 0;
          const failed = Array.isArray(result?.failedResults)
            ? result.failedResults.length
            : 0;
          const credits = result?.usage?.credits ?? 0;
          return `Read ${success} web page${success === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""} · ${credits} credit${credits === 1 ? "" : "s"}`;
        },
        onEmpty: "No web pages could be read",
        onError: "Web page reading failed",
      },
      buildTraceDetails: ({ args, content }) =>
        buildReadTraceDetails(args, content),
    },
    validate: validateWebReadInput,
    execute: async (input, context) => {
      if (!context.runId) {
        throw new Error("web_read requires an active local agent run.");
      }
      assertWebReadUrlsFromSearch(context.runId, input.urls);
      const result = await providerFactory().read({
        ...input,
        signal: context.signal,
      });
      const pages = applyRunSourceIds(context.runId, result.pages);
      return {
        ...result,
        pages,
        citation: webCitationInstruction(
          pages.map((source) => source.sourceId),
        ),
      };
    },
  };
}
