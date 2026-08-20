import type { GeneratedChatImage, PaperContextRef } from "../../shared/types";
import type { AgentToolContext } from "../types";
import type {
  BatchMoveAssignment,
  BatchTagAssignment,
  CollectionSummary,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
  ZoteroGateway,
} from "./zoteroGateway";

export type NoteSaveTarget = "item" | "standalone";

export type UpdateMetadataOperation = {
  id?: string;
  type: "update_metadata";
  itemId?: number;
  paperContext?: PaperContextRef;
  metadata: EditableArticleMetadataPatch;
};

export type ApplyTagsOperation = {
  id?: string;
  type: "apply_tags";
  assignments?: BatchTagAssignment[];
  itemIds?: number[];
  tags?: string[];
};

export type RemoveTagsOperation = {
  id?: string;
  type: "remove_tags";
  itemIds: number[];
  tags: string[];
};

export type MoveToCollectionAssignment = {
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
};

export type MoveToCollectionOperation = {
  id?: string;
  type: "move_to_collection";
  assignments?: MoveToCollectionAssignment[];
  itemIds?: number[];
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
  /**
   * `"add"` (the default) files the item and leaves its other collections
   * alone. `"move"` takes it out of `from` as well — until this existed, the
   * tool said "moved" while only ever adding.
   */
  mode?: "add" | "move";
  /** Required for a move: the collection to leave, or `"all"`. */
  from?: number | "all";
};

/**
 * Restores exact collection membership.
 *
 * A move's only correct inverse is the set the item had beforehand.
 * `remove_from_collection` cannot express it: undoing a move with a removal
 * would unfile the item from the destination and never put back the
 * collections the move took it out of.
 */
/**
 * Writes a note onto each of many items in one approved operation.
 *
 * `save_note` takes a single `targetItemId`, so "write a summary note on each
 * of my 50 most recent papers" was 50 tool calls and — because every
 * `note_write mode:'create'` returns its own review card — 50 human
 * approvals. That, not the round budget, is what made the request
 * impractical.
 */
export type SaveSavedSearchOperation = {
  id?: string;
  type: "save_saved_search";
  name: string;
  conditions: Array<{
    condition: string;
    operator: string;
    value?: string | number;
    mode?: string;
    required?: boolean;
  }>;
  joinMode?: "all" | "any";
  savedSearchId?: number;
  libraryID?: number;
};

export type DeleteSavedSearchOperation = {
  id?: string;
  type: "delete_saved_search";
  savedSearchId: number;
  permanent?: boolean;
};

export type UpdateCollectionOperation = {
  id?: string;
  type: "update_collection";
  collectionId: number;
  name?: string;
  /** `null` promotes the collection to top level. */
  parentCollectionId?: number | null;
};

export type UpdateLibraryTagOperation = {
  id?: string;
  type: "update_library_tag";
  action: "rename" | "delete" | "merge" | "setColor";
  tag: string;
  newTag?: string;
  color?: string;
  position?: number;
  libraryID?: number;
};

/**
 * Replaces each item's tags with exactly the given set.
 *
 * The add-only path is why "give my library exactly these 20 tags" drifted:
 * each batch added its own and nothing removed a previous batch's choices.
 */
export type SetItemTagsOperation = {
  id?: string;
  type: "set_item_tags";
  assignments: Array<{ itemId: number; tags: string[] }>;
};

export type SaveNotesBatchOperation = {
  id?: string;
  type: "save_notes_batch";
  notes: Array<{
    targetItemId: number;
    content: string;
    collections?: number[];
  }>;
  target?: "item" | "standalone";
  modelName?: string;
};

export type CreateItemsOperation = {
  id?: string;
  type: "create_items";
  libraryID?: number;
  items: Array<{
    itemType: string;
    fields?: Record<string, string>;
    creators?: Array<{
      creatorType: string;
      firstName?: string;
      lastName?: string;
      name?: string;
    }>;
    tags?: string[];
    collections?: number[];
  }>;
};

export type ReparentItemsOperation = {
  id?: string;
  type: "reparent_items";
  assignments: Array<{ itemId: number; parentItemId: number | null }>;
};

export type RelateItemsOperation = {
  id?: string;
  type: "relate_items";
  itemId: number;
  relatedItemIds: number[];
  action: "add" | "remove";
};

export type SetItemCollectionsOperation = {
  id?: string;
  type: "set_item_collections";
  assignments: Array<{ itemId: number; collectionIds: number[] }>;
};

export type RemoveFromCollectionOperation = {
  id?: string;
  type: "remove_from_collection";
  itemIds: number[];
  collectionId: number;
};

export type CreateCollectionOperation = {
  id?: string;
  type: "create_collection";
  name: string;
  parentCollectionId?: number;
  libraryID?: number;
};

export type DeleteCollectionOperation = {
  id?: string;
  type: "delete_collection";
  collectionId: number;
  /**
   * Trash the collection's items too. Off by default, matching Zotero, whose
   * "Delete Collection" leaves items in the library and offers "Delete
   * Collection and Items" as a separate command.
   */
  deleteItems?: boolean;
  /**
   * Erase instead of trashing. Irreversible, so it records no undo.
   */
  permanent?: boolean;
};

export type SaveNoteOperation = {
  id?: string;
  type: "save_note";
  content: string;
  target?: NoteSaveTarget;
  targetItemId?: number;
  modelName?: string;
  appendToTrackedNote?: boolean;
  generatedImages?: GeneratedChatImage[];
  /**
   * Collections to file a standalone note into. Only standalone notes can be
   * collection members — a child note belongs to its parent item, and Zotero
   * collections hold top-level items only.
   */
  collections?: number[];
};

