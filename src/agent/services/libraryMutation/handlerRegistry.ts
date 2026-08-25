import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "./contracts";
import type { AgentToolContext } from "../../types";
import type { ZoteroGateway } from "../zoteroGateway";
import { forwardExecutors, type ForwardExecution } from "./forwardExecutors";
import { canonicalJsonEqual } from "./canonicalJson";
import { asMutationStateView, MutationStateView } from "./stateView";

export type LibraryMutationOperationType = LibraryMutationOperation["type"];
export type LibraryMutationOperationOf<
  Type extends LibraryMutationOperationType,
> = Extract<LibraryMutationOperation, { type: Type }>;

export type LibraryMutationHandler<Type extends LibraryMutationOperationType> =
  Readonly<{
    type: Type;
    validate: (value: unknown) => value is LibraryMutationOperationOf<Type>;
    targetCount: (operation: LibraryMutationOperationOf<Type>) => number;
    affectedCount: (
      operation: LibraryMutationOperationOf<Type>,
      result: unknown,
    ) => number;
    atomize: (
      operation: LibraryMutationOperationOf<Type>,
    ) => LibraryMutationOperation[];
    stateSections: readonly (
      | "items"
      | "collections"
      | "savedSearches"
      | "libraryTags"
      | "relations"
    )[];
    deferredInverse: (operation: LibraryMutationOperationOf<Type>) => boolean;
    planInverse: (
      operation: LibraryMutationOperationOf<Type>,
      state: MutationStateView,
    ) => Readonly<{
      inverseOperations?: LibraryMutationOperation[];
      reason?: string;
    }>;
    inverseSatisfied: (
      operation: LibraryMutationOperationOf<Type>,
      state: MutationStateView,
    ) => boolean;
    execute: (
      operation: LibraryMutationOperationOf<Type>,
      context: AgentToolContext,
      gateway: ZoteroGateway,
    ) => Promise<ForwardExecution>;
    replay: "state-aware" | "forward-only";
    executionDomain:
      | "item-metadata-tags-relations"
      | "collection-search-structure"
      | "notes-lifecycle"
      | "attachments-imports";
  }>;

export type LibraryMutationHandlerRegistry = {
  [Type in LibraryMutationOperationType]: LibraryMutationHandler<Type>;
};

type HandlerOptions<Type extends LibraryMutationOperationType> = Partial<
  Pick<
    LibraryMutationHandler<Type>,
    | "targetCount"
    | "affectedCount"
    | "atomize"
    | "stateSections"
    | "deferredInverse"
    | "planInverse"
    | "inverseSatisfied"
    | "execute"
    | "replay"
    | "executionDomain"
  >
>;

const resultCount = (result: unknown, key: string): number => {
  const value = (result || {}) as Record<string, unknown>;
  return Math.max(0, Math.floor(Number(value[key]) || 0));
};

const resultStatus = (result: unknown, status: string): number =>
  (result as { status?: unknown } | null)?.status === status ? 1 : 0;

function onePer<Operation extends LibraryMutationOperation, Value>(
  operation: Operation,
  values: readonly Value[] | undefined,
  build: (value: Value) => Operation,
): LibraryMutationOperation[] {
  return values && values.length > 1 ? values.map(build) : [operation];
}

function defineHandler<Type extends LibraryMutationOperationType>(
  type: Type,
  options: HandlerOptions<Type> = {},
): LibraryMutationHandler<Type> {
  return Object.freeze({
    type,
    validate: (value: unknown): value is LibraryMutationOperationOf<Type> =>
      Boolean(
        value &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === type,
      ),
    targetCount: options.targetCount || (() => 1),
    affectedCount: options.affectedCount || (() => 1),
    atomize: options.atomize || ((operation) => [operation]),
    stateSections: options.stateSections || [],
    deferredInverse: options.deferredInverse || (() => false),
    planInverse: options.planInverse || (() => ({})),
    inverseSatisfied: options.inverseSatisfied || (() => false),
    execute:
      options.execute ||
      ((operation, context, gateway) =>
        forwardExecutors[type](operation as never, context, gateway)),
    replay: options.replay || "forward-only",
    executionDomain: options.executionDomain || "item-metadata-tags-relations",
  });
}

