import type {
  AgentActionContract,
  AgentActionObligation,
  AgentActionReceipt,
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolEffect,
} from "../types";
import {
  createdSemanticTargets,
  itemTarget,
  normalizePath,
  verifyNoteWriteTarget,
  operationItemIds,
  operationDestinationCollectionIds,
  operationTags,
  prepareActionExecution,
  targetItemId,
  targetSatisfied,
  targetSatisfiedFromResult,
  type ActionContractGateway,
  type PreparedActionExecution,
} from "./actionOperationEvidence";
import { listScopeTargetIds, resolveScope } from "./actionScope";

export type {
  ActionContractGateway,
  PreparedActionExecution,
} from "./actionOperationEvidence";
export { extractLibraryMutationOperations } from "./actionOperationEvidence";

export type ScopeValidationFailure = {
  message: string;
  expectedCount: number;
  proposedCount: number;
  rejectedTargets: string[];
  missingTargets: string[];
};

export class ActionContractService {
  constructor(private readonly gateway: ActionContractGateway) {}

  async createContract(
    request: AgentRuntimeRequest,
  ): Promise<AgentActionContract | null> {
    const intents = request.classifiedIntent?.actionIntents || [];
    if (!intents.length) return null;
    const obligations: AgentActionObligation[] = [];
    for (const intent of intents) {
      obligations.push(...(await resolveScope(this.gateway, request, intent)));
    }
    return {
      version: 1,
      state: "pending",
      obligations,
      correctionCount: 0,
    };
  }

  async prepare(
    tool: AgentToolDefinition<any, any>,
    input: unknown,
  ): Promise<PreparedActionExecution> {
    return prepareActionExecution(tool, input, this.gateway);
  }

