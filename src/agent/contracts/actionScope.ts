import type {
  AgentActionIntent,
  AgentActionObligation,
  AgentRuntimeRequest,
} from "../types";
import type {
  ActionContractGateway,
  CollectionSummary,
} from "./actionOperationEvidence";
import { normalizePath, uniqueNumbers } from "./actionOperationEvidence";
import {
  isLibraryMutationOperationType,
  libraryMutationTargetsItems,
} from "../services/libraryMutation/handlerOperations";

function listCurrentCollectionSummaries(
  gateway: ActionContractGateway,
  libraryID: number,
): CollectionSummary[] {
  return gateway.listCurrentCollectionSummaries
    ? gateway.listCurrentCollectionSummaries(libraryID)
    : gateway.listCollectionSummaries(libraryID);
}

export async function listScopeTargetIds(
  gateway: ActionContractGateway,
  params: {
    libraryID: number;
    collectionId: number;
    collectionPath: string;
    targetKind: AgentActionIntent["targetKind"];
    includeDescendants: boolean;
  },
): Promise<number[]> {
  const summaries = listCurrentCollectionSummaries(gateway, params.libraryID);
  const rootPath = normalizePath(params.collectionPath);
  const collectionIds = params.includeDescendants
    ? summaries
        .filter((summary) => {
          const path = normalizePath(summary.path || summary.name);
          return path === rootPath || path.startsWith(`${rootPath}/`);
        })
        .map((summary) => summary.collectionId)
    : [params.collectionId];
  const targetIds: number[] = [];
  for (const collectionId of collectionIds) {
    if (gateway.listCurrentCollectionTargetIds) {
      targetIds.push(
        ...gateway.listCurrentCollectionTargetIds({
          libraryID: params.libraryID,
          collectionId,
          targetKind: params.targetKind,
        }),
      );
      continue;
    }
    if (params.targetKind === "papers") {
      const result = await gateway.listCollectionPaperTargets({
        libraryID: params.libraryID,
        collectionId,
      });
      targetIds.push(...result.papers.map((paper) => paper.itemId));
    } else {
      const result = await gateway.listCollectionItemTargets({
        libraryID: params.libraryID,
        collectionId,
      });
      targetIds.push(...result.items.map((item) => item.itemId));
    }
  }
  return uniqueNumbers(targetIds);
}

export async function listCurrentLibraryTargetIds(
  gateway: ActionContractGateway,
  params: {
    libraryID: number;
    targetKind: AgentActionIntent["targetKind"];
  },
): Promise<number[]> {
  if (gateway.listCurrentLibraryTargetIds) {
    return uniqueNumbers(await gateway.listCurrentLibraryTargetIds(params));
  }
  if (params.targetKind === "papers") {
    if (!gateway.listLibraryPaperTargets) return [];
    const result = await gateway.listLibraryPaperTargets({
      libraryID: params.libraryID,
    });
    return uniqueNumbers(result.papers.map((paper) => paper.itemId));
  }
  if (!gateway.listLibraryItemTargets) return [];
  const result = await gateway.listLibraryItemTargets({
    libraryID: params.libraryID,
  });
  return uniqueNumbers(result.items.map((item) => item.itemId));
}

async function resolveUnscopedBoundary(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
): Promise<AgentActionObligation["targetBoundary"]> {
  if (
    !isLibraryMutationOperationType(intent.operation) ||
    !libraryMutationTargetsItems(intent.operation)
  ) {
    return undefined;
  }
  const libraryID = Math.floor(Number(request.libraryID));
  if (!Number.isInteger(libraryID) || libraryID <= 0) return undefined;
  let frozenTargetIds: number[];
  let kind: "library" | "selection";
  if (intent.coverage === "all") {
    kind = "library";
    frozenTargetIds = await listCurrentLibraryTargetIds(gateway, {
      libraryID,
      targetKind: intent.targetKind,
    });
  } else {
    kind = "selection";
    frozenTargetIds = uniqueNumbers([
      Number(intent.parameters?.targetItemId),
      ...(request.selectedPaperContexts || []).map((paper) => paper.itemId),
      Number(request.activeItemId),
    ]).slice(0, intent.coverage === "one" ? 1 : undefined);
    if (!frozenTargetIds.length) return undefined;
  }
  return {
    kind,
    libraryID,
    frozenTargetIds,
    scopeDigest: [
      "v1",
      kind,
      libraryID,
      ...frozenTargetIds.slice().sort((left, right) => left - right),
    ].join(":"),
  };
}

