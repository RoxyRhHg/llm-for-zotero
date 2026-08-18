import {
  browsePaperCollectionCandidates,
  invalidatePaperSearchCache,
  listLibraryPaperCandidates,
  searchPaperCandidates,
  searchAllItemCandidates,
  type PaperBrowseCollectionCandidate,
  type PaperSearchGroupCandidate,
} from "../../modules/contextPanel/paperSearch";
import {
  createNoteFromAssistantText,
  createStandaloneNoteFromAssistantText,
  normalizeNoteSourceText,
  readNoteSnapshot,
  renderRawNoteHtml,
  stripNoteHtml,
} from "../../modules/contextPanel/notes";
import {
  importNoteImageAsset,
  type NoteImageImportInput,
} from "../../modules/contextPanel/noteImages";
import {
  getActiveContextAttachmentFromTabs,
  resolveContextSourceItem,
} from "../../modules/contextPanel/contextResolution";
import { resolvePaperContextRefFromAttachment } from "../../modules/contextPanel/paperAttribution";
import { invalidateCachedContextText } from "../../modules/contextPanel/pdfContext";
import { ensureMineruCacheDirForAttachment } from "../../modules/contextPanel/mineruSync";
import { persistVerifiedNoteHtml } from "../../modules/contextPanel/notePersistence";
import type { AgentRuntimeRequest } from "../types";
import type {
  GeneratedChatImage,
  PaperContentSourceMode,
  PaperContextRef,
  TagContextRef,
} from "../../shared/types";
import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../../modules/contextPanel/portalScope";
import {
  refusalFor,
  type LibraryOperation,
} from "../capabilities/libraryObjects";

export const EDITABLE_ARTICLE_METADATA_FIELDS = [
  "title",
  "shortTitle",
  "abstractNote",
  "publicationTitle",
  "journalAbbreviation",
  "proceedingsTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "extra",
  "ISSN",
  "ISBN",
  "publisher",
  "place",
] as const;

export type EditableArticleMetadataField =
  (typeof EDITABLE_ARTICLE_METADATA_FIELDS)[number];

export type EditableArticleCreator = {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  fieldMode?: 0 | 1;
};

export type EditableArticleMetadataPatch = Partial<
  Record<EditableArticleMetadataField, string>
> & {
  creators?: EditableArticleCreator[];
};

export type EditableArticleMetadataSnapshot = {
  itemId: number;
  itemType: string;
  title: string;
  fields: Record<EditableArticleMetadataField, string>;
  creators: EditableArticleCreator[];
};

export type LibraryPaperTargetAttachment = {
  contextItemId: number;
  title: string;
};

export type LibraryPaperTarget = {
  itemId: number;
  libraryID?: number;
  title: string;
  firstCreator?: string;
  year?: string;
  dateAdded?: string;
  attachments: LibraryPaperTargetAttachment[];
  tags: string[];
  collectionIds: number[];
};

export type LibraryItemTargetAttachment = {
  contextItemId: number;
  title: string;
  contentType: string;
  /** For PDF attachments: Zotero full-text indexing state. Omitted for non-PDFs. */
  indexingState?:
    | "indexed"
    | "partial"
    | "unindexed"
    | "queued"
    | "unavailable";
  /** If MinerU has parsed this PDF, the cache directory path containing markdown + images. */
  mineruCacheDir?: string;
};

export type LibraryItemTarget = {
  itemId: number;
  libraryID?: number;
  itemType: string;
  title: string;
  firstCreator?: string;
  year?: string;
  dateAdded?: string;
  attachments: LibraryItemTargetAttachment[];
  tags: string[];
  collectionIds: number[];
  noteKind?: "item" | "standalone";
};

export type CollectionBrowseNode = {
  collectionId: number;
  name: string;
  paperCount: number;
  descendantPaperCount: number;
  childCollections: CollectionBrowseNode[];
};

/**
 * Result of `saveAnswerToNote`.
 *
 * The bare `"created" | "appended" | "standalone_created"` string this
 * replaced is why no caller could act on a note it had just written — the id
 * existed two layers down and was thrown away on the way up (issue #374).
 */
export type SaveAnswerToNoteResult = {
  status: "created" | "appended" | "standalone_created";
  noteId?: number;
  collections?: number[];
};

export type CollectionSummary = {
  collectionId: number;
  name: string;
  libraryID: number;
  path?: string;
};

export type BatchTagItemResult = {
  itemId: number;
  title: string;
  status: "updated" | "skipped" | "missing";
  addedTags: string[];
  skippedTags: string[];
  reason?: string;
};

export type BatchTagAssignment = {
  itemId: number;
  tags: string[];
};

export type BatchMoveItemResult = {
  itemId: number;
  title: string;
  status: "moved" | "skipped" | "missing";
  targetCollectionId?: number;
  targetCollectionName?: string;
  reason?: string;
};

export type BatchMoveAssignment = {
  itemId: number;
  targetCollectionId: number;
};

/**
 * The exact collection membership an item should end up with.
 *
 * This is the primitive a real "move" needs. Membership is a *set*, so the
 * only way to move an item without corrupting it is to state the whole set
 * at once — and the only inverse that restores a move is the set it had
 * before. Expressing a move as add-then-remove cannot do either.
 */
export type ItemCollectionSet = {
  itemId: number;
  collectionIds: number[];
};

export type PaperNoteRecord = {
  noteId: number;
  title: string;
  noteText: string;
  wordCount: number;
};

export type PaperAnnotationRecord = {
  annotationId: number;
  type: string;
  text: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
};

export type RelatedPaperResult = LibraryPaperTarget & {
  matchScore: number;
  matchReasons: string[];
};

export type DuplicateGroup = {
  matchReason: string;
  papers: LibraryPaperTarget[];
};

function normalizeMetadataValue(value: unknown): string {
  return `${value ?? ""}`.trim();
}

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

/**
 * Resolves an item for a collection-membership write and reports why it may
 * not proceed, using the declared capability matrix rather than the old
 * regular-item filter.
 *
 * The behaviour change that matters: standalone notes and standalone
 * attachments are legal collection members in Zotero and are now filed
 * instead of being reported as "Item not found", and a child attachment is
 * refused explicitly instead of silently filing its parent.
 *
 * Portal pseudo-items are still unwrapped first — they stand in for a real
 * paper and must be resolved before the matrix sees them.
 */
function resolveMatrixItem(
  item: Zotero.Item | null | undefined,
  itemId: number,
  operation: LibraryOperation,
): { item: Zotero.Item } | { refusal: string } {
  if (!item) {
    return { refusal: `No item with ID ${itemId} exists in this library` };
  }
  if (isGlobalPortalItem(item)) {
    return { refusal: "The library portal is not an item that can be filed" };
  }
  const resolved = isPaperPortalItem(item)
    ? resolvePaperPortalBaseItem(item)
    : item;
  if (!resolved) {
    return { refusal: `No item with ID ${itemId} exists in this library` };
  }
  const refusal = refusalFor(operation, resolved, itemId);
  return refusal ? { refusal } : { item: resolved };
}

function resolveRegularItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) return null;
  if (isGlobalPortalItem(item)) return null;
  if (isPaperPortalItem(item)) {
    return resolvePaperPortalBaseItem(item);
  }
  if (item.isAttachment() && item.parentID) {
    const parent = Zotero.Items.get(item.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return item?.isRegularItem?.() ? item : null;
}

function getItemTypeName(item: Zotero.Item): string {
  try {
    const name = (
      Zotero as unknown as { ItemTypes?: { getName?: (id: number) => string } }
    ).ItemTypes?.getName?.(item.itemTypeID);
    return typeof name === "string" && name.trim() ? name.trim() : "";
  } catch (_error) {
    void _error;
    return "";
  }
}

/**
 * Fields that are never patchable, whatever the item type.
 *
 * These are primary or computed columns rather than `itemData` fields.
 * `setField` throws for most of them, and the few it accepts (`dateAdded`,
 * `dateModified`) would let the agent rewrite provenance -- so they are
 * refused here with a reason rather than surfacing as a raw Zotero throw.
 */
const NON_EDITABLE_METADATA_FIELDS = new Set([
  "id",
  "key",
  "libraryID",
  "itemID",
  "itemType",
  "itemTypeID",
  "dateAdded",
  "dateModified",
  "version",
  "synced",
  "deleted",
  "firstCreator",
  "numChildren",
  "parentItem",
  "parentID",
  "parentKey",
  "relations",
  "collections",
  "tags",
  "note",
  "createdByUserID",
  "lastModifiedByUserID",
]);

/**
 * Whether a field can be written on this particular item.
 *
 * Two defects here, both of which reported success while doing the wrong
 * thing:
 *
 * - No base-field mapping. `publicationTitle` is a *base* field whose
 *   type-specific name is `bookTitle` on a book section and
 *   `proceedingsTitle` on a conference paper. Checking the base id against
 *   the type said "invalid" for fields Zotero writes happily. `setField`
 *   itself resolves this with `getFieldIDFromTypeAndBase`, so the check has
 *   to as well or it disagrees with the write it is guarding.
 * - Fail-open. The `catch` returned `true`, so if `Zotero.ItemFields` were
 *   missing every field was declared valid and the error surfaced later as a
 *   raw throw from `setField`. No test defines `ItemFields`, so that branch
 *   has never run in CI.
 */
function isFieldValidForItemType(
  item: Zotero.Item,
  fieldName: string,
): boolean {
  if (NON_EDITABLE_METADATA_FIELDS.has(fieldName)) return false;
  const itemFields = (
    Zotero as unknown as {
      ItemFields?: {
        getID?: (name: string) => number | false;
        isValidForType?: (fieldId: number, itemTypeId: number) => boolean;
        getFieldIDFromTypeAndBase?: (
          itemTypeId: number,
          baseFieldId: number,
        ) => number | false;
      };
    }
  ).ItemFields;
  // Fail closed: without the schema there is no way to tell a valid field
  // from a typo, and guessing "valid" turns a typo into a thrown write.
  if (!itemFields?.getID || typeof itemFields.isValidForType !== "function") {
    return false;
  }
  try {
    const baseFieldId = itemFields.getID(fieldName);
    if (!baseFieldId) return false;
    const itemTypeID = item.itemTypeID;
    // Mirrors setField: prefer the type-specific field, fall back to the base.
    const fieldId =
      itemFields.getFieldIDFromTypeAndBase?.(itemTypeID, baseFieldId) ||
      baseFieldId;
    return Boolean(itemFields.isValidForType(fieldId, itemTypeID));
  } catch {
    return false;
  }
}

/**
 * Every field this item type accepts, for telling the model what it may set.
 */
export function listEditableFieldsForItem(item: Zotero.Item): string[] {
  const itemFields = (
    Zotero as unknown as {
      ItemFields?: {
        getItemTypeFields?: (itemTypeId: number) => number[];
        getName?: (fieldId: number) => string;
      };
    }
  ).ItemFields;
  if (!itemFields?.getItemTypeFields || !itemFields.getName) return [];
  try {
    return itemFields
      .getItemTypeFields(item.itemTypeID)
      .map((fieldId) => itemFields.getName?.(fieldId) || "")
      .filter((name) => name && !NON_EDITABLE_METADATA_FIELDS.has(name));
  } catch {
    return [];
  }
}

function normalizeCreatorForSnapshot(
  creator: _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator,
): EditableArticleCreator | null {
  const creatorType =
    typeof (creator as { creatorType?: unknown }).creatorType === "string" &&
    (creator as { creatorType?: string }).creatorType?.trim()
      ? (creator as { creatorType: string }).creatorType.trim()
      : "author";
  const name =
    typeof (creator as { name?: unknown }).name === "string" &&
    (creator as { name?: string }).name?.trim()
      ? (creator as { name: string }).name.trim()
      : undefined;
  const firstName =
    typeof (creator as { firstName?: unknown }).firstName === "string" &&
    (creator as { firstName?: string }).firstName?.trim()
      ? (creator as { firstName: string }).firstName.trim()
      : undefined;
  const lastName =
    typeof (creator as { lastName?: unknown }).lastName === "string" &&
    (creator as { lastName?: string }).lastName?.trim()
      ? (creator as { lastName: string }).lastName.trim()
      : undefined;
  const fieldMode =
    Number((creator as { fieldMode?: unknown }).fieldMode) === 1 || name
      ? 1
      : 0;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode,
  };
}

function isPaperContentSourceMode(
  value: unknown,
): value is PaperContentSourceMode {
  return (
    value === "text" ||
    value === "mineru" ||
    value === "pdf" ||
    value === "markdown" ||
    value === "html" ||
    value === "txt" ||
    value === "docx"
  );
}