  async validateScope(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
  ): Promise<ScopeValidationFailure | null> {
    if (!contract) return null;
    if (prepared.descriptor.kind === "execution_only") {
      const explicitlyRequested = contract.obligations.some(
        (obligation) => obligation.capability === prepared.capability,
      );
      if (!explicitlyRequested) {
        return {
          message: `Execution-only capability ${prepared.capability} is outside this action contract and cannot verify the requested Zotero state.`,
          expectedCount: contract.obligations.length,
          proposedCount: 1,
          rejectedTargets: [prepared.capability],
          missingTargets: contract.obligations.map(
            (obligation) => obligation.capability,
          ),
        };
      }
      return null;
    }
    if (prepared.descriptor.kind !== "semantic_state") return null;
    const capabilityObligations = contract.obligations.filter(
      (obligation) => obligation.capability === prepared.capability,
    );
    for (const obligation of capabilityObligations) {
      const prefix = obligation.constraints?.tagPrefix;
      if (!prefix) continue;
      const tags = prepared.operations.flatMap(operationTags);
      const rejectedTags = tags.filter((tag) => !tag.startsWith(prefix));
      if (rejectedTags.length) {
        return {
          message: `Action constraint rejected before confirmation: ${rejectedTags.length} tag(s) do not start with required prefix "${prefix}".`,
          expectedCount: tags.length,
          proposedCount: tags.length,
          rejectedTargets: rejectedTags.map((tag) => `tag:${tag}`),
          missingTargets: [],
        };
      }
    }
    const obligations = capabilityObligations.filter(
      (obligation) => obligation.scope,
    );
    if (!obligations.length) return null;
    const destinationObligations = obligations.filter(
      (obligation) => obligation.scopeRole === "destination",
    );
    if (destinationObligations.length) {
      for (const obligation of destinationObligations) {
        const current = this.gateway.getCollectionSummary(
          obligation.scope!.collectionId,
        );
        if (
          !current ||
          normalizePath(current.path || current.name) !==
            normalizePath(obligation.scope!.collectionPath)
        ) {
          return {
            message:
              "Destination collection changed after planning; refresh and retry before mutating.",
            expectedCount: 1,
            proposedCount: prepared.destinationCollectionIds.length,
            rejectedTargets: [],
            missingTargets: [`collection:${obligation.scope!.collectionId}`],
          };
        }
      }
      const expectedCollections = new Set(
        destinationObligations.map(
          (obligation) => obligation.scope!.collectionId,
        ),
      );
      const proposedCollections = new Set(prepared.destinationCollectionIds);
      const rejectedCollections = [...proposedCollections].filter(
        (collectionId) => !expectedCollections.has(collectionId),
      );
      const missingCollections = [...expectedCollections].filter(
        (collectionId) => !proposedCollections.has(collectionId),
      );
      if (rejectedCollections.length || missingCollections.length) {
        return {
          message: `Action destination rejected before confirmation: expected exact collection ID(s) ${[
            ...expectedCollections,
          ].join(", ")}, proposed ${
            [...proposedCollections].join(", ") || "none"
          }.`,
          expectedCount: expectedCollections.size,
          proposedCount: proposedCollections.size,
          rejectedTargets: rejectedCollections.map(
            (collectionId) => `collection:${collectionId}`,
          ),
          missingTargets: missingCollections.map(
            (collectionId) => `collection:${collectionId}`,
          ),
        };
      }
    }
    const moveObligations = capabilityObligations.filter(
      (obligation) => obligation.constraints?.collectionMode === "move",
    );
    if (moveObligations.length) {
      const sourceCollectionIds = new Set(
        moveObligations
          .filter((obligation) => obligation.scopeRole !== "destination")
          .map((obligation) => obligation.scope?.collectionId)
          .filter((collectionId): collectionId is number =>
            Boolean(collectionId),
          ),
      );
      const destinationCollectionIds = new Set(
        moveObligations
          .filter((obligation) => obligation.scopeRole === "destination")
          .map((obligation) => obligation.scope?.collectionId)
          .filter((collectionId): collectionId is number =>
            Boolean(collectionId),
          ),
      );
      const validMove = prepared.operations.some((operation) => {
        if (
          operation.type !== "move_to_collection" ||
          operation.mode !== "move"
        ) {
          return false;
        }
        if (
          operation.from !== "all" &&
          !sourceCollectionIds.has(Number(operation.from))
        ) {
          return false;
        }
        const proposedDestinations = new Set(
          operationDestinationCollectionIds(operation),
        );
        return (
          proposedDestinations.size > 0 &&
          [...proposedDestinations].every((collectionId) =>
            destinationCollectionIds.has(collectionId),
          )
        );
      });
      if (!validMove) {
        return {
          message:
            "True move required before confirmation: use one move_to_collection operation with mode:'move', the exact source collection ID, and the exact destination collection ID.",
          expectedCount:
            sourceCollectionIds.size + destinationCollectionIds.size,
          proposedCount: prepared.operations.length,
          rejectedTargets: prepared.requestedTargets,
          missingTargets: [
            ...[...sourceCollectionIds].map(
              (collectionId) => `source-collection:${collectionId}`,
            ),
            ...[...destinationCollectionIds].map(
              (collectionId) => `destination-collection:${collectionId}`,
            ),
          ],
        };
      }
    }
    const sourceObligations = obligations.filter(
      (obligation) => obligation.scopeRole !== "destination",
    );
    if (!sourceObligations.length || !prepared.requestedTargets.length) {
      return null;
    }
    const expectedTargets: string[] = [];
    for (const obligation of sourceObligations) {
      const scope = obligation.scope!;
      const current = await listScopeTargetIds(this.gateway, {
        libraryID: scope.libraryID,
        collectionId: scope.collectionId,
        collectionPath: scope.collectionPath,
        targetKind: obligation.targetKind,
        includeDescendants: scope.includeDescendants,
      });
      const frozen = [...scope.frozenTargetIds].sort((a, b) => a - b);
      const refreshed = [...current].sort((a, b) => a - b);
      if (JSON.stringify(frozen) !== JSON.stringify(refreshed)) {
        return {
          message: `Collection scope changed after planning; refresh and retry before mutating. Expected ${frozen.length} direct members, now found ${refreshed.length}.`,
          expectedCount: frozen.length,
          proposedCount: prepared.requestedTargets.length,
          rejectedTargets: [],
          missingTargets: frozen.map(itemTarget),
        };
      }
      expectedTargets.push(...frozen.map(itemTarget));
    }
    const expected = new Set(expectedTargets);
    const proposed = new Set(prepared.requestedTargets);
    const rejectedTargets = [...proposed].filter(
      (target) => !expected.has(target),
    );
    const requiresAll = sourceObligations.some(
      (obligation) => obligation.coverage === "all",
    );
    const missingTargets = requiresAll
      ? [...expected].filter((target) => !proposed.has(target))
      : [];
    if (!rejectedTargets.length && !missingTargets.length) return null;
    return {
      message: `Action scope rejected before confirmation: expected ${expected.size} direct member target(s), proposed ${proposed.size}.`,
      expectedCount: expected.size,
      proposedCount: proposed.size,
      rejectedTargets,
      missingTargets,
    };
  }

