import type { AgentToolContext } from "../../types";
import { sha256Text } from "../../store/journalRecoveryBlobStore";
import type { ZoteroGateway } from "../zoteroGateway";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
  MutationItemState,
  RelateItemsOperation,
} from "./contracts";
import { mutationUsesDeferredInverse } from "./handlerRegistry";

function normalizeLibraryID(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
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

export class MutationStateReader {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  async captureOperationState(
    operation: LibraryMutationOperation,
    context: AgentToolContext,
    executionResult?: unknown,
  ): Promise<LibraryMutationState> {
    let itemIds = operationItemIds(operation);
    if (executionResult !== undefined) {
      const createdItemIds = resultCreatedItemIds(executionResult);
      itemIds =
        mutationUsesDeferredInverse(operation) && createdItemIds.length
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
        mutationUsesDeferredInverse(operation) ||
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
        const isRegularItem =
          item.isRegularItem?.() === true ||
          (typeof item.isRegularItem !== "function" &&
            item.isNote?.() !== true &&
            item.isAttachment?.() !== true);
        if (isRegularItem) {
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
        }
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
}
