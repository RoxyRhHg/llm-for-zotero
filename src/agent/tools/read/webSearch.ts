import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  AgentTraceDetail,
} from "../../types";
import type {
  WebAccessDepth,
  WebSearchResponse,
  WebSearchTimeRange,
  WebSearchTopic,
} from "../../../webAccess/types";
import { registerWebSearchSources } from "../../../webAccess/runSources";
import { normalizePublicWebUrl } from "../../../webAccess/tavilyClient";
import { fail, ok, validateObject } from "../shared";
import {
  createConfiguredWebAccessProvider,
  isWebAccessToolAvailable,
  type WebAccessProviderFactory,
  webCitationInstruction,
} from "./webAccessShared";

export type WebSearchInput = {
  query: string;
  depth: WebAccessDepth;
  topic: WebSearchTopic;
  maxResults: number;
  timeRange?: WebSearchTimeRange;
  startDate?: string;
  endDate?: string;
  includeDomains?: string[];
  excludeDomains?: string[];
};

export type WebSearchToolResult = WebSearchResponse & {
  citation: ReturnType<typeof webCitationInstruction>;
};

function normalizeDepth(value: unknown): WebAccessDepth {
  return value === "advanced" ? "advanced" : "basic";
}

function normalizeTopic(value: unknown): WebSearchTopic {
  return value === "news" || value === "finance" ? value : "general";
}

function normalizeTimeRange(value: unknown): WebSearchTimeRange | undefined {
  return value === "day" ||
    value === "week" ||
    value === "month" ||
    value === "year"
    ? value
    : undefined;
}

function normalizeDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function normalizeDomains(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const domains = value.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : "",
  );
  if (
    domains.some(
      (domain) =>
        !domain ||
        domain.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          domain,
        ),
    )
  ) {
    return undefined;
  }
  try {
    for (const domain of domains) normalizePublicWebUrl(`https://${domain}/`);
  } catch {
    return undefined;
  }
  return Array.from(new Set(domains));
}

export function validateWebSearchInput(
  args: unknown,
): AgentToolInputValidation<WebSearchInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("web_search expects an object input");
  }
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
  if (
    args.topic !== undefined &&
    args.topic !== "general" &&
    args.topic !== "news" &&
    args.topic !== "finance"
  ) {
    return fail("topic must be one of: general, news, finance");
  }
  const maxResultsRaw = args.maxResults ?? 5;
  const maxResults = Number(maxResultsRaw);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
    return fail("maxResults must be an integer from 1 to 10");
  }
  const timeRange = normalizeTimeRange(args.timeRange);
  if (args.timeRange !== undefined && !timeRange) {
    return fail("timeRange must be one of: day, week, month, year");
  }
  const startDate = normalizeDate(args.startDate);
  const endDate = normalizeDate(args.endDate);
  if (args.startDate !== undefined && !startDate) {
    return fail("startDate must use YYYY-MM-DD");
  }
  if (args.endDate !== undefined && !endDate) {
    return fail("endDate must use YYYY-MM-DD");
  }
  if (timeRange && (startDate || endDate)) {
    return fail("timeRange cannot be combined with startDate or endDate");
  }
  if (startDate && endDate && startDate > endDate) {
    return fail("startDate must not be after endDate");
  }
  const includeDomains = normalizeDomains(args.includeDomains);
  const excludeDomains = normalizeDomains(args.excludeDomains);
  if (args.includeDomains !== undefined && !includeDomains) {
    return fail("includeDomains must contain at most 10 valid domain names");
  }
  if (args.excludeDomains !== undefined && !excludeDomains) {
    return fail("excludeDomains must contain at most 10 valid domain names");
  }
  return ok({
    query,
    depth: normalizeDepth(args.depth),
    topic: normalizeTopic(args.topic),
    maxResults,
    timeRange,
    startDate,
    endDate,
    includeDomains,
    excludeDomains,
  });
}

function buildSearchTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input = validateWebSearchInput(args);
  const result =
    content && typeof content === "object"
      ? (content as Partial<WebSearchToolResult>)
      : {};
  const details: AgentTraceDetail[] = [];
  if (input.ok) {
    details.push({ label: "Query", value: input.value.query });
    details.push({ label: "Depth", value: input.value.depth });
    details.push({ label: "Topic", value: input.value.topic });
    if (input.value.timeRange) {
      details.push({ label: "Time range", value: input.value.timeRange });
    }
    if (input.value.startDate || input.value.endDate) {
      details.push({
        label: "Date range",
        value: `${input.value.startDate || "…"} – ${input.value.endDate || "…"}`,
      });
    }
    if (input.value.includeDomains?.length) {
      details.push({
        label: "Included domains",
        value: input.value.includeDomains.join(", "),
      });
    }
    if (input.value.excludeDomains?.length) {
      details.push({
        label: "Excluded domains",
        value: input.value.excludeDomains.join(", "),
      });
    }
  }
  for (const [index, source] of (result.results || []).entries()) {
    details.push({
      label: `Result ${index + 1}`,
      value: `${source.organization} — ${source.title}`,
    });
    details.push({
      label: `Hostname ${index + 1}`,
      value: source.hostname,
    });
    details.push({ label: `URL ${index + 1}`, value: source.url, kind: "url" });
    if (source.snippet) {
      details.push({ label: `Snippet ${index + 1}`, value: source.snippet });
    }
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

export function createWebSearchTool(
  providerFactory: WebAccessProviderFactory = createConfiguredWebAccessProvider,
): AgentToolDefinition<WebSearchInput, WebSearchToolResult> {
  return {
    spec: {
      name: "web_search",
      description:
        "Search the current public web with Tavily. Use this for current facts, general websites, news, products, organizations, or other non-scholarly online information. Use literature_search for scholarly paper discovery.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "The focused web search query.",
          },
          depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description:
              "basic is the default and costs 1 credit. Use advanced only when broader/deeper retrieval is needed; it costs 2 credits.",
          },
          topic: {
            type: "string",
            enum: ["general", "news", "finance"],
          },
          maxResults: { type: "integer", minimum: 1, maximum: 10 },
          timeRange: {
            type: "string",
            enum: ["day", "week", "month", "year"],
          },
          startDate: { type: "string", description: "YYYY-MM-DD" },
          endDate: { type: "string", description: "YYYY-MM-DD" },
          includeDomains: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
          },
          excludeDomains: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      localAgentOnly: true,
    },
    isAvailable: isWebAccessToolAvailable,
    guidance: {
      matches: (request) =>
        /\b(web|website|internet|online|latest|current|today|news|price|weather|company|organization|product|documentation)\b/i.test(
          request.userText,
        ),
      instruction:
        "Use web_search for current or general web information that is not primarily scholarly literature. Start with depth:'basic'; use depth:'advanced' only when the task needs deeper retrieval. Use web_read on the strongest result URLs when snippets are insufficient. Every final-answer paragraph that uses these results must end with the exact hidden source marker described in the tool result, using only returned sourceId values. Do not add a references footer.",
    },
    presentation: {
      label: "Search Web",
      mergeResultIntoCallTrace: true,
      buildTraceSummary: ({ args, content }) => {
        const input = validateWebSearchInput(args);
        const result = content as Partial<WebSearchToolResult> | undefined;
        if (!input.ok || !result) return null;
        const count = Array.isArray(result.results) ? result.results.length : 0;
        const credits = result.usage?.credits ?? 0;
        return `Searched “${input.value.query}” · ${count} result${count === 1 ? "" : "s"} · ${input.value.depth} · ${credits} credit${credits === 1 ? "" : "s"}`;
      },
      summaries: {
        onCall: ({ args }) => {
          const validated = validateWebSearchInput(args);
          return validated.ok
            ? `Searching the web for “${validated.value.query}”`
            : "Searching the web";
        },
        onSuccess: ({ content }) => {
          const result = content as Partial<WebSearchToolResult> | undefined;
          const count = Array.isArray(result?.results)
            ? result.results.length
            : 0;
          const credits = result?.usage?.credits ?? 0;
          return `Found ${count} web result${count === 1 ? "" : "s"} · ${credits} credit${credits === 1 ? "" : "s"}`;
        },
        onEmpty: "No web results found",
        onError: "Web search failed",
      },
      buildTraceDetails: ({ args, content }) =>
        buildSearchTraceDetails(args, content),
    },
    validate: validateWebSearchInput,
    execute: async (input, context) => {
      if (!context.runId) {
        throw new Error("web_search requires an active local agent run.");
      }
      const result = await providerFactory().search({
        ...input,
        signal: context.signal,
      });
      const results = registerWebSearchSources(context.runId, result.results);
      return {
        ...result,
        results,
        citation: webCitationInstruction(
          results.map((source) => source.sourceId),
        ),
      };
    },
  };
}