function normalizePaperContexts(
  entries: PaperContextRef[] | undefined,
): PaperContextRef[] {
  if (!Array.isArray(entries)) return [];
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const itemId = Number(entry.itemId);
    const contextItemId = Number(entry.contextItemId);
    if (!Number.isFinite(itemId) || !Number.isFinite(contextItemId)) continue;
    const normalized: PaperContextRef = {
      itemId: Math.floor(itemId),
      contextItemId: Math.floor(contextItemId),
      title: `${entry.title || `Paper ${Math.floor(itemId)}`}`.trim(),
      attachmentTitle: entry.attachmentTitle?.trim() || undefined,
      citationKey: entry.citationKey?.trim() || undefined,
      firstCreator: entry.firstCreator?.trim() || undefined,
      year: entry.year?.trim() || undefined,
    };
    if (isPaperContentSourceMode(entry.contentSourceMode)) {
      normalized.contentSourceMode = entry.contentSourceMode;
    }
    if (entry.mineruCacheDir?.trim()) {
      normalized.mineruCacheDir = entry.mineruCacheDir.trim();
    }
    const key = `${normalized.itemId}:${normalized.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function getCollectionIDs(item: Zotero.Item | null | undefined): number[] {
  if (!item) return [];
  try {
    return item
      .getCollections()
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
  } catch (_error) {
    void _error;
    return [];
  }
}

function resolveLibraryDisplayName(libraryID: number): string {
  try {
    const libraries = (
      Zotero as unknown as {
        Libraries?: {
          getName?: (targetLibraryID: number) => unknown;
          get?: (
            targetLibraryID: number,
          ) => { name?: unknown } | null | undefined;
        };
      }
    ).Libraries;
    const directName = normalizeText(libraries?.getName?.(libraryID));
    if (directName) return directName;
    const library = libraries?.get?.(libraryID);
    const objectName = normalizeText(library?.name);
    if (objectName) return objectName;
  } catch (_error) {
    void _error;
  }
  return "My Library";
}

function getPdfChildAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  for (const attachmentId of item.getAttachments()) {
    const attachment = Zotero.Items.get(attachmentId) || null;
    if (
      attachment &&
      attachment.isAttachment?.() &&
      attachment.attachmentContentType === "application/pdf"
    ) {
      out.push(attachment);
    }
  }
  return out;
}

function getAllChildAttachments(item: Zotero.Item): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  if (!item?.isRegularItem?.()) return out;
  for (const attachmentId of item.getAttachments()) {
    const att = Zotero.Items.get(attachmentId) || null;
    if (att && att.isAttachment?.()) out.push(att);
  }
  return out;
}

function resolveAttachmentTitle(
  attachment: Zotero.Item,
  index: number,
  total: number,
): string {
  const title = normalizeText(attachment.getField?.("title"));
  if (title) return title;
  const filename = normalizeText(
    (attachment as unknown as { attachmentFilename?: string })
      .attachmentFilename,
  );
  if (filename) return filename;
  return total > 1 ? `PDF ${index + 1}` : "PDF";
}

function resolveAnyAttachmentTitle(
  attachment: Zotero.Item,
  index: number,
  total: number,
): string {
  const title = normalizeText(attachment.getField?.("title"));
  if (title) return title;
  const filename = normalizeText(
    (attachment as unknown as { attachmentFilename?: string })
      .attachmentFilename,
  );
  if (filename) return filename;
  const contentType = normalizeText(attachment.attachmentContentType);
  if (contentType) {
    const ext = contentType.split("/").pop() || contentType;
    return total > 1 ? `${ext.toUpperCase()} ${index + 1}` : ext.toUpperCase();
  }
  return total > 1 ? `Attachment ${index + 1}` : "Attachment";
}

function getItemTags(
  item: Zotero.Item | null | undefined,
  options: { includeAutomatic?: boolean } = {},
): string[] {
  if (!item) return [];
  const includeAutomatic = options.includeAutomatic !== false;
  try {
    const out = (item.getTags?.() || [])
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object") {
          const typed = entry as {
            tag?: unknown;
            name?: unknown;
            type?: unknown;
          };
          if (typed.type === 1 && !includeAutomatic) return "";
          return typeof typed.tag === "string"
            ? typed.tag
            : typeof typed.name === "string"
              ? typed.name
              : "";
        }
        return "";
      })
      .map((entry) => normalizeText(entry))
      .filter(Boolean);
    return Array.from(new Set(out)).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildPaperTargetFromItem(
  item: Zotero.Item,
): LibraryPaperTarget | null {
  const target = resolveRegularItem(item);
  if (!target) return null;
  const attachments = getPdfChildAttachments(target).map(
    (attachment, index, list) => ({
      contextItemId: attachment.id,
      title: resolveAttachmentTitle(attachment, index, list.length),
    }),
  );
  if (!attachments.length) return null;
  return {
    itemId: target.id,
    libraryID: Number(target.libraryID) || undefined,
    title:
      normalizeText(target.getField?.("title")) ||
      normalizeText(target.getDisplayTitle?.()) ||
      `Item ${target.id}`,
    firstCreator:
      normalizeText(target.firstCreator) ||
      normalizeText(target.getField?.("firstCreator")) ||
      undefined,
    year:
      normalizeText(target.getField?.("date")).match(/\b(19|20)\d{2}\b/)?.[0] ||
      undefined,
    dateAdded: normalizeText(target.getField?.("dateAdded")) || undefined,
    attachments,
    tags: getItemTags(target),
    collectionIds: getCollectionIDs(target),
  };
}

function buildItemTargetFromItem(item: Zotero.Item): LibraryItemTarget | null {
  // Standalone attachment/file (no parent item)
  if (item.isAttachment?.() && !item.parentID) {
    const title = resolveAnyAttachmentTitle(item, 0, 1);
    return {
      itemId: item.id,
      libraryID: Number(item.libraryID) || undefined,
      itemType: "attachment",
      title,
      dateAdded: normalizeText(item.getField?.("dateAdded")) || undefined,
      attachments: [
        {
          contextItemId: item.id,
          title,
          contentType:
            normalizeText(item.attachmentContentType) ||
            "application/octet-stream",
        },
      ],
      tags: getItemTags(item),
      collectionIds: getCollectionIDs(item),
    };
  }
  // Standalone note (no parent)
  if ((item as any).isNote?.() && !item.parentID) {
    const rawTitle = normalizeText(
      (item as any).getNoteTitle?.() || item.getDisplayTitle?.() || "",
    );
    return {
      itemId: item.id,
      libraryID: Number(item.libraryID) || undefined,
      itemType: "note",
      title: rawTitle || `Note ${item.id}`,
      dateAdded: normalizeText(item.getField?.("dateAdded")) || undefined,
      attachments: [],
      tags: getItemTags(item),
      collectionIds: getCollectionIDs(item),
      noteKind: "standalone",
    };
  }
  // Regular item (with or without PDF)
  const target = resolveRegularItem(item);
  if (!target) return null;
  const allAtts = getAllChildAttachments(target);
  return {
    itemId: target.id,
    libraryID: Number(target.libraryID) || undefined,
    itemType: getItemTypeName(target),
    title:
      normalizeText(target.getField?.("title")) ||
      normalizeText(target.getDisplayTitle?.()) ||
      `Item ${target.id}`,
    firstCreator:
      normalizeText(target.firstCreator) ||
      normalizeText(target.getField?.("firstCreator")) ||
      undefined,
    year:
      normalizeText(target.getField?.("date")).match(/\b(19|20)\d{2}\b/)?.[0] ||
      undefined,
    dateAdded: normalizeText(target.getField?.("dateAdded")) || undefined,
    attachments: allAtts.map((att, index, list) => ({
      contextItemId: att.id,
      title: resolveAnyAttachmentTitle(att, index, list.length),
      contentType:
        normalizeText(att.attachmentContentType) || "application/octet-stream",
    })),
    tags: getItemTags(target),
    collectionIds: getCollectionIDs(target),
  };
}

function summarizeCollectionNode(
  candidate: PaperBrowseCollectionCandidate,
): CollectionBrowseNode {
  const childCollections = candidate.childCollections.map((entry) =>
    summarizeCollectionNode(entry),
  );
  const paperCount = candidate.papers.length;
  const descendantPaperCount =
    paperCount +
    childCollections.reduce(
      (sum, entry) => sum + entry.descendantPaperCount,
      0,
    );
  return {
    collectionId: candidate.collectionId,
    name:
      normalizeText(candidate.name) || `Collection ${candidate.collectionId}`,
    paperCount,
    descendantPaperCount,
    childCollections,
  };
}

function listLibraryCollections(libraryID: number): Zotero.Collection[] {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  try {
    return Zotero.Collections.getByLibrary(Math.floor(libraryID), true) || [];
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildCollectionPathMap(
  collections: Zotero.Collection[],
): Map<number, string> {
  const byId = new Map<number, Zotero.Collection>();
  const pathById = new Map<number, string>();
  for (const collection of collections) {
    byId.set(collection.id, collection);
  }
  const resolvePath = (collectionId: number): string => {
    const cached = pathById.get(collectionId);
    if (cached) return cached;
    const collection = byId.get(collectionId);
    if (!collection) return "";
    const name =
      normalizeText(collection.name) || `Collection ${collection.id}`;
    const parentId = Number(collection.parentID);
    if (!Number.isFinite(parentId) || parentId <= 0 || !byId.has(parentId)) {
      pathById.set(collectionId, name);
      return name;
    }
    const path = `${resolvePath(Math.floor(parentId))} / ${name}`;
    pathById.set(collectionId, path);
    return path;
  };
  for (const collection of collections) {
    resolvePath(collection.id);
  }
  return pathById;
}

async function getAllLibraryItems(libraryID: number): Promise<Zotero.Item[]> {
  try {
    const items: Zotero.Item[] = await Zotero.Items.getAll(
      libraryID,
      true,
      false,
      false,
    );
    return items.filter((item) => {
      // Include regular items, standalone notes, and standalone attachments.
      // Exclude child attachments, annotations, and child notes.
      if ((item as any).isNote?.()) return !item.parentID;
      if (item.isAttachment?.()) return !item.parentID;
      return item.isRegularItem?.() ?? false;
    });
  } catch (_error) {
    void _error;
    return [];
  }
}

function buildItemTargets(
  items: Zotero.Item[],
  options?: { itemType?: string; hasPdf?: boolean },
): LibraryItemTarget[] {
  const typeFilter = options?.itemType?.trim().toLowerCase();
  const results: LibraryItemTarget[] = [];
  for (const item of items) {
    const target = buildItemTargetFromItem(item);
    if (!target) continue;
    if (typeFilter && target.itemType.toLowerCase() !== typeFilter) continue;
    if (!libraryItemTargetMatchesFilters(target, options)) continue;
    results.push(target);
  }
  return results;
}

function normalizeResultLimit(limit: unknown): number | undefined {
  return Number.isFinite(limit) && Number(limit) > 0
    ? Math.max(1, Math.floor(Number(limit)))
    : undefined;
}

function limitItemTargets(
  items: LibraryItemTarget[],
  limit: unknown,
): LibraryItemTarget[] {
  const normalizedLimit = normalizeResultLimit(limit);
  return normalizedLimit && items.length > normalizedLimit
    ? items.slice(0, normalizedLimit)
    : items;
}

function libraryItemTargetHasPdf(target: LibraryItemTarget): boolean {
  return target.attachments.some((attachment) => {
    const contentType = normalizeText(attachment.contentType).toLowerCase();
    const title = normalizeText(attachment.title).toLowerCase();
    return (
      contentType === "application/pdf" ||
      title.endsWith(".pdf") ||
      title === "pdf"
    );
  });
}

function libraryItemTargetMatchesFilters(
  target: LibraryItemTarget,
  filters?: { hasPdf?: boolean },
): boolean {
  if (filters?.hasPdf === undefined) return true;
  return libraryItemTargetHasPdf(target) === filters.hasPdf;
}

// ── Zotero.Search-backed listing helpers ──────────────────────────────────────

export type AgentLibraryFilters = {
  collectionId?: number;
  unfiled?: boolean;
  hasPdf?: boolean;
  itemType?: string;
  author?: string;
  yearFrom?: number;
  yearTo?: number;
  tag?: string;
  /** List the trash instead of the library. */
  deleted?: boolean;
};

/**
 * One clause of an advanced search, forwarded to `Zotero.Search`.
 *
 * The agent previously had nine hand-written filters against Zotero's own
 * ~130 conditions x 15 operators. Re-implementing that vocabulary a filter at
 * a time is how it stayed nine for so long, so this forwards the vocabulary
 * instead of mirroring it: new Zotero versions add conditions for free.
 */
export type AgentSearchCondition = {
  condition: string;
  operator: string;
  value?: string | number;
  /**
   * Sub-mode for the few conditions that take one, e.g. `fulltextContent`
   * with `phrase` or `regexp`. Zotero spells this `condition/mode`.
   */
  mode?: string;
  /** Zotero's per-condition `required` flag. */
  required?: boolean;
};

export type AgentSearchConditionError = {
  condition: string;
  reason: string;
  validOperators?: string[];
};

/**
 * Checks conditions before any of them reach `Zotero.Search`.
 *
 * `addCondition` throws for both an unknown condition and an unsupported
 * operator, and a throw mid-build leaves a half-populated search. Worse, the
 * callers used to swallow it into an empty result, which is how a year filter
 * silently reported "no matching library results" on every library. Validate
 * first, and tell the model which operators the condition actually takes --
 * an error it cannot act on is as useless as an empty result.
 */
export function validateSearchConditions(
  conditions: AgentSearchCondition[],
): AgentSearchConditionError[] {
  const registry = (
    Zotero as unknown as {
      SearchConditions?: {
        get?: (
          name: string,
        ) => { operators?: Record<string, boolean> } | undefined;
      };
    }
  ).SearchConditions;
  if (!registry?.get) return [];
  const errors: AgentSearchConditionError[] = [];
  for (const entry of conditions) {
    const name = String(entry?.condition || "").trim();
    if (!name) {
      errors.push({ condition: "", reason: "A condition name is required" });
      continue;
    }
    // A block flips joinMode for the WHOLE query: any block sets
    // hasQuicksearch, and joinModeAny is `_joinMode == 'any' || hasQuicksearch`.
    // Exposing them would let one clause silently turn an AND search into OR.
    if (name === "blockStart" || name === "blockEnd") {
      errors.push({
        condition: name,
        reason:
          "Grouping blocks are not available: opening one flips every other condition in the query from AND to OR. Use joinMode instead, or run separate searches.",
      });
      continue;
    }
    const declared = registry.get(name);
    if (!declared) {
      errors.push({
        condition: name,
        reason: `"${name}" is not a Zotero search condition`,
      });
      continue;
    }
    const operator = String(entry?.operator || "").trim();
    const validOperators = Object.keys(declared.operators || {});
    if (!operator || !declared.operators?.[operator]) {
      errors.push({
        condition: name,
        reason: `"${operator || "(missing)"}" is not a valid operator for "${name}"`,
        validOperators,
      });
    }
  }
  return errors;
}

/**
 * Applies the exact year range in JS.
 *
 * The SQL side can only narrow: Zotero compares dates as strings, and an
 * `isAfter` on a bare year matches everything later in *that same* year. So
 * the range is enforced here, on the parsed year, exactly as the in-memory
 * fallback path already did. Items with no parseable year are excluded, which
 * is what a year-bounded question means.
 */
function libraryItemTargetMatchesYear(
  target: LibraryItemTarget,
  filters?: { yearFrom?: number; yearTo?: number },
): boolean {
  if (filters?.yearFrom == null && filters?.yearTo == null) return true;
  const year = parseInt(String(target.year ?? ""), 10);
  if (Number.isNaN(year)) return false;
  if (filters.yearFrom != null && year < filters.yearFrom) return false;
  if (filters.yearTo != null && year > filters.yearTo) return false;
  return true;
}

/**
 * Builds the `Zotero.Search` behind the agent's structured filters.
 *
 * Two conditions here were wrong in ways that silently produced empty or
 * over-broad results:
 *
 * 1. `year` was given `isGreaterThan`/`isLessThan`, which it does not accept
 *    (`searchConditions.js` allows only is/isNot/contains/doesNotContain).
 *    `addCondition` *throws* on an unsupported operator, and both callers
 *    swallowed the throw — so every text search combined with a year filter
 *    reported "no matching library results", always. The list path happened
 *    to fall back to an in-memory filter, which is why this went unnoticed.
 *    Year is now narrowed with `date`, which does support ranges, and made
 *    exact by `libraryItemTargetMatchesYear`.
 *
 * 2. The author filter was an OR block. Any block sets `hasQuicksearch`, and
 *    `joinModeAny` is `_joinMode == 'any' || hasQuicksearch` — so opening a
 *    block flipped *every other condition* in the query from AND to OR. A
 *    search for "papers by Peyrache in collection X" returned everything by
 *    Peyrache plus everything in X. `creator` matches all creator roles in
 *    one condition, so no block is needed.
 */
function buildAgentLibrarySearch(
  libraryID: number,
  filters: AgentLibraryFilters,
): Zotero.Search {
  const search = new Zotero.Search({ libraryID });
  if (filters.collectionId) {
    search.addCondition("collectionID", "is", filters.collectionId);
  }
  if (filters.unfiled) {
    search.addCondition("unfiled", "true", "");
  }
  if (filters.itemType) {
    search.addCondition("itemType", "is", filters.itemType);
  }
  if (filters.author) {
    // `creator` spans author, editor, bookAuthor and the rest.
    search.addCondition("creator", "contains", filters.author);
  }
  if (filters.yearFrom != null) {
    // `> 'YYYY-00-00'`, so this may admit part of the preceding year; the
    // exact bound is applied afterwards.
    search.addCondition("date", "isAfter", String(filters.yearFrom - 1));
  }
  if (filters.yearTo != null) {
    // `< 'YYYY-00-00'` for the following year, which is an exact upper bound.
    search.addCondition("date", "isBefore", String(filters.yearTo + 1));
  }
  if (filters.tag) {
    search.addCondition("tag", "is", filters.tag);
  }
  if (filters.deleted) {
    // Zotero excludes trashed items from every search unless asked, so
    // without this the trash could not be enumerated -- and restoring
    // something the user deleted meant knowing its id already.
    search.addCondition("deleted", "true" as never, "");
  }
  return search;
}

const FULLTEXT_INDEX_STATE_MAP: Record<
  number,
  LibraryItemTargetAttachment["indexingState"]
> = {
  0: "unavailable",
  1: "unindexed",
  2: "partial",
  3: "indexed",
  4: "queued",
};

export class ZoteroGateway {
  getItem(itemId: number | undefined): Zotero.Item | null {
    if (!Number.isFinite(itemId) || !itemId || itemId <= 0) return null;
    return Zotero.Items.get(Math.floor(itemId)) || null;
  }

  getCollection(collectionId: number | undefined): Zotero.Collection | null {
    if (!Number.isFinite(collectionId) || !collectionId || collectionId <= 0) {
      return null;
    }
    return Zotero.Collections.get(Math.floor(collectionId)) || null;
  }

  resolveLibraryID(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    libraryID?: number;
  }): number {
    const explicitLibraryID = Number(params.libraryID);
    if (Number.isFinite(explicitLibraryID) && explicitLibraryID > 0) {
      return Math.floor(explicitLibraryID);
    }
    const itemLibraryID = Number(params.item?.libraryID);
    if (Number.isFinite(itemLibraryID) && itemLibraryID > 0) {
      return Math.floor(itemLibraryID);
    }
    const requestLibraryID = Number(params.request?.libraryID);
    if (Number.isFinite(requestLibraryID) && requestLibraryID > 0) {
      return Math.floor(requestLibraryID);
    }
    const activeItemLibraryID = Number(
      this.getItem(params.request?.activeItemId)?.libraryID,
    );
    if (Number.isFinite(activeItemLibraryID) && activeItemLibraryID > 0) {
      return Math.floor(activeItemLibraryID);
    }
    return 0;
  }

  invalidateLibrarySearchCache(libraryID?: number): void {
    invalidatePaperSearchCache(libraryID);
  }

  getCollectionSummary(
    collectionId: number | undefined,
  ): CollectionSummary | null {
    const collection = this.getCollection(collectionId);
    if (!collection) return null;
    const pathMap = buildCollectionPathMap(
      listLibraryCollections(Number(collection.libraryID) || 0),
    );
    return {
      collectionId: collection.id,
      name: normalizeText(collection.name) || `Collection ${collection.id}`,
      libraryID: Number(collection.libraryID) || 0,
      path:
        pathMap.get(collection.id) ||
        normalizeText(collection.name) ||
        `Collection ${collection.id}`,
    };
  }

  listCollectionSummaries(libraryID: number): CollectionSummary[] {
    const normalizedLibraryID = Number.isFinite(libraryID)
      ? Math.floor(libraryID)
      : 0;
    if (!normalizedLibraryID) return [];
    const collections = listLibraryCollections(normalizedLibraryID);
    const pathMap = buildCollectionPathMap(collections);
    return collections
      .map((collection) => ({
        collectionId: collection.id,
        name: normalizeText(collection.name) || `Collection ${collection.id}`,
        libraryID: Number(collection.libraryID) || normalizedLibraryID,
        path:
          pathMap.get(collection.id) ||
          normalizeText(collection.name) ||
          `Collection ${collection.id}`,
      }))
      .sort((left, right) =>
        (left.path || left.name).localeCompare(
          right.path || right.name,
          undefined,
          {
            sensitivity: "base",
          },
        ),
      );
  }

  async getAllChildAttachmentInfos(
    itemId: number,
  ): Promise<LibraryItemTargetAttachment[]> {
    const item = this.getItem(itemId);
    if (!item) return [];
    const allAtts = getAllChildAttachments(
      item.isRegularItem?.()
        ? item
        : this.resolveBibliographicItem(item) || item,
    );
    const results: LibraryItemTargetAttachment[] = [];
    for (let i = 0; i < allAtts.length; i++) {
      const att = allAtts[i];
      const contentType =
        normalizeText(att.attachmentContentType) || "application/octet-stream";
      let indexingState: LibraryItemTargetAttachment["indexingState"];
      let mineruCacheDir: string | undefined;
      if (contentType === "application/pdf") {
        try {
          const stateNum = await Zotero.Fulltext.getIndexedState(att);
          indexingState = FULLTEXT_INDEX_STATE_MAP[stateNum] ?? "unavailable";
        } catch (err) {
          ztoolkit.log("LLM: Fulltext index state check failed", err);
          indexingState = "unavailable";
        }
        // Check if MinerU has parsed this PDF
        try {
          mineruCacheDir = await ensureMineruCacheDirForAttachment(att);
        } catch (err) {
          ztoolkit.log("LLM: MinerU cache check failed", err);
        }
      }
      results.push({
        contextItemId: att.id,
        title: resolveAnyAttachmentTitle(att, i, allAtts.length),
        contentType,
        indexingState,
        mineruCacheDir,
      });
    }
    return results;
  }

  async listLibraryPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for listing papers");
    }
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(
        this.getItem(candidate.itemId),
      );
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (target) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
    };
  }

  getPaperTargetsByItemIds(itemIds: number[]): LibraryPaperTarget[] {
    const out: LibraryPaperTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.resolveBibliographicItem(this.getItem(rawItemId));
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildPaperTargetFromItem(item);
      if (target) {
        out.push(target);
      }
    }
    return out;
  }

  resolvePaperContextTarget(params: {
    itemId?: number;
    contextItemId?: number;
  }): PaperContextRef | null {
    const itemId =
      Number.isFinite(params.itemId) && Number(params.itemId) > 0
        ? Math.floor(Number(params.itemId))
        : undefined;
    const contextItemId =
      Number.isFinite(params.contextItemId) && Number(params.contextItemId) > 0
        ? Math.floor(Number(params.contextItemId))
        : undefined;

    if (contextItemId) {
      const paperContext = resolvePaperContextRefFromAttachment(
        this.getItem(contextItemId),
      );
      if (!paperContext) return null;
      if (itemId && paperContext.itemId !== itemId) return null;
      return paperContext;
    }

    if (!itemId) return null;
    const item = this.resolveBibliographicItem(this.getItem(itemId));
    if (!item) return null;
    const target = buildPaperTargetFromItem(item);
    const firstAttachment = target?.attachments[0];
    if (!target || !firstAttachment) return null;
    return (
      resolvePaperContextRefFromAttachment(
        this.getItem(firstAttachment.contextItemId),
      ) || {
        itemId: target.itemId,
        contextItemId: firstAttachment.contextItemId,
        title: target.title,
        attachmentTitle: firstAttachment.title,
        firstCreator: target.firstCreator,
        year: target.year,
      }
    );
  }

  async listBibliographicItemTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing bibliographic items",
      );
    }
    const rawItems = await getAllLibraryItems(libraryID);
    const items: LibraryItemTarget[] = [];
    for (const rawItem of rawItems) {
      const item = this.resolveBibliographicItem(rawItem);
      if (!item) continue;
      const target = buildItemTargetFromItem(item);
      if (target && !target.noteKind) {
        items.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      items:
        normalizedLimit && items.length > normalizedLimit
          ? items.slice(0, normalizedLimit)
          : items,
      totalCount: items.length,
    };
  }

  getBibliographicItemTargetsByItemIds(itemIds: number[]): LibraryItemTarget[] {
    const out: LibraryItemTarget[] = [];
    const seen = new Set<number>();
    for (const rawItemId of itemIds) {
      const item = this.resolveBibliographicItem(this.getItem(rawItemId));
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      const target = buildItemTargetFromItem(item);
      if (target && !target.noteKind) {
        out.push(target);
      }
    }
    return out;
  }

  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    return resolveRegularItem(item);
  }

  resolveMetadataItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    itemId?: number;
    paperContext?: PaperContextRef | null;
  }): Zotero.Item | null {
    const byItemId = resolveRegularItem(this.getItem(params.itemId));
    if (byItemId) return byItemId;
    const byPaperContext = resolveRegularItem(
      this.getItem(params.paperContext?.itemId),
    );
    if (byPaperContext) return byPaperContext;
    const byActiveItem = resolveRegularItem(
      this.getItem(params.request?.activeItemId),
    );
    if (byActiveItem) return byActiveItem;
    return resolveRegularItem(params.item || null);
  }

  getActiveContextItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null {
    if (item) {
      return resolveContextSourceItem(item).contextItem;
    }
    return getActiveContextAttachmentFromTabs();
  }

  getActivePaperContext(
    item: Zotero.Item | null | undefined,
  ): PaperContextRef | null {
    return resolvePaperContextRefFromAttachment(
      this.getActiveContextItem(item),
    );
  }

  resolveActiveNoteItem(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
  }): Zotero.Item | null {
    const requestNoteId = Number(
      params.request?.activeNoteContext?.noteId || 0,
    );
    if (Number.isFinite(requestNoteId) && requestNoteId > 0) {
      const noteItem = this.getItem(Math.floor(requestNoteId));
      if ((noteItem as any)?.isNote?.()) {
        return noteItem;
      }
    }
    const candidate =
      params.item ||
      params.request?.item ||
      this.getItem(params.request?.activeItemId);
    return (candidate as any)?.isNote?.() ? candidate : null;
  }

  getActiveNoteSnapshot(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
  }) {
    return readNoteSnapshot(this.resolveActiveNoteItem(params));
  }

  async replaceCurrentNote(params: {
    request?: AgentRuntimeRequest;
    item?: Zotero.Item | null;
    content: string;
    expectedOriginalHtml?: string;
    /** Pre-patched HTML that bypasses the text→HTML conversion.  When
     *  provided, this HTML is set directly on the note, preserving
     *  images, list numbering, and other structure that the plain-text
     *  roundtrip would destroy. */
    preRenderedHtml?: string;
  }): Promise<{
    noteId: number;
    title: string;
    previousHtml: string;
    previousText: string;
    nextText: string;
  }> {
    const noteItem = this.resolveActiveNoteItem(params);
    if (!noteItem) {
      throw new Error("No active note is available to edit");
    }
    const snapshot = readNoteSnapshot(noteItem);
    if (!snapshot) {
      throw new Error("Could not read the active note");
    }
    if (
      typeof params.expectedOriginalHtml === "string" &&
      normalizeText(snapshot.text) !==
        normalizeText(stripNoteHtml(params.expectedOriginalHtml))
    ) {
      throw new Error(
        "The active note changed before this edit was applied. Refresh and try again.",
      );
    }
    const nextText = normalizeNoteSourceText(
      typeof params.content === "string"
        ? params.content
        : String(params.content || ""),
    );
    await persistVerifiedNoteHtml(
      noteItem,
      params.preRenderedHtml || renderRawNoteHtml(nextText),
    );
    invalidateCachedContextText(snapshot.noteId);
    return {
      noteId: snapshot.noteId,
      title: snapshot.title,
      previousHtml: snapshot.html,
      previousText: snapshot.text,
      nextText,
    };
  }

  async restoreNoteHtml(params: {
    noteId: number;
    html: string;
  }): Promise<void> {
    const noteItem = this.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) {
      throw new Error("Note not found for undo");
    }
    await persistVerifiedNoteHtml(
      noteItem,
      typeof params.html === "string" ? params.html : "",
    );
    invalidateCachedContextText(Math.floor(params.noteId));
  }

  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null {
    // Matches the write path: resolveRegularItem redirects a child
    // attachment to its parent, so reading back after writing on an
    // attachment returned the parent's fields and confirmed a change that
    // never happened to the object the user named.
    const resolution = resolveMatrixItem(item, Number(item?.id) || 0, "update");
    if ("refusal" in resolution) return null;
    const target = resolution.item;
    // Every field this item type actually has, not the fixed 18. The union
    // keeps the well-known names present (as empty strings) so existing card
    // layouts and callers still find them.
    const typeFields = listEditableFieldsForItem(target);
    const fieldNames = Array.from(
      new Set<string>([
        ...(EDITABLE_ARTICLE_METADATA_FIELDS as readonly string[]),
        ...typeFields,
      ]),
    );
    const fields = Object.fromEntries(
      fieldNames.map((fieldName) => {
        let value = "";
        try {
          // includeBaseMapped: `publicationTitle` is stored as `bookTitle` on
          // a book section and `proceedingsTitle` on a conference paper, so
          // without this it reads back empty on nine item types.
          value = normalizeMetadataValue(
            (
              target as unknown as {
                getField: (
                  name: string,
                  unformatted?: boolean,
                  includeBaseMapped?: boolean,
                ) => string;
              }
            ).getField(fieldName, false, true),
          );
        } catch (_error) {
          void _error;
        }
        return [fieldName, value];
      }),
    ) as Record<EditableArticleMetadataField, string>;
    let creators: EditableArticleCreator[] = [];
    try {
      creators = (target.getCreatorsJSON?.() || [])
        .map((creator) => normalizeCreatorForSnapshot(creator))
        .filter((creator): creator is EditableArticleCreator =>
          Boolean(creator),
        );
    } catch (_error) {
      void _error;
    }
    return {
      itemId: target.id,
      itemType: getItemTypeName(target),
      title:
        normalizeMetadataValue(target.getDisplayTitle?.()) ||
        fields.title ||
        `Item ${target.id}`,
      fields,
      creators,
    };
  }

  isEditableArticleMetadataFieldSupported(
    item: Zotero.Item | null | undefined,
    fieldName: EditableArticleMetadataField,
  ): boolean {
    const target = resolveRegularItem(item);
    if (!target) return false;
    return isFieldValidForItemType(target, fieldName);
  }

  supportsEditableArticleCreators(
    item: Zotero.Item | null | undefined,
  ): boolean {
    const target = resolveRegularItem(item);
    if (!target) return false;
    try {
      const creatorTypes = (
        Zotero as unknown as {
          CreatorTypes?: {
            itemTypeHasCreators?: (itemTypeId: number) => boolean;
          };
        }
      ).CreatorTypes;
      return typeof creatorTypes?.itemTypeHasCreators === "function"
        ? creatorTypes.itemTypeHasCreators(target.itemTypeID)
        : true;
    } catch (_error) {
      void _error;
      return true;
    }
  }

  listPaperContexts(request: AgentRuntimeRequest): PaperContextRef[] {
    const out = [
      ...normalizePaperContexts(request.selectedPaperContexts),
      ...normalizePaperContexts(request.fullTextPaperContexts),
      ...normalizePaperContexts(request.pinnedPaperContexts),
    ];
    const allowAmbientActivePaper =
      request.conversationKind !== "global" &&
      !request.selectedCollectionContexts?.length &&
      !request.selectedTagContexts?.length;
    if (!allowAmbientActivePaper) {
      return out;
    }
    const activeItem = this.getItem(request.activeItemId);
    const activeContext = this.getActivePaperContext(activeItem);
    if (activeContext) {
      const key = `${activeContext.itemId}:${activeContext.contextItemId}`;
      if (
        !out.some(
          (entry) => entry && `${entry.itemId}:${entry.contextItemId}` === key,
        )
      ) {
        out.unshift(activeContext);
      }
    }
    return out;
  }

  async browseCollections(params: { libraryID: number }): Promise<{
    libraryID: number;
    libraryName: string;
    collections: CollectionBrowseNode[];
    unfiled: {
      name: string;
      paperCount: number;
    };
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for browsing collections");
    }
    const candidates = await browsePaperCollectionCandidates(libraryID);
    const collections = candidates
      .filter((entry) => entry.collectionId > 0)
      .map((entry) => summarizeCollectionNode(entry));
    const unfiledNode =
      candidates.find((entry) => entry.collectionId === 0) || null;
    return {
      libraryID,
      libraryName: resolveLibraryDisplayName(libraryID),
      collections,
      unfiled: {
        name: "Unfiled",
        paperCount: unfiledNode?.papers.length || 0,
      },
    };
  }

  async listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
  }): Promise<{
    collection: CollectionSummary;
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const collection = this.getCollectionSummary(params.collectionId);
    if (!collection) {
      throw new Error("Collection not found");
    }
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing collection papers",
      );
    }
    if (collection.libraryID && collection.libraryID !== libraryID) {
      throw new Error("Collection does not belong to the active library");
    }
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(
        this.getItem(candidate.itemId),
      );
      if (!item?.inCollection?.(collection.collectionId)) continue;
      const target = buildPaperTargetFromItem(item);
      if (target) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      collection,
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
    };
  }

  async listUnfiledPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error("No active library available for listing unfiled papers");
    }
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(
        this.getItem(candidate.itemId),
      );
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (target && target.collectionIds.length === 0) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
    };
  }

  async listUntaggedPaperTargets(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    papers: LibraryPaperTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) {
      throw new Error(
        "No active library available for listing untagged papers",
      );
    }
    const candidates = await listLibraryPaperCandidates(libraryID);
    const papers: LibraryPaperTarget[] = [];
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(
        this.getItem(candidate.itemId),
      );
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (target && target.tags.length === 0) {
        papers.push(target);
      }
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return {
      papers:
        normalizedLimit && papers.length > normalizedLimit
          ? papers.slice(0, normalizedLimit)
          : papers,
      totalCount: papers.length,
    };
  }

  async searchLibraryItems(params: {
    libraryID: number;
    query: string;
    excludeContextItemId?: number | null;
    limit?: number;
  }): Promise<PaperSearchGroupCandidate[]> {
    return searchPaperCandidates(
      params.libraryID,
      params.query,
      params.excludeContextItemId,
      params.limit,
    );
  }

  // ── Universal item listing (all item types, not PDF-only) ──────────────────

  async listLibraryItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID)
      throw new Error("No active library available for listing items");
    const rawItems = await getAllLibraryItems(libraryID);
    const allItems = buildItemTargets(rawItems, { itemType: params.itemType });
    return {
      items: limitItemTargets(allItems, params.limit),
      totalCount: allItems.length,
    };
  }

  async listCollectionItemTargets(params: {
    libraryID: number;
    collectionId: number;
    limit?: number;
    itemType?: string;
  }): Promise<{
    collection: CollectionSummary;
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const collection = this.getCollectionSummary(params.collectionId);
    if (!collection) throw new Error("Collection not found");
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const inCollection = rawItems.filter((item) => {
      const ids = getCollectionIDs(item);
      return ids.includes(params.collectionId);
    });
    const allItems = buildItemTargets(inCollection, {
      itemType: params.itemType,
    });
    return {
      collection,
      items: limitItemTargets(allItems, params.limit),
      totalCount: allItems.length,
    };
  }

  async listUnfiledItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const unfiled = rawItems.filter(
      (item) => getCollectionIDs(item).length === 0,
    );
    const allItems = buildItemTargets(unfiled, { itemType: params.itemType });
    return {
      items: limitItemTargets(allItems, params.limit),
      totalCount: allItems.length,
    };
  }

  async listUntaggedItemTargets(params: {
    libraryID: number;
    limit?: number;
    itemType?: string;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const untagged = rawItems.filter((item) => getItemTags(item).length === 0);
    const allItems = buildItemTargets(untagged, { itemType: params.itemType });
    return {
      items: limitItemTargets(allItems, params.limit),
      totalCount: allItems.length,
    };
  }

  async listTagItemTargets(params: {
    libraryID: number;
    tagContext: TagContextRef;
    limit?: number;
    itemType?: string;
  }): Promise<{
    tagName: string;
    items: LibraryItemTarget[];
    totalCount: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const tagName = normalizeText(params.tagContext.name);
    const normalizedName = normalizeText(
      params.tagContext.normalizedName || params.tagContext.name,
    )
      .toLowerCase()
      .trim();
    const includeAutomatic = params.tagContext.includeAutomatic === true;
    const rawItems = await getAllLibraryItems(libraryID);
    const filtered = rawItems.filter((item) => {
      const tags = getItemTags(item, { includeAutomatic });
      if (params.tagContext.scope === "allTagged") return tags.length > 0;
      if (params.tagContext.scope === "untagged") return tags.length === 0;
      if (!normalizedName) return false;
      return tags.some(
        (tag) => tag === tagName || tag.toLowerCase() === normalizedName,
      );
    });
    const allItems = buildItemTargets(filtered, { itemType: params.itemType });
    return {
      tagName,
      items: limitItemTargets(allItems, params.limit),
      totalCount: allItems.length,
    };
  }

  /**
   * Runs an advanced search expressed in Zotero's own condition vocabulary.
   *
   * The nine hand-written filters could express a fraction of what the
   * Advanced Search window can. Rather than growing them one at a time, this
   * forwards conditions straight to `Zotero.Search`, so the agent inherits
   * every condition Zotero has — including ones added in future versions.
   *
   * Three things this must get right:
   *
   * - **Page before enriching.** The existing paths enrich every match and
   *   then slice, so a condition matching 20k items built 20k objects to show
   *   50. Here the id array is windowed first.
   * - **Resolve to parents.** `Zotero.Search` returns child items, and
   *   list-style callers drop anything with a `parentID` — so `fulltextContent`,
   *   `annotationText` and `childNote` would match and then vanish.
   * - **Never omit the library.** A `Zotero.Search` with no `libraryID`
   *   searches *every* library, including group libraries the user did not ask
   *   about.
   */
  async searchItemsByConditions(params: {
    libraryID: number;
    conditions: AgentSearchCondition[];
    joinMode?: "all" | "any";
    resolveToParents?: boolean;
    includeTrashed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{
    items: LibraryItemTarget[];
    totalCount: number;
    returnedCount: number;
    offset: number;
    nextOffset?: number;
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");

    const errors = validateSearchConditions(params.conditions);
    if (errors.length) {
      const detail = errors
        .map((error) =>
          error.validOperators?.length
            ? `${error.reason}. Valid operators: ${error.validOperators.join(", ")}`
            : error.reason,
        )
        .join("; ");
      throw new Error(`Invalid search conditions: ${detail}`);
    }

    const search = new Zotero.Search({ libraryID });
    if (params.joinMode === "any" || params.joinMode === "all") {
      search.addCondition("joinMode", params.joinMode as never, "");
    }
    // Zotero excludes trashed items unless told otherwise, so listing the
    // trash was impossible without this -- which in turn made restore
    // unusable, because nothing could enumerate what was in there.
    if (params.includeTrashed) {
      search.addCondition("deleted", "true" as never, "");
    }
    for (const entry of params.conditions) {
      const name = entry.mode
        ? `${entry.condition}/${entry.mode}`
        : entry.condition;
      search.addCondition(
        name as never,
        entry.operator as never,
        entry.value === undefined ? "" : (entry.value as never),
        entry.required,
      );
    }

    const rawIds: number[] = await search.search();

    const resolved: number[] = [];
    const seen = new Set<number>();
    for (const id of rawIds) {
      const item = Zotero.Items.get(id);
      if (!item) continue;
      let targetId = Number(id);
      if (params.resolveToParents) {
        const parentID = (item as { parentID?: number | false }).parentID;
        if (parentID) targetId = Number(parentID);
      } else if (
        (item as { parentID?: number | false }).parentID ||
        item.isAnnotation?.()
      ) {
        continue;
      }
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      resolved.push(targetId);
    }

    const offset =
      Number.isFinite(params.offset) && Number(params.offset) > 0
        ? Math.floor(Number(params.offset))
        : 0;
    const limit = Math.min(
      Math.max(
        Number.isFinite(params.limit) && Number(params.limit) > 0
          ? Math.floor(Number(params.limit))
          : 50,
        1,
      ),
      200,
    );
    // The window is taken on ids, so enrichment only runs for what is
    // actually returned.
    const page = resolved.slice(offset, offset + limit);

    const items: LibraryItemTarget[] = [];
    for (const itemId of page) {
      const item = this.getItem(itemId);
      if (!item) continue;
      const target = buildItemTargetFromItem(item);
      if (target) items.push(target);
    }

    const nextOffset = offset + page.length;
    return {
      items,
      totalCount: resolved.length,
      returnedCount: items.length,
      offset,
      nextOffset: nextOffset < resolved.length ? nextOffset : undefined,
    };
  }

  /**
   * Lists Zotero's item types and, optionally, the fields each one accepts.
   *
   * Without this the model guesses field names, and a guess is not a soft
   * failure: `setField` throws for a field the type does not have. Creating an
   * item of any type is impossible without knowing what types exist.
   */
  listItemTypes(params?: { itemType?: string; includeFields?: boolean }): {
    itemTypes: Array<{
      itemType: string;
      localized?: string;
      fields?: string[];
      creatorTypes?: string[];
    }>;
  } {
    const itemTypes = (
      Zotero as unknown as {
        ItemTypes?: {
          getTypes?: () => Array<{ id: number; name: string }>;
          getAll?: () => Array<{ id: number; name: string }>;
          getLocalizedString?: (idOrName: number | string) => string;
        };
      }
    ).ItemTypes;
    const itemFields = (
      Zotero as unknown as {
        ItemFields?: {
          getItemTypeFields?: (itemTypeId: number) => number[];
          getName?: (fieldId: number) => string;
        };
      }
    ).ItemFields;
    const creatorTypes = (
      Zotero as unknown as {
        CreatorTypes?: {
          getTypesForItemType?: (
            itemTypeId: number,
          ) => Array<{ id: number; name: string }>;
        };
      }
    ).CreatorTypes;

    const all = itemTypes?.getTypes?.() || itemTypes?.getAll?.() || [];
    const wanted = params?.itemType
      ? all.filter((entry) => entry.name === params.itemType)
      : all;

    return {
      itemTypes: wanted.map((entry) => {
        const row: {
          itemType: string;
          localized?: string;
          fields?: string[];
          creatorTypes?: string[];
        } = { itemType: entry.name };
        try {
          const localized = itemTypes?.getLocalizedString?.(entry.id);
          if (localized) row.localized = localized;
        } catch {
          // A missing localisation must not hide the type itself.
        }
        // Fields are only included on request or for a single type: all ~35
        // types with their fields is a large payload to spend on a lookup.
        if (params?.includeFields || params?.itemType) {
          try {
            row.fields = (itemFields?.getItemTypeFields?.(entry.id) || [])
              .map((fieldId) => itemFields?.getName?.(fieldId) || "")
              .filter(
                (name) => name && !NON_EDITABLE_METADATA_FIELDS.has(name),
              );
          } catch {
            row.fields = [];
          }
          try {
            row.creatorTypes = (
              creatorTypes?.getTypesForItemType?.(entry.id) || []
            ).map((creator) => creator.name);
          } catch {
            row.creatorTypes = [];
          }
        }
        return row;
      }),
    };
  }

  async listItemsByFilters(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const normalizedLimit = normalizeResultLimit(params.limit);
    try {
      const search = buildAgentLibrarySearch(libraryID, params.filters || {});
      const rawIds: number[] = await search.search();
      // Drop child items (child notes, annotations, attachments)
      const topIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (item && !item.parentID && !item.isAnnotation?.() && !seen.has(id)) {
          seen.add(id);
          topIds.push(id);
        }
      }
      const items: LibraryItemTarget[] = [];
      for (const id of topIds) {
        const raw = this.getItem(id);
        if (!raw) continue;
        const target = buildItemTargetFromItem(raw);
        if (
          target &&
          libraryItemTargetMatchesFilters(target, params.filters) &&
          libraryItemTargetMatchesYear(target, params.filters)
        ) {
          items.push(target);
        }
      }
      return {
        items: normalizedLimit ? items.slice(0, normalizedLimit) : items,
        totalCount: items.length,
      };
    } catch (error) {
      // The in-memory path reads the live library, so it cannot answer a
      // trash query. Falling back would quietly return the user's ordinary
      // items when they asked what was in the trash.
      if (params.filters?.deleted) throw error;
      // Otherwise a genuine fallback: the in-memory path applies the same
      // filters and returns correct results. It is logged because silence is
      // what masked the `year` operator bug for as long as it existed.
      Zotero.debug(
        `[agent] Zotero.Search listing failed, falling back to in-memory filtering: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this._listItemsByFiltersInMemory(params);
    }
  }

  private async _listItemsByFiltersInMemory(params: {
    libraryID: number;
    filters?: AgentLibraryFilters;
    limit?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const filters = params.filters || {};
    const rawItems = await getAllLibraryItems(params.libraryID);
    let filtered = rawItems;
    if (filters.collectionId) {
      filtered = filtered.filter((item) =>
        getCollectionIDs(item).includes(filters.collectionId as number),
      );
    } else if (filters.unfiled) {
      filtered = filtered.filter((item) => getCollectionIDs(item).length === 0);
    }
    if (filters.author) {
      const q = filters.author.toLowerCase();
      filtered = filtered.filter((item) =>
        normalizeText(item.getField?.("firstCreator"))
          .toLowerCase()
          .includes(q),
      );
    }
    if (filters.yearFrom != null || filters.yearTo != null) {
      filtered = filtered.filter((item) => {
        const y = parseInt(normalizeText(item.getField?.("year")), 10);
        if (isNaN(y)) return false;
        if (filters.yearFrom != null && y < filters.yearFrom) return false;
        if (filters.yearTo != null && y > filters.yearTo) return false;
        return true;
      });
    }
    if (filters.tag) {
      const tagName = filters.tag;
      filtered = filtered.filter((item) => {
        const tags: Array<{ tag: string }> = (item as any).getTags?.() || [];
        return tags.some((t) => t.tag === tagName);
      });
    }
    const items = buildItemTargets(filtered, {
      itemType: filters.itemType,
      hasPdf: filters.hasPdf,
    });
    return {
      items: limitItemTargets(items, params.limit),
      totalCount: items.length,
    };
  }

  async listStandaloneNotes(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{ notes: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const rawItems = await getAllLibraryItems(libraryID);
    const standaloneNotes: LibraryItemTarget[] = [];
    for (const item of rawItems) {
      if (!(item as any).isNote?.() || item.parentID) continue;
      const target = buildItemTargetFromItem(item);
      if (target) standaloneNotes.push(target);
    }
    return {
      notes: limitItemTargets(standaloneNotes, params.limit),
      totalCount: standaloneNotes.length,
    };
  }

  getStandaloneNoteContent(params: { noteId: number }): PaperNoteRecord | null {
    const noteItem = this.getItem(params.noteId);
    if (!noteItem || !(noteItem as any).isNote?.()) return null;
    const html = noteItem.getNote?.() || "";
    const text = normalizeNoteSourceText(html);
    if (!text.trim()) return null;
    const rawTitle = normalizeText(
      (noteItem as any).getNoteTitle?.() || noteItem.getDisplayTitle?.() || "",
    ).trim();
    return {
      noteId: noteItem.id,
      title: rawTitle || `Note ${noteItem.id}`,
      noteText: text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
    };
  }

  getAttachmentInfo(params: { attachmentId: number }): {
    attachmentId: number;
    parentItemId?: number;
    title: string;
    contentType: string;
    filename?: string;
    hasFile: boolean;
    linkMode: string;
  } | null {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) return null;
    const filename = normalizeText(
      (item as any).attachmentFilename || item.getField?.("title") || "",
    );
    const hasFile = !!(item as any).hasFile;
    const rawLinkMode = (item as any).attachmentLinkMode;
    const linkModeMap: Record<number, string> = {
      0: "imported_file",
      1: "imported_url",
      2: "linked_file",
      3: "linked_url",
    };
    const linkMode =
      typeof rawLinkMode === "number"
        ? linkModeMap[rawLinkMode] || String(rawLinkMode)
        : "unknown";
    return {
      attachmentId: item.id,
      parentItemId: item.parentID || undefined,
      title:
        normalizeText(item.getField?.("title")) ||
        filename ||
        `Attachment ${item.id}`,
      contentType:
        normalizeText(item.attachmentContentType) || "application/octet-stream",
      filename: filename || undefined,
      hasFile,
      linkMode,
    };
  }

  async searchAllLibraryItems(params: {
    libraryID: number;
    query: string;
    filters?: AgentLibraryFilters;
    allowedItemIds?: number[];
    limit?: number;
  }): Promise<{ items: LibraryItemTarget[]; totalCount: number }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID || !params.query?.trim()) {
      return { items: [], totalCount: 0 };
    }
    const normalizedLimit = normalizeResultLimit(params.limit) || 50;
    const allowedItemIds = Array.isArray(params.allowedItemIds)
      ? new Set(
          params.allowedItemIds
            .map((itemId) =>
              Number.isFinite(itemId) && itemId > 0 ? Math.floor(itemId) : 0,
            )
            .filter(Boolean),
        )
      : null;
    try {
      const search = params.filters
        ? buildAgentLibrarySearch(libraryID, params.filters)
        : new Zotero.Search({ libraryID });
      search.addCondition(
        "quicksearch-everything",
        "contains",
        params.query.trim(),
      );
      const rawIds: number[] = await search.search();
      // Resolve child items (notes/attachments) to their top-level parent, de-duplicate
      const resolvedIds: number[] = [];
      const seen = new Set<number>();
      for (const id of rawIds) {
        const item = Zotero.Items.get(id);
        if (!item) continue;
        const topId = (item.parentID as number | false | undefined) || id;
        if (allowedItemIds && !allowedItemIds.has(topId)) continue;
        if (!seen.has(topId)) {
          seen.add(topId);
          resolvedIds.push(topId);
        }
      }
      const targets: LibraryItemTarget[] = [];
      for (const itemId of resolvedIds) {
        const item = this.getItem(itemId);
        if (!item) continue;
        const target = buildItemTargetFromItem(item);
        if (
          target &&
          libraryItemTargetMatchesFilters(target, params.filters) &&
          libraryItemTargetMatchesYear(target, params.filters)
        ) {
          targets.push(target);
        }
      }
      return {
        items:
          normalizedLimit && targets.length > normalizedLimit
            ? targets.slice(0, normalizedLimit)
            : targets,
        totalCount: targets.length,
      };
    } catch (error) {
      // Deliberately not swallowed into an empty result. Reporting "no
      // matching library results" for a *broken query* is indistinguishable
      // from a genuine miss, which is exactly how the `year` operator bug
      // stayed invisible: the agent confidently told users their library had
      // nothing. A thrown error surfaces as a tool failure instead.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async searchAllNotes(params: {
    libraryID: number;
    query: string;
    limit?: number;
  }): Promise<
    Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    >
  > {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const query = params.query?.trim();
    if (!query) return [];
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : 200;
    try {
      const search = new Zotero.Search({ libraryID });
      search.addCondition("itemType", "is", "note");
      search.addCondition("quicksearch-everything", "contains", query);
      const noteIds: number[] = await search.search();
      return this._buildNoteResults(noteIds, normalizedLimit);
    } catch (_error) {
      void _error;
      // Fallback: in-memory scan across all items and child notes
      return this._searchAllNotesInMemory({
        libraryID,
        query,
        limit: normalizedLimit,
      });
    }
  }

  private _buildNoteResults(
    noteIds: number[],
    limit: number,
  ): Array<
    LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
  > {
    const results: Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    > = [];
    for (const noteId of noteIds) {
      if (results.length >= limit) break;
      const noteItem = this.getItem(noteId);
      if (!noteItem?.isNote?.()) continue;
      const rawTitle = normalizeText(
        (noteItem as any).getNoteTitle?.() ||
          noteItem.getDisplayTitle?.() ||
          "",
      ).trim();
      const title = rawTitle || `Note ${noteItem.id}`;
      if (noteItem.parentID) {
        const parentItem = this.getItem(noteItem.parentID as number);
        const parentTitle = parentItem
          ? normalizeText(parentItem.getDisplayTitle?.() || "").trim() ||
            `Item ${parentItem.id}`
          : undefined;
        results.push({
          itemId: noteItem.id,
          itemType: "note",
          title,
          attachments: [],
          tags: getItemTags(noteItem),
          collectionIds: [],
          noteKind: "item",
          parentItemId: noteItem.parentID as number,
          parentItemTitle: parentTitle,
        });
      } else {
        const target = buildItemTargetFromItem(noteItem);
        if (target) results.push({ ...target, noteKind: "standalone" });
      }
    }
    return results;
  }

  private async _searchAllNotesInMemory(params: {
    libraryID: number;
    query: string;
    limit: number;
  }): Promise<
    Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    >
  > {
    const queryLower = params.query.toLowerCase();
    const rawItems = await getAllLibraryItems(params.libraryID);
    const results: Array<
      LibraryItemTarget & { parentItemId?: number; parentItemTitle?: string }
    > = [];
    for (const item of rawItems) {
      if (results.length >= params.limit) break;
      if ((item as any).isNote?.() && !item.parentID) {
        const html = item.getNote?.() || "";
        const text = normalizeNoteSourceText(html);
        const rawTitle = normalizeText(
          (item as any).getNoteTitle?.() || item.getDisplayTitle?.() || "",
        ).trim();
        const title = rawTitle || `Note ${item.id}`;
        if (!`${title} ${text}`.toLowerCase().includes(queryLower)) continue;
        const target = buildItemTargetFromItem(item);
        if (target) results.push({ ...target, noteKind: "standalone" });
        continue;
      }
      if (!(item as any).isRegularItem?.()) continue;
      const noteIds: number[] = (item as any).getNotes?.() || [];
      if (!noteIds.length) continue;
      const parentTitle =
        normalizeText(item.getDisplayTitle?.() || "").trim() ||
        `Item ${item.id}`;
      for (const noteId of noteIds) {
        if (results.length >= params.limit) break;
        const noteItem = Zotero.Items.get(noteId);
        if (!noteItem?.isNote?.()) continue;
        const html = noteItem.getNote?.() || "";
        const text = normalizeNoteSourceText(html);
        const rawTitle = normalizeText(
          (noteItem as any).getNoteTitle?.() ||
            noteItem.getDisplayTitle?.() ||
            "",
        ).trim();
        const title = rawTitle || `Note ${noteItem.id}`;
        if (!`${title} ${text}`.toLowerCase().includes(queryLower)) continue;
        results.push({
          itemId: noteItem.id,
          itemType: "note",
          title,
          attachments: [],
          tags: getItemTags(noteItem),
          collectionIds: [],
          noteKind: "item",
          parentItemId: item.id,
          parentItemTitle: parentTitle,
        });
      }
    }
    return results;
  }

  async indexPdfAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    indexingState: string;
    triggered: boolean;
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item?.isAttachment?.()) throw new Error("Not an attachment item");
    if (!(item as any).isPDFAttachment?.())
      throw new Error("Not a PDF attachment");
    await Zotero.Fulltext.indexItems([params.attachmentId]);
    let indexingState = "unavailable";
    try {
      const stateNum = await Zotero.Fulltext.getIndexedState(item);
      indexingState = FULLTEXT_INDEX_STATE_MAP[stateNum] ?? "unavailable";
    } catch (err) {
      ztoolkit.log("LLM: Attachment indexing state check failed", err);
    }
    return {
      attachmentId: params.attachmentId,
      indexingState,
      triggered: true,
    };
  }

  async listLibraryTags(params: {
    libraryID: number;
    query?: string;
    limit?: number;
  }): Promise<{ name: string; type: number }[]> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const raw = await Zotero.Tags.getAll(libraryID);
    let tags = raw.map((t) => ({ name: t.tag, type: t.type ?? 0 }));
    if (params.query) {
      const q = params.query.toLowerCase();
      tags = tags.filter((t) => t.name.toLowerCase().includes(q));
    }
    const normalizedLimit = Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit as number))
      : undefined;
    return normalizedLimit ? tags.slice(0, normalizedLimit) : tags;
  }

  listAllLibraries(): {
    libraryID: number;
    name: string;
    type: string;
    editable: boolean;
  }[] {
    return Zotero.Libraries.getAll().map((lib) => ({
      libraryID: lib.libraryID,
      name: lib.name,
      type: Zotero.Libraries.getType(lib.libraryID),
      editable: Zotero.Libraries.isEditable(lib.libraryID),
    }));
  }

  async applyTagAssignments(params: {
    assignments: BatchTagAssignment[];
  }): Promise<{
    selectedCount: number;
    updatedCount: number;
    skippedCount: number;
    items: BatchTagItemResult[];
  }> {
    const normalizedAssignments: BatchTagAssignment[] = [];
    const seen = new Set<number>();
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      const tags = Array.from(
        new Set(
          (Array.isArray(entry.tags) ? entry.tags : [])
            .map((tag) => normalizeText(tag))
            .filter(Boolean),
        ),
      );
      if (!itemId || !tags.length || seen.has(itemId)) continue;
      seen.add(itemId);
      normalizedAssignments.push({
        itemId,
        tags,
      });
    }
    if (!normalizedAssignments.length) {
      throw new Error("No valid tag assignments were provided");
    }
    const results: BatchTagItemResult[] = [];
    let updatedCount = 0;
    for (const assignment of normalizedAssignments) {
      // Tags live on the item itself. The old resolver redirected a child
      // attachment to its parent -- a wrong-object write that then reported
      // the PARENT's id and title as the target -- and rejected standalone
      // notes outright as "Item not found".
      const resolution = resolveMatrixItem(
        this.getItem(assignment.itemId),
        assignment.itemId,
        "update",
      );
      const item = "item" in resolution ? resolution.item : null;
      if (!item) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          addedTags: [],
          skippedTags: assignment.tags,
          reason:
            "refusal" in resolution
              ? resolution.refusal
              : `Item ${assignment.itemId} could not be resolved`,
        });
        continue;
      }
      const target = buildPaperTargetFromItem(item);
      const title =
        target?.title ||
        normalizeText(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
      const addedTags: string[] = [];
      const skippedTags: string[] = [];
      for (const tag of assignment.tags) {
        if (!tag) continue;
        if (item.hasTag?.(tag)) {
          skippedTags.push(tag);
          continue;
        }
        item.addTag?.(tag, 0);
        addedTags.push(tag);
      }
      if (addedTags.length) {
        await item.saveTx();
        updatedCount += 1;
      }
      results.push({
        itemId: item.id,
        title,
        status: addedTags.length ? "updated" : "skipped",
        addedTags,
        skippedTags,
        reason: addedTags.length ? undefined : "All tags already existed",
      });
    }
    return {
      selectedCount: normalizedAssignments.length,
      updatedCount,
      skippedCount: results.length - updatedCount,
      items: results,
    };
  }

  async applyTagsToItems(params: {
    itemIds: number[];
    tags: string[];
  }): Promise<{
    selectedCount: number;
    updatedCount: number;
    skippedCount: number;
    items: BatchTagItemResult[];
  }> {
    return this.applyTagAssignments({
      assignments: params.itemIds.map((itemId) => ({
        itemId,
        tags: params.tags,
      })),
    });
  }

  /**
   * Sets an item's collection membership to exactly the given set.
   *
   * Every other collection write in this file was an add or a single remove,
   * which is why "move" was a lie: `addItemsToCollections` only ever called
   * `addToCollection`, so a move left the item in both the old and the new
   * collection while reporting `status: "moved"`.
   *
   * Membership is a set, so it has to be written as one:
   *
   * - The whole destination set for an item is resolved before any write.
   *   One item can legitimately carry several destinations in a single call,
   *   and applying them pairwise makes the second assignment undo the first.
   * - Both `addToCollection` and `removeFromCollection` are checked against
   *   the capability matrix *before* anything is written. The matrix refuses
   *   child items for removal, so an add-then-refuse would leave the item
   *   filed in both places — the exact corruption this replaces.
   * - Adds and removes for one item share a single `saveTx`, so an item is
   *   never observable in a half-moved state.
   */
  async setItemCollections(params: {
    assignments: ItemCollectionSet[];
  }): Promise<{
    items: BatchMoveItemResult[];
    changedCount: number;
    priorCollections: ItemCollectionSet[];
  }> {
    // Collapse to one destination set per item before touching anything.
    const desired = new Map<number, Set<number>>();
    const order: number[] = [];
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      if (!itemId) continue;
      if (!desired.has(itemId)) {
        desired.set(itemId, new Set());
        order.push(itemId);
      }
      const set = desired.get(itemId) as Set<number>;
      for (const raw of entry.collectionIds || []) {
        const collectionId = Number.isFinite(raw) ? Math.floor(raw) : 0;
        if (collectionId > 0) set.add(collectionId);
      }
    }

    const results: BatchMoveItemResult[] = [];
    const priorCollections: ItemCollectionSet[] = [];
    const touchedLibraryIDs = new Set<number>();
    let changedCount = 0;

    for (const itemId of order) {
      const targets = desired.get(itemId) as Set<number>;
      const rawItem = this.getItem(itemId);

      // Check both verbs up front: a move that may not remove must not add.
      const addResolution = resolveMatrixItem(
        rawItem,
        itemId,
        "addToCollection",
      );
      const removeResolution = resolveMatrixItem(
        rawItem,
        itemId,
        "removeFromCollection",
      );
      const blocked =
        "refusal" in addResolution
          ? addResolution.refusal
          : "refusal" in removeResolution
            ? removeResolution.refusal
            : null;
      if (blocked || !("item" in addResolution)) {
        results.push({
          itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) || `Item ${itemId}`
            : `Item ${itemId}`,
          status: "missing",
          targetCollectionId: 0,
          reason: blocked || `Item ${itemId} could not be resolved`,
        });
        continue;
      }
      const item = addResolution.item;

      const prior = this.getItemCollectionIds(Number(item.id));
      const priorSet = new Set(prior);
      const toAdd = [...targets].filter((id) => !priorSet.has(id));
      const toRemove = prior.filter((id) => !targets.has(id));

      const title =
        normalizeText(item.getDisplayTitle?.()) || `Item ${item.id}`;
      const primaryTarget = [...targets][0] ?? 0;
      const targetSummary = primaryTarget
        ? this.getCollectionSummary(primaryTarget)
        : null;

      if (!toAdd.length && !toRemove.length) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "skipped",
          targetCollectionId: primaryTarget,
          targetCollectionName: targetSummary?.path || targetSummary?.name,
          reason: "Already filed exactly here",
        });
        continue;
      }

      try {
        for (const collectionId of toAdd) {
          item.addToCollection(collectionId);
        }
        for (const collectionId of toRemove) {
          item.removeFromCollection(collectionId);
        }
        // One transaction per item: never observable half-moved.
        await item.saveTx();
      } catch (error) {
        results.push({
          itemId: Number(item.id),
          title,
          status: "missing",
          targetCollectionId: primaryTarget,
          targetCollectionName: targetSummary?.path || targetSummary?.name,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Recorded per item, so the inverse restores the exact prior set —
      // including items that were in three collections, or in none.
      priorCollections.push({ itemId: Number(item.id), collectionIds: prior });
      changedCount += 1;
      touchedLibraryIDs.add(Number(item.libraryID));
      results.push({
        itemId: Number(item.id),
        title,
        status: "moved",
        targetCollectionId: primaryTarget,
        targetCollectionName: targetSummary?.path || targetSummary?.name,
      });
    }

    for (const libraryID of touchedLibraryIDs) {
      if (libraryID > 0) invalidatePaperSearchCache(libraryID);
    }
    return { items: results, changedCount, priorCollections };
  }

  /**
   * Files items into collections.
   *
   * `mode: "add"` is the historical behaviour and stays the default: the item
   * gains the destination and keeps everything else.
   *
   * `mode: "move"` actually moves. Until now the vocabulary said "moved"
   * everywhere — the result field, the row status, the button — while the
   * code only ever added, so asking to move a paper left it filed in both
   * the old and the new collection.
   *
   * `from` is required for a move and never inferred: `from: <collectionId>`
   * takes it out of that one collection, `from: "all"` makes the destination
   * set exhaustive. Guessing would silently unfile items from collections the
   * user never mentioned.
   */
  async addItemsToCollections(params: {
    assignments: BatchMoveAssignment[];
    mode?: "add" | "move";
    from?: number | "all";
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    skippedCount: number;
    collections: CollectionSummary[];
    items: BatchMoveItemResult[];
    priorCollections?: ItemCollectionSet[];
  }> {
    const normalizedAssignments: BatchMoveAssignment[] = [];
    const seen = new Set<string>();
    for (const entry of params.assignments) {
      const itemId = Number.isFinite(entry.itemId)
        ? Math.floor(entry.itemId)
        : 0;
      const targetCollectionId = Number.isFinite(entry.targetCollectionId)
        ? Math.floor(entry.targetCollectionId)
        : 0;
      const key = `${itemId}:${targetCollectionId}`;
      if (!itemId || !targetCollectionId || seen.has(key)) continue;
      seen.add(key);
      normalizedAssignments.push({
        itemId,
        targetCollectionId,
      });
    }
    if (!normalizedAssignments.length) {
      throw new Error("No valid collection assignments were provided");
    }
    const collectionMap = new Map<number, CollectionSummary>();
    for (const assignment of normalizedAssignments) {
      if (collectionMap.has(assignment.targetCollectionId)) continue;
      const collection = this.getCollectionSummary(
        assignment.targetCollectionId,
      );
      if (!collection) {
        throw new Error("Collection not found");
      }
      collectionMap.set(assignment.targetCollectionId, collection);
    }

    if (params.mode === "move") {
      if (params.from == null) {
        throw new Error(
          'A move needs an explicit source: pass from:<collectionId> to take items out of one collection, or from:"all" to replace their collection membership entirely.',
        );
      }
      // Collapse every assignment into one destination set per item first.
      // Handling them pairwise would let the second assignment for an item
      // undo the first.
      const destinations = new Map<number, Set<number>>();
      for (const assignment of normalizedAssignments) {
        const set = destinations.get(assignment.itemId) || new Set<number>();
        set.add(assignment.targetCollectionId);
        destinations.set(assignment.itemId, set);
      }
      const sets: ItemCollectionSet[] = [];
      for (const [itemId, targets] of destinations) {
        const keep =
          params.from === "all"
            ? []
            : this.getItemCollectionIds(itemId).filter(
                (id) => id !== params.from,
              );
        sets.push({
          itemId,
          collectionIds: Array.from(new Set([...keep, ...targets])),
        });
      }
      const outcome = await this.setItemCollections({ assignments: sets });
      return {
        selectedCount: sets.length,
        movedCount: outcome.changedCount,
        skippedCount: outcome.items.length - outcome.changedCount,
        collections: Array.from(collectionMap.values()),
        items: outcome.items,
        priorCollections: outcome.priorCollections,
      };
    }

    const results: BatchMoveItemResult[] = [];
    let movedCount = 0;
    for (const assignment of normalizedAssignments) {
      const collection = collectionMap.get(assignment.targetCollectionId);
      if (!collection) {
        results.push({
          itemId: assignment.itemId,
          title: `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: assignment.targetCollectionId,
          reason: "Collection not found",
        });
        continue;
      }
      const rawItem = this.getItem(assignment.itemId);
      const resolution = resolveMatrixItem(
        rawItem,
        assignment.itemId,
        "addToCollection",
      );
      const item = "item" in resolution ? resolution.item : null;
      if (!item) {
        // "Item not found" was reported for items that plainly exist — a
        // note, a standalone attachment, a child attachment — because the
        // filter that rejected them could not say why. An agent reading that
        // reason has no way to correct itself, and a user reading it in the
        // trace is simply told something false.
        results.push({
          itemId: assignment.itemId,
          title: rawItem
            ? normalizeText(rawItem.getDisplayTitle?.()) ||
              `Item ${assignment.itemId}`
            : `Item ${assignment.itemId}`,
          status: "missing",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason:
            "refusal" in resolution
              ? resolution.refusal
              : `Item ${assignment.itemId} could not be resolved`,
        });
        continue;
      }
      const target = buildPaperTargetFromItem(item);
      const title =
        target?.title ||
        normalizeText(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
      if (item.inCollection?.(collection.collectionId)) {
        results.push({
          itemId: item.id,
          title,
          status: "skipped",
          targetCollectionId: collection.collectionId,
          targetCollectionName: collection.path || collection.name,
          reason: "Paper is already in this collection",
        });
        continue;
      }
      item.addToCollection(collection.collectionId);
      await item.saveTx();
      movedCount += 1;
      results.push({
        itemId: item.id,
        title,
        status: "moved",
        targetCollectionId: collection.collectionId,
        targetCollectionName: collection.path || collection.name,
      });
    }
    if (movedCount > 0) {
      const touchedLibraryIDs = new Set<number>();
      for (const collection of collectionMap.values()) {
        if (collection.libraryID > 0) {
          touchedLibraryIDs.add(collection.libraryID);
        }
      }
      for (const libraryID of touchedLibraryIDs) {
        invalidatePaperSearchCache(libraryID);
      }
    }
    return {
      selectedCount: normalizedAssignments.length,
      movedCount,
      skippedCount: results.length - movedCount,
      collections: Array.from(collectionMap.values()),
      items: results,
    };
  }

  async addItemsToCollection(params: {
    itemIds: number[];
    targetCollectionId: number;
  }): Promise<{
    selectedCount: number;
    movedCount: number;
    skippedCount: number;
    collection: CollectionSummary;
    items: BatchMoveItemResult[];
  }> {
    const collection = this.getCollectionSummary(params.targetCollectionId);
    if (!collection) {
      throw new Error("Collection not found");
    }
    const result = await this.addItemsToCollections({
      assignments: params.itemIds.map((itemId) => ({
        itemId,
        targetCollectionId: params.targetCollectionId,
      })),
    });
    return {
      selectedCount: result.selectedCount,
      movedCount: result.movedCount,
      skippedCount: result.skippedCount,
      collection,
      items: result.items,
    };
  }

  async saveAnswerToNote(params: {
    item: Zotero.Item | null;
    libraryID?: number;
    content: string;
    modelName: string;
    target?: "item" | "standalone";
    appendToTrackedNote?: boolean;
    generatedImages?: GeneratedChatImage[];
    /** Collections to file a standalone note into. Ignored for child notes. */
    collections?: number[];
  }): Promise<SaveAnswerToNoteResult> {
    if (params.target === "standalone") {
      const libraryID =
        Number.isFinite(params.libraryID) && (params.libraryID as number) > 0
          ? Math.floor(params.libraryID as number)
          : params.item?.libraryID || 0;
      const created = await createStandaloneNoteFromAssistantText(
        libraryID,
        params.content,
        params.modelName,
        undefined,
        undefined,
        params.generatedImages,
        undefined,
        undefined,
        params.collections,
      );
      return {
        status: "standalone_created",
        noteId: created.noteId,
        collections: created.collections,
      };
    }
    if (!params.item) {
      throw new Error("No Zotero item is active for item-note creation");
    }
    const status = await createNoteFromAssistantText(
      params.item,
      params.content,
      params.modelName,
      undefined,
      {
        appendToTrackedNote: params.appendToTrackedNote === true,
        rememberCreatedNote: params.appendToTrackedNote === true,
        generatedImages: params.generatedImages,
      },
    );
    return { status };
  }

  getPaperNotes(params: {
    item: Zotero.Item | null | undefined;
    maxNotes?: number;
  }): PaperNoteRecord[] {
    const target = resolveRegularItem(params.item);
    if (!target) return [];
    const limit =
      Number.isFinite(params.maxNotes) && (params.maxNotes as number) > 0
        ? Math.floor(params.maxNotes as number)
        : 20;
    try {
      const noteIds: number[] = target.getNotes?.() || [];
      const results: PaperNoteRecord[] = [];
      for (const noteId of noteIds) {
        if (results.length >= limit) break;
        const noteItem = Zotero.Items.get(noteId);
        if (!noteItem?.isNote?.()) continue;
        const html = noteItem.getNote?.() || "";
        const text = normalizeNoteSourceText(html);
        if (!text.trim()) continue;
        const rawTitle = normalizeText(
          (
            noteItem as unknown as { getNoteTitle?: () => unknown }
          ).getNoteTitle?.() || "",
        ).trim();
        results.push({
          noteId: noteItem.id,
          title: rawTitle || `Note ${noteItem.id}`,
          noteText:
            text.length > 10000 ? `${text.slice(0, 10000)}\u2026` : text,
          wordCount: text.split(/\s+/).filter(Boolean).length,
        });
      }
      return results;
    } catch (_error) {
      void _error;
      return [];
    }
  }

  getPaperAnnotations(params: {
    item: Zotero.Item | null | undefined;
    maxAnnotations?: number;
  }): PaperAnnotationRecord[] {
    const target = resolveRegularItem(params.item);
    if (!target) return [];
    const limit =
      Number.isFinite(params.maxAnnotations) &&
      (params.maxAnnotations as number) > 0
        ? Math.floor(params.maxAnnotations as number)
        : 100;
    const results: PaperAnnotationRecord[] = [];
    try {
      const pdfs = getPdfChildAttachments(target);
      for (const pdf of pdfs) {
        if (results.length >= limit) break;
        const annotationIds: number[] =
          (
            pdf as unknown as { getAnnotations?: () => number[] }
          ).getAnnotations?.() || [];
        for (const annotationId of annotationIds) {
          if (results.length >= limit) break;
          const annotation = Zotero.Items.get(annotationId);
          if (!annotation?.isAnnotation?.()) continue;
          const ann = annotation as unknown as {
            annotationText?: string;
            annotationComment?: string;
            annotationType?: string;
            annotationColor?: string;
            annotationPageLabel?: string;
          };
          const text = normalizeText(ann.annotationText || "");
          const comment =
            normalizeText(ann.annotationComment || "") || undefined;
          if (!text && !comment) continue;
          results.push({
            annotationId: annotation.id,
            type: normalizeText(ann.annotationType || "") || "highlight",
            text: text.length > 500 ? `${text.slice(0, 500)}\u2026` : text,
            comment:
              comment && comment.length > 500
                ? `${comment.slice(0, 500)}\u2026`
                : comment,
            color: normalizeText(ann.annotationColor || "") || undefined,
            pageLabel:
              normalizeText(ann.annotationPageLabel || "") || undefined,
          });
        }
      }
    } catch (_error) {
      void _error;
    }
    return results;
  }

  async createCollection(params: {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
  }): Promise<CollectionSummary> {
    const normalizedName = normalizeText(params.name).trim();
    if (!normalizedName) {
      throw new Error("Collection name is required");
    }
    const libraryID =
      Number.isFinite(params.libraryID) && params.libraryID > 0
        ? Math.floor(params.libraryID)
        : 0;
    if (!libraryID) {
      throw new Error("No library available for collection creation");
    }
    if (params.parentCollectionId) {
      const parentCollection = this.getCollection(params.parentCollectionId);
      if (!parentCollection) {
        throw new Error(
          `Parent collection ${params.parentCollectionId} not found`,
        );
      }
    }
    const collection = new Zotero.Collection();
    (collection as unknown as { libraryID: number }).libraryID = libraryID;
    collection.name = normalizedName;
    if (params.parentCollectionId) {
      collection.parentID = params.parentCollectionId;
    }
    await collection.saveTx();
    invalidatePaperSearchCache(libraryID);
    const allCollections = listLibraryCollections(libraryID);
    const pathMap = buildCollectionPathMap(allCollections);
    return {
      collectionId: collection.id,
      name: normalizedName,
      libraryID,
      path: pathMap.get(collection.id) || normalizedName,
    };
  }

  /**
   * Describes a collection before it is deleted.
   *
   * Deleting now trashes rather than erases, so the inverse is a restore by
   * id and this snapshot is no longer load-bearing for undo. It still
   * describes the collection for the confirmation card, and
   * `childCollectionCount` tells the user how much of their tree a delete
   * would take with it. Returns `null` when the collection does not exist.
   */
  snapshotCollectionForDelete(params: { collectionId: number }): {
    name: string;
    parentCollectionId?: number;
    libraryID: number;
    itemIds: number[];
    childCollectionCount: number;
  } | null {
    const collection = this.getCollection(params.collectionId) as
      | (Zotero.Collection & {
          getChildItems?: (asIDs: true, includeDeleted?: boolean) => number[];
          getChildCollections?: (asIDs: true) => number[];
        })
      | null;
    if (!collection) return null;
    let itemIds: number[] = [];
    try {
      itemIds = collection.getChildItems?.(true) || [];
    } catch {
      itemIds = [];
    }
    let childCollectionCount = 0;
    try {
      childCollectionCount = (collection.getChildCollections?.(true) || [])
        .length;
    } catch {
      childCollectionCount = 0;
    }
    const parentID = Number((collection as { parentID?: unknown }).parentID);
    return {
      name:
        normalizeText(collection.name) || `Collection ${params.collectionId}`,
      parentCollectionId:
        Number.isFinite(parentID) && parentID > 0 ? parentID : undefined,
      libraryID: Number(collection.libraryID) || 0,
      itemIds,
      childCollectionCount,
    };
  }

  /**
   * Moves a collection to the trash, matching what Zotero's own UI does.
   *
   * This used to call `eraseTx()`, which is Zotero's *permanent* erase — it
   * wipes the collection and every descendant with no way back. Zotero has
   * had a collection trash since `deletedCollections` landed, and its own
   * "Delete Collection" sets `deleted = true`; only "Delete Permanently"
   * erases. The agent was therefore more destructive than the UI while
   * telling the user the opposite ("Zotero has no trash for collections").
   *
   * Setting `deleted` routes through `Zotero.Collection.trash()`, which
   * trashes descendant collections too and preserves every id, so a restore
   * brings back the original objects rather than rebuilding lookalikes.
   *
   * Items are left in the library unless `deleteItems` is set — again
   * matching Zotero, whose menu offers "Delete Collection" and "Delete
   * Collection and Items" as separate commands.
   */
  async deleteCollection(params: {
    collectionId: number;
    deleteItems?: boolean;
    permanent?: boolean;
  }): Promise<void> {
    const collection = this.getCollection(params.collectionId);
    if (!collection) return;
    const libraryID = Number(collection.libraryID) || 0;
    if (params.permanent) {
      await (
        collection as unknown as {
          eraseTx: (options?: { deleteItems?: boolean }) => Promise<void>;
        }
      ).eraseTx({ deleteItems: !!params.deleteItems });
    } else {
      (collection as unknown as { deleted: boolean }).deleted = true;
      await (
        collection as unknown as {
          saveTx: (options?: { deleteItems?: boolean }) => Promise<unknown>;
        }
      ).saveTx({ deleteItems: !!params.deleteItems });
    }
    if (libraryID > 0) invalidatePaperSearchCache(libraryID);
  }

  /**
   * Brings collections back out of the trash.
   *
   * Descendants are restored alongside their parent, mirroring both what
   * `trash()` took down and what Zotero's own "Restore to Library" does
   * (`zoteroPane.js` restores `getDescendents(false, 'collection', true)`).
   * Without that, restoring a parent would leave its subtree stranded in the
   * trash.
   */
  async restoreCollections(params: {
    collectionIds: number[];
  }): Promise<{ restoredCount: number }> {
    const touchedLibraryIDs = new Set<number>();
    const seen = new Set<number>();
    let restoredCount = 0;
    for (const collectionId of params.collectionIds) {
      const collection = this.getCollection(collectionId) as
        | (Zotero.Collection & {
            deleted?: boolean;
            getDescendents?: (
              nested: boolean,
              type: "collection" | "item" | null,
              includeDeletedItems?: boolean,
            ) => Array<{ id: number; type: string }>;
          })
        | null;
      if (!collection) continue;
      const targets: Array<Zotero.Collection & { deleted?: boolean }> = [
        collection,
      ];
      try {
        for (const descendent of collection.getDescendents?.(
          false,
          "collection",
          true,
        ) || []) {
          const child = this.getCollection(descendent.id) as
            | (Zotero.Collection & { deleted?: boolean })
            | null;
          if (child) targets.push(child);
        }
      } catch {
        // A missing descendant must not block restoring the parent.
      }
      for (const target of targets) {
        const id = Number(target.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!target.deleted) continue;
        target.deleted = false;
        await (
          target as unknown as { saveTx: () => Promise<unknown> }
        ).saveTx();
        restoredCount += 1;
        touchedLibraryIDs.add(Number(target.libraryID));
      }
    }
    for (const libraryID of touchedLibraryIDs) {
      if (libraryID > 0) invalidatePaperSearchCache(libraryID);
    }
    return { restoredCount };
  }

  /**
   * Removes tags and reports which ones were actually on the item.
   *
   * It used to return `void`, and the caller derived its count from the
   * paper-target map — which `buildPaperTargetFromItem` gates on having a PDF
   * child. So removing a tag from a book worked, reported `removedCount: 0`,
   * and recorded no undo. Once `effect` started reading that count, the same
   * stale zero also told the user nothing had changed.
   */
  async removeTagsFromItem(params: {
    itemId: number;
    tags: string[];
  }): Promise<{ removed: string[] }> {
    // Tags live on the item itself — including notes and standalone
    // attachments, which the regular-item filter used to exclude — so this
    // resolves through the capability matrix rather than the paper map.
    const raw = this.getItem(params.itemId);
    const resolution = resolveMatrixItem(raw, params.itemId, "update");
    const item = "item" in resolution ? resolution.item : null;
    if (!item || !params.tags.length) return { removed: [] };
    const removed: string[] = [];
    for (const tag of params.tags) {
      if (!tag) continue;
      if (item.hasTag?.(tag)) {
        item.removeTag?.(tag);
        removed.push(tag);
      }
    }
    if (removed.length) {
      await item.saveTx();
    }
    return { removed };
  }

  /**
   * Returns whether the item was actually removed. It used to return `void`
   * and bail silently on an unresolvable item, while the caller counted every
   * requested id as removed — so a request to unfile ten notes reported
   * "removedCount: 10" having done nothing at all.
   */
  /**
   * Reads an item's real collection membership.
   *
   * The read path used to take this from the paper-target map, which is built
   * by `buildPaperTargetFromItem` and returns `null` for any item without a
   * PDF child — so a book sitting in three collections reported none, and a
   * note reported nothing at all. That is the channel an agent uses to verify
   * a filing operation, so it silently failed exactly where it mattered.
   */
  getItemCollectionIds(itemId: number): number[] {
    const item = this.getItem(itemId);
    if (!item) return [];
    try {
      const ids = (
        item as unknown as { getCollections?: () => number[] }
      ).getCollections?.();
      return Array.isArray(ids)
        ? ids.filter((id) => Number.isFinite(id) && id > 0)
        : [];
    } catch {
      return [];
    }
  }

  async removeItemFromCollection(params: {
    itemId: number;
    collectionId: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    const resolution = resolveMatrixItem(
      this.getItem(params.itemId),
      params.itemId,
      "removeFromCollection",
    );
    if (!("item" in resolution)) {
      return { removed: false, reason: resolution.refusal };
    }
    const item = resolution.item;
    if (!item.inCollection?.(params.collectionId)) {
      return {
        removed: false,
        reason: "The item was not in that collection",
      };
    }
    item.removeFromCollection(params.collectionId);
    await item.saveTx();
    const collection = this.getCollection(params.collectionId);
    const libraryID = Number(collection?.libraryID) || 0;
    if (libraryID > 0) invalidatePaperSearchCache(libraryID);
    return { removed: true };
  }

  async findRelatedPapersInLibrary(params: {
    libraryID: number;
    referenceItemId: number;
    limit?: number;
  }): Promise<{
    referenceTitle: string;
    relatedPapers: RelatedPaperResult[];
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const referenceItem = this.resolveBibliographicItem(
      this.getItem(params.referenceItemId),
    );
    if (!referenceItem) throw new Error("Reference paper not found");
    const referenceTarget = buildPaperTargetFromItem(referenceItem);
    if (!referenceTarget)
      throw new Error("Reference paper has no PDF attachment");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 10;
    const refTitle = normalizeText(referenceTarget.title).toLowerCase();
    const refTitleWords = new Set(
      refTitle.split(/\W+/).filter((w) => w.length > 3),
    );
    const refAuthor = normalizeText(
      referenceTarget.firstCreator || "",
    ).toLowerCase();
    const refYear = referenceTarget.year ? Number(referenceTarget.year) : null;
    const refJournal = normalizeText(
      String(referenceItem.getField?.("publicationTitle") ?? ""),
    ).toLowerCase();
    const candidates = await listLibraryPaperCandidates(libraryID);
    const scored: RelatedPaperResult[] = [];
    for (const candidate of candidates) {
      if (candidate.itemId === referenceTarget.itemId) continue;
      const item = this.resolveBibliographicItem(
        this.getItem(candidate.itemId),
      );
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (!target) continue;
      let score = 0;
      const reasons: string[] = [];
      const candAuthor = normalizeText(target.firstCreator || "").toLowerCase();
      if (refAuthor && candAuthor && refAuthor === candAuthor) {
        score += 40;
        reasons.push(`Same first author: ${target.firstCreator}`);
      }
      const candTitle = normalizeText(target.title).toLowerCase();
      const candTitleWords = new Set(
        candTitle.split(/\W+/).filter((w) => w.length > 3),
      );
      const sharedWords = [...refTitleWords].filter((w) =>
        candTitleWords.has(w),
      );
      if (sharedWords.length >= 2) {
        score += Math.min(sharedWords.length * 8, 30);
        reasons.push(
          `Shared title keywords: ${sharedWords.slice(0, 3).join(", ")}`,
        );
      }
      const candJournal = normalizeText(
        String(item.getField?.("publicationTitle") ?? ""),
      ).toLowerCase();
      if (refJournal && candJournal && refJournal === candJournal) {
        score += 15;
        reasons.push(`Same journal: ${item.getField?.("publicationTitle")}`);
      }
      const candYear = target.year ? Number(target.year) : null;
      if (refYear && candYear && Math.abs(refYear - candYear) <= 3) {
        score += 5;
      }
      const sharedTags = referenceTarget.tags.filter((t) =>
        target.tags.includes(t),
      );
      if (sharedTags.length > 0) {
        score += sharedTags.length * 5;
        reasons.push(`Shared tags: ${sharedTags.slice(0, 3).join(", ")}`);
      }
      if (score > 0) {
        scored.push({ ...target, matchScore: score, matchReasons: reasons });
      }
    }
    scored.sort((a, b) => b.matchScore - a.matchScore);
    return {
      referenceTitle: referenceTarget.title,
      relatedPapers: scored.slice(0, limit),
    };
  }

  async detectDuplicatesInLibrary(params: {
    libraryID: number;
    limit?: number;
  }): Promise<{
    totalGroups: number;
    groups: DuplicateGroup[];
  }> {
    const libraryID = Number.isFinite(params.libraryID)
      ? Math.floor(params.libraryID)
      : 0;
    if (!libraryID) throw new Error("No active library available");
    const limit =
      Number.isFinite(params.limit) && (params.limit as number) > 0
        ? Math.floor(params.limit as number)
        : 20;
    const candidates = await listLibraryPaperCandidates(libraryID);
    const byDoi = new Map<string, LibraryPaperTarget[]>();
    const byNormalizedTitle = new Map<string, LibraryPaperTarget[]>();
    for (const candidate of candidates) {
      const item = this.resolveBibliographicItem(
        this.getItem(candidate.itemId),
      );
      if (!item) continue;
      const target = buildPaperTargetFromItem(item);
      if (!target) continue;
      const doi = normalizeText(
        String(item.getField?.("DOI") ?? ""),
      ).toLowerCase();
      if (doi) {
        const existing = byDoi.get(doi) || [];
        existing.push(target);
        byDoi.set(doi, existing);
      }
      const normalizedTitle = normalizeText(target.title)
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (normalizedTitle.length > 10) {
        const existing = byNormalizedTitle.get(normalizedTitle) || [];
        existing.push(target);
        byNormalizedTitle.set(normalizedTitle, existing);
      }
    }
    const groups: DuplicateGroup[] = [];
    const seenItemIds = new Set<number>();
    for (const [doi, papers] of byDoi) {
      if (papers.length < 2) continue;
      if (groups.length >= limit) break;
      const newPapers = papers.filter((p) => !seenItemIds.has(p.itemId));
      if (newPapers.length < 2) continue;
      groups.push({ matchReason: `Same DOI: ${doi}`, papers: newPapers });
      for (const p of newPapers) seenItemIds.add(p.itemId);
    }
    for (const [, papers] of byNormalizedTitle) {
      if (papers.length < 2) continue;
      if (groups.length >= limit) break;
      const newPapers = papers.filter((p) => !seenItemIds.has(p.itemId));
      if (newPapers.length < 2) continue;
      groups.push({ matchReason: "Same title", papers: newPapers });
      for (const p of newPapers) seenItemIds.add(p.itemId);
    }
    return { totalGroups: groups.length, groups };
  }

  async updateArticleMetadata(params: {
    item: Zotero.Item | null;
    metadata: EditableArticleMetadataPatch;
  }): Promise<{
    status: "updated";
    itemId: number;
    title: string;
    changedFields: string[];
  }> {
    // resolveRegularItem silently substitutes the PARENT for a child
    // attachment, so writing metadata on an attachment edited a different
    // object and then read the parent back as confirmation -- a self-verifying
    // false success. The matrix answers per kind instead.
    const resolution = resolveMatrixItem(
      params.item,
      Number(params.item?.id) || 0,
      "update",
    );
    if ("refusal" in resolution) throw new Error(resolution.refusal);
    const item = resolution.item;

    // Every key in the patch is a candidate now. The 18-name allowlist was
    // never the real schema -- Zotero's own field table is -- and it silently
    // dropped anything outside it, so "set the publisher on this book"
    // reported success with nothing written.
    const fieldNames = Object.keys(params.metadata).filter(
      (fieldName) => fieldName !== "creators",
    );
    const unsupportedFields = fieldNames.filter(
      (fieldName) => !isFieldValidForItemType(item, fieldName),
    );
    if (unsupportedFields.length) {
      const itemTypeName = getItemTypeName(item) || "this item type";
      const available = listEditableFieldsForItem(item);
      throw new Error(
        `Unsupported metadata fields for ${itemTypeName}: ${unsupportedFields.join(", ")}.` +
          (available.length
            ? ` Fields this item type accepts: ${available.join(", ")}.`
            : ""),
      );
    }

    const rejectedFields: string[] = [];
    for (const fieldName of fieldNames) {
      const value =
        (params.metadata as Record<string, unknown>)[fieldName] ?? "";
      // setField returns false rather than throwing for a value it cannot
      // parse -- `accessDate: "yesterday"` is the common case -- and the old
      // code ignored that and reported success anyway.
      // The bundled typings declare setField as void; Zotero returns a
      // boolean (item.js:653), false meaning the value was not taken.
      const accepted = (
        item as unknown as {
          setField: (field: string, value: string) => boolean | void;
        }
      ).setField(fieldName, String(value));
      if (accepted === false && String(value).trim()) {
        const before = normalizeText(item.getField?.(fieldName));
        if (before !== String(value).trim()) rejectedFields.push(fieldName);
      }
    }
    if (rejectedFields.length) {
      throw new Error(
        `Zotero rejected these values: ${rejectedFields.join(", ")}. Check the format — dates must be real dates, not phrases like "yesterday".`,
      );
    }

    if (Array.isArray(params.metadata.creators)) {
      const creatorTypes = (
        Zotero as unknown as {
          CreatorTypes?: {
            itemTypeHasCreators?: (itemTypeId: number) => boolean;
          };
        }
      ).CreatorTypes;
      const supportsCreators =
        typeof creatorTypes?.itemTypeHasCreators === "function"
          ? creatorTypes.itemTypeHasCreators(item.itemTypeID)
          : true;
      if (!supportsCreators) {
        const itemTypeName = getItemTypeName(item) || "this item type";
        throw new Error(`Creators are not supported for ${itemTypeName}`);
      }
      item.setCreators(
        params.metadata.creators as Array<
          _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator
        >,
        { strict: true },
      );
    }

    await item.saveTx();
    const changedFields = [
      ...fieldNames,
      ...(Array.isArray(params.metadata.creators) ? ["creators"] : []),
    ];
    const snapshot = this.getEditableArticleMetadata(item);
    return {
      status: "updated",
      itemId: item.id,
      title: snapshot?.title || `Item ${item.id}`,
      changedFields,
    };
  }

  async trashItems(params: { itemIds: number[] }): Promise<{
    trashedCount: number;
    items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }>;
  }> {
    const items: Array<{
      itemId: number;
      title: string;
      status: "trashed" | "skipped" | "error";
      reason?: string;
    }> = [];
    let trashedCount = 0;
    const touchedLibraryIDs = new Set<number>();
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item) {
        items.push({
          itemId,
          title: `Item ${itemId}`,
          status: "skipped",
          reason: "Item not found",
        });
        continue;
      }
      const title = String(item.getField?.("title") || `Item ${itemId}`);
      if (item.deleted) {
        items.push({
          itemId,
          title,
          status: "skipped",
          reason: "Already in trash",
        });
        continue;
      }
      try {
        item.deleted = true;
        await item.saveTx();
        trashedCount++;
        touchedLibraryIDs.add(Number(item.libraryID));
        items.push({ itemId, title, status: "trashed" });
      } catch (error) {
        items.push({
          itemId,
          title,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const libraryID of touchedLibraryIDs) {
      invalidatePaperSearchCache(libraryID);
    }
    return { trashedCount, items };
  }

  /**
   * Brings items back out of the trash.
   *
   * Reports which ids it actually restored, rather than `void`: an item that
   * was never trashed is skipped, so a caller that assumed every requested id
   * came back would build an inverse that re-trashes items this call never
   * touched.
   */
  async restoreItems(params: {
    itemIds: number[];
  }): Promise<{ restoredCount: number; itemIds: number[] }> {
    const touchedLibraryIDs = new Set<number>();
    const restored: number[] = [];
    for (const itemId of params.itemIds) {
      const item = this.getItem(itemId);
      if (!item || !item.deleted) continue;
      item.deleted = false;
      await item.saveTx();
      restored.push(Number(item.id));
      touchedLibraryIDs.add(Number(item.libraryID));
    }
    for (const libraryID of touchedLibraryIDs) {
      invalidatePaperSearchCache(libraryID);
    }
    return { restoredCount: restored.length, itemIds: restored };
  }

  /**
   * Brings saved searches back out of the trash. Zotero tracks these in
   * `deletedSearches`, exactly as it does collections.
   */
  async restoreSavedSearches(params: {
    savedSearchIds: number[];
  }): Promise<{ restoredCount: number }> {
    let restoredCount = 0;
    for (const savedSearchId of params.savedSearchIds) {
      const search = (
        Zotero.Searches as unknown as {
          get?: (id: number) => (Zotero.Search & { deleted?: boolean }) | null;
        }
      ).get?.(savedSearchId);
      if (!search || !search.deleted) continue;
      (search as unknown as { deleted: boolean }).deleted = false;
      await (search as unknown as { saveTx: () => Promise<unknown> }).saveTx();
      restoredCount += 1;
    }
    return { restoredCount };
  }

  // ── Merge duplicates ──────────────────────────────────────────────

  /**
   * Merges duplicates, delegating to Zotero's own merge.
   *
   * This used to be hand-rolled, and diverged from Zotero in ways that
   * quietly damaged the library:
   *
   * - It never wrote the `dc:replaces` relation onto the survivor.
   *   `integration.js` resolves a Word or LibreOffice citation pointing at a
   *   merged-away item *only* through that predicate, so on the next citation
   *   refresh the user got "the item could not be found in your library" and
   *   had to hand-pick a replacement for every affected citation. Zotero's
   *   own merge repoints them silently.
   * - It never deduplicated identical PDF attachments by hash, so the
   *   survivor accumulated a copy of the same file per duplicate.
   * - It never remapped old item keys inside merged note HTML
   *   (`Zotero.Notes.replaceItemKey`), leaving dead links in notes.
   * - It never took the earliest `dateAdded`.
   * - It ran outside a transaction, saving each object separately, so a
   *   failure part-way left the library half-merged.
   * - It dropped tag types, turning manual tags into automatic ones.
   *
   * Zotero's implementation does all of this inside one transaction.
   */
  async mergeItems(params: {
    masterItemId: number;
    otherItemIds: number[];
  }): Promise<{
    mergedCount: number;
    masterItemId: number;
    masterTitle: string;
    trashedIds: number[];
  }> {
    const masterItem = this.getItem(params.masterItemId);
    if (!masterItem)
      throw new Error(`Master item ${params.masterItemId} not found`);
    const masterTitle = String(
      masterItem.getField?.("title") || `Item ${params.masterItemId}`,
    );

    const others: Zotero.Item[] = [];
    for (const otherId of params.otherItemIds) {
      if (otherId === params.masterItemId) continue;
      const otherItem = this.getItem(otherId);
      if (!otherItem) continue;
      if (Number(otherItem.libraryID) !== Number(masterItem.libraryID)) {
        throw new Error(
          `Item ${otherId} is in a different library than the master item, and Zotero cannot merge across libraries.`,
        );
      }
      others.push(otherItem);
    }
    if (!others.length) {
      return {
        mergedCount: 0,
        masterItemId: params.masterItemId,
        masterTitle,
        trashedIds: [],
      };
    }

    const merge = (
      Zotero.Items as unknown as {
        merge?: (item: Zotero.Item, otherItems: Zotero.Item[]) => Promise<void>;
      }
    ).merge;
    if (typeof merge !== "function") {
      // Refuse rather than fall back to the hand-rolled path: a merge that
      // silently omits dc:replaces breaks the user's citations, and they
      // would not find out until the next time they refreshed a document.
      throw new Error(
        "This Zotero build does not expose Zotero.Items.merge, so duplicates cannot be merged safely.",
      );
    }
    await merge.call(Zotero.Items, masterItem, others);

    const trashedIds = others.map((item) => Number(item.id));
    const touchedLibraryIDs = new Set<number>([Number(masterItem.libraryID)]);
    for (const libraryID of touchedLibraryIDs) {
      if (libraryID > 0) invalidatePaperSearchCache(libraryID);
    }

    return {
      mergedCount: trashedIds.length,
      masterItemId: params.masterItemId,
      masterTitle,
      trashedIds,
    };
  }

  // ── Attachment management ──────────────────────────────────────────

  /**
   * Delete an attachment (moves to trash).
   */
  async deleteAttachment(params: { attachmentId: number }): Promise<{
    attachmentId: number;
    title: string;
    status: "deleted" | "not_found";
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) {
      return {
        attachmentId: params.attachmentId,
        title: "",
        status: "not_found",
      };
    }
    const title = String(
      (item as unknown as { attachmentFilename?: string }).attachmentFilename ||
        item.getField?.("title") ||
        `Attachment ${params.attachmentId}`,
    );
    item.deleted = true;
    await item.saveTx();
    return { attachmentId: params.attachmentId, title, status: "deleted" };
  }

  /**
   * Rename an attachment's filename on disk.
   */
  /**
   * Renames an attachment's file on disk.
   *
   * This used to probe `Zotero.Attachments.renameAttachmentFile`, which does
   * not exist — the method lives on `Zotero.Item.prototype`. The probe was
   * therefore always false, every rename silently fell through to setting the
   * *title* field, and the result still said `status: "renamed"`. The file on
   * disk never moved.
   *
   * `updateTitle` mirrors Zotero's own behaviour: the title follows the
   * filename only when it was tracking it to begin with. `unique` means a
   * name collision produces `paper-1.pdf` rather than failing, so the actual
   * filename is read back rather than assumed.
   */
  async renameAttachment(params: {
    attachmentId: number;
    newName: string;
  }): Promise<{
    attachmentId: number;
    previousName: string;
    newName: string;
    status: "renamed" | "unchanged" | "not_found" | "no_file" | "error";
    titleUpdated?: boolean;
    reason?: string;
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) {
      return {
        attachmentId: params.attachmentId,
        previousName: "",
        newName: params.newName,
        status: "not_found",
      };
    }
    const attachment = item as unknown as {
      attachmentFilename?: string;
      attachmentLinkMode?: number;
      renameAttachmentFile?: (
        newName: string,
        options?: {
          overwrite?: boolean;
          unique?: boolean;
          updateTitle?: boolean;
          out?: { noChange?: boolean; titleUpdated?: boolean };
        },
      ) => Promise<boolean | -1 | -2>;
    };
    const previousName = String(attachment.attachmentFilename || "");

    // A linked URL has no file, so "rename" can only mean the title. Handled
    // explicitly rather than by silently falling through, which is what made
    // the old bug invisible.
    if (
      attachment.attachmentLinkMode === 3 ||
      !attachment.renameAttachmentFile
    ) {
      try {
        item.setField("title", params.newName);
        await item.saveTx();
        return {
          attachmentId: params.attachmentId,
          previousName: String(item.getField?.("title") || previousName),
          newName: params.newName,
          status: "renamed",
          titleUpdated: true,
        };
      } catch (error) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    try {
      const out: { noChange?: boolean; titleUpdated?: boolean } = {};
      const outcome = await attachment.renameAttachmentFile(params.newName, {
        unique: true,
        updateTitle: true,
        out,
      });
      if (outcome === false) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "no_file",
          reason:
            "The attachment's file is missing, so there is nothing to rename. Re-link it to a file first.",
        };
      }
      if (outcome === -1) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "error",
          reason: "A file with that name already exists.",
        };
      }
      if (outcome === -2) {
        return {
          attachmentId: params.attachmentId,
          previousName,
          newName: params.newName,
          status: "error",
          reason: "Zotero could not rename the file.",
        };
      }
      // `unique` may have appended a suffix, so report what the file is
      // actually called rather than what was requested.
      const actualName = String(
        attachment.attachmentFilename || params.newName,
      );
      return {
        attachmentId: params.attachmentId,
        previousName,
        newName: actualName,
        status: out.noChange ? "unchanged" : "renamed",
        titleUpdated: !!out.titleUpdated,
      };
    } catch (error) {
      return {
        attachmentId: params.attachmentId,
        previousName,
        newName: params.newName,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Points an attachment at a different file on disk.
   *
   * This used to refuse anything that was not `linkMode === 2`, so a user
   * whose *stored* PDF had gone missing — the common case, and exactly what
   * Zotero's own "Locate File…" repairs — was told "Only linked-file
   * attachments can be re-linked". Zotero refuses only linked *URLs*.
   *
   * It also assigned `attachmentPath` directly, skipping filename
   * sanitisation, the copy-into-storage step that stored attachments need,
   * the cached file-state refresh, and the notifier event that clears the
   * missing-file emblem. Delegating to Zotero's own method gets all four.
   */
  async relinkAttachment(params: {
    attachmentId: number;
    newPath: string;
  }): Promise<{
    attachmentId: number;
    previousPath: string;
    newPath: string;
    status: "relinked" | "not_found" | "not_linked_file" | "error";
    reason?: string;
  }> {
    const item = this.getItem(params.attachmentId);
    if (!item || !item.isAttachment?.()) {
      return {
        attachmentId: params.attachmentId,
        previousPath: "",
        newPath: params.newPath,
        status: "not_found",
      };
    }
    const attachment = item as unknown as {
      attachmentLinkMode?: number;
      attachmentPath?: string;
      getFilePathAsync?: () => Promise<string | false>;
      relinkAttachmentFile?: (path: string) => Promise<boolean>;
    };
    // 3 = LINK_MODE_LINKED_URL, the only mode Zotero itself rejects.
    if (attachment.attachmentLinkMode === 3) {
      return {
        attachmentId: params.attachmentId,
        previousPath: "",
        newPath: params.newPath,
        status: "not_linked_file",
        reason:
          "This attachment is a linked URL, which has no file to re-link.",
      };
    }
    const previousPath = String((await attachment.getFilePathAsync?.()) || "");
    try {
      if (attachment.relinkAttachmentFile) {
        await attachment.relinkAttachmentFile(params.newPath);
      } else {
        attachment.attachmentPath = params.newPath;
        await item.saveTx();
      }
      return {
        attachmentId: params.attachmentId,
        previousPath,
        newPath: String(
          (await attachment.getFilePathAsync?.()) || params.newPath,
        ),
        status: "relinked",
      };
    } catch (error) {
      return {
        attachmentId: params.attachmentId,
        previousPath,
        newPath: params.newPath,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // ── Embed image in note ──────────────────────────────────────────

  /**
   * Import an image file as an embedded note attachment and return its key.
   * The key can then be used in note HTML: <img data-attachment-key="KEY" />
   */
  async importNoteImage(
    params: NoteImageImportInput,
  ): Promise<{ key: string } | null> {
    return importNoteImageAsset(params);
  }

  // ── Import local files ──────────────────────────────────────────

  /**
   * Import local files (PDFs, etc.) into the Zotero library.
   * Uses Zotero.Attachments.importFromFile to create items with attached files.
   * For PDFs, Zotero automatically attempts to retrieve metadata.
   */
  async importLocalFiles(params: {
    filePaths: string[];
    libraryID?: number;
    targetCollectionId?: number;
  }): Promise<{
    succeeded: number;
    failed: number;
    items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }>;
  }> {
    const targetLibraryID =
      params.libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;
    const targetCollection = params.targetCollectionId
      ? this.getCollection(params.targetCollectionId)
      : null;

    let succeeded = 0;
    let failed = 0;
    const items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }> = [];

    const Attachments = (Zotero as any).Attachments;

    for (const filePath of params.filePaths) {
      try {
        // Check file exists
        const fileExists = await (async () => {
          try {
            const IOUtils = (globalThis as any).IOUtils;
            if (IOUtils?.exists) return await IOUtils.exists(filePath);
            const OSFile = (globalThis as any).OS?.File;
            if (OSFile?.exists) return await OSFile.exists(filePath);
            return true; // assume exists if we can't check
          } catch {
            return false;
          }
        })();

        if (!fileExists) {
          items.push({
            filePath,
            status: "not_found",
            reason: "File not found",
          });
          failed++;
          continue;
        }

        // Create a nsIFile reference
        let nsFile: any;
        const Components = (globalThis as any).Components;
        if (Components?.classes) {
          nsFile = Components.classes[
            "@mozilla.org/file/local;1"
          ].createInstance(Components.interfaces.nsIFile);
          nsFile.initWithPath(filePath);
        }

        let attachmentItem: any;

        if (Attachments?.importFromFile && nsFile) {
          // Primary: Zotero.Attachments.importFromFile({ file, libraryID })
          attachmentItem = await Attachments.importFromFile({
            file: nsFile,
            libraryID: targetLibraryID,
          });
        } else if (Attachments?.importFromFile) {
          // Try with path string
          attachmentItem = await Attachments.importFromFile({
            file: filePath,
            libraryID: targetLibraryID,
          });
        } else {
          items.push({
            filePath,
            status: "error",
            reason: "Zotero.Attachments.importFromFile is not available",
          });
          failed++;
          continue;
        }

        if (!attachmentItem) {
          items.push({
            filePath,
            status: "error",
            reason: "Import returned no item",
          });
          failed++;
          continue;
        }

        const itemId = Number(attachmentItem.id);
        const title = String(
          attachmentItem.getField?.("title") ||
            (attachmentItem as any).attachmentFilename ||
            filePath.split(/[\\/]/).pop() ||
            filePath,
        );

        // If there's a parent item (Zotero auto-created from metadata retrieval),
        // use that for collection assignment
        const parentId = attachmentItem.parentID;
        const targetItem = parentId
          ? this.getItem(parentId) || attachmentItem
          : attachmentItem;

        if (targetCollection && targetItem.isRegularItem?.()) {
          targetItem.addToCollection(targetCollection.id);
          await targetItem.saveTx();
        }

        items.push({
          filePath,
          status: "imported",
          itemId: parentId || itemId,
          title,
        });
        succeeded++;
      } catch (error) {
        items.push({
          filePath,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }

    if (succeeded > 0) {
      invalidatePaperSearchCache(targetLibraryID);
    }

    return { succeeded, failed, items };
  }

  /**
   * Fetch canonical metadata for a paper by identifier (DOI, arXiv ID, or ISBN)
   * using Zotero's built-in Translate.Search engine — the same engine that powers
   * "Add Item by Identifier". Returns a complete metadata patch with ALL fields
   * without creating any item in the library.
   *
   * Falls back to creating a temporary item and reading its fields if the
   * translator does not support libraryID: false.
   */
  /**
   * Parses a user- or model-supplied identifier into Zotero's translator
   * shape.
   *
   * The import path used to have its own two-branch version: a
   * case-SENSITIVE `arxiv:` prefix, else "assume DOI". So the ISBNs and URLs
   * both schemas advertised silently failed, and — worse — the tool's own
   * validation hint suggested `"arXiv:2301.00001"` with a capital V, which
   * failed its own check.
   */
  private parseImportIdentifier(rawIdentifier: string): Record<string, string> {
    const trimmed = rawIdentifier.trim();
    if (/^arxiv:/i.test(trimmed)) {
      return { arXiv: trimmed.replace(/^arxiv:/i, "").trim() };
    }
    const withoutIsbnPrefix = trimmed.replace(/^isbn[:\s]?/i, "");
    if (/^[\d-]{10,}$/.test(withoutIsbnPrefix)) {
      return { ISBN: withoutIsbnPrefix.trim() };
    }
    if (/^pmid[:\s]?\d+$/i.test(trimmed)) {
      return { PMID: trimmed.replace(/^pmid[:\s]?/i, "").trim() };
    }
    return { DOI: trimmed.replace(/^https?:\/\/doi\.org\//i, "") };
  }

  async fetchMetadataByIdentifier(
    rawIdentifier: string,
  ): Promise<EditableArticleMetadataPatch | null> {
    try {
      const isArXiv = /^arxiv:/i.test(rawIdentifier);
      const isIsbn = /^(isbn[:\s]?)?[\d-]{10,}$/i.test(
        rawIdentifier.replace(/^isbn[:\s]?/i, ""),
      );
      const identifier: Record<string, string> = isArXiv
        ? { arXiv: rawIdentifier.replace(/^arxiv:/i, "") }
        : isIsbn
          ? { ISBN: rawIdentifier.replace(/^isbn[:\s]?/i, "").trim() }
          : { DOI: rawIdentifier.replace(/^https?:\/\/doi\.org\//i, "") };

      const translate = new (
        Zotero as unknown as {
          Translate: {
            Search: new () => {
              setIdentifier(id: Record<string, string>): void;
              getTranslators(): Promise<unknown[]>;
              setTranslator(t: unknown): void;
              translate(opts?: {
                libraryID?: number | false;
                saveAttachments?: boolean;
              }): Promise<unknown[]>;
            };
          };
        }
      ).Translate.Search();

      translate.setIdentifier(identifier);
      const translators = await translate.getTranslators();
      if (!translators || translators.length === 0) return null;
      translate.setTranslator(translators);

      // Try libraryID: false first — returns raw JSON without saving to DB
      let rawItems: unknown[];
      let tempItemId: number | null = null;
      try {
        rawItems = await translate.translate({
          libraryID: false as unknown as number,
          saveAttachments: false,
        });
      } catch {
        // Fallback: create a temporary item, read its metadata, then delete it
        const targetLibraryID =
          (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
            .Libraries?.userLibraryID ?? 1;
        rawItems = await translate.translate({ libraryID: targetLibraryID });
        if (rawItems?.[0] && typeof rawItems[0] === "object") {
          const id = Number((rawItems[0] as { id?: unknown }).id);
          if (Number.isFinite(id) && id > 0) tempItemId = Math.floor(id);
        }
      }

      if (!rawItems || rawItems.length === 0) return null;
      const raw = rawItems[0] as Record<string, unknown>;

      // If we got a real Zotero item (fallback path), read fields from it
      if (tempItemId) {
        const item = this.getItem(tempItemId);
        if (item) {
          const snapshot = this.getEditableArticleMetadata(item);
          // Clean up the temporary item
          try {
            item.deleted = true;
            await item.saveTx();
            await item.eraseTx();
          } catch {
            // Best-effort cleanup
          }
          if (snapshot) {
            const patch: EditableArticleMetadataPatch = {};
            for (const [key, value] of Object.entries(snapshot.fields)) {
              if (value) {
                patch[key as EditableArticleMetadataField] = value;
              }
            }
            if (snapshot.creators.length) patch.creators = snapshot.creators;
            return Object.keys(patch).length ? patch : null;
          }
        }
        return null;
      }

      // libraryID: false path — raw is a translator JSON object
      return this.translatorJsonToPatch(raw);
    } catch {
      return null;
    }
  }

  /**
   * Convert a raw Zotero translator JSON result (from libraryID: false) into
   * an EditableArticleMetadataPatch.
   */
  private translatorJsonToPatch(
    raw: Record<string, unknown>,
  ): EditableArticleMetadataPatch | null {
    const patch: EditableArticleMetadataPatch = {};
    for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
      const value = raw[fieldName];
      if (typeof value === "string" && value.trim()) {
        patch[fieldName] = value.trim();
      } else if (typeof value === "number") {
        patch[fieldName] = String(value);
      }
    }
    // Creators from translator JSON come as [{firstName, lastName, creatorType}]
    const rawCreators = Array.isArray(raw.creators) ? raw.creators : [];
    const creators: EditableArticleCreator[] = [];
    for (const entry of rawCreators) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as Record<string, unknown>;
      const creatorType =
        typeof c.creatorType === "string" && c.creatorType.trim()
          ? c.creatorType.trim()
          : "author";
      const firstName =
        typeof c.firstName === "string" && c.firstName.trim()
          ? c.firstName.trim()
          : undefined;
      const lastName =
        typeof c.lastName === "string" && c.lastName.trim()
          ? c.lastName.trim()
          : undefined;
      const name =
        typeof c.name === "string" && c.name.trim() ? c.name.trim() : undefined;
      if (!name && !firstName && !lastName) continue;
      creators.push({
        creatorType,
        firstName,
        lastName,
        name,
        fieldMode: (name && !firstName && !lastName ? 1 : 0) as 0 | 1,
      });
    }
    if (creators.length) patch.creators = creators;
    return Object.keys(patch).length ? patch : null;
  }

  /**
   * Import papers into the Zotero library by identifier (DOI or arXiv ID).
   *
   * - Plain DOI strings (starting with "10.") → `{ DOI: id }`
   * - arXiv IDs prefixed with `"arxiv:"` (e.g. `"arxiv:2301.12345"`) → `{ arXiv: id }`
   *
   * Uses Zotero's built-in `Translate.Search` API, which fetches metadata from
   * CrossRef / arXiv translators and saves items to the target library.
   * Zotero will also attempt to attach a PDF if one is openly available.
   */
  async importPapersByIdentifiers(
    identifiers: string[],
    libraryID?: number,
    targetCollectionId?: number,
  ): Promise<{
    succeeded: number;
    failed: number;
    itemIds?: number[];
    items: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }>;
  }> {
    let succeeded = 0;
    let failed = 0;
    const itemIds: number[] = [];
    // Per-identifier rows: "10 of 50 failed" was previously unattributable,
    // so a user had no way to know which ten to retry.
    const rows: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }> = [];
    const targetLibraryID =
      libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;
    const targetCollection = targetCollectionId
      ? this.getCollection(targetCollectionId)
      : null;
    if (targetCollectionId && !targetCollection) {
      throw new Error("Target collection not found");
    }

    for (const rawId of identifiers) {
      try {
        const identifier = this.parseImportIdentifier(rawId);

        const translate = new (
          Zotero as unknown as {
            Translate: {
              Search: new () => {
                setIdentifier(id: Record<string, string>): void;
                getTranslators(): Promise<unknown[]>;
                setTranslator(t: unknown): void;
                translate(opts?: { libraryID?: number }): Promise<unknown[]>;
              };
            };
          }
        ).Translate.Search();

        translate.setIdentifier(identifier);
        const translators = await translate.getTranslators();
        if (!translators || translators.length === 0) {
          failed++;
          rows.push({
            identifier: rawId,
            status: "not_found",
            reason: "No translator could resolve this identifier",
          });
          continue;
        }
        translate.setTranslator(translators);
        const items = await translate.translate({ libraryID: targetLibraryID });
        if (items && items.length > 0) {
          const importedRegularItemIds = items
            .map((item) =>
              item && typeof item === "object"
                ? Number((item as { id?: unknown }).id)
                : NaN,
            )
            .filter((itemId) => Number.isFinite(itemId) && itemId > 0)
            .map((itemId) => Math.floor(itemId))
            .filter((itemId) => {
              const importedItem = this.getItem(itemId);
              return Boolean(importedItem?.isRegularItem?.());
            });
          if (targetCollection) {
            for (const itemId of importedRegularItemIds) {
              const importedItem = this.getItem(itemId);
              if (
                !importedItem ||
                importedItem.inCollection?.(targetCollection.id)
              ) {
                continue;
              }
              importedItem.addToCollection(targetCollection.id);
              await importedItem.saveTx();
            }
          }
          itemIds.push(...importedRegularItemIds);
          // Previously `|| items.length`, which reported success when the
          // translator returned something but nothing survived the
          // regular-item filter — so nothing was filed and it still counted.
          if (importedRegularItemIds.length) {
            succeeded += importedRegularItemIds.length;
            for (const itemId of importedRegularItemIds) {
              rows.push({ identifier: rawId, status: "imported", itemId });
            }
          } else {
            failed++;
            rows.push({
              identifier: rawId,
              status: "error",
              reason:
                "The translator returned no regular item for this identifier",
            });
          }
        } else {
          failed++;
          rows.push({
            identifier: rawId,
            status: "not_found",
            reason: "The translator returned no items",
          });
        }
      } catch (error) {
        failed++;
        rows.push({
          identifier: rawId,
          status: "error",
          reason: error instanceof Error ? error.message : "Import failed",
        });
      }
    }

    // A follow-up library_search would not have seen the new items.
    if (itemIds.length && targetLibraryID > 0) {
      invalidatePaperSearchCache(targetLibraryID);
    }

    return { succeeded, failed, itemIds, items: rows };
  }
}