export async function resolveScope(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
): Promise<AgentActionObligation[]> {
  const collectionLifecycle =
    intent.operation === "update_collection" ||
    intent.operation === "delete_collection";
  if (collectionLifecycle && !intent.scope) {
    const requestedId = intent.parameters?.collectionId;
    const selected = request.selectedCollectionContexts || [];
    const selectedId =
      selected.length === 1 ? selected[0].collectionId : undefined;
    const collectionId = requestedId || selectedId;
    if (!collectionId) {
      throw new Error(
        `The ${intent.operation} action requires one exact collection target. Select one collection or provide its ID.`,
      );
    }
    const summary = gateway.getCollectionSummary(collectionId);
    if (!summary) {
      throw new Error(`Collection ${collectionId} is no longer available.`);
    }
    const { scope: _scope, ...unscoped } = intent;
    return [
      {
        ...unscoped,
        id: `${intent.capability}:collection:${collectionId}`,
        parameters: { ...(intent.parameters || {}), collectionId },
      },
    ];
  }
  if (intent.operation === "create_collection") {
    const createsAtTopLevel = /\btop[- ]level\b/i.test(request.userText || "");
    const requestedParentId = intent.parameters?.parentCollectionId;
    const explicitlyNested =
      (typeof requestedParentId === "number" && requestedParentId > 0) ||
      /\b(?:under|inside|within|as (?:a )?child of)\b/i.test(
        request.userText || "",
      );
    if (createsAtTopLevel || requestedParentId === null || !explicitlyNested) {
      const { scope: _scope, ...unscoped } = intent;
      return [
        {
          ...unscoped,
          id: `${intent.capability}:unscoped`,
          parameters: {
            ...(intent.parameters || {}),
            parentCollectionId: intent.parameters?.parentCollectionId ?? null,
          },
        },
      ];
    }
    if (typeof requestedParentId === "number" && requestedParentId > 0) {
      if (!gateway.getCollectionSummary(requestedParentId)) {
        throw new Error(
          `Parent collection ${requestedParentId} is no longer available.`,
        );
      }
      const { scope: _scope, ...unscoped } = intent;
      return [
        {
          ...unscoped,
          id: `${intent.capability}:collection-parent:${requestedParentId}`,
        },
      ];
    }
    if (!intent.scope) {
      const selected = request.selectedCollectionContexts || [];
      if (selected.length !== 1) {
        throw new Error(
          "A nested collection creation requires one exact parent collection.",
        );
      }
      const parentId = selected[0].collectionId;
      if (!gateway.getCollectionSummary(parentId)) {
        throw new Error(
          `Parent collection ${parentId} is no longer available.`,
        );
      }
      const { scope: _scope, ...unscoped } = intent;
      return [
        {
          ...unscoped,
          id: `${intent.capability}:collection-parent:${parentId}`,
          parameters: {
            ...(intent.parameters || {}),
            parentCollectionId: parentId,
          },
        },
      ];
    }
  }
  if (!intent.scope) {
    const { scope: _scope, ...unscoped } = intent;
    const targetBoundary = await resolveUnscopedBoundary(
      gateway,
      request,
      intent,
    );
    if (
      isLibraryMutationOperationType(intent.operation) &&
      libraryMutationTargetsItems(intent.operation) &&
      !targetBoundary
    ) {
      throw new Error(
        `The ${intent.operation} action has no resolvable frozen target boundary. Select the exact target items or state a concrete library scope.`,
      );
    }
    return [
      {
        ...unscoped,
        id: `${intent.capability}:unscoped`,
        targetBoundary,
      },
    ];
  }
  const selected = request.selectedCollectionContexts || [];
  const requestedPath = normalizePath(intent.scope.path);
  let summaries: CollectionSummary[];
  if (requestedPath) {
    const libraryIDs = uniqueNumbers([
      ...selected.map((entry) => entry.libraryID),
      Number(request.libraryID),
    ]);
    summaries = libraryIDs.flatMap((libraryID) =>
      listCurrentCollectionSummaries(gateway, libraryID).filter((summary) => {
        const path = normalizePath(summary.path || summary.name);
        return (
          path === requestedPath ||
          normalizePath(summary.name) === requestedPath
        );
      }),
    );
    if (summaries.length !== 1) {
      throw new Error(
        summaries.length
          ? `Collection scope "${intent.scope.path}" is ambiguous (${summaries.length} matches).`
          : `Collection scope "${intent.scope.path}" was not found.`,
      );
    }
  } else {
    summaries = selected
      .map((entry) => gateway.getCollectionSummary(entry.collectionId))
      .filter((entry): entry is CollectionSummary => Boolean(entry));
    if (!summaries.length) {
      throw new Error("The requested collection scope is no longer available.");
    }
  }
  const obligations: AgentActionObligation[] = [];
  for (const summary of summaries) {
    const collectionPath = summary.path || summary.name;
    if (intent.operation === "create_collection") {
      obligations.push({
        ...intent,
        id: `${intent.capability}:collection-parent:${summary.collectionId}`,
        parameters: {
          ...(intent.parameters || {}),
          parentCollectionId: summary.collectionId,
        },
        scope: undefined,
      });
      continue;
    }
    if (collectionLifecycle) {
      obligations.push({
        ...intent,
        id: `${intent.capability}:collection:${summary.collectionId}`,
        parameters: {
          ...(intent.parameters || {}),
          collectionId: summary.collectionId,
        },
        scope: {
          ...intent.scope,
          libraryID: summary.libraryID,
          collectionId: summary.collectionId,
          collectionPath,
        },
      });
      continue;
    }
    const frozenTargetIds = await listScopeTargetIds(gateway, {
      libraryID: summary.libraryID,
      collectionId: summary.collectionId,
      collectionPath,
      targetKind: intent.targetKind,
      includeDescendants: intent.scope.includeDescendants,
    });
    obligations.push({
      ...intent,
      id: `${intent.capability}:collection:${summary.collectionId}`,
      scope: {
        ...intent.scope,
        libraryID: summary.libraryID,
        collectionId: summary.collectionId,
        collectionPath,
      },
      targetBoundary: {
        kind: "collection",
        libraryID: summary.libraryID,
        frozenTargetIds,
        scopeDigest: [
          "v1",
          summary.libraryID,
          summary.collectionId,
          intent.scope.includeDescendants ? "recursive" : "direct",
          ...frozenTargetIds.slice().sort((left, right) => left - right),
        ].join(":"),
      },
    });
  }
  return obligations;
}
