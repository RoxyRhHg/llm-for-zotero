import type {
  AgentActionCapability,
  AgentActionContract,
  AgentActionObligation,
  AgentActionReceipt,
  AgentToolEffect,
} from "../types";

export type ContractEvaluation = {
  state: AgentActionContract["state"];
  correction?: string;
  failure?: string;
};

const ACTION_CORRECTION_GUIDANCE: Partial<
  Record<AgentActionCapability, string>
> = {
  "zotero.tags":
    "Use library_search when target IDs are unknown, then library_update with the required tag operation.",
  "zotero.metadata":
    "Use library_search when target IDs are unknown, then library_update with the required metadata operation.",
  "zotero.collections":
    "Use library_search when item or collection IDs are unknown, then library_update with the required add, remove, or move collection operation.",
  "zotero.notes": "Use note_write or note_write_batch for the required notes.",
  "zotero.import": "Use library_import for the required imports.",
  "zotero.trash":
    "Use library_update with the required trash or restore operation.",
  "zotero.attachments":
    "Use the matching attachment tool for the required attachment change.",
  "zotero.read": "Use paper_read with the required read mode.",
  "file.write": "Use file_io for the required artifact change.",
  "command.execute": "Use run_command for the requested execution.",
  "zotero.script": "Use zotero_script for the requested execution.",
};

