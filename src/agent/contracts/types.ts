export type AgentActionCapability =
  | "zotero.read"
  | "zotero.tags"
  | "zotero.metadata"
  | "zotero.collections"
  | "zotero.notes"
  | "zotero.import"
  | "zotero.trash"
  | "zotero.attachments"
  | "zotero.annotations"
  | "file.write"
  | "command.execute"
  | "zotero.script";

export type AgentActionIntent = {
  capability: AgentActionCapability;
  coverage: "one" | "some" | "all";
  targetKind: "papers" | "items";
  scope?: {
    kind: "collection";
    path?: string;
    includeDescendants: boolean;
  };
  scopeRole?: "source" | "destination";
  constraints?: {
    tagPrefix?: string;
    readMode?: "full";
    collectionMode?: "move";
  };
};

export type AgentActionObligation = AgentActionIntent & {
  id: string;
  scope?: AgentActionIntent["scope"] & {
    libraryID: number;
    collectionId: number;
    collectionPath: string;
    frozenTargetIds: number[];
  };
};

export type AgentActionContract = {
  version: 1;
  state:
    | "pending"
    | "satisfied"
    | "partial"
    | "cancelled"
    | "failed"
    | "unverified";
  obligations: AgentActionObligation[];
  correctionCount: number;
};

export type AgentActionReceipt = {
  version: 1;
  descriptorKind: "semantic_state" | "artifact_state" | "execution_only";
  capability: AgentActionCapability;
  verification: "verified" | "execution_only" | "unverified";
  status:
    | "applied"
    | "already_satisfied"
    | "partial"
    | "cancelled"
    | "failed"
    | "observed"
    | "unverified";
  requestedTargets: string[];
  appliedTargets: string[];
  alreadySatisfiedTargets: string[];
  rejectedTargets: string[];
  reasons: string[];
  verifiedFacts: string[];
};

export type AgentToolActionDescriptor =
  | {
      kind: "semantic_state";
      capability: AgentActionCapability;
      source: "library_mutation" | "zotero_read";
      action?: {
        kind: "note_write";
        mode: "create" | "edit" | "append";
        targetItemId?: number;
        targetNoteId?: number;
        destinationCollectionIds: number[];
        expectedText?: string;
      };
    }
  | {
      kind: "artifact_state";
      capability: "file.write";
    }
  | {
      kind: "execution_only";
      capability: "command.execute" | "zotero.script";
    };
