import type { GeneratedChatImage, PaperContextRef } from "../../shared/types";
import type { AgentToolContext, AgentToolEffect } from "../types";
import type {
  BatchMoveAssignment,
  BatchTagAssignment,
  CollectionSummary,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
  ZoteroGateway,
} from "./zoteroGateway";
import { sha256Text } from "../store/journalRecoveryBlobStore";

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

export type LibraryMutationInverse = {
  description: string;
  inverseOperations?: LibraryMutationOperation[];
  irreversibleReason?: string;
};

export type LibraryMutationExecutionResult = {
  operation: LibraryMutationOperation["type"];
  operationId?: string;
  result: unknown;
};

export type LibraryMutationExecution = {
  result: LibraryMutationExecutionResult;
  inverse?: LibraryMutationInverse | null;
  effect: AgentToolEffect;
  affectedCount: number;
};

export type LibraryMutationPlan = {
  effect: "write";
  reversibility: "full" | "partial" | "none";
  reason?: string;
  description: string;
  /** Persisted before the forward write whenever the inverse is knowable. */
  inverseOperations?: LibraryMutationOperation[];
  /** Narrow object state used for audit and conflict-safe replay. */
  precondition?: unknown;
  /** Creation/import IDs are not knowable until Zotero commits. */
  deferredInverse?: boolean;
};

type MutationItemState = {
  itemId: number;
  exists: boolean;
  version?: number;
  dateModified?: string;
  fields?: Record<string, string>;
  creators?: EditableArticleMetadataSnapshot["creators"];
  tags?: string[];
  collectionIds?: number[];
  parentItemId?: number | null;
  deleted?: boolean;
  attachmentPath?: string;
  attachmentTitle?: string;
  childAttachmentIds?: number[];
  childNoteIds?: number[];
  noteHtmlChecksum?: string;
  annotation?: {
    type: string;
    text: string;
    comment: string;
    color: string;
    pageLabel: string;
    sortIndex: string;
    position: unknown;
    tags: string[];
  };
};

export type LibraryMutationState = {
  version: 1;
  operation: LibraryMutationOperation["type"];
  items?: MutationItemState[];
  collections?: Array<{
    collectionId: number;
    exists: boolean;
    name?: string;
    parentCollectionId?: number | null;
    deleted?: boolean;
    directItemIds?: number[];
    childCollectionIds?: number[];
  }>;
  savedSearches?: Array<{
    savedSearchId: number;
    exists: boolean;
    libraryID?: number;
    name?: string;
    deleted?: boolean;
    conditions?: Array<Record<string, unknown>>;
  }>;
  libraryTags?: Array<{
    libraryID: number;
    name: string;
    observable: boolean;
    exists: boolean;
    itemIds: number[];
    color?: string;
    position?: number;
  }>;
  relations?: Array<{
    itemId: number;
    relatedItemId: number;
    related: boolean;
    reciprocal: boolean;
  }>;
};

function buildMetadataInverse(
  snapshot: EditableArticleMetadataSnapshot,
): LibraryMutationInverse {
  const { itemId, fields, creators, title } = snapshot;
  return {
    description: `Undo metadata edit for "${title}"`,
    inverseOperations: [
      {
        type: "update_metadata",
        itemId,
        metadata: { ...fields, creators },
      },
    ],
  };
}

function buildTagInverse(
  itemIdsByTag: Array<{ itemId: number; addedTags: string[] }>,
): LibraryMutationInverse | null {
  if (!itemIdsByTag.length) return null;
  return {
    inverseOperations: itemIdsByTag.map(({ itemId, addedTags }) => ({
      type: "remove_tags" as const,
      itemIds: [itemId],
      tags: addedTags,
    })),
    description: `Undo tags applied to ${itemIdsByTag.length} paper${
      itemIdsByTag.length === 1 ? "" : "s"
    }`,
  };
}

function buildRemoveTagsInverse(
  restored: Array<{ itemId: number; tags: string[] }>,
): LibraryMutationInverse | null {
  if (!restored.length) return null;
  return {
    inverseOperations: restored.map((entry) => ({
      type: "apply_tags" as const,
      itemIds: [entry.itemId],
      tags: entry.tags,
    })),
    description: `Restore removed tags on ${restored.length} paper${
      restored.length === 1 ? "" : "s"
    }`,
  };
}