export type TrashItemsOperation = {
  id?: string;
  type: "trash_items";
  itemIds: number[];
};

/**
 * Brings items, collections or saved searches back out of the Zotero trash.
 *
 * Restoring was previously reachable only as the inverse of an action the
 * agent itself had just taken, so anything the *user* trashed — or anything
 * trashed in an earlier session — was unreachable.
 */
export type RestoreFromTrashOperation = {
  id?: string;
  type: "restore_from_trash";
  itemIds?: number[];
  collectionIds?: number[];
  savedSearchIds?: number[];
};

export type MergeItemsOperation = {
  id?: string;
  type: "merge_items";
  masterItemId: number;
  otherItemIds: number[];
};

export type DeleteAttachmentOperation = {
  id?: string;
  type: "delete_attachment";
  attachmentId: number;
};

export type RenameAttachmentOperation = {
  id?: string;
  type: "rename_attachment";
  attachmentId: number;
  newName: string;
};

export type RelinkAttachmentOperation = {
  id?: string;
  type: "relink_attachment";
  attachmentId: number;
  newPath: string;
};

export type ImportLocalFilesOperation = {
  id?: string;
  type: "import_local_files";
  filePaths: string[];
  libraryID?: number;
  targetCollectionId?: number;
  /** See ZoteroGateway.importLocalFiles. */
  mode?: "auto" | "translate" | "attach";
  recognize?: boolean;
};

export type ImportIdentifiersOperation = {
  id?: string;
  type: "import_identifiers";
  identifiers: string[];
  libraryID?: number;
  targetCollectionId?: number;
};

export type LibraryMutationOperation =
  | UpdateMetadataOperation
  | ApplyTagsOperation
  | RemoveTagsOperation
  | MoveToCollectionOperation
  | RemoveFromCollectionOperation
  | CreateCollectionOperation
  | SetItemCollectionsOperation
  | SaveNotesBatchOperation
  | SaveSavedSearchOperation
  | DeleteSavedSearchOperation
  | UpdateCollectionOperation
  | UpdateLibraryTagOperation
  | SetItemTagsOperation
  | CreateItemsOperation
  | ReparentItemsOperation
  | RelateItemsOperation
  | DeleteCollectionOperation
  | SaveNoteOperation
  | ImportIdentifiersOperation
  | TrashItemsOperation
  | RestoreFromTrashOperation
  | MergeItemsOperation
  | DeleteAttachmentOperation
  | RenameAttachmentOperation
  | RelinkAttachmentOperation
  | ImportLocalFilesOperation;

export type LibraryMutationUndo = {
  toolName: string;
  description: string;
  revert: () => Promise<void>;
  /**
   * The inverse expressed as operations, so it can be persisted.
   *
   * `revert` is a closure and dies with the process — which is why the old
   * undo stack was ten of them in RAM, wiped by a restart. An inverse
   * expressed as data survives, and replaying it takes the same path (and the
   * same refusals) as a forward write.
   *
   * Absent means the inverse is not expressible as operations; the journal
   * records those as irreversible with `irreversibleReason` rather than
   * pretending they can be undone.
   */
  inverseOperations?: LibraryMutationOperation[];
  irreversibleReason?: string;
};

export type LibraryMutationExecutionResult = {
  operation: LibraryMutationOperation["type"];
  operationId?: string;
  result: unknown;
};

function buildMetadataUndo(
  zoteroGateway: ZoteroGateway,
  snapshot: EditableArticleMetadataSnapshot,
): LibraryMutationUndo {
  const { itemId, fields, creators, title } = snapshot;
  return {
    toolName: "library_mutation",
    description: `Undo metadata edit for "${title}"`,
    inverseOperations: [
      {
        type: "update_metadata",
        itemId,
        metadata: { ...fields, creators },
      },
    ],
    revert: async () => {
      const item = zoteroGateway.getItem(itemId);
      if (!item) return;
      await zoteroGateway.updateArticleMetadata({
        item,
        metadata: { ...fields, creators },
      });
    },
  };
}

function buildTagUndo(
  zoteroGateway: ZoteroGateway,
  itemIdsByTag: Array<{ itemId: number; addedTags: string[] }>,
): LibraryMutationUndo | null {
  if (!itemIdsByTag.length) return null;
  return {
    toolName: "library_mutation",
    inverseOperations: itemIdsByTag.map(({ itemId, addedTags }) => ({
      type: "remove_tags" as const,
      itemIds: [itemId],
      tags: addedTags,
    })),
    description: `Undo tags applied to ${itemIdsByTag.length} paper${
      itemIdsByTag.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      for (const { itemId, addedTags } of itemIdsByTag) {
        await zoteroGateway.removeTagsFromItem({ itemId, tags: addedTags });
      }
    },
  };
}

function buildRemoveTagsUndo(
  zoteroGateway: ZoteroGateway,
  restored: Array<{ itemId: number; tags: string[] }>,
): LibraryMutationUndo | null {
  if (!restored.length) return null;
  return {
    toolName: "library_mutation",
    inverseOperations: restored.map((entry) => ({
      type: "apply_tags" as const,
      itemIds: [entry.itemId],
      tags: entry.tags,
    })),
    description: `Restore removed tags on ${restored.length} paper${
      restored.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      for (const entry of restored) {
        await zoteroGateway.applyTagsToItems({
          itemIds: [entry.itemId],
          tags: entry.tags,
        });
      }
    },
  };
}