export function actionToolGuidanceForCapabilities(
  capabilities: Iterable<AgentActionCapability>,
): string {
  return [
    ...new Set(
      [...capabilities]
        .map((capability) => ACTION_CORRECTION_GUIDANCE[capability])
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ].join(" ");
}

function itemTarget(itemId: number): string {
  return `item:${itemId}`;
}

export function createUnverifiedReceipt(params: {
  capability?: AgentActionCapability;
  descriptorKind?: AgentActionReceipt["descriptorKind"];
  status?: AgentActionReceipt["status"];
  reason: string;
}): AgentActionReceipt {
  return {
    version: 1,
    descriptorKind: params.descriptorKind || "semantic_state",
    capability: params.capability || "zotero.read",
    verification: params.status === "cancelled" ? "verified" : "unverified",
    status: params.status || "failed",
    requestedTargets: [],
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [params.reason],
    verifiedFacts: [],
  };
}

export function createFallbackToolReceipt(params: {
  toolName: string;
  mutability: "read" | "write";
  input: unknown;
  ok: boolean;
  effect?: AgentToolEffect;
  cancelled?: boolean;
  reason?: string;
}): AgentActionReceipt {
  if (params.cancelled) {
    return createUnverifiedReceipt({
      status: "cancelled",
      reason: params.reason || "User cancelled the action.",
    });
  }
  if (params.toolName === "file_io" && params.ok) {
    const status =
      params.effect === "applied"
        ? "applied"
        : params.effect === "none"
          ? "already_satisfied"
          : params.effect === "partial"
            ? "partial"
            : "unverified";
    return {
      version: 1,
      descriptorKind: "artifact_state",
      capability: "file.write",
      verification: params.effect === undefined ? "unverified" : "verified",
      status,
      requestedTargets: [],
      appliedTargets: params.effect === "applied" ? ["file"] : [],
      alreadySatisfiedTargets: params.effect === "none" ? ["file"] : [],
      rejectedTargets: [],
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts: [],
    };
  }
  if (
    (params.toolName === "run_command" ||
      params.toolName === "zotero_script") &&
    params.ok
  ) {
    return {
      version: 1,
      descriptorKind: "execution_only",
      capability:
        params.toolName === "run_command" ? "command.execute" : "zotero.script",
      verification: "execution_only",
      status: "observed",
      requestedTargets: [],
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts: [],
    };
  }
  if (params.mutability === "read" && params.ok) {
    const fullRead =
      params.input &&
      typeof params.input === "object" &&
      (params.input as { mode?: unknown }).mode === "full";
    return {
      version: 1,
      descriptorKind: "semantic_state",
      capability: "zotero.read",
      verification: "verified",
      status: "observed",
      requestedTargets: [],
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts: fullRead ? ["read_mode:full"] : [],
    };
  }
  return createUnverifiedReceipt({
    descriptorKind:
      params.toolName === "file_io"
        ? "artifact_state"
        : params.toolName === "run_command" ||
            params.toolName === "zotero_script"
          ? "execution_only"
          : "semantic_state",
    capability:
      params.toolName === "file_io"
        ? "file.write"
        : params.toolName === "run_command"
          ? "command.execute"
          : params.toolName === "zotero_script"
            ? "zotero.script"
            : "zotero.read",
    status: params.ok ? "unverified" : "failed",
    reason:
      params.reason || "No action verifier is configured for this caller.",
  });
}

export function evaluateActionContract(
  contract: AgentActionContract,
  receipts: AgentActionReceipt[],
): ContractEvaluation {
  if (!contract.obligations.length) return { state: "satisfied" };
  const missing: AgentActionObligation[] = [];
  let sawPartial = false;
  let sawCancelled = false;
  let sawUnverified = false;
  for (const obligation of contract.obligations) {
    const matching = receipts.filter(
      (receipt) => receipt.capability === obligation.capability,
    );
    const verified = matching.filter(
      (receipt) =>
        receipt.verification === "verified" &&
        (!obligation.constraints?.readMode ||
          receipt.verifiedFacts.includes(
            `read_mode:${obligation.constraints.readMode}`,
          )) &&
        (receipt.status === "applied" ||
          receipt.status === "already_satisfied" ||
          receipt.status === "observed"),
    );
    const cancelled = matching.some(
      (receipt) => receipt.status === "cancelled",
    );
    if (
      obligation.scope &&
      obligation.scopeRole !== "destination" &&
      obligation.coverage === "all"
    ) {
      const covered = new Set(
        verified.flatMap((receipt) => [
          ...receipt.appliedTargets,
          ...receipt.alreadySatisfiedTargets,
        ]),
      );
      if (
        !obligation.scope.frozenTargetIds.every((itemId) =>
          covered.has(itemTarget(itemId)),
        )
      ) {
        missing.push(obligation);
      }
    } else if (!verified.length) {
      missing.push(obligation);
    }
    sawCancelled ||= cancelled && verified.length === 0;
    sawPartial ||= matching.some((receipt) => receipt.status === "partial");
    sawUnverified ||= matching.some(
      (receipt) => receipt.verification !== "verified",
    );
  }
  if (!missing.length) {
    if (sawCancelled) return { state: "cancelled" };
    return { state: "satisfied" };
  }
  if (sawCancelled) return { state: "cancelled" };
  const labels = missing.map((entry) => {
    const scope = entry.scope
      ? ` in exact collection "${entry.scope.collectionPath}" (${entry.scope.frozenTargetIds.length} direct members)`
      : "";
    return `${entry.capability} coverage:${entry.coverage}${scope}`;
  });
  const failureReasons = [
    ...new Set(
      missing.flatMap((obligation) =>
        receipts
          .filter((receipt) => receipt.capability === obligation.capability)
          .flatMap((receipt) => receipt.reasons),
      ),
    ),
  ];
  const failureDetail = failureReasons.length
    ? ` Verification detail: ${failureReasons.join("; ")}`
    : "";
  const state = sawPartial
    ? "partial"
    : sawUnverified
      ? "unverified"
      : "pending";
  const correctionGuidance = actionToolGuidanceForCapabilities(
    missing.map((entry) => entry.capability),
  );
  return {
    state,
    correction:
      `Correction for this turn: the requested action contract is not satisfied: ${labels.join("; ")}. ` +
      `${correctionGuidance} Call the matching tool now with only the exact scoped targets. ` +
      "Completion requires a verified receipt; model prose, command exit success, and opaque script output are not proof of Zotero state.",
    failure: `I could not verify completion of the requested action. Missing obligation(s): ${labels.join("; ")}.${failureDetail}`,
  };
}

export function formatReceiptStatus(receipts: AgentActionReceipt[]): string {
  if (!receipts.length) return "";
  return receipts
    .map((receipt) => {
      const verified =
        receipt.appliedTargets.length + receipt.alreadySatisfiedTargets.length;
      const requested = receipt.requestedTargets.length;
      const coverage = requested ? ` ${verified}/${requested}` : "";
      return `[Action status: ${receipt.capability} — ${receipt.status}${coverage}; ${receipt.verification}]`;
    })
    .join("\n");
}