const restoreTagState = (state: MutationStateView) => ({
  inverseOperations: [
    {
      type: "set_item_tags" as const,
      assignments: (state.items || [])
        .filter((item) => item.exists)
        .map((item) => ({ itemId: item.itemId, tags: item.tags || [] })),
    },
  ],
});

const restoreCollectionState = (state: MutationStateView) => ({
  inverseOperations: [
    {
      type: "set_item_collections" as const,
      assignments: (state.items || [])
        .filter((item) => item.exists)
        .map((item) => ({
          itemId: item.itemId,
          collectionIds: item.collectionIds || [],
        })),
    },
  ],
});

const sameMembers = <T>(left: readonly T[], right: readonly T[]) => {
  const normalize = (values: readonly T[]) =>
    [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

export const libraryMutationHandlers = {
  update_metadata: defineHandler("update_metadata", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => {
      const item = state.items?.[0];
      return item?.exists && item.fields
        ? {
            inverseOperations: [
              {
                type: "update_metadata",
                itemId: item.itemId,
                metadata: {
                  ...item.fields,
                  ...(item.creators ? { creators: item.creators } : {}),
                },
              },
            ],
          }
        : {};
    },
    inverseSatisfied: (operation, state) => {
      const current = state.item(Number(operation.itemId));
      if (!current?.exists || !current.fields) return false;
      return Object.entries(operation.metadata).every(([field, value]) =>
        field === "creators"
          ? canonicalJsonEqual(current.creators, value)
          : current.fields?.[field] === value,
      );
    },
  }),
  apply_tags: defineHandler("apply_tags", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreTagState(state),
    inverseSatisfied: (operation, state) => {
      const assignments = operation.assignments?.length
        ? operation.assignments
        : (operation.itemIds || []).map((itemId) => ({
            itemId,
            tags: operation.tags || [],
          }));
      return assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        const tags = new Set(current?.tags || []);
        return Boolean(
          current?.exists && assignment.tags.every((tag) => tags.has(tag)),
        );
      });
    },
    targetCount: (operation) =>
      new Set(
        operation.assignments?.length
          ? operation.assignments.map((assignment) => assignment.itemId)
          : operation.itemIds || [],
      ).size,
    affectedCount: (_operation, result) => resultCount(result, "updatedCount"),
    atomize: (operation) =>
      operation.assignments?.length
        ? onePer(operation, operation.assignments, (assignment) => ({
            ...operation,
            assignments: [assignment],
          }))
        : onePer(operation, operation.itemIds, (itemId) => ({
            ...operation,
            itemIds: [itemId],
          })),
  }),
  remove_tags: defineHandler("remove_tags", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreTagState(state),
    inverseSatisfied: (operation, state) =>
      operation.itemIds.every((itemId) => {
        const current = state.item(itemId);
        const tags = new Set(current?.tags || []);
        return Boolean(
          current?.exists && operation.tags.every((tag) => !tags.has(tag)),
        );
      }),
    targetCount: (operation) => operation.itemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "removedCount"),
    atomize: (operation) =>
      onePer(operation, operation.itemIds, (itemId) => ({
        ...operation,
        itemIds: [itemId],
      })),
  }),
  move_to_collection: defineHandler("move_to_collection", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreCollectionState(state),
    targetCount: (operation) =>
      new Set(
        operation.assignments?.length
          ? operation.assignments.map((assignment) => assignment.itemId)
          : operation.itemIds || [],
      ).size,
    affectedCount: (_operation, result) => resultCount(result, "movedCount"),
    atomize: (operation) =>
      operation.assignments?.length
        ? onePer(operation, operation.assignments, (assignment) => ({
            ...operation,
            assignments: [assignment],
          }))
        : onePer(operation, operation.itemIds, (itemId) => ({
            ...operation,
            itemIds: [itemId],
          })),
  }),
  remove_from_collection: defineHandler("remove_from_collection", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreCollectionState(state),
    inverseSatisfied: (operation, state) =>
      operation.itemIds.every((itemId) => {
        const current = state.item(itemId);
        return Boolean(
          current?.exists &&
          current.collectionIds &&
          !current.collectionIds.includes(operation.collectionId),
        );
      }),
    targetCount: (operation) => operation.itemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "removedCount"),
    atomize: (operation) =>
      onePer(operation, operation.itemIds, (itemId) => ({
        ...operation,
        itemIds: [itemId],
      })),
  }),
  create_collection: defineHandler("create_collection", {
    deferredInverse: () => true,
    executionDomain: "collection-search-structure",
  }),
  set_item_collections: defineHandler("set_item_collections", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreCollectionState(state),
    inverseSatisfied: (operation, state) =>
      operation.assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        return Boolean(
          current?.exists &&
          current.collectionIds &&
          sameMembers(current.collectionIds, assignment.collectionIds),
        );
      }),
    targetCount: (operation) => operation.assignments.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.assignments, (assignment) => ({
        ...operation,
        assignments: [assignment],
      })),
  }),
  save_notes_batch: defineHandler("save_notes_batch", {
    deferredInverse: () => true,
    executionDomain: "notes-lifecycle",
    targetCount: (operation) => operation.notes.length,
    affectedCount: (_operation, result) => resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.notes, (note) => ({
        ...operation,
        notes: [note],
      })),
  }),
  save_saved_search: defineHandler("save_saved_search", {
    stateSections: ["savedSearches"],
    deferredInverse: (operation) => !operation.savedSearchId,
    executionDomain: "collection-search-structure",
    planInverse: (operation) => ({
      reason: operation.savedSearchId
        ? "Replacing a saved search requires its complete prior conditions."
        : "The new saved-search ID is assigned only after commit.",
    }),
  }),
  delete_saved_search: defineHandler("delete_saved_search", {
    stateSections: ["savedSearches"],
    replay: "state-aware",
    executionDomain: "collection-search-structure",
    planInverse: (operation) =>
      operation.permanent
        ? { reason: "A permanently erased saved search cannot be restored." }
        : {
            inverseOperations: [
              {
                type: "restore_from_trash",
                savedSearchIds: [operation.savedSearchId],
              },
            ],
          },
    inverseSatisfied: (operation, state) => {
      const current = state.savedSearch(operation.savedSearchId);
      return operation.permanent
        ? current?.exists === false
        : Boolean(current?.exists && current.deleted === true);
    },
    affectedCount: (_operation, result) =>
      (result as { status?: unknown } | null)?.status === "not_found" ? 0 : 1,
  }),
  update_collection: defineHandler("update_collection", {
    stateSections: ["collections"],
    replay: "state-aware",
    executionDomain: "collection-search-structure",
    planInverse: (_operation, state) => {
      const collection = state.collections?.[0];
      return collection?.exists
        ? {
            inverseOperations: [
              {
                type: "update_collection",
                collectionId: collection.collectionId,
                name: collection.name,
                parentCollectionId: collection.parentCollectionId,
              },
            ],
          }
        : {};
    },
    inverseSatisfied: (operation, state) => {
      const current = state.collection(operation.collectionId);
      return Boolean(
        current?.exists &&
        (operation.name === undefined || current.name === operation.name) &&
        (operation.parentCollectionId === undefined ||
          (current.parentCollectionId ?? null) ===
            operation.parentCollectionId),
      );
    },
    affectedCount: (_operation, result) => resultStatus(result, "updated"),
  }),
  update_library_tag: defineHandler("update_library_tag", {
    stateSections: ["libraryTags"],
    planInverse: (operation, state) => {
      if (operation.action !== "rename" || !operation.newTag) {
        return {
          reason: `Library tag action ${operation.action} does not preserve enough information for a lossless inverse.`,
        };
      }
      const source = state.libraryTags?.find(
        (entry) => entry.name === operation.tag.trim(),
      );
      const destination = state.libraryTags?.find(
        (entry) => entry.name === operation.newTag?.trim(),
      );
      if (
        source?.observable !== true ||
        !source.exists ||
        destination?.observable !== true ||
        destination.exists
      ) {
        return {
          reason: destination?.exists
            ? "The destination tag already exists, so Zotero will merge memberships and cannot later separate them losslessly."
            : "The source and destination tag memberships could not be verified before the rename.",
        };
      }
      return {
        inverseOperations: [
          { ...operation, tag: operation.newTag, newTag: operation.tag },
        ],
      };
    },
    affectedCount: (_operation, result) => resultStatus(result, "applied"),
  }),
  set_item_tags: defineHandler("set_item_tags", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => restoreTagState(state),
    inverseSatisfied: (operation, state) =>
      operation.assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        return Boolean(
          current?.exists &&
          current.tags &&
          sameMembers(current.tags, assignment.tags),
        );
      }),
    targetCount: (operation) => operation.assignments.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.assignments, (assignment) => ({
        ...operation,
        assignments: [assignment],
      })),
  }),
  create_items: defineHandler("create_items", {
    deferredInverse: () => true,
    targetCount: (operation) => operation.items.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.items, (item) => ({
        ...operation,
        items: [item],
      })),
  }),
  reparent_items: defineHandler("reparent_items", {
    stateSections: ["items"],
    replay: "state-aware",
    planInverse: (_operation, state) => ({
      inverseOperations: [
        {
          type: "reparent_items",
          assignments: (state.items || [])
            .filter((item) => item.exists)
            .map((item) => ({
              itemId: item.itemId,
              parentItemId: item.parentItemId ?? null,
            })),
        },
      ],
    }),
    inverseSatisfied: (operation, state) =>
      operation.assignments.every((assignment) => {
        const current = state.item(assignment.itemId);
        return Boolean(
          current?.exists &&
          (current.parentItemId ?? null) === assignment.parentItemId,
        );
      }),
    targetCount: (operation) => operation.assignments.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.assignments, (assignment) => ({
        ...operation,
        assignments: [assignment],
      })),
  }),
  relate_items: defineHandler("relate_items", {
    stateSections: ["relations"],
    replay: "state-aware",
    planInverse: (operation) => ({
      inverseOperations: [
        { ...operation, action: operation.action === "add" ? "remove" : "add" },
      ],
    }),
    inverseSatisfied: (operation, state) =>
      (state.relations || []).every((relation) =>
        operation.action === "add"
          ? relation.related && relation.reciprocal
          : !relation.related && !relation.reciprocal,
      ),
    targetCount: (operation) => operation.relatedItemIds.length,
    affectedCount: (_operation, result) =>
      resultCount(result, "changedCount") ||
      resultCount(result, "createdCount"),
    atomize: (operation) =>
      onePer(operation, operation.relatedItemIds, (relatedItemId) => ({
        ...operation,
        relatedItemIds: [relatedItemId],
      })),
  }),
  delete_collection: defineHandler("delete_collection", {
    stateSections: ["collections"],
    replay: "state-aware",
    executionDomain: "collection-search-structure",
    planInverse: (operation) =>
      operation.permanent
        ? { reason: "A permanently erased collection cannot be restored." }
        : {
            inverseOperations: [
              {
                type: "restore_from_trash",
                collectionIds: [operation.collectionId],
              },
            ],
          },
    inverseSatisfied: (operation, state) => {
      const current = state.collection(operation.collectionId);
      return operation.permanent
        ? current?.exists === false
        : Boolean(current?.exists && current.deleted === true);
    },
  }),
  save_note: defineHandler("save_note", {
    deferredInverse: () => true,
    executionDomain: "notes-lifecycle",
  }),
  import_identifiers: defineHandler("import_identifiers", {
    deferredInverse: () => true,
    executionDomain: "attachments-imports",
    targetCount: (operation) => operation.identifiers.length,
    affectedCount: (_operation, result) => resultCount(result, "succeeded"),
    atomize: (operation) =>
      onePer(operation, operation.identifiers, (identifier) => ({
        ...operation,
        identifiers: [identifier],
      })),
  }),
  trash_items: defineHandler("trash_items", {
    stateSections: ["items"],
    replay: "state-aware",
    executionDomain: "notes-lifecycle",
    planInverse: (_operation, state) => ({
      inverseOperations: [
        {
          type: "restore_from_trash",
          itemIds: (state.items || [])
            .filter((item) => item.exists && !item.deleted)
            .map((item) => item.itemId),
        },
      ],
    }),
    inverseSatisfied: (operation, state) =>
      operation.itemIds.every((itemId) => {
        const current = state.item(itemId);
        return Boolean(current?.exists && current.deleted === true);
      }),
    targetCount: (operation) => operation.itemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "trashedCount"),
    atomize: (operation) =>
      onePer(operation, operation.itemIds, (itemId) => ({
        ...operation,
        itemIds: [itemId],
      })),
  }),
  restore_from_trash: defineHandler("restore_from_trash", {
    stateSections: ["items", "collections", "savedSearches"],
    replay: "state-aware",
    executionDomain: "notes-lifecycle",
    planInverse: (operation) => ({
      inverseOperations: operation.itemIds?.length
        ? [{ type: "trash_items", itemIds: operation.itemIds }]
        : undefined,
      ...(operation.collectionIds?.length || operation.savedSearchIds?.length
        ? {
            reason:
              "The item portion is reversible, but collection/saved-search restore is finalized from Zotero's actual result.",
          }
        : {}),
    }),
    inverseSatisfied: (operation, state) =>
      (operation.itemIds || []).every((itemId) => {
        const current = state.item(itemId);
        return Boolean(current?.exists && current.deleted === false);
      }) &&
      (operation.collectionIds || []).every((collectionId) => {
        const current = state.collection(collectionId);
        return Boolean(current?.exists && current.deleted === false);
      }) &&
      (operation.savedSearchIds || []).every((savedSearchId) => {
        const current = state.savedSearch(savedSearchId);
        return Boolean(current?.exists && current.deleted === false);
      }),
    targetCount: (operation) =>
      (operation.itemIds?.length || 0) +
      (operation.collectionIds?.length || 0) +
      (operation.savedSearchIds?.length || 0),
    affectedCount: (_operation, result) => resultCount(result, "restoredCount"),
    atomize: (operation) => {
      const units: LibraryMutationOperation[] = [
        ...(operation.itemIds || []).map((itemId) => ({
          ...operation,
          itemIds: [itemId],
          collectionIds: undefined,
          savedSearchIds: undefined,
        })),
        ...(operation.collectionIds || []).map((collectionId) => ({
          ...operation,
          itemIds: undefined,
          collectionIds: [collectionId],
          savedSearchIds: undefined,
        })),
        ...(operation.savedSearchIds || []).map((savedSearchId) => ({
          ...operation,
          itemIds: undefined,
          collectionIds: undefined,
          savedSearchIds: [savedSearchId],
        })),
      ];
      return units.length > 1 ? units : [operation];
    },
  }),
  merge_items: defineHandler("merge_items", {
    executionDomain: "notes-lifecycle",
    planInverse: () => ({
      reason:
        "Merging can move and deduplicate child objects, so it has no lossless inverse.",
    }),
    targetCount: (operation) => operation.otherItemIds.length,
    affectedCount: (_operation, result) => resultCount(result, "mergedCount"),
  }),
  delete_attachment: defineHandler("delete_attachment", {
    stateSections: ["items"],
    executionDomain: "attachments-imports",
    planInverse: (operation) => ({
      inverseOperations: [
        { type: "restore_from_trash", itemIds: [operation.attachmentId] },
      ],
    }),
    affectedCount: (_operation, result) => resultStatus(result, "deleted"),
  }),
  rename_attachment: defineHandler("rename_attachment", {
    stateSections: ["items"],
    replay: "state-aware",
    executionDomain: "attachments-imports",
    planInverse: (operation, state) => {
      const previous = state.items?.[0]?.attachmentTitle;
      return previous
        ? {
            inverseOperations: [
              {
                type: "rename_attachment",
                attachmentId: operation.attachmentId,
                newName: previous,
              },
            ],
          }
        : {};
    },
    inverseSatisfied: (operation, state) => {
      const current = state.item(operation.attachmentId);
      return Boolean(
        current?.exists && current.attachmentTitle === operation.newName,
      );
    },
    affectedCount: (_operation, result) => resultStatus(result, "renamed"),
  }),
  relink_attachment: defineHandler("relink_attachment", {
    stateSections: ["items"],
    replay: "state-aware",
    executionDomain: "attachments-imports",
    planInverse: (operation, state) => {
      const previous = state.items?.[0]?.attachmentPath;
      return previous
        ? {
            inverseOperations: [
              {
                type: "relink_attachment",
                attachmentId: operation.attachmentId,
                newPath: previous,
              },
            ],
          }
        : { reason: "The attachment had no resolvable previous path." };
    },
    inverseSatisfied: (operation, state) => {
      const current = state.item(operation.attachmentId);
      return Boolean(
        current?.exists && current.attachmentPath === operation.newPath,
      );
    },
    affectedCount: (_operation, result) => resultStatus(result, "relinked"),
  }),
  import_local_files: defineHandler("import_local_files", {
    deferredInverse: () => true,
    executionDomain: "attachments-imports",
    targetCount: (operation) => operation.filePaths.length,
    affectedCount: (_operation, result) => resultCount(result, "succeeded"),
    atomize: (operation) =>
      onePer(operation, operation.filePaths, (filePath) => ({
        ...operation,
        filePaths: [filePath],
      })),
  }),
} satisfies LibraryMutationHandlerRegistry;