function buildCollectionAddUndo(
  zoteroGateway: ZoteroGateway,
  movedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationUndo | null {
  if (!movedItems.length) return null;
  const byCollection = new Map<number, number[]>();
  for (const { itemId, collectionId } of movedItems) {
    const list = byCollection.get(collectionId) || [];
    list.push(itemId);
    byCollection.set(collectionId, list);
  }
  return {
    toolName: "library_mutation",
    inverseOperations: Array.from(byCollection.entries()).map(
      ([collectionId, itemIds]) => ({
        type: "remove_from_collection" as const,
        itemIds,
        collectionId,
      }),
    ),
    description: `Undo collection moves for ${movedItems.length} paper${
      movedItems.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      for (const { itemId, collectionId } of movedItems) {
        await zoteroGateway.removeItemFromCollection({
          itemId,
          collectionId,
        });
      }
    },
  };
}

/**
 * Puts items back into exactly the collections they were in.
 *
 * The inverse of a move is a *set*, not a removal. `buildCollectionAddUndo`
 * emits `remove_from_collection`, so using it to undo a move would take the
 * item out of its destination and never restore the collections it was moved
 * out of — silently unfiling it.
 */
function buildCollectionSetUndo(
  zoteroGateway: ZoteroGateway,
  priorCollections: Array<{ itemId: number; collectionIds: number[] }>,
): LibraryMutationUndo | null {
  if (!priorCollections.length) return null;
  return {
    toolName: "library_mutation",
    inverseOperations: [
      { type: "set_item_collections" as const, assignments: priorCollections },
    ],
    description: `Restore the previous collections of ${priorCollections.length} item${
      priorCollections.length === 1 ? "" : "s"
    }`,
    revert: async () => {
      await zoteroGateway.setItemCollections({
        assignments: priorCollections,
      });
    },
  };
}

function buildCollectionRemoveUndo(
  zoteroGateway: ZoteroGateway,
  removedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationUndo | null {
  if (!removedItems.length) return null;
  return {
    toolName: "library_mutation",
    inverseOperations: removedItems.map(({ itemId, collectionId }) => ({
      type: "move_to_collection" as const,
      itemIds: [itemId],
      targetCollectionId: collectionId,
    })),
    description: `Restore ${removedItems.length} paper${
      removedItems.length === 1 ? "" : "s"
    } to their collection`,
    revert: async () => {
      for (const { itemId, collectionId } of removedItems) {
        await zoteroGateway.addItemsToCollection({
          itemIds: [itemId],
          targetCollectionId: collectionId,
        });
      }
    },
  };
}

function buildCreateCollectionUndo(
  zoteroGateway: ZoteroGateway,
  collection: CollectionSummary,
): LibraryMutationUndo {
  return {
    toolName: "library_mutation",
    inverseOperations: [
      {
        type: "delete_collection",
        collectionId: collection.collectionId,
        permanent: true,
      },
    ],
    description: `Undo creation of collection "${collection.name}"`,
    revert: async () => {
      // Erase rather than trash: undoing a creation should leave nothing
      // behind, not park an unwanted collection in the user's trash.
      await zoteroGateway.deleteCollection({
        collectionId: collection.collectionId,
        permanent: true,
      });
    },
  };
}

/**
 * Restores a collection that `delete_collection` moved to the trash.
 *
 * This used to rebuild the collection from a flat snapshot, which minted a
 * new id — so anything holding the old id silently stopped following it, and
 * subcollections could not come back at all (which is why deleting a
 * collection with subcollections was refused outright).
 *
 * Now that deleting trashes rather than erases, the inverse is simply to
 * clear the `deleted` flag: every id survives, and descendants are restored
 * with their parent. Items trashed alongside the collection are restored too,
 * but only when the delete actually took them.
 */
function buildDeleteCollectionUndo(
  zoteroGateway: ZoteroGateway,
  snapshot: {
    collectionId: number;
    name: string;
    itemIds: number[];
    childCollectionCount: number;
    deleteItems: boolean;
  },
): LibraryMutationUndo {
  const parts: string[] = [];
  if (snapshot.childCollectionCount > 0) {
    parts.push(
      `${snapshot.childCollectionCount} subcollection${snapshot.childCollectionCount === 1 ? "" : "s"}`,
    );
  }
  if (snapshot.deleteItems && snapshot.itemIds.length) {
    parts.push(
      `${snapshot.itemIds.length} item${snapshot.itemIds.length === 1 ? "" : "s"}`,
    );
  }
  return {
    toolName: "library_mutation",
    description: `Restore collection "${snapshot.name}"${
      parts.length ? ` with its ${parts.join(" and ")}` : ""
    }`,
    inverseOperations: [
      {
        type: "restore_from_trash",
        collectionIds: [snapshot.collectionId],
        ...(snapshot.deleteItems && snapshot.itemIds.length
          ? { itemIds: snapshot.itemIds }
          : {}),
      },
    ],
    revert: async () => {
      await zoteroGateway.restoreCollections({
        collectionIds: [snapshot.collectionId],
      });
      if (snapshot.deleteItems && snapshot.itemIds.length) {
        await zoteroGateway.restoreItems({ itemIds: snapshot.itemIds });
      }
    },
  };
}

/**
 * Trashes a note the agent just created. `save_note` previously recorded no
 * inverse at all, so "undo that" after writing a note popped an unrelated
 * earlier entry instead.
 */
function buildSaveNoteUndo(
  zoteroGateway: ZoteroGateway,
  noteId: number,
): LibraryMutationUndo {
  return {
    toolName: "library_mutation",
    inverseOperations: [{ type: "trash_items", itemIds: [noteId] }],
    description: "Trash the note that was just created",
    revert: async () => {
      await zoteroGateway.trashItems({ itemIds: [noteId] });
    },
  };
}

function directTagAssignments(
  operation: ApplyTagsOperation,
): BatchTagAssignment[] {
  if (operation.assignments?.length) return operation.assignments;
  if (!operation.itemIds?.length || !operation.tags?.length) return [];
  return operation.itemIds.map((itemId) => ({
    itemId,
    tags: operation.tags as string[],
  }));
}

function directMoveAssignments(
  operation: MoveToCollectionOperation,
): BatchMoveAssignment[] {
  if (operation.assignments?.length) {
    return operation.assignments
      .filter((assignment): assignment is BatchMoveAssignment =>
        Boolean(assignment.targetCollectionId),
      )
      .map((assignment) => ({
        itemId: assignment.itemId,
        targetCollectionId: assignment.targetCollectionId as number,
      }));
  }
  if (!operation.itemIds?.length || !operation.targetCollectionId) return [];
  return operation.itemIds.map((itemId) => ({
    itemId,
    targetCollectionId: operation.targetCollectionId as number,
  }));
}

function normalizeLibraryID(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function assertItemInActiveLibrary(
  item: Zotero.Item | null | undefined,
  context: AgentToolContext,
  operationLabel: string,
): void {
  const requestLibraryID = normalizeLibraryID(context.request.libraryID);
  const itemLibraryID = normalizeLibraryID(item?.libraryID);
  if (
    !requestLibraryID ||
    !itemLibraryID ||
    requestLibraryID === itemLibraryID
  ) {
    return;
  }
  const itemId = Number((item as { id?: unknown } | null | undefined)?.id);
  const itemLabel =
    Number.isFinite(itemId) && itemId > 0 ? `item ${itemId}` : "item";
  throw new Error(
    `Refusing ${operationLabel} for ${itemLabel} in library ${itemLibraryID}; active library is ${requestLibraryID}.`,
  );
}

export class LibraryMutationService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  async executeOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<{
    result: LibraryMutationExecutionResult;
    undo?: LibraryMutationUndo | null;
  }> {
    switch (operation.type) {
      case "update_metadata": {
        const targetItem = this.zoteroGateway.resolveMetadataItem({
          request: context.request,
          item: context.item,
          itemId: operation.itemId,
          paperContext: operation.paperContext,
        });
        assertItemInActiveLibrary(targetItem, context, "metadata update");
        const previousSnapshot =
          this.zoteroGateway.getEditableArticleMetadata(targetItem);
        const result = await this.zoteroGateway.updateArticleMetadata({
          item: targetItem,
          metadata: operation.metadata,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: previousSnapshot
            ? buildMetadataUndo(this.zoteroGateway, previousSnapshot)
            : null,
        };
      }
      case "apply_tags": {
        const assignments = directTagAssignments(operation);
        if (!assignments.length) {
          throw new Error("No tag assignments were selected");
        }
        const result = await this.zoteroGateway.applyTagAssignments({
          assignments,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: buildTagUndo(
            this.zoteroGateway,
            result.items
              .filter(
                (item) =>
                  item.status === "updated" && item.addedTags.length > 0,
              )
              .map((item) => ({
                itemId: item.itemId,
                addedTags: item.addedTags,
              })),
          ),
        };
      }
      case "remove_tags": {
        // Counted from what the gateway actually removed. Deriving this from
        // the paper-target map meant a book (or any PDF-less item) reported
        // zero removals and recorded no undo, while the tag really was gone.
        const removed: Array<{ itemId: number; tags: string[] }> = [];
        const rows: Array<{
          itemId: number;
          status: string;
          reason?: string;
        }> = [];
        for (const itemId of operation.itemIds) {
          const outcome = await this.zoteroGateway.removeTagsFromItem({
            itemId,
            tags: operation.tags,
          });
          if (outcome.removed.length) {
            removed.push({ itemId, tags: outcome.removed });
            rows.push({ itemId, status: "removed" });
          } else {
            rows.push({
              itemId,
              status: "skipped",
              reason: "None of those tags were on this item",
            });
          }
        }
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              itemIds: operation.itemIds,
              removedCount: removed.length,
              tags: operation.tags,
              items: rows,
            },
          },
          undo: buildRemoveTagsUndo(this.zoteroGateway, removed),
        };
      }
      case "move_to_collection": {
        const assignments = directMoveAssignments(operation);
        if (!assignments.length) {
          throw new Error("No paper-to-collection assignments were selected");
        }
        const result = await this.zoteroGateway.addItemsToCollections({
          assignments,
          mode: operation.mode,
          from: operation.from,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // A move's inverse has to restore the whole prior membership set.
          // The add-undo below only removes the destination, which for a move
          // would leave the item unfiled from wherever it came.
          undo:
            operation.mode === "move" && result.priorCollections?.length
              ? buildCollectionSetUndo(
                  this.zoteroGateway,
                  result.priorCollections,
                )
              : buildCollectionAddUndo(
                  this.zoteroGateway,
                  result.items
                    .filter(
                      (item) =>
                        item.status === "moved" && item.targetCollectionId,
                    )
                    .map((item) => ({
                      itemId: item.itemId,
                      collectionId: item.targetCollectionId as number,
                    })),
                ),
        };
      }
      case "save_saved_search": {
        const libraryID = this.zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
          libraryID: operation.libraryID,
        });
        const result = await this.zoteroGateway.saveSavedSearch({
          libraryID,
          name: operation.name,
          conditions: operation.conditions,
          joinMode: operation.joinMode,
          savedSearchId: operation.savedSearchId,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Only a newly created search has a clean inverse; replacing an
          // existing one's conditions discards what they were.
          undo:
            result.status === "created"
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "delete_saved_search" as const,
                      savedSearchId: result.savedSearchId,
                      permanent: true,
                    },
                  ],
                  description: `Delete the saved search "${result.name}"`,
                  revert: async () => {
                    await this.zoteroGateway.deleteSavedSearch({
                      savedSearchId: result.savedSearchId,
                      permanent: true,
                    });
                  },
                }
              : null,
        };
      }
      case "delete_saved_search": {
        const result = await this.zoteroGateway.deleteSavedSearch({
          savedSearchId: operation.savedSearchId,
          permanent: operation.permanent,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.status === "trashed"
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "restore_from_trash" as const,
                      savedSearchIds: [operation.savedSearchId],
                    },
                  ],
                  description: `Restore the saved search from the trash`,
                  revert: async () => {
                    await this.zoteroGateway.restoreSavedSearches({
                      savedSearchIds: [operation.savedSearchId],
                    });
                  },
                }
              : null,
        };
      }
      case "update_collection": {
        const result = await this.zoteroGateway.updateCollection({
          collectionId: operation.collectionId,
          name: operation.name,
          parentCollectionId: operation.parentCollectionId,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.status === "updated"
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "update_collection" as const,
                      collectionId: operation.collectionId,
                      name: result.previousName,
                      parentCollectionId: result.previousParentCollectionId,
                    },
                  ],
                  description: `Rename "${result.name}" back to "${result.previousName}"`,
                  revert: async () => {
                    await this.zoteroGateway.updateCollection({
                      collectionId: operation.collectionId,
                      name: result.previousName,
                      parentCollectionId: result.previousParentCollectionId,
                    });
                  },
                }
              : null,
        };
      }
      case "update_library_tag": {
        const libraryID = this.zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
          libraryID: operation.libraryID,
        });
        const result = await this.zoteroGateway.updateLibraryTag({
          libraryID,
          action: operation.action,
          tag: operation.tag,
          newTag: operation.newTag,
          color: operation.color,
          position: operation.position,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Only a rename is reversible by renaming back. A merge destroys
          // the source/destination distinction, while a delete destroys the
          // membership set; neither may advertise a lossy "undo".
          undo:
            result.status === "applied" &&
            operation.action === "rename" &&
            result.newTag
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "update_library_tag" as const,
                      action: "rename" as const,
                      tag: result.newTag,
                      newTag: operation.tag,
                      libraryID,
                    },
                  ],
                  description: `Rename tag "${result.newTag}" back to "${operation.tag}"`,
                  revert: async () => {
                    await this.zoteroGateway.updateLibraryTag({
                      libraryID,
                      action: "rename",
                      tag: result.newTag as string,
                      newTag: operation.tag,
                    });
                  },
                }
              : result.status === "applied" &&
                  (operation.action === "delete" ||
                    operation.action === "merge")
                ? {
                    toolName: "library_mutation",
                    irreversibleReason:
                      operation.action === "delete"
                        ? `Deleting the tag "${operation.tag}" library-wide also discards which items carried it, so it cannot be restored.`
                        : `Merging the tag "${operation.tag}" into "${operation.newTag || "another tag"}" destroys which items originally carried each tag, so it cannot be separated safely.`,
                    description:
                      operation.action === "delete"
                        ? `Delete tag "${operation.tag}"`
                        : `Merge tag "${operation.tag}"`,
                    revert: async () => {
                      throw new Error(
                        operation.action === "delete"
                          ? `Deleting a tag library-wide cannot be undone: which items carried "${operation.tag}" is not recorded anywhere.`
                          : `Merging tags cannot be undone safely because their original membership sets are no longer distinguishable.`,
                      );
                    },
                  }
                : null,
        };
      }
      case "set_item_tags": {
        const result = await this.zoteroGateway.setItemTags({
          assignments: operation.assignments,
        });
        const changed = result.items.filter((row) => row.status === "updated");
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // The inverse of replacing a set is the set it had before.
          undo: changed.length
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  {
                    type: "set_item_tags" as const,
                    assignments: changed.map((row) => ({
                      itemId: row.itemId,
                      tags: row.previousTags || [],
                    })),
                  },
                ],
                description: `Restore the previous tags on ${changed.length} item${
                  changed.length === 1 ? "" : "s"
                }`,
                revert: async () => {
                  await this.zoteroGateway.setItemTags({
                    assignments: changed.map((row) => ({
                      itemId: row.itemId,
                      tags: row.previousTags || [],
                    })),
                  });
                },
              }
            : null,
        };
      }
      case "save_notes_batch": {
        const rows: Array<{
          targetItemId: number;
          noteId?: number;
          title: string;
          status: "created" | "error";
          reason?: string;
        }> = [];
        const createdNoteIds: number[] = [];
        for (const entry of operation.notes) {
          const target = this.zoteroGateway.getItem(entry.targetItemId);
          const title = target
            ? String(target.getDisplayTitle?.() || `Item ${entry.targetItemId}`)
            : `Item ${entry.targetItemId}`;
          if (!target) {
            rows.push({
              targetItemId: entry.targetItemId,
              title,
              status: "error",
              reason: `No item with ID ${entry.targetItemId} exists in this library`,
            });
            continue;
          }
          try {
            const saved = await this.zoteroGateway.saveAnswerToNote({
              item: target,
              libraryID: context.request.libraryID,
              content: entry.content,
              modelName: operation.modelName || context.modelName,
              target: operation.target || "item",
              collections: entry.collections,
            });
            if (saved.noteId) createdNoteIds.push(saved.noteId);
            rows.push({
              targetItemId: entry.targetItemId,
              noteId: saved.noteId,
              title,
              status: "created",
            });
          } catch (error) {
            // One bad target must not lose the other forty-nine notes.
            rows.push({
              targetItemId: entry.targetItemId,
              title,
              status: "error",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              createdCount: createdNoteIds.length,
              failedCount: rows.length - createdNoteIds.length,
              notes: rows,
            },
          },
          undo: createdNoteIds.length
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  { type: "trash_items", itemIds: createdNoteIds },
                ],
                description: `Trash ${createdNoteIds.length} note${
                  createdNoteIds.length === 1 ? "" : "s"
                } that were just written`,
                revert: async () => {
                  await this.zoteroGateway.trashItems({
                    itemIds: createdNoteIds,
                  });
                },
              }
            : null,
        };
      }
      case "create_items": {
        const libraryID = this.zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
          libraryID: operation.libraryID,
        });
        if (!libraryID) {
          throw new Error("No active library available for item creation");
        }
        const result = await this.zoteroGateway.createItems({
          libraryID,
          items: operation.items as never,
        });
        const createdIds = result.items
          .filter((row) => row.status === "created" && row.itemId)
          .map((row) => row.itemId as number);
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Trash rather than erase, matching every other delete here: the
          // user may want the item back after undoing by mistake.
          undo: createdIds.length
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  { type: "trash_items", itemIds: createdIds },
                ],
                description: `Trash ${createdIds.length} newly created item${
                  createdIds.length === 1 ? "" : "s"
                }`,
                revert: async () => {
                  await this.zoteroGateway.trashItems({ itemIds: createdIds });
                },
              }
            : null,
        };
      }
      case "reparent_items": {
        const result = await this.zoteroGateway.reparentItems({
          assignments: operation.assignments,
        });
        const moved = result.items.filter((row) => row.status === "reparented");
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Each item goes back to its own previous parent, which may be a
          // different item or top level; one blanket inverse cannot express
          // that.
          undo: moved.length
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  {
                    type: "reparent_items" as const,
                    assignments: moved.map((row) => ({
                      itemId: row.itemId,
                      parentItemId: row.previousParentId ?? null,
                    })),
                  },
                ],
                description: `Move ${moved.length} item${
                  moved.length === 1 ? "" : "s"
                } back to their previous parents`,
                revert: async () => {
                  await this.zoteroGateway.reparentItems({
                    assignments: moved.map((row) => ({
                      itemId: row.itemId,
                      parentItemId: row.previousParentId ?? null,
                    })),
                  });
                },
              }
            : null,
        };
      }
      case "relate_items": {
        const result = await this.zoteroGateway.relateItems({
          itemId: operation.itemId,
          relatedItemIds: operation.relatedItemIds,
          action: operation.action,
        });
        const affected = result.items
          .filter(
            (row) => row.status === "related" || row.status === "unrelated",
          )
          .map((row) => row.relatedItemId);
        const inverseAction = operation.action === "add" ? "remove" : "add";
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: affected.length
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  {
                    type: "relate_items" as const,
                    itemId: operation.itemId,
                    relatedItemIds: affected,
                    action: inverseAction as "add" | "remove",
                  },
                ],
                description:
                  operation.action === "add"
                    ? `Unlink ${affected.length} related item${affected.length === 1 ? "" : "s"}`
                    : `Re-link ${affected.length} related item${affected.length === 1 ? "" : "s"}`,
                revert: async () => {
                  await this.zoteroGateway.relateItems({
                    itemId: operation.itemId,
                    relatedItemIds: affected,
                    action: inverseAction,
                  });
                },
              }
            : null,
        };
      }
      case "set_item_collections": {
        const result = await this.zoteroGateway.setItemCollections({
          assignments: operation.assignments,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo: result.priorCollections.length
            ? buildCollectionSetUndo(
                this.zoteroGateway,
                result.priorCollections,
              )
            : null,
        };
      }
      case "remove_from_collection": {
        const removedItems: Array<{ itemId: number; collectionId: number }> =
          [];
        const rows: Array<{
          itemId: number;
          status: string;
          reason?: string;
        }> = [];
        for (const itemId of operation.itemIds) {
          const outcome = await this.zoteroGateway.removeItemFromCollection({
            itemId,
            collectionId: operation.collectionId,
          });
          if (outcome.removed) {
            removedItems.push({ itemId, collectionId: operation.collectionId });
            rows.push({ itemId, status: "removed" });
          } else {
            rows.push({
              itemId,
              status: "skipped",
              reason: outcome.reason,
            });
          }
        }
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              itemIds: operation.itemIds,
              collectionId: operation.collectionId,
              // Counted from what actually happened, not from the request.
              removedCount: removedItems.length,
              items: rows,
            },
          },
          undo: removedItems.length
            ? buildCollectionRemoveUndo(this.zoteroGateway, removedItems)
            : undefined,
        };
      }
      case "create_collection": {
        const libraryID = this.zoteroGateway.resolveLibraryID({
          request: context.request,
          item: context.item,
          libraryID: operation.libraryID,
        });
        if (!libraryID) {
          throw new Error(
            "No active library available for collection creation",
          );
        }
        const collection = await this.zoteroGateway.createCollection({
          name: operation.name,
          parentCollectionId: operation.parentCollectionId,
          libraryID,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: { collection },
          },
          undo: buildCreateCollectionUndo(this.zoteroGateway, collection),
        };
      }
      case "delete_collection": {
        // Deleting trashes the collection, exactly as Zotero's own "Delete
        // Collection" does, so subcollections travel with it and the inverse
        // is a restore by id rather than a rebuild. That is why the old
        // refusal of collections with subcollections is gone: a flat snapshot
        // could not restore a subtree, but the trash restores it intact.
        const snapshot = this.zoteroGateway.snapshotCollectionForDelete({
          collectionId: operation.collectionId,
        });
        await this.zoteroGateway.deleteCollection({
          collectionId: operation.collectionId,
          deleteItems: operation.deleteItems,
          permanent: operation.permanent,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              collectionId: operation.collectionId,
              status: operation.permanent ? "erased" : "trashed",
              childCollectionCount: snapshot?.childCollectionCount ?? 0,
              itemCount: snapshot?.itemIds.length ?? 0,
              itemsTrashed: !!operation.deleteItems,
            },
          },
          // A permanent erase has no inverse, so it deliberately records no
          // undo rather than promising one it cannot honour.
          undo:
            snapshot && !operation.permanent
              ? buildDeleteCollectionUndo(this.zoteroGateway, {
                  ...snapshot,
                  collectionId: operation.collectionId,
                  deleteItems: !!operation.deleteItems,
                })
              : undefined,
        };
      }
      case "save_note": {
        const item =
          (operation.targetItemId
            ? this.zoteroGateway.getItem(operation.targetItemId)
            : null) ||
          this.zoteroGateway.getItem(context.request.activeItemId) ||
          context.item;
        const saved = await this.zoteroGateway.saveAnswerToNote({
          item,
          libraryID: context.request.libraryID,
          content: operation.content,
          modelName: operation.modelName || context.modelName,
          target: operation.target,
          appendToTrackedNote: operation.appendToTrackedNote,
          generatedImages: operation.generatedImages,
          collections: operation.collections,
        });
        // The note id and the collections it landed in are returned so the
        // caller can verify and follow up; previously only a status string
        // came back and any next step was impossible to express.
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              status: saved.status,
              noteId: saved.noteId,
              collections: saved.collections,
            },
          },
          undo:
            saved.noteId && saved.noteId > 0
              ? buildSaveNoteUndo(this.zoteroGateway, saved.noteId)
              : undefined,
        };
      }
      case "import_identifiers": {
        const result = await this.zoteroGateway.importPapersByIdentifiers(
          operation.identifiers,
          operation.libraryID,
          operation.targetCollectionId,
        );
        const importedIds = result.itemIds || [];
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Previously no undo at all — so after "create a collection, import
          // 50 papers into it", the top of the undo stack was the *collection
          // creation*. "Undo that" deleted the folder and left all 50 items
          // behind, which is worse than a no-op.
          undo: importedIds.length
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  { type: "trash_items" as const, itemIds: importedIds },
                ],
                description: `Trash the ${importedIds.length} imported item${
                  importedIds.length === 1 ? "" : "s"
                }`,
                revert: async () => {
                  await this.zoteroGateway.trashItems({ itemIds: importedIds });
                },
              }
            : undefined,
        };
      }
      case "trash_items": {
        const result = await this.zoteroGateway.trashItems({
          itemIds: operation.itemIds,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.trashedCount > 0
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "restore_from_trash" as const,
                      itemIds: result.items
                        .filter((item) => item.status === "trashed")
                        .map((item) => item.itemId),
                    },
                  ],
                  description: `Restore ${result.trashedCount} trashed item${
                    result.trashedCount === 1 ? "" : "s"
                  }`,
                  revert: async () => {
                    await this.zoteroGateway.restoreItems({
                      itemIds: result.items
                        .filter((item) => item.status === "trashed")
                        .map((item) => item.itemId),
                    });
                  },
                }
              : null,
        };
      }
      case "restore_from_trash": {
        const itemIds = operation.itemIds || [];
        const collectionIds = operation.collectionIds || [];
        const savedSearchIds = operation.savedSearchIds || [];
        const restoredItems = itemIds.length
          ? await this.zoteroGateway.restoreItems({ itemIds })
          : { restoredCount: 0, itemIds: [] as number[] };
        const restoredCollections = collectionIds.length
          ? await this.zoteroGateway.restoreCollections({ collectionIds })
          : { restoredCount: 0 };
        const restoredSearches = savedSearchIds.length
          ? await this.zoteroGateway.restoreSavedSearches({ savedSearchIds })
          : { restoredCount: 0 };
        const total =
          restoredItems.restoredCount +
          restoredCollections.restoredCount +
          restoredSearches.restoredCount;
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result: {
              restoredItemCount: restoredItems.restoredCount,
              restoredCollectionCount: restoredCollections.restoredCount,
              restoredSavedSearchCount: restoredSearches.restoredCount,
              restoredCount: total,
            },
          },
          // The inverse re-trashes only what this call actually restored, so
          // undoing a partial restore cannot sweep up untouched siblings.
          undo: total
            ? {
                toolName: "library_mutation",
                inverseOperations: [
                  ...(restoredItems.itemIds.length
                    ? [
                        {
                          type: "trash_items" as const,
                          itemIds: restoredItems.itemIds,
                        },
                      ]
                    : []),
                  ...collectionIds.map((collectionId) => ({
                    type: "delete_collection" as const,
                    collectionId,
                  })),
                  ...savedSearchIds.map((savedSearchId) => ({
                    type: "delete_saved_search" as const,
                    savedSearchId,
                  })),
                ],
                description: `Move ${total} restored object${total === 1 ? "" : "s"} back to the trash`,
                revert: async () => {
                  if (restoredItems.itemIds.length) {
                    await this.zoteroGateway.trashItems({
                      itemIds: restoredItems.itemIds,
                    });
                  }
                  for (const collectionId of collectionIds) {
                    await this.zoteroGateway.deleteCollection({ collectionId });
                  }
                },
              }
            : null,
        };
      }
      case "merge_items": {
        const result = await this.zoteroGateway.mergeItems({
          masterItemId: operation.masterItemId,
          otherItemIds: operation.otherItemIds,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // A merge is not fully reversible: Zotero moves children onto the
          // survivor and deduplicates identical attachments by hash, so the
          // originals no longer exist to give back. Bringing the duplicates
          // out of the trash returns records stripped of their attachments,
          // notes and tags -- so the description says exactly that rather
          // than promising a restore it cannot perform.
          undo:
            result.mergedCount > 0
              ? {
                  toolName: "merge_items",
                  description: `Bring ${result.mergedCount} merged item${
                    result.mergedCount === 1 ? "" : "s"
                  } back from the trash (their attachments, notes and tags stay with the surviving item, so this does not fully un-merge them)`,
                  revert: async () => {
                    await this.zoteroGateway.restoreItems({
                      itemIds: result.trashedIds,
                    });
                  },
                }
              : null,
        };
      }
      case "delete_attachment": {
        const result = await this.zoteroGateway.deleteAttachment({
          attachmentId: operation.attachmentId,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.status === "deleted"
              ? {
                  toolName: "manage_attachments",
                  inverseOperations: [
                    {
                      type: "restore_from_trash" as const,
                      itemIds: [operation.attachmentId],
                    },
                  ],
                  description: `Restore deleted attachment: ${result.title}`,
                  revert: async () => {
                    await this.zoteroGateway.restoreItems({
                      itemIds: [operation.attachmentId],
                    });
                  },
                }
              : null,
        };
      }
      case "rename_attachment": {
        const result = await this.zoteroGateway.renameAttachment({
          attachmentId: operation.attachmentId,
          newName: operation.newName,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Renaming recorded no inverse at all, so "undo that" after a
          // rename popped an unrelated earlier entry. Only a rename that
          // actually moved the file is reversible.
          undo:
            result.status === "renamed" && result.previousName
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "rename_attachment" as const,
                      attachmentId: operation.attachmentId,
                      newName: result.previousName,
                    },
                  ],
                  description: `Rename attachment back to "${result.previousName}"`,
                  revert: async () => {
                    await this.zoteroGateway.renameAttachment({
                      attachmentId: operation.attachmentId,
                      newName: result.previousName,
                    });
                  },
                }
              : null,
        };
      }
      case "relink_attachment": {
        const result = await this.zoteroGateway.relinkAttachment({
          attachmentId: operation.attachmentId,
          newPath: operation.newPath,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          // Only offer to undo when there was a resolvable file to go back
          // to; re-linking an attachment whose file was already missing has
          // no previous path to restore.
          undo:
            result.status === "relinked" && result.previousPath
              ? {
                  toolName: "library_mutation",
                  inverseOperations: [
                    {
                      type: "relink_attachment" as const,
                      attachmentId: operation.attachmentId,
                      newPath: result.previousPath,
                    },
                  ],
                  description: `Re-link attachment back to ${result.previousPath}`,
                  revert: async () => {
                    await this.zoteroGateway.relinkAttachment({
                      attachmentId: operation.attachmentId,
                      newPath: result.previousPath,
                    });
                  },
                }
              : null,
        };
      }
      case "import_local_files": {
        const result = await this.zoteroGateway.importLocalFiles({
          filePaths: operation.filePaths,
          libraryID: operation.libraryID,
          targetCollectionId: operation.targetCollectionId,
          mode: operation.mode,
          recognize: operation.recognize,
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          undo:
            result.succeeded > 0
              ? {
                  toolName: "import_local_files",
                  inverseOperations: [
                    {
                      type: "trash_items" as const,
                      itemIds: result.items
                        .filter(
                          (item) => item.status === "imported" && item.itemId,
                        )
                        .map((item) => item.itemId as number),
                    },
                  ],
                  description: `Trash ${result.succeeded} imported item${
                    result.succeeded === 1 ? "" : "s"
                  }`,
                  revert: async () => {
                    const importedIds = result.items
                      .filter((i) => i.status === "imported" && i.itemId)
                      .map((i) => i.itemId!);
                    if (importedIds.length) {
                      await this.zoteroGateway.trashItems({
                        itemIds: importedIds,
                      });
                    }
                  },
                }
              : null,
        };
      }
    }
  }
}