  finalize(
    prepared: PreparedActionExecution,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
    },
  ): AgentActionReceipt {
    const base = {
      version: 1 as const,
      descriptorKind: prepared.descriptor.kind,
      capability: prepared.capability,
      requestedTargets: prepared.requestedTargets,
      rejectedTargets: [] as string[],
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts: prepared.verifiedFacts,
    };
    if (params.cancelled) {
      return {
        ...base,
        verification: "verified",
        status: "cancelled",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (!params.ok) {
      return {
        ...base,
        verification: "unverified",
        status: "failed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (prepared.descriptor.kind === "execution_only") {
      return {
        ...base,
        verification: "execution_only",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (prepared.descriptor.kind === "artifact_state") {
      const applied =
        params.effect === "applied" ? prepared.requestedTargets : [];
      return {
        ...base,
        verification: params.effect === undefined ? "unverified" : "verified",
        status:
          params.effect === "applied"
            ? "applied"
            : params.effect === "none"
              ? "already_satisfied"
              : params.effect === "partial"
                ? "partial"
                : "unverified",
        appliedTargets: applied,
        alreadySatisfiedTargets:
          params.effect === "none" ? prepared.requestedTargets : [],
      };
    }
    if (prepared.descriptor.source === "zotero_read") {
      return {
        ...base,
        verification: "verified",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (
      prepared.descriptor.kind === "semantic_state" &&
      prepared.descriptor.action?.kind === "note_write"
    ) {
      const noteVerification = verifyNoteWriteTarget(
        prepared.descriptor,
        params.content,
        this.gateway,
      );
      if (noteVerification.targets) {
        return {
          ...base,
          verification: "verified",
          status: "applied",
          requestedTargets: noteVerification.targets,
          appliedTargets: noteVerification.targets,
          alreadySatisfiedTargets: [],
        };
      }
      return {
        ...base,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        reasons: [...base.reasons, noteVerification.reason],
      };
    }
    if (!prepared.requestedTargets.length) {
      const createdTargets = createdSemanticTargets(
        prepared.operations,
        params.content,
        this.gateway,
      );
      if (createdTargets?.length) {
        return {
          ...base,
          verification: "verified",
          status: "applied",
          requestedTargets: createdTargets,
          appliedTargets: createdTargets,
          alreadySatisfiedTargets: [],
        };
      }
    }
    const appliedTargets: string[] = [];
    const alreadySatisfiedTargets: string[] = [];
    const unverifiedTargets: string[] = [];
    for (const target of prepared.requestedTargets) {
      const itemId = targetItemId(target);
      const relevant = itemId
        ? prepared.operations.filter((operation) =>
            operationItemIds(operation).includes(itemId),
          )
        : [];
      const verified =
        itemId && relevant.length
          ? relevant.every(
              (operation) =>
                targetSatisfied(operation, itemId, this.gateway) === true ||
                targetSatisfiedFromResult(
                  operation,
                  itemId,
                  params.content,
                  this.gateway,
                ) === true,
            )
          : false;
      if (!verified) {
        unverifiedTargets.push(target);
      } else if (prepared.alreadySatisfiedTargets.includes(target)) {
        alreadySatisfiedTargets.push(target);
      } else {
        appliedTargets.push(target);
      }
    }
    const verifiedCount =
      appliedTargets.length + alreadySatisfiedTargets.length;
    const verification = unverifiedTargets.length ? "unverified" : "verified";
    const status =
      verifiedCount === prepared.requestedTargets.length && verifiedCount > 0
        ? appliedTargets.length
          ? "applied"
          : "already_satisfied"
        : verifiedCount > 0
          ? "partial"
          : "unverified";
    return {
      ...base,
      verification,
      status,
      appliedTargets,
      alreadySatisfiedTargets,
      rejectedTargets: unverifiedTargets,
      reasons: [
        ...base.reasons,
        ...(unverifiedTargets.length
          ? [
              `Postcondition could not be verified for ${unverifiedTargets.join(", ")}.`,
            ]
          : []),
      ],
    };
  }

  rejectionReceipt(
    prepared: PreparedActionExecution,
    failure: ScopeValidationFailure,
  ): AgentActionReceipt {
    return {
      version: 1,
      descriptorKind: prepared.descriptor.kind,
      capability: prepared.capability,
      verification: "verified",
      status: "failed",
      requestedTargets: prepared.requestedTargets,
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: failure.rejectedTargets,
      reasons: [failure.message],
      verifiedFacts: prepared.verifiedFacts,
    };
  }
}
