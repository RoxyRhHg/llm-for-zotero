import type {
  AgentActionCapability,
  AgentActionIntent,
  AgentRuntimeRequest,
} from "../types";
import type { WriteNoteDestination } from "../writeNoteDestination";

const VALID_ACTION_CAPABILITIES = new Set<AgentActionCapability>([
  "zotero.read",
  "zotero.tags",
  "zotero.metadata",
  "zotero.collections",
  "zotero.notes",
  "zotero.import",
  "zotero.trash",
  "zotero.attachments",
  "zotero.annotations",
  "file.write",
  "command.execute",
  "zotero.script",
]);

function parseActionIntent(value: unknown): AgentActionIntent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.capability !== "string" ||
    !VALID_ACTION_CAPABILITIES.has(record.capability as AgentActionCapability)
  ) {
    return null;
  }
  if (
    record.coverage !== "one" &&
    record.coverage !== "some" &&
    record.coverage !== "all"
  ) {
    return null;
  }
  const targetKind = record.targetKind === "items" ? "items" : "papers";
  const rawScope = record.scope;
  const scope =
    rawScope &&
    typeof rawScope === "object" &&
    (rawScope as { kind?: unknown }).kind === "collection"
      ? {
          kind: "collection" as const,
          path:
            typeof (rawScope as { path?: unknown }).path === "string" &&
            (rawScope as { path: string }).path.trim()
              ? (rawScope as { path: string }).path.trim()
              : undefined,
          includeDescendants:
            (rawScope as { includeDescendants?: unknown })
              .includeDescendants === true,
        }
      : undefined;
  const rawConstraints = record.constraints;
  const tagPrefix =
    rawConstraints &&
    typeof rawConstraints === "object" &&
    typeof (rawConstraints as { tagPrefix?: unknown }).tagPrefix === "string"
      ? (rawConstraints as { tagPrefix: string }).tagPrefix.trim()
      : "";
  const readMode =
    rawConstraints &&
    typeof rawConstraints === "object" &&
    (rawConstraints as { readMode?: unknown }).readMode === "full"
      ? "full"
      : undefined;
  const collectionMode =
    rawConstraints &&
    typeof rawConstraints === "object" &&
    (rawConstraints as { collectionMode?: unknown }).collectionMode === "move"
      ? "move"
      : undefined;
  return {
    capability: record.capability as AgentActionCapability,
    coverage: record.coverage,
    targetKind,
    scopeRole: record.scopeRole === "destination" ? "destination" : "source",
    ...(scope ? { scope } : {}),
    ...(tagPrefix || readMode || collectionMode
      ? {
          constraints: {
            ...(tagPrefix ? { tagPrefix } : {}),
            ...(readMode ? { readMode } : {}),
            ...(collectionMode ? { collectionMode } : {}),
          },
        }
      : {}),
  };
}

export function parseActionIntents(value: unknown): AgentActionIntent[] {
  return Array.isArray(value)
    ? value
        .map(parseActionIntent)
        .filter((intent): intent is AgentActionIntent => Boolean(intent))
    : [];
}

function actionIntentKey(intent: AgentActionIntent): string {
  return [
    intent.capability,
    intent.coverage,
    intent.targetKind,
    intent.scope?.path || "",
    intent.scope?.includeDescendants ? "descendants" : "direct",
    intent.scopeRole || "source",
  ].join("|");
}

export function mergeActionIntents(
  primary: AgentActionIntent[],
  fallback: AgentActionIntent[],
): AgentActionIntent[] {
  const deterministicCapabilities = new Set(
    fallback.map((intent) => intent.capability),
  );
  const merged = new Map<string, AgentActionIntent>();
  for (const intent of [
    ...primary.filter(
      (intent) => !deterministicCapabilities.has(intent.capability),
    ),
    ...fallback,
  ]) {
    const key = actionIntentKey(intent);
    if (!merged.has(key)) merged.set(key, intent);
  }
  return [...merged.values()];
}

export function reconcileNoteDestinationActionIntents(
  intents: AgentActionIntent[],
  destination: WriteNoteDestination,
): AgentActionIntent[] {
  if (destination === "none") return intents;
  const desiredCapability =
    destination === "file" ? "file.write" : "zotero.notes";
  const noteIntent = intents.find(
    (intent) => intent.capability === desiredCapability,
  );
  const alternateIntent = intents.find(
    (intent) =>
      intent.capability ===
      (destination === "file" ? "zotero.notes" : "file.write"),
  );
  const basis = noteIntent || alternateIntent;
  const replacement: AgentActionIntent =
    destination === "file"
      ? {
          capability: "file.write",
          coverage: basis?.coverage || "one",
          targetKind: "items",
        }
      : {
          ...(basis || {
            coverage: "one" as const,
            targetKind: "items" as const,
          }),
          capability: "zotero.notes",
          targetKind: "items",
        };
  return mergeActionIntents(
    intents.filter(
      (intent) =>
        intent.capability !== "zotero.notes" &&
        intent.capability !== "file.write",
    ),
    [replacement],
  );
}

function requestedCoverage(text: string): AgentActionIntent["coverage"] {
  if (/\b(?:all|every|each)\b/i.test(text)) return "all";
  if (
    /\b(?:this|current|one|single)\b/i.test(text) ||
    /\bthe\s+(?:paper|item|entry)\s+(?:titled|named)\b/i.test(text)
  ) {
    return "one";
  }
  return "some";
}