export function getLibraryMutationHandler<
  Type extends LibraryMutationOperationType,
>(operation: LibraryMutationOperationOf<Type>): LibraryMutationHandler<Type> {
  return libraryMutationHandlers[
    operation.type
  ] as unknown as LibraryMutationHandler<Type>;
}

export function mutationTargetCountFromHandler(
  operation: LibraryMutationOperation,
): number {
  return libraryMutationHandlers[operation.type].targetCount(
    operation as never,
  );
}

export function mutationAffectedCountFromHandler(
  operation: LibraryMutationOperation,
  result: unknown,
): number {
  return libraryMutationHandlers[operation.type].affectedCount(
    operation as never,
    result,
  );
}

export function atomizeMutationOperationFromHandler(
  operation: LibraryMutationOperation,
): LibraryMutationOperation[] {
  return libraryMutationHandlers[operation.type].atomize(operation as never);
}

export function mutationUsesDeferredInverse(
  operation: LibraryMutationOperation,
): boolean {
  return libraryMutationHandlers[operation.type].deferredInverse(
    operation as never,
  );
}

export function planMutationInverseFromHandler(
  operation: LibraryMutationOperation,
  state: LibraryMutationState | MutationStateView,
): Readonly<{
  inverseOperations?: LibraryMutationOperation[];
  reason?: string;
}> {
  return libraryMutationHandlers[operation.type].planInverse(
    operation as never,
    asMutationStateView(state),
  );
}

export function mutationInverseIsSatisfied(
  operation: LibraryMutationOperation,
  state: LibraryMutationState | MutationStateView,
): boolean {
  return libraryMutationHandlers[operation.type].inverseSatisfied(
    operation as never,
    asMutationStateView(state),
  );
}

export function executeMutationFromHandler(
  operation: LibraryMutationOperation,
  context: AgentToolContext,
  gateway: ZoteroGateway,
): Promise<ForwardExecution> {
  return libraryMutationHandlers[operation.type].execute(
    operation as never,
    context,
    gateway,
  );
}

export function isRegisteredLibraryMutationOperation(
  value: unknown,
): value is LibraryMutationOperation {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  if (
    typeof type !== "string" ||
    !Object.prototype.hasOwnProperty.call(libraryMutationHandlers, type)
  )
    return false;
  return libraryMutationHandlers[type as LibraryMutationOperationType].validate(
    value,
  );
}