function buildCollectionAddInverse(
  movedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationInverse | null {
  if (!movedItems.length) return null;
  const byCollection = new Map<number, number[]>();
  for (const { itemId, collectionId } of movedItems) {
    const list = byCollection.get(collectionId) || [];
    list.push(itemId);
    byCollection.set(collectionId, list);
  }
  return {
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
  };
}

/**
 * Puts items back into exactly the collections they were in.
 *
 * The inverse of a move is a *set*, not a removal. `buildCollectionAddInverse`
 * emits `remove_from_collection`, so using it to undo a move would take the
 * item out of its destination and never restore the collections it was moved
 * out of — silently unfiling it.
 */
function buildCollectionSetInverse(
  priorCollections: Array<{ itemId: number; collectionIds: number[] }>,
): LibraryMutationInverse | null {
  if (!priorCollections.length) return null;
  return {
    inverseOperations: [
      { type: "set_item_collections" as const, assignments: priorCollections },
    ],
    description: `Restore the previous collections of ${priorCollections.length} item${
      priorCollections.length === 1 ? "" : "s"
    }`,
  };
}

function buildCollectionRemoveInverse(
  removedItems: Array<{ itemId: number; collectionId: number }>,
): LibraryMutationInverse | null {
  if (!removedItems.length) return null;
  return {
    inverseOperations: removedItems.map(({ itemId, collectionId }) => ({
      type: "move_to_collection" as const,
      itemIds: [itemId],
      targetCollectionId: collectionId,
    })),
    description: `Restore ${removedItems.length} paper${
      removedItems.length === 1 ? "" : "s"
    } to their collection`,
  };
}

function buildCreateCollectionInverse(
  collection: CollectionSummary,
): LibraryMutationInverse {
  return {
    inverseOperations: [
      {
        type: "delete_collection",
        collectionId: collection.collectionId,
        permanent: true,
      },
    ],
    description: `Undo creation of collection "${collection.name}"`,
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
function buildDeleteCollectionInverse(snapshot: {
  collectionId: number;
  name: string;
  itemIds: number[];
  childCollectionCount: number;
  deleteItems: boolean;
}): LibraryMutationInverse {
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
  };
}

/**
 * Trashes a note the agent just created. `save_note` previously recorded no
 * inverse at all, so "undo that" after writing a note popped an unrelated
 * earlier entry instead.
 */
function buildSaveNoteInverse(noteId: number): LibraryMutationInverse {
  return {
    inverseOperations: [{ type: "trash_items", itemIds: [noteId] }],
    description: "Trash the note that was just created",
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

function mutationAffectedCount(
  operation: LibraryMutationOperation,
  result: unknown,
): number {
  const value = (result || {}) as Record<string, unknown>;
  const count = (key: string): number =>
    Math.max(0, Math.floor(Number(value[key]) || 0));
  switch (operation.type) {
    case "apply_tags":
      return count("updatedCount");
    case "remove_tags":
    case "remove_from_collection":
      return count("removedCount");
    case "move_to_collection":
      return count("movedCount");
    case "set_item_tags":
    case "create_items":
    case "reparent_items":
    case "relate_items":
    case "set_item_collections":
      return count("changedCount") || count("createdCount");
    case "save_notes_batch":
      return count("createdCount");
    case "import_identifiers":
    case "import_local_files":
      return count("succeeded");
    case "trash_items":
      return count("trashedCount");
    case "restore_from_trash":
      return count("restoredCount");
    case "merge_items":
      return count("mergedCount");
    case "delete_saved_search":
      return value.status === "not_found" ? 0 : 1;
    case "update_collection":
      return value.status === "updated" ? 1 : 0;
    case "update_library_tag":
      return value.status === "applied" ? 1 : 0;
    case "delete_attachment":
      return value.status === "deleted" ? 1 : 0;
    case "rename_attachment":
      return value.status === "renamed" ? 1 : 0;
    case "relink_attachment":
      return value.status === "relinked" ? 1 : 0;
    case "update_metadata":
    case "save_saved_search":
    case "create_collection":
    case "delete_collection":
    case "save_note":
      return 1;
  }
}

function mutationTargetCount(operation: LibraryMutationOperation): number {
  switch (operation.type) {
    case "apply_tags":
      return new Set(
        directTagAssignments(operation).map((assignment) => assignment.itemId),
      ).size;
    case "move_to_collection":
      return new Set(
        directMoveAssignments(operation).map((assignment) => assignment.itemId),
      ).size;
    case "remove_tags":
    case "remove_from_collection":
    case "trash_items":
      return operation.itemIds.length;
    case "set_item_tags":
    case "set_item_collections":
    case "reparent_items":
      return operation.assignments.length;
    case "save_notes_batch":
      return operation.notes.length;
    case "create_items":
      return operation.items.length;
    case "relate_items":
      return operation.relatedItemIds.length;
    case "import_identifiers":
      return operation.identifiers.length;
    case "import_local_files":
      return operation.filePaths.length;
    case "restore_from_trash":
      return (
        (operation.itemIds?.length || 0) +
        (operation.collectionIds?.length || 0) +
        (operation.savedSearchIds?.length || 0)
      );
    case "merge_items":
      return operation.otherItemIds.length;
    case "update_metadata":
    case "create_collection":
    case "save_saved_search":
    case "delete_saved_search":
    case "update_collection":
    case "update_library_tag":
    case "delete_collection":
    case "save_note":
    case "delete_attachment":
    case "rename_attachment":
    case "relink_attachment":
      return 1;
  }
}

function mutationEffect(
  operation: LibraryMutationOperation,
  affectedCount: number,
): AgentToolEffect {
  if (affectedCount <= 0) return "none";
  const targetCount = mutationTargetCount(operation);
  return targetCount > affectedCount ? "partial" : "applied";
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

function operationItemIds(operation: LibraryMutationOperation): number[] {
  const record = operation as unknown as Record<string, unknown>;
  const ids: number[] = [];
  const add = (value: unknown): void => {
    const id = Math.floor(Number(value));
    if (Number.isFinite(id) && id > 0 && !ids.includes(id)) ids.push(id);
  };
  add(record.itemId);
  add(record.targetItemId);
  add(record.masterItemId);
  add(record.attachmentId);
  for (const key of ["itemIds", "otherItemIds"]) {
    const values = record[key];
    if (Array.isArray(values)) values.forEach(add);
  }
  const assignments = record.assignments;
  if (Array.isArray(assignments)) {
    for (const assignment of assignments) {
      if (assignment && typeof assignment === "object") {
        add((assignment as Record<string, unknown>).itemId);
      }
    }
  }
  return ids;
}

function resultCreatedItemIds(value: unknown): number[] {
  const ids = new Set<number>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6 || candidate === null || candidate === undefined) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    for (const key of ["itemId", "noteId", "annotationId"]) {
      const id = Math.floor(Number(record[key]));
      if (Number.isFinite(id) && id > 0) ids.add(id);
    }
    if (Array.isArray(record.itemIds)) {
      for (const value of record.itemIds) {
        const id = Math.floor(Number(value));
        if (Number.isFinite(id) && id > 0) ids.add(id);
      }
    }
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return [...ids];
}

function resultObjectIds(
  value: unknown,
  singularKeys: readonly string[],
  pluralKeys: readonly string[],
): number[] {
  const ids = new Set<number>();
  const add = (candidate: unknown): void => {
    const id = Math.floor(Number(candidate));
    if (Number.isFinite(id) && id > 0) ids.add(id);
  };
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 6 || candidate === null || candidate === undefined) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    singularKeys.forEach((key) => add(record[key]));
    for (const key of pluralKeys) {
      const values = record[key];
      if (Array.isArray(values)) values.forEach(add);
    }
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  visit(value, 0);
  return [...ids].sort((left, right) => left - right);
}

function readCollectionChildIds(
  collection: Zotero.Collection,
  method: "getChildItems" | "getChildCollections",
): number[] {
  try {
    return Array.from(
      new Set(
        (collection[method]?.(true, false) || [])
          .map((value: unknown) => Math.floor(Number(value)))
          .filter((value: number) => Number.isFinite(value) && value > 0),
      ),
    ).sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function readSavedSearchState(savedSearchId: number) {
  const search = (
    Zotero as unknown as {
      Searches?: {
        get?: (id: number) =>
          | (Zotero.Search & {
              libraryID?: number;
              name?: string;
              deleted?: boolean;
              getConditions?: () => Record<string, unknown>;
            })
          | null;
      };
    }
  ).Searches?.get?.(savedSearchId);
  if (!search) return { savedSearchId, exists: false } as const;
  let conditions: Array<Record<string, unknown>> = [];
  try {
    conditions = Object.entries(search.getConditions?.() || {})
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, value]) =>
        value && typeof value === "object"
          ? { ...(value as Record<string, unknown>) }
          : { value },
      );
  } catch {
    conditions = [];
  }
  return {
    savedSearchId,
    exists: true,
    libraryID: normalizeLibraryID(search.libraryID),
    name: String(search.name || ""),
    deleted: Boolean(search.deleted),
    conditions,
  } as const;
}

async function readLibraryTagState(
  libraryID: number,
  name: string,
): Promise<NonNullable<LibraryMutationState["libraryTags"]>[number]> {
  const normalizedName = name.trim();
  const tags = (
    Zotero as unknown as {
      Tags?: {
        getID?: (name: string) => number | false;
        getTagItems?: (libraryID: number, tagID: number) => Promise<number[]>;
        getColor?: (
          libraryID: number,
          name: string,
        ) => { color?: unknown; position?: unknown } | false;
      };
    }
  ).Tags;
  if (!tags?.getID || !tags.getTagItems) {
    return {
      libraryID,
      name: normalizedName,
      observable: false,
      exists: false,
      itemIds: [],
    };
  }
  let tagID: number | false;
  let itemIds: number[];
  let color: { color?: unknown; position?: unknown } | false;
  try {
    tagID = tags.getID(normalizedName);
    itemIds = tagID
      ? Array.from(
          new Set(
            (await tags.getTagItems(libraryID, tagID))
              .map((value) => Math.floor(Number(value)))
              .filter((value) => Number.isFinite(value) && value > 0),
          ),
        ).sort((left, right) => left - right)
      : [];
    color = tags.getColor?.(libraryID, normalizedName) || false;
  } catch {
    return {
      libraryID,
      name: normalizedName,
      observable: false,
      exists: false,
      itemIds: [],
    };
  }
  const colorText =
    color && typeof color.color === "string" ? color.color : undefined;
  const position =
    color && Number.isFinite(Number(color.position))
      ? Number(color.position)
      : undefined;
  return {
    libraryID,
    name: normalizedName,
    observable: true,
    exists: itemIds.length > 0 || Boolean(color),
    itemIds,
    ...(colorText ? { color: colorText } : {}),
    ...(position === undefined ? {} : { position }),
  };
}

function readRelationState(
  zoteroGateway: ZoteroGateway,
  operation: RelateItemsOperation,
): NonNullable<LibraryMutationState["relations"]> {
  const source = zoteroGateway.getItem(operation.itemId) as
    | (Zotero.Item & { relatedItems?: readonly string[] })
    | null;
  const sourceRelated = new Set(source?.relatedItems || []);
  return Array.from(new Set(operation.relatedItemIds))
    .sort((left, right) => left - right)
    .map((relatedItemId) => {
      const target = zoteroGateway.getItem(relatedItemId) as
        | (Zotero.Item & { relatedItems?: readonly string[] })
        | null;
      const targetRelated = new Set(target?.relatedItems || []);
      return {
        itemId: operation.itemId,
        relatedItemId,
        related: Boolean(target?.key && sourceRelated.has(target.key)),
        reciprocal: Boolean(source?.key && targetRelated.has(source.key)),
      };
    });
}

function readItemTags(item: Zotero.Item | null): string[] {
  if (!item) return [];
  try {
    return (item.getTags?.() || [])
      .map((entry: unknown) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const record = entry as { tag?: unknown; name?: unknown };
        return typeof record.tag === "string"
          ? record.tag
          : typeof record.name === "string"
            ? record.name
            : "";
      })
      .filter(Boolean)
      .sort((left: string, right: string) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function readItemCollections(item: Zotero.Item | null): number[] {
  if (!item) return [];
  try {
    return (item.getCollections?.() || [])
      .map((value: unknown) => Math.floor(Number(value)))
      .filter((value: number) => Number.isFinite(value) && value > 0)
      .sort((left: number, right: number) => left - right);
  } catch {
    return [];
  }
}

async function readAttachmentPath(item: Zotero.Item | null): Promise<string> {
  if (!item?.isAttachment?.()) return "";
  try {
    const value = await (
      item as Zotero.Item & { getFilePathAsync?: () => Promise<unknown> }
    ).getFilePathAsync?.();
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

const DEFERRED_INVERSE_OPERATIONS = new Set<LibraryMutationOperation["type"]>([
  "create_items",
  "create_collection",
  "save_note",
  "save_notes_batch",
  "import_identifiers",
  "import_local_files",
]);

export class LibraryMutationService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  getGateway(): ZoteroGateway {
    return this.zoteroGateway;
  }

  /**
   * Capture the durable inverse before the forward operation starts.
   *
   * Creation/import operations are the deliberate exception: Zotero assigns
   * their IDs at commit time, so their forward intent is prepared first and
   * the inverse is finalized immediately after execution.
   */
  async planOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<LibraryMutationPlan> {
    const precondition = await this.captureOperationState(operation, context);
    const items = precondition.items || [];
    const description = `Apply ${operation.type}`;

    if (
      DEFERRED_INVERSE_OPERATIONS.has(operation.type) ||
      (operation.type === "save_saved_search" && !operation.savedSearchId)
    ) {
      return {
        effect: "write",
        reversibility: "partial",
        reason:
          "The created Zotero object IDs are assigned only after commit; an interrupted step is reported as uncertain.",
        description,
        precondition,
        deferredInverse: true,
      };
    }

    let inverseOperations: LibraryMutationOperation[] | undefined;
    let reason: string | undefined;
    switch (operation.type) {
      case "update_metadata": {
        const state = items[0];
        if (state?.exists && state.fields) {
          inverseOperations = [
            {
              type: "update_metadata",
              itemId: state.itemId,
              metadata: {
                ...state.fields,
                ...(state.creators ? { creators: state.creators } : {}),
              },
            },
          ];
        }
        break;
      }
      case "apply_tags":
      case "remove_tags":
      case "set_item_tags":
        inverseOperations = [
          {
            type: "set_item_tags",
            assignments: items
              .filter((state) => state.exists)
              .map((state) => ({
                itemId: state.itemId,
                tags: state.tags || [],
              })),
          },
        ];
        break;
      case "move_to_collection":
      case "remove_from_collection":
      case "set_item_collections":
        inverseOperations = [
          {
            type: "set_item_collections",
            assignments: items
              .filter((state) => state.exists)
              .map((state) => ({
                itemId: state.itemId,
                collectionIds: state.collectionIds || [],
              })),
          },
        ];
        break;
      case "update_collection": {
        const collection = precondition.collections?.[0];
        if (collection?.exists) {
          inverseOperations = [
            {
              type: "update_collection",
              collectionId: collection.collectionId,
              name: collection.name,
              parentCollectionId: collection.parentCollectionId,
            },
          ];
        }
        break;
      }
      case "update_library_tag":
        if (operation.action === "rename" && operation.newTag) {
          const source = precondition.libraryTags?.find(
            (state) => state.name === operation.tag.trim(),
          );
          const destination = precondition.libraryTags?.find(
            (state) => state.name === operation.newTag?.trim(),
          );
          const canRenameBack =
            source?.observable === true &&
            source.exists &&
            destination?.observable === true &&
            !destination.exists;
          if (!canRenameBack) {
            reason =
              destination?.exists === true
                ? "The destination tag already exists, so Zotero will merge memberships and cannot later separate them losslessly."
                : "The source and destination tag memberships could not be verified before the rename.";
            break;
          }
          inverseOperations = [
            {
              ...operation,
              tag: operation.newTag,
              newTag: operation.tag,
            },
          ];
        } else {
          reason = `Library tag action ${operation.action} does not preserve enough information for a lossless inverse.`;
        }
        break;
      case "reparent_items":
        inverseOperations = [
          {
            type: "reparent_items",
            assignments: items
              .filter((state) => state.exists)
              .map((state) => ({
                itemId: state.itemId,
                parentItemId: state.parentItemId ?? null,
              })),
          },
        ];
        break;
      case "trash_items":
        inverseOperations = [
          {
            type: "restore_from_trash",
            itemIds: items
              .filter((state) => state.exists && !state.deleted)
              .map((state) => state.itemId),
          },
        ];
        break;
      case "restore_from_trash":
        inverseOperations = operation.itemIds?.length
          ? [{ type: "trash_items", itemIds: operation.itemIds }]
          : undefined;
        if (
          operation.collectionIds?.length ||
          operation.savedSearchIds?.length
        ) {
          reason =
            "The item portion is reversible, but collection/saved-search restore is finalized from Zotero's actual result.";
        }
        break;
      case "delete_collection":
        if (!operation.permanent) {
          inverseOperations = [
            {
              type: "restore_from_trash",
              collectionIds: [operation.collectionId],
            },
          ];
        } else {
          reason = "A permanently erased collection cannot be restored.";
        }
        break;
      case "delete_saved_search":
        if (!operation.permanent) {
          inverseOperations = [
            {
              type: "restore_from_trash",
              savedSearchIds: [operation.savedSearchId],
            },
          ];
        } else {
          reason = "A permanently erased saved search cannot be restored.";
        }
        break;
      case "delete_attachment":
        inverseOperations = [
          {
            type: "restore_from_trash",
            itemIds: [operation.attachmentId],
          },
        ];
        break;
      case "rename_attachment": {
        const previous = items[0]?.attachmentTitle;
        if (previous) {
          inverseOperations = [
            {
              type: "rename_attachment",
              attachmentId: operation.attachmentId,
              newName: previous,
            },
          ];
        }
        break;
      }
      case "relink_attachment": {
        const previous = items[0]?.attachmentPath;
        if (previous) {
          inverseOperations = [
            {
              type: "relink_attachment",
              attachmentId: operation.attachmentId,
              newPath: previous,
            },
          ];
        } else {
          reason = "The attachment had no resolvable previous path.";
        }
        break;
      }
      case "merge_items":
        reason =
          "Merging can move and deduplicate child objects, so it has no lossless inverse.";
        break;
      case "relate_items":
        inverseOperations = [
          {
            ...operation,
            action: operation.action === "add" ? "remove" : "add",
          },
        ];
        break;
      case "save_saved_search":
        reason = operation.savedSearchId
          ? "Replacing a saved search requires its complete prior conditions."
          : "The new saved-search ID is assigned only after commit.";
        break;
    }

    const usefulInverse = inverseOperations?.some((inverse) => {
      const record = inverse as unknown as Record<string, unknown>;
      return !Array.isArray(record.itemIds) || record.itemIds.length > 0;
    });
    return {
      effect: "write",
      reversibility: usefulInverse ? (reason ? "partial" : "full") : "none",
      reason: usefulInverse ? reason : reason || "No lossless inverse exists.",
      description,
      inverseOperations: usefulInverse ? inverseOperations : undefined,
      precondition,
    };
  }

  async captureOperationState(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
    executionResult?: unknown,
  ): Promise<LibraryMutationState> {
    let itemIds = operationItemIds(operation);
    if (executionResult !== undefined) {
      const createdItemIds = resultCreatedItemIds(executionResult);
      itemIds =
        DEFERRED_INVERSE_OPERATIONS.has(operation.type) && createdItemIds.length
          ? createdItemIds
          : Array.from(new Set([...itemIds, ...createdItemIds]));
    }
    if (operation.type === "update_metadata" && !itemIds.length) {
      const target = this.zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: context.item,
        itemId: operation.itemId,
        paperContext: operation.paperContext,
      });
      if (target) itemIds = [target.id];
    }

    const states: MutationItemState[] = [];
    for (const itemId of itemIds) {
      let item =
        typeof this.zoteroGateway.getItem === "function"
          ? this.zoteroGateway.getItem(itemId)
          : null;
      if (!item && operation.type === "update_metadata") {
        item = this.zoteroGateway.resolveMetadataItem({
          request: context.request,
          item: context.item,
          itemId: operation.itemId,
          paperContext: operation.paperContext,
        });
      }
      if (!item) {
        states.push({ itemId, exists: false });
        continue;
      }
      const state: MutationItemState = {
        itemId,
        exists: true,
        parentItemId: Number(item.parentID) > 0 ? Number(item.parentID) : null,
        deleted: Boolean((item as Zotero.Item & { deleted?: boolean }).deleted),
      };
      if (item.isAnnotation?.()) {
        const annotation = item as Zotero.Item & {
          annotationType?: unknown;
          annotationText?: unknown;
          annotationComment?: unknown;
          annotationColor?: unknown;
          annotationPageLabel?: unknown;
          annotationSortIndex?: unknown;
          annotationPosition?: unknown;
        };
        state.annotation = {
          type: String(annotation.annotationType || ""),
          text: String(annotation.annotationText || ""),
          comment: String(annotation.annotationComment || ""),
          color: String(annotation.annotationColor || ""),
          pageLabel: String(annotation.annotationPageLabel || ""),
          sortIndex: String(annotation.annotationSortIndex || ""),
          position: annotation.annotationPosition ?? null,
          tags: readItemTags(item),
        };
      }
      if (operation.type === "update_metadata") {
        const snapshot = this.zoteroGateway.getEditableArticleMetadata(item);
        if (snapshot) {
          state.fields = {};
          for (const field of Object.keys(operation.metadata)) {
            if (field === "creators") continue;
            state.fields[field] = snapshot.fields[
              field as keyof typeof snapshot.fields
            ] as string;
          }
          if (operation.metadata.creators !== undefined) {
            state.creators = snapshot.creators;
          }
        }
      }
      if (
        operation.type === "apply_tags" ||
        operation.type === "remove_tags" ||
        operation.type === "set_item_tags"
      ) {
        state.tags = readItemTags(item);
      }
      if (
        operation.type === "move_to_collection" ||
        operation.type === "remove_from_collection" ||
        operation.type === "set_item_collections"
      ) {
        state.collectionIds = readItemCollections(item);
      }
      if (
        operation.type === "rename_attachment" ||
        operation.type === "relink_attachment"
      ) {
        state.attachmentTitle =
          String(
            (item as Zotero.Item & { attachmentFilename?: unknown })
              .attachmentFilename ||
              item.getField?.("title") ||
              "",
          ).trim() || undefined;
        state.attachmentPath = (await readAttachmentPath(item)) || undefined;
      }
      const captureCompleteItemFingerprint =
        DEFERRED_INVERSE_OPERATIONS.has(operation.type) ||
        operation.type === "trash_items" ||
        operation.type === "restore_from_trash";
      if (captureCompleteItemFingerprint) {
        const snapshot =
          typeof this.zoteroGateway.getEditableArticleMetadata === "function"
            ? this.zoteroGateway.getEditableArticleMetadata(item)
            : null;
        const version = Number(
          (item as Zotero.Item & { version?: unknown }).version,
        );
        if (Number.isFinite(version)) state.version = version;
        const dateModified = String(
          (item as Zotero.Item & { dateModified?: unknown }).dateModified || "",
        );
        if (dateModified) state.dateModified = dateModified;
        if (snapshot?.fields) state.fields = snapshot.fields;
        if (snapshot?.creators) state.creators = snapshot.creators;
        state.tags = readItemTags(item);
        state.collectionIds = readItemCollections(item);
        const attachmentTitle = String(
          (item as Zotero.Item & { attachmentFilename?: unknown })
            .attachmentFilename ||
            item.getField?.("title") ||
            "",
        ).trim();
        if (attachmentTitle) state.attachmentTitle = attachmentTitle;
        const attachmentPath = await readAttachmentPath(item);
        if (attachmentPath) state.attachmentPath = attachmentPath;
        state.childAttachmentIds = Array.from(
          new Set(
            (item.getAttachments?.() || [])
              .map((value: unknown) => Math.floor(Number(value)))
              .filter((value: number) => Number.isFinite(value) && value > 0),
          ),
        ).sort((left, right) => left - right);
        state.childNoteIds = Array.from(
          new Set(
            (item.getNotes?.() || [])
              .map((value: unknown) => Math.floor(Number(value)))
              .filter((value: number) => Number.isFinite(value) && value > 0),
          ),
        ).sort((left, right) => left - right);
        if (item.isNote?.()) {
          state.noteHtmlChecksum = await sha256Text(item.getNote?.() || "");
        }
      }
      states.push(state);
    }

    const collectionIds = new Set<number>();
    if (
      operation.type === "update_collection" ||
      operation.type === "delete_collection"
    ) {
      collectionIds.add(operation.collectionId);
    }
    if (operation.type === "restore_from_trash") {
      operation.collectionIds?.forEach((id) => collectionIds.add(id));
    }
    if (executionResult !== undefined) {
      const resultIds = resultObjectIds(
        executionResult,
        operation.type === "create_collection" ? ["collectionId"] : [],
        ["restoredCollectionIds"],
      );
      resultIds.forEach((id) => collectionIds.add(id));
    }
    const collections = [...collectionIds]
      .sort((left, right) => left - right)
      .map((collectionId) => {
        const collection = this.zoteroGateway.getCollection(collectionId);
        return collection
          ? {
              collectionId,
              exists: true,
              name: String(collection.name || ""),
              parentCollectionId:
                Number(collection.parentID) > 0
                  ? Number(collection.parentID)
                  : null,
              deleted: Boolean(
                (collection as Zotero.Collection & { deleted?: boolean })
                  .deleted,
              ),
              directItemIds: readCollectionChildIds(
                collection,
                "getChildItems",
              ),
              childCollectionIds: readCollectionChildIds(
                collection,
                "getChildCollections",
              ),
            }
          : { collectionId, exists: false };
      });

    const savedSearchIds = new Set<number>();
    if (operation.type === "save_saved_search" && operation.savedSearchId) {
      savedSearchIds.add(operation.savedSearchId);
    }
    if (operation.type === "delete_saved_search") {
      savedSearchIds.add(operation.savedSearchId);
    }
    if (operation.type === "restore_from_trash") {
      operation.savedSearchIds?.forEach((id) => savedSearchIds.add(id));
    }
    if (executionResult !== undefined) {
      resultObjectIds(
        executionResult,
        operation.type === "save_saved_search" ? ["savedSearchId"] : [],
        ["restoredSavedSearchIds"],
      ).forEach((id) => savedSearchIds.add(id));
    }
    const savedSearches = [...savedSearchIds]
      .sort((left, right) => left - right)
      .map(readSavedSearchState);

    let libraryTags: LibraryMutationState["libraryTags"];
    if (operation.type === "update_library_tag") {
      const libraryID = this.zoteroGateway.resolveLibraryID({
        request: context.request,
        item: context.item,
        libraryID: operation.libraryID,
      });
      const names = Array.from(
        new Set(
          [operation.tag, operation.newTag]
            .filter((value): value is string => Boolean(value?.trim()))
            .map((value) => value.trim()),
        ),
      );
      libraryTags = [];
      for (const name of names) {
        libraryTags.push(await readLibraryTagState(libraryID, name));
      }
    }

    const relations =
      operation.type === "relate_items"
        ? readRelationState(this.zoteroGateway, operation)
        : undefined;
    return {
      version: 1,
      operation: operation.type,
      ...(states.length ? { items: states } : {}),
      ...(collections.length ? { collections } : {}),
      ...(savedSearches.length ? { savedSearches } : {}),
      ...(libraryTags?.length ? { libraryTags } : {}),
      ...(relations?.length ? { relations } : {}),
    };
  }

  async executeOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<LibraryMutationExecution> {
    const execution = await this.performOperation(operation, context);
    const affectedCount = mutationAffectedCount(
      operation,
      execution.result.result,
    );
    return {
      ...execution,
      effect: mutationEffect(operation, affectedCount),
      affectedCount,
    };
  }

  private async performOperation(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
  ): Promise<{
    result: LibraryMutationExecutionResult;
    inverse?: LibraryMutationInverse | null;
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
          inverse: previousSnapshot
            ? buildMetadataInverse(previousSnapshot)
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
          inverse: buildTagInverse(
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
          inverse: buildRemoveTagsInverse(removed),
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
          inverse:
            operation.mode === "move" && result.priorCollections?.length
              ? buildCollectionSetInverse(result.priorCollections)
              : buildCollectionAddInverse(
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
          inverse:
            result.status === "created"
              ? {
                  inverseOperations: [
                    {
                      type: "delete_saved_search" as const,
                      savedSearchId: result.savedSearchId,
                      permanent: true,
                    },
                  ],
                  description: `Delete the saved search "${result.name}"`,
                }
              : null,
        };
      }
      case "delete_saved_search": {
        const result = await this.zoteroGateway.deleteSavedSearch({
          savedSearchId: operation.savedSearchId,
          ...(operation.permanent ? { permanent: true } : {}),
        });
        return {
          result: {
            operation: operation.type,
            operationId: operation.id,
            result,
          },
          inverse:
            result.status === "trashed"
              ? {
                  inverseOperations: [
                    {
                      type: "restore_from_trash" as const,
                      savedSearchIds: [operation.savedSearchId],
                    },
                  ],
                  description: `Restore the saved search from the trash`,
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
          inverse:
            result.status === "updated"
              ? {
                  inverseOperations: [
                    {
                      type: "update_collection" as const,
                      collectionId: operation.collectionId,
                      name: result.previousName,
                      parentCollectionId: result.previousParentCollectionId,
                    },
                  ],
                  description: `Rename "${result.name}" back to "${result.previousName}"`,
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
          inverse:
            result.status === "applied" &&
            operation.action === "rename" &&
            result.newTag &&
            result.destinationExisted === false
              ? {
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
                }
              : result.status === "applied" &&
                  (operation.action === "delete" ||
                    operation.action === "merge" ||
                    (operation.action === "rename" &&
                      result.destinationExisted !== false))
                ? {
                    irreversibleReason:
                      operation.action === "delete"
                        ? `Deleting the tag "${operation.tag}" library-wide also discards which items carried it, so it cannot be restored.`
                        : `Combining the tag "${operation.tag}" with the existing tag "${operation.newTag || "another tag"}" destroys which items originally carried each tag, so it cannot be separated safely.`,
                    description:
                      operation.action === "delete"
                        ? `Delete tag "${operation.tag}"`
                        : `Merge tag "${operation.tag}"`,
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
          inverse: changed.length
            ? {
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
              createdCount: rows.filter((row) => row.status === "created")
                .length,
              failedCount: rows.filter((row) => row.status === "error").length,
              notes: rows,
            },
          },
          inverse: createdNoteIds.length
            ? {
                inverseOperations: [
                  { type: "trash_items", itemIds: createdNoteIds },
                ],
                description: `Trash ${createdNoteIds.length} note${
                  createdNoteIds.length === 1 ? "" : "s"
                } that were just written`,
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
          inverse: createdIds.length
            ? {
                inverseOperations: [
                  { type: "trash_items", itemIds: createdIds },
                ],
                description: `Trash ${createdIds.length} newly created item${
                  createdIds.length === 1 ? "" : "s"
                }`,
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
          inverse: moved.length
            ? {
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
          inverse: affected.length
            ? {
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
          inverse: result.priorCollections.length
            ? buildCollectionSetInverse(result.priorCollections)
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
          inverse: removedItems.length
            ? buildCollectionRemoveInverse(removedItems)
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
          inverse: buildCreateCollectionInverse(collection),
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
          ...(operation.deleteItems ? { deleteItems: true } : {}),
          ...(operation.permanent ? { permanent: true } : {}),
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
          inverse:
            snapshot && !operation.permanent
              ? buildDeleteCollectionInverse({
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
          inverse:
            saved.noteId && saved.noteId > 0
              ? buildSaveNoteInverse(saved.noteId)
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
          inverse: importedIds.length
            ? {
                inverseOperations: [
                  { type: "trash_items" as const, itemIds: importedIds },
                ],
                description: `Trash the ${importedIds.length} imported item${
                  importedIds.length === 1 ? "" : "s"
                }`,
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
          inverse:
            result.trashedCount > 0
              ? {
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
          : { restoredCount: 0, collectionIds: [] as number[] };
        const restoredSearches = savedSearchIds.length
          ? await this.zoteroGateway.restoreSavedSearches({ savedSearchIds })
          : { restoredCount: 0, savedSearchIds: [] as number[] };
        const restoredCollectionIds = Array.isArray(
          restoredCollections.collectionIds,
        )
          ? restoredCollections.collectionIds
          : [];
        const restoredSavedSearchIds = Array.isArray(
          restoredSearches.savedSearchIds,
        )
          ? restoredSearches.savedSearchIds
          : [];
        const incompleteRestoreIdentity =
          restoredCollectionIds.length < restoredCollections.restoredCount ||
          restoredSavedSearchIds.length < restoredSearches.restoredCount;
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
              restoredCollectionIds,
              restoredSavedSearchIds,
              restoredCount: total,
            },
          },
          // The inverse re-trashes only what this call actually restored, so
          // undoing a partial restore cannot sweep up untouched siblings.
          inverse: total
            ? {
                inverseOperations: [
                  ...(restoredItems.itemIds.length
                    ? [
                        {
                          type: "trash_items" as const,
                          itemIds: restoredItems.itemIds,
                        },
                      ]
                    : []),
                  ...restoredCollectionIds.map((collectionId) => ({
                    type: "delete_collection" as const,
                    collectionId,
                  })),
                  ...restoredSavedSearchIds.map((savedSearchId) => ({
                    type: "delete_saved_search" as const,
                    savedSearchId,
                  })),
                ],
                description: `Move ${total} restored object${total === 1 ? "" : "s"} back to the trash`,
                ...(incompleteRestoreIdentity
                  ? {
                      irreversibleReason:
                        "Some restored collection or saved-search IDs were not reported by Zotero, so only the identified objects can be returned to the trash safely.",
                    }
                  : {}),
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
          inverse:
            result.mergedCount > 0
              ? {
                  description: `Bring ${result.mergedCount} merged item${
                    result.mergedCount === 1 ? "" : "s"
                  } back from the trash (their attachments, notes and tags stay with the surviving item, so this does not fully un-merge them)`,
                  irreversibleReason:
                    "A Zotero merge cannot be safely undone because child records may be deduplicated or moved onto the surviving item.",
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
          inverse:
            result.status === "deleted"
              ? {
                  inverseOperations: [
                    {
                      type: "restore_from_trash" as const,
                      itemIds: [operation.attachmentId],
                    },
                  ],
                  description: `Restore deleted attachment: ${result.title}`,
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
          inverse:
            result.status === "renamed" && result.previousName
              ? {
                  inverseOperations: [
                    {
                      type: "rename_attachment" as const,
                      attachmentId: operation.attachmentId,
                      newName: result.previousName,
                    },
                  ],
                  description: `Rename attachment back to "${result.previousName}"`,
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
          inverse:
            result.status === "relinked" && result.previousPath
              ? {
                  inverseOperations: [
                    {
                      type: "relink_attachment" as const,
                      attachmentId: operation.attachmentId,
                      newPath: result.previousPath,
                    },
                  ],
                  description: `Re-link attachment back to ${result.previousPath}`,
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
          inverse:
            result.succeeded > 0
              ? {
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
                }
              : null,
        };
      }
    }
  }
}