function requestedCollectionScope(
  request: Pick<AgentRuntimeRequest, "userText" | "selectedCollectionContexts">,
): AgentActionIntent["scope"] | undefined {
  const text = request.userText || "";
  const named = text.match(
    /\b(?:collection|folder)\s+(?:named\s+)?["“']([^"”']+)["”']/i,
  )?.[1];
  if (!named && !request.selectedCollectionContexts?.length) return undefined;
  return {
    kind: "collection",
    ...(named && !request.selectedCollectionContexts?.length
      ? { path: named.trim() }
      : {}),
    includeDescendants:
      /\b(?:subcollections?|descendants?|including children)\b/i.test(text),
  };
}

function requestedMoveCollectionScopes(text: string): {
  source: AgentActionIntent["scope"];
  destination: AgentActionIntent["scope"];
} | null {
  const source = text.match(
    /\b(?:out\s+of|from)\s+(?:the\s+)?(?:collection|folder)\s+["“']([^"”']+)["”']/i,
  )?.[1];
  const destination = text.match(
    /\b(?:into|to)\s+(?:(?:the\s+)?(?:collection|folder)\s+)?["“']([^"”']+)["”']/i,
  )?.[1];
  if (!source || !destination) return null;
  return {
    source: {
      kind: "collection",
      path: source.trim(),
      includeDescendants: false,
    },
    destination: {
      kind: "collection",
      path: destination.trim(),
      includeDescendants: false,
    },
  };
}

/** Deterministic safety fallback for explicit action verbs. */
export function inferActionIntentsFromRequest(
  request: Pick<AgentRuntimeRequest, "userText" | "selectedCollectionContexts">,
): AgentActionIntent[] {
  const text = (request.userText || "").trim();
  if (!text) return [];
  const coverage = requestedCoverage(text);
  const scope = requestedCollectionScope(request);
  const moveScopes = requestedMoveCollectionScopes(text);
  const intents: AgentActionIntent[] = [];
  const add = (
    capability: AgentActionCapability,
    targetKind: "papers" | "items" = "papers",
    constraints?: AgentActionIntent["constraints"],
    scopeRole: AgentActionIntent["scopeRole"] = "source",
    actionScope: AgentActionIntent["scope"] | undefined = scope,
  ) => {
    intents.push({
      capability,
      coverage,
      targetKind,
      scopeRole,
      ...(actionScope ? { scope: actionScope } : {}),
      ...(constraints ? { constraints } : {}),
    });
  };
  const tagPrefix = text.match(
    /\b(?:tag\s+prefix|prefix(?:ed)?\s+(?:with\s+)?)["“']([^"”']+)["”']/i,
  )?.[1];
  if (
    (/\b(?:add|apply|assign|remove|set|replace|create)\b/i.test(text) &&
      /\btags?\b/i.test(text)) ||
    (/\btag\b/i.test(text) && /\b(?:papers?|items?|entries)\b/i.test(text))
  ) {
    add("zotero.tags", "papers", tagPrefix ? { tagPrefix } : undefined);
  }
  if (
    /\b(?:update|edit|change|correct|set|replace|enrich)\b[\s\S]{0,100}\b(?:metadata|fields?|extra|title|abstract|doi|date|year|authors?|creators?|publication)\b/i.test(
      text,
    )
  ) {
    add("zotero.metadata");
  }
  if (
    (/\b(?:create|rename|delete|move|file|add|remove|organize|organise)\b/i.test(
      text,
    ) &&
      /\b(?:collections?|folders?)\b/i.test(text)) ||
    (/\b(?:move|file)\b/i.test(text) &&
      /\b(?:papers?|items?|entries)\b/i.test(text) &&
      /\b(?:into|to)\b/i.test(text)) ||
    /\bnew\s+(?:zotero\s+)?(?:collection|folder)\b/i.test(text)
  ) {
    if (moveScopes) {
      add(
        "zotero.collections",
        "items",
        { collectionMode: "move" },
        "source",
        moveScopes.source,
      );
      add(
        "zotero.collections",
        "items",
        { collectionMode: "move" },
        "destination",
        moveScopes.destination,
      );
    } else {
      add("zotero.collections", "items");
    }
  }
  if (
    /\b(?:create|write|save|append|edit|update)\b/i.test(text) &&
    /\bnotes?\b/i.test(text)
  ) {
    const destination = /\b(?:standalone|collection|folder)\b/i.test(text);
    add(
      "zotero.notes",
      "items",
      undefined,
      destination ? "destination" : "source",
    );
  }
  if (
    /\bimport\b/i.test(text) &&
    /\b(?:papers?|items?|files?|doi|isbn|pmid|arxiv)\b/i.test(text)
  ) {
    add("zotero.import", "items", undefined, "destination");
  }
  if (
    /\b(?:trash|restore|undelete|delete)\b/i.test(text) &&
    /\b(?:papers?|items?|entries)\b/i.test(text)
  ) {
    add("zotero.trash", "items");
  }
  if (
    /\b(?:delete|rename|relink|change)\b/i.test(text) &&
    /\battachments?\b/i.test(text)
  ) {
    add("zotero.attachments", "items");
  }
  if (
    /\b(?:read|review|analy[sz]e|inspect)\b[\s\S]{0,50}\b(?:full|entire|complete|exhaustive)\b[\s\S]{0,20}\b(?:paper|text|pdf|document)\b|\b(?:full|entire|complete|exhaustive)\b[\s\S]{0,30}\b(?:paper|text|pdf|document)\b/i.test(
      text,
    )
  ) {
    add("zotero.read", "papers", { readMode: "full" });
  }
  if (
    /\b(?:run|execute)\b[\s\S]{0,30}\b(?:command|shell|script)\b/i.test(text)
  ) {
    add(
      /\bzotero\b/i.test(text) ? "zotero.script" : "command.execute",
      "items",
    );
  }
  return mergeActionIntents([], intents);
}
