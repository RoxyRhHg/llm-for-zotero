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

export async function resolveScope(
  gateway: ActionContractGateway,
  request: AgentRuntimeRequest,
  intent: AgentActionIntent,
): Promise<AgentActionObligation[]> {
  if (!intent.scope) {
    const { scope: _scope, ...unscoped } = intent;
    return [{ ...unscoped, id: `${intent.capability}:unscoped` }];
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
        frozenTargetIds,
      },
    });
  }
  return obligations;
}
