import { resolveContextAttachmentSupportFromMetadata } from "../modules/contextPanel/contextAttachmentSupport";
import { isMineruSyncPackageTitle } from "../modules/contextPanel/mineruSync";
import {
  zoteroChangeDispatcher,
  type ZoteroChangeEvent,
} from "./zoteroChangeDispatcher";

export type LibraryIndexAttachment = Readonly<{
  attachmentId: number;
  libraryID: number;
  parentItemId?: number;
  title: string;
  filename: string;
  contentType: string;
  isStandalone: boolean;
  hasPdfMime: boolean;
  hasPdfFilename: boolean;
  isPdf: boolean;
  isContextEligiblePdf: boolean;
  isMineruPackage: boolean;
}>;

export type LibraryIndexItem = Readonly<{
  itemId: number;
  libraryID: number;
  itemType: string;
  kind: "regular" | "standalone-note" | "standalone-attachment";
  title: string;
  shortTitle: string;
  citationKey: string;
  doi: string;
  creators: readonly string[];
  firstCreator: string;
  publicationTitle: string;
  venue: string;
  date: string;
  year: string;
  abstractNote: string;
  extra: string;
  tags: readonly string[];
  automaticTags: readonly string[];
  collectionIds: readonly number[];
  attachmentIds: readonly number[];
  childNoteIds: readonly number[];
  dateAdded: string;
  dateModified: string;
  addedAt: number;
  modifiedAt: number;
  deleted: boolean;
}>;

export type LibraryIndexCollection = Readonly<{
  collectionId: number;
  libraryID: number;
  name: string;
  parentCollectionId: number;
  deleted: boolean;
}>;

export type LibraryIndexChildNote = Readonly<{
  noteId: number;
  libraryID: number;
  parentItemId: number;
  title: string;
}>;

export type LibraryIndexTag = Readonly<{
  normalizedName: string;
  displayVariants: readonly string[];
  manualItemIds: ReadonlySet<number>;
  automaticItemIds: ReadonlySet<number>;
}>;

export type LibraryIndexSearchableFields = Readonly<{
  title: string;
  shortTitle: string;
  citationKey: string;
  doi: string;
  creators: string;
  venue: string;
  date: string;
  year: string;
  tags: string;
  attachmentTitles: string;
  abstractNote: string;
  extra: string;
}>;

export type LibraryIndexSnapshot = Readonly<{
  libraryID: number;
  libraryName: string;
  epoch: number;
  builtAt: number;
  itemById: ReadonlyMap<number, LibraryIndexItem>;
  topLevelItemOrder: readonly number[];
  attachmentById: ReadonlyMap<number, LibraryIndexAttachment>;
  childAttachmentIdsByItemId: ReadonlyMap<number, readonly number[]>;
  pdfAttachmentIdsByItemId: ReadonlyMap<number, readonly number[]>;
  childNoteIdsByItemId: ReadonlyMap<number, readonly number[]>;
  childNoteById: ReadonlyMap<number, LibraryIndexChildNote>;
  parentItemIdByChildId: ReadonlyMap<number, number>;
  collectionById: ReadonlyMap<number, LibraryIndexCollection>;
  directItemIdsByCollectionId: ReadonlyMap<number, ReadonlySet<number>>;
  childCollectionIdsByCollectionId: ReadonlyMap<number, readonly number[]>;
  collectionPathById: ReadonlyMap<number, string>;
  tagByNormalizedName: ReadonlyMap<string, LibraryIndexTag>;
  normalizedTagNameByTagId: ReadonlyMap<number, string>;
  tagIdsByNormalizedName: ReadonlyMap<string, readonly number[]>;
  unfiledItemIds: ReadonlySet<number>;
  untaggedItemIds: ReadonlySet<number>;
  pdfCapableItemIds: ReadonlySet<number>;
  searchableFieldsByItemId: ReadonlyMap<number, LibraryIndexSearchableFields>;
}>;

export type LibraryIndexMetrics = Readonly<{
  fullBuilds: number;
  itemsGetAllCalls: number;
  projectedTopLevelItems: number;
  incrementalItemUpdates: number;
  incrementalCollectionUpdates: number;
  coalescedRebuilds: number;
  staleBuildDiscards: number;
}>;

type MutableMetrics = {
  -readonly [K in keyof LibraryIndexMetrics]: number;
};

type PendingIndexChanges = {
  itemIds: Set<number>;
  collectionIds: Set<number>;
  libraryName: boolean;
  fullRebuild: boolean;
};

type LibraryState = {
  epoch: number;
  snapshot?: LibraryIndexSnapshot;
  loadTask?: Promise<LibraryIndexSnapshot>;
  backgroundRefreshTask?: Promise<void>;
  pendingChanges?: PendingIndexChanges;
  reconciling?: boolean;
  rebuildTimer?: ReturnType<typeof setTimeout>;
};

function pendingIndexChanges(): PendingIndexChanges {
  return {
    itemIds: new Set<number>(),
    collectionIds: new Set<number>(),
    libraryName: false,
    fullRebuild: false,
  };
}

function hasPendingIndexChanges(changes: PendingIndexChanges): boolean {
  return Boolean(
    changes.fullRebuild ||
    changes.libraryName ||
    changes.itemIds.size ||
    changes.collectionIds.size,
  );
}

type RawTag = string | { tag?: unknown; name?: unknown; type?: unknown };

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  constructor(private readonly source: Map<K, V>) {}

  get size(): number {
    return this.source.size;
  }

  get(key: K): V | undefined {
    return this.source.get(key);
  }

  has(key: K): boolean {
    return this.source.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.source.entries();
  }

  keys(): MapIterator<K> {
    return this.source.keys();
  }

  values(): MapIterator<V> {
    return this.source.values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.source.forEach((value, key) =>
      callbackfn.call(thisArg, value, key, this),
    );
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  mutable(): Map<K, V> {
    return this.source;
  }
}

class ReadonlySetView<T> implements ReadonlySet<T> {
  constructor(private readonly source: Set<T>) {}

  get size(): number {
    return this.source.size;
  }

  has(value: T): boolean {
    return this.source.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.source.entries();
  }

  keys(): SetIterator<T> {
    return this.source.keys();
  }

  values(): SetIterator<T> {
    return this.source.values();
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    this.source.forEach((value) =>
      callbackfn.call(thisArg, value, value, this),
    );
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  mutable(): Set<T> {
    return this.source;
  }
}

function readonlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (source instanceof ReadonlyMapView) return source;
  return new ReadonlyMapView(source instanceof Map ? source : new Map(source));
}

function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  if (source instanceof ReadonlySetView) return source;
  return new ReadonlySetView(source instanceof Set ? source : new Set(source));
}

function patchMap<K, V>(
  base: ReadonlyMap<K, V>,
  updates: ReadonlyMap<K, V>,
  deleted: ReadonlySet<K> = new Set(),
): ReadonlyMap<K, V> {
  if (!updates.size && !deleted.size) return base;
  const view =
    base instanceof ReadonlyMapView ? base : new ReadonlyMapView(new Map(base));
  const mutable = view.mutable();
  for (const key of deleted) {
    if (!updates.has(key)) mutable.delete(key);
  }
  for (const [key, value] of updates) mutable.set(key, value);
  return view;
}

function patchSet<T>(
  base: ReadonlySet<T>,
  added: ReadonlySet<T>,
  deleted: ReadonlySet<T>,
): ReadonlySet<T> {
  if (!added.size && !deleted.size) return base;
  const view =
    base instanceof ReadonlySetView ? base : new ReadonlySetView(new Set(base));
  const mutable = view.mutable();
  for (const value of deleted) {
    if (!added.has(value)) mutable.delete(value);
  }
  for (const value of added) mutable.add(value);
  return view;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function field(item: Zotero.Item, name: string): string {
  try {
    return text(item.getField?.(name as _ZoteroTypes.Item.ItemField));
  } catch {
    return "";
  }
}

function timestamp(value: unknown): number {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );
}

export function normalizeLibraryIndexText(value: unknown): string {
  const source = text(value);
  if (!source) return "";
  try {
    return source
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  } catch {
    return source.toLowerCase().replace(/\s+/g, " ").trim();
  }
}

/**
 * Normalize an exact tag identity without applying fuzzy search folding.
 *
 * Punctuation, symbols, accents, and internal whitespace are meaningful tag
 * content. Removing them would merge distinct Zotero tags such as `C` and
 * `C++`, so only canonical Unicode form, surrounding whitespace, and case are
 * normalized here.
 */
export function normalizeLibraryIndexTagIdentity(value: unknown): string {
  const source = text(value);
  if (!source) return "";
  try {
    return source.normalize("NFC").toLowerCase();
  } catch {
    return source.toLowerCase();
  }
}

function sameStringMembers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((value) => members.has(value));
}

function sameNumberMembers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  const members = new Set(left);
  return right.every((value) => members.has(value));
}

function itemType(item: Zotero.Item): string {
  const direct = text((item as Zotero.Item & { itemType?: unknown }).itemType);
  if (direct) return direct;
  try {
    const id = Number(
      (item as Zotero.Item & { itemTypeID?: unknown }).itemTypeID,
    );
    const name = (
      Zotero as unknown as {
        ItemTypes?: { getName?: (itemTypeID: number) => unknown };
      }
    ).ItemTypes?.getName?.(id);
    return text(name) || "item";
  } catch {
    return "item";
  }
}

function creators(item: Zotero.Item): string[] {
  const out: string[] = [];
  try {
    for (const creator of item.getCreators?.() || []) {
      const name =
        text((creator as { name?: unknown }).name) ||
        [text(creator.firstName), text(creator.lastName)]
          .filter(Boolean)
          .join(" ");
      const normalized = normalizeLibraryIndexText(name);
      // Preserve creator rows, not just display-name values. Distinct people
      // can legitimately have the same rendered name, and authorship counts
      // are row-based even though search uses the normalized text.
      if (!normalized) continue;
      out.push(name);
    }
  } catch {
    // A malformed creator row should not discard the item.
  }
  return out;
}

function tags(item: Zotero.Item): { manual: string[]; automatic: string[] } {
  const manual = new Set<string>();
  const automatic = new Set<string>();
  try {
    for (const raw of (item.getTags?.() || []) as RawTag[]) {
      const name =
        typeof raw === "string" ? text(raw) : text(raw.tag ?? raw.name);
      if (!name) continue;
      if (typeof raw !== "string" && Number(raw.type) === 1) {
        automatic.add(name);
      } else {
        manual.add(name);
      }
    }
  } catch {
    // Treat malformed tag payloads as no tags.
  }
  const sort = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "base" });
  return {
    manual: [...manual].sort(sort),
    automatic: [...automatic].sort(sort),
  };
}

function collectionIds(item: Zotero.Item): number[] {
  try {
    return positiveIds(item.getCollections?.() || []);
  } catch {
    return [];
  }
}

function noteTitle(item: Zotero.Item): string {
  try {
    return (
      text(
        (
          item as Zotero.Item & { getNoteTitle?: () => unknown }
        ).getNoteTitle?.(),
      ) ||
      text(item.getDisplayTitle?.()) ||
      `Note ${item.id}`
    );
  } catch {
    return `Note ${item.id}`;
  }
}

function resolveLibraryName(libraryID: number): string {
  try {
    const libraries = (
      Zotero as unknown as {
        Libraries?: {
          getName?: (id: number) => unknown;
          get?: (id: number) => { name?: unknown } | undefined;
        };
      }
    ).Libraries;
    return (
      text(libraries?.getName?.(libraryID)) ||
      text(libraries?.get?.(libraryID)?.name) ||
      "My Library"
    );
  } catch {
    return "My Library";
  }
}

function attachmentRecord(
  attachment: Zotero.Item,
  parentItemId: number | undefined,
  index: number,
  total: number,
): LibraryIndexAttachment {
  const filename = text(
    (attachment as Zotero.Item & { attachmentFilename?: unknown })
      .attachmentFilename,
  );
  const contentType = text(attachment.attachmentContentType);
  const rawTitle = field(attachment, "title");
  const fallback = contentType
    ? (contentType.split("/").pop() || "attachment").toUpperCase()
    : "Attachment";
  const title =
    rawTitle || filename || (total > 1 ? `${fallback} ${index + 1}` : fallback);
  const support = resolveContextAttachmentSupportFromMetadata({
    contentType,
    filename,
  });
  const hasPdfMime = contentType.toLowerCase() === "application/pdf";
  const hasPdfFilename = filename.toLowerCase().endsWith(".pdf");
  const isPdf = hasPdfMime || hasPdfFilename;
  const isMineruPackage =
    isMineruSyncPackageTitle(title) || isMineruSyncPackageTitle(filename);
  return Object.freeze({
    attachmentId: attachment.id,
    libraryID: Number(attachment.libraryID) || 0,
    ...(parentItemId ? { parentItemId } : {}),
    title,
    filename,
    contentType: contentType || "application/octet-stream",
    isStandalone: !parentItemId,
    hasPdfMime,
    hasPdfFilename,
    isPdf,
    isContextEligiblePdf: support?.kind === "pdf" && !isMineruPackage,
    isMineruPackage,
  });
}

function projectItem(item: Zotero.Item): {
  item: LibraryIndexItem;
  attachments: LibraryIndexAttachment[];
  childNoteIds: number[];
  childNotes: LibraryIndexChildNote[];
  attachmentTitles: string[];
} | null {
  const isStandaloneNote = Boolean(
    (item as Zotero.Item & { isNote?: () => boolean }).isNote?.() &&
    !item.parentID,
  );
  const isStandaloneAttachment = Boolean(
    item.isAttachment?.() && !item.parentID,
  );
  const isRegular = Boolean(item.isRegularItem?.());
  if (!isRegular && !isStandaloneNote && !isStandaloneAttachment) return null;

  const projectedAttachments: LibraryIndexAttachment[] = [];
  const childNoteIds: number[] = [];
  const childNotes: LibraryIndexChildNote[] = [];
  if (isRegular) {
    const ids = positiveIds(item.getAttachments?.() || []);
    ids.forEach((id, index) => {
      const child = Zotero.Items.get(id) || null;
      if (!child?.isAttachment?.()) return;
      projectedAttachments.push(
        attachmentRecord(child, item.id, index, ids.length),
      );
    });
    for (const id of positiveIds(
      (item as Zotero.Item & { getNotes?: () => unknown }).getNotes?.() || [],
    )) {
      const child = Zotero.Items.get(id) || null;
      if (
        child &&
        (child as Zotero.Item & { isNote?: () => boolean }).isNote?.()
      ) {
        childNoteIds.push(id);
        childNotes.push(
          Object.freeze({
            noteId: id,
            libraryID: Number(child.libraryID) || Number(item.libraryID) || 0,
            parentItemId: item.id,
            title: noteTitle(child),
          }),
        );
      }
    }
  } else if (isStandaloneAttachment) {
    projectedAttachments.push(attachmentRecord(item, undefined, 0, 1));
  }

  const creatorNames = isRegular ? creators(item) : [];
  const itemTags = tags(item);
  const date = isRegular ? field(item, "date") : "";
  const indexedYear = isRegular
    ? date.match(/\b(19|20)\d{2}\b/)?.[0] || field(item, "year")
    : "";
  const publicationTitle = isRegular ? field(item, "publicationTitle") : "";
  const venue = isRegular
    ? [
        publicationTitle,
        field(item, "journalAbbreviation"),
        field(item, "proceedingsTitle"),
        field(item, "conferenceName"),
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const title = isStandaloneNote
    ? noteTitle(item)
    : isStandaloneAttachment
      ? projectedAttachments[0]?.title || `Attachment ${item.id}`
      : field(item, "title") ||
        text(item.getDisplayTitle?.()) ||
        `Item ${item.id}`;
  const dateAdded =
    text((item as Zotero.Item & { dateAdded?: unknown }).dateAdded) ||
    field(item, "dateAdded");
  const dateModified = text(item.dateModified);
  const record: LibraryIndexItem = Object.freeze({
    itemId: item.id,
    libraryID: Number(item.libraryID) || 0,
    itemType: isStandaloneNote
      ? "note"
      : isStandaloneAttachment
        ? "attachment"
        : itemType(item),
    kind: isStandaloneNote
      ? "standalone-note"
      : isStandaloneAttachment
        ? "standalone-attachment"
        : "regular",
    title,
    shortTitle: isRegular ? field(item, "shortTitle") : "",
    citationKey: isRegular ? field(item, "citationKey") : "",
    doi: isRegular ? field(item, "DOI") : "",
    creators: Object.freeze(creatorNames),
    firstCreator: isRegular
      ? text(item.firstCreator) ||
        field(item, "firstCreator") ||
        creatorNames[0] ||
        ""
      : "",
    publicationTitle,
    venue,
    date,
    year: indexedYear,
    abstractNote: isRegular ? field(item, "abstractNote") : "",
    extra: isRegular ? field(item, "extra") : "",
    tags: Object.freeze(itemTags.manual),
    automaticTags: Object.freeze(itemTags.automatic),
    collectionIds: Object.freeze(collectionIds(item)),
    attachmentIds: Object.freeze(
      projectedAttachments.map((attachment) => attachment.attachmentId),
    ),
    childNoteIds: Object.freeze(childNoteIds),
    dateAdded,
    dateModified,
    addedAt: timestamp(dateAdded),
    modifiedAt: timestamp(dateModified),
    deleted: Boolean((item as Zotero.Item & { deleted?: unknown }).deleted),
  });
  return {
    item: record,
    attachments: projectedAttachments,
    childNoteIds,
    childNotes,
    attachmentTitles: projectedAttachments.map(
      (attachment) => attachment.title,
    ),
  };
}

function searchable(
  item: LibraryIndexItem,
  attachmentTitles: readonly string[],
): LibraryIndexSearchableFields {
  return Object.freeze({
    title: normalizeLibraryIndexText(item.title),
    shortTitle: normalizeLibraryIndexText(item.shortTitle),
    citationKey: normalizeLibraryIndexText(item.citationKey),
    doi: normalizeLibraryIndexText(item.doi),
    creators: normalizeLibraryIndexText(
      [...item.creators, item.firstCreator].filter(Boolean).join(" "),
    ),
    venue: normalizeLibraryIndexText(item.venue),
    date: normalizeLibraryIndexText(item.date),
    year: normalizeLibraryIndexText(item.year),
    tags: normalizeLibraryIndexText(
      [...item.tags, ...item.automaticTags].join(" "),
    ),
    attachmentTitles: normalizeLibraryIndexText(attachmentTitles.join(" ")),
    abstractNote: normalizeLibraryIndexText(item.abstractNote),
    extra: normalizeLibraryIndexText(item.extra),
  });
}

function collectionsForLibrary(libraryID: number): Zotero.Collection[] {
  try {
    return Zotero.Collections.getByLibrary(libraryID, true) || [];
  } catch {
    return [];
  }
}

function buildCollectionProjection(
  libraryID: number,
  items: ReadonlyMap<number, LibraryIndexItem>,
): Pick<
  LibraryIndexSnapshot,
  | "collectionById"
  | "directItemIdsByCollectionId"
  | "childCollectionIdsByCollectionId"
  | "collectionPathById"
> {
  const collectionById = new Map<number, LibraryIndexCollection>();
  const directItemIdsByCollectionId = new Map<number, Set<number>>();
  const childCollectionIdsByCollectionId = new Map<number, number[]>();
  for (const collection of collectionsForLibrary(libraryID)) {
    const parent = Number(collection.parentID);
    collectionById.set(
      collection.id,
      Object.freeze({
        collectionId: collection.id,
        libraryID: Number(collection.libraryID) || libraryID,
        name: text(collection.name) || `Collection ${collection.id}`,
        parentCollectionId:
          Number.isFinite(parent) && parent > 0 ? Math.floor(parent) : 0,
        deleted: Boolean(
          (collection as Zotero.Collection & { deleted?: unknown }).deleted,
        ),
      }),
    );
    directItemIdsByCollectionId.set(
      collection.id,
      new Set(positiveIds(collection.getChildItems?.(true, false) || [])),
    );
    childCollectionIdsByCollectionId.set(
      collection.id,
      positiveIds(collection.getChildCollections?.(true, false) || []),
    );
  }
  for (const item of items.values()) {
    for (const collectionId of item.collectionIds) {
      const set = directItemIdsByCollectionId.get(collectionId) || new Set();
      set.add(item.itemId);
      directItemIdsByCollectionId.set(collectionId, set);
    }
  }
  const collectionPathById = new Map<number, string>();
  const resolvePath = (id: number, seen = new Set<number>()): string => {
    const cached = collectionPathById.get(id);
    if (cached) return cached;
    const collection = collectionById.get(id);
    if (!collection) return "";
    if (seen.has(id)) return collection.name;
    seen.add(id);
    const parent = collection.parentCollectionId;
    const path =
      parent && collectionById.has(parent)
        ? `${resolvePath(parent, seen)} / ${collection.name}`
        : collection.name;
    collectionPathById.set(id, path);
    return path;
  };
  for (const id of collectionById.keys()) resolvePath(id);
  return {
    collectionById,
    directItemIdsByCollectionId: new Map(
      [...directItemIdsByCollectionId].map(([id, members]) => [
        id,
        readonlySet(members),
      ]),
    ),
    childCollectionIdsByCollectionId,
    collectionPathById,
  };
}

function rebuildDerived(
  base: Pick<
    LibraryIndexSnapshot,
    | "libraryID"
    | "libraryName"
    | "epoch"
    | "builtAt"
    | "itemById"
    | "topLevelItemOrder"
    | "attachmentById"
    | "childAttachmentIdsByItemId"
    | "pdfAttachmentIdsByItemId"
    | "childNoteIdsByItemId"
    | "childNoteById"
    | "parentItemIdByChildId"
    | "searchableFieldsByItemId"
  >,
  collectionProjection?: ReturnType<typeof buildCollectionProjection>,
): LibraryIndexSnapshot {
  const tagMutable = new Map<
    string,
    { variants: Set<string>; manual: Set<number>; automatic: Set<number> }
  >();
  const unfiledItemIds = new Set<number>();
  const untaggedItemIds = new Set<number>();
  const pdfCapableItemIds = new Set<number>();
  for (const item of base.itemById.values()) {
    // Keep trashed items in the canonical snapshot so restore/trash queries
    // can resolve them, but exclude them from every ordinary derived view.
    if (item.deleted) continue;
    if (!item.collectionIds.length) unfiledItemIds.add(item.itemId);
    if (!item.tags.length && !item.automaticTags.length) {
      untaggedItemIds.add(item.itemId);
    }
    if ((base.pdfAttachmentIdsByItemId.get(item.itemId)?.length || 0) > 0) {
      pdfCapableItemIds.add(item.itemId);
    }
    const addTags = (values: readonly string[], automatic: boolean): void => {
      for (const value of values) {
        const normalized = normalizeLibraryIndexTagIdentity(value);
        if (!normalized) continue;
        const entry = tagMutable.get(normalized) || {
          variants: new Set<string>(),
          manual: new Set<number>(),
          automatic: new Set<number>(),
        };
        entry.variants.add(value);
        (automatic ? entry.automatic : entry.manual).add(item.itemId);
        tagMutable.set(normalized, entry);
      }
    };
    addTags(item.tags, false);
    addTags(item.automaticTags, true);
  }
  const tagByNormalizedName = new Map<string, LibraryIndexTag>();
  const normalizedTagNameByTagId = new Map<number, string>();
  const tagIdsByNormalizedName = new Map<string, readonly number[]>();
  for (const [normalizedName, entry] of tagMutable) {
    tagByNormalizedName.set(
      normalizedName,
      Object.freeze({
        normalizedName,
        displayVariants: Object.freeze([...entry.variants].sort()),
        manualItemIds: readonlySet(entry.manual),
        automaticItemIds: readonlySet(entry.automatic),
      }),
    );
    const tagIds = new Set<number>();
    for (const variant of entry.variants) {
      try {
        const tagId = Number(Zotero.Tags.getID(variant));
        if (Number.isFinite(tagId) && tagId > 0) {
          normalizedTagNameByTagId.set(tagId, normalizedName);
          tagIds.add(tagId);
        }
      } catch {
        // Tag-name reverse lookup is an optimization; item membership remains
        // correct even if an unusual tag cannot be resolved to an ID.
      }
    }
    if (tagIds.size) {
      tagIdsByNormalizedName.set(normalizedName, Object.freeze([...tagIds]));
    }
  }
  const collections =
    collectionProjection ||
    buildCollectionProjection(base.libraryID, base.itemById);
  return Object.freeze({
    ...base,
    ...collections,
    itemById: readonlyMap(base.itemById),
    attachmentById: readonlyMap(base.attachmentById),
    childAttachmentIdsByItemId: readonlyMap(base.childAttachmentIdsByItemId),
    pdfAttachmentIdsByItemId: readonlyMap(base.pdfAttachmentIdsByItemId),
    childNoteIdsByItemId: readonlyMap(base.childNoteIdsByItemId),
    childNoteById: readonlyMap(base.childNoteById),
    parentItemIdByChildId: readonlyMap(base.parentItemIdByChildId),
    searchableFieldsByItemId: readonlyMap(base.searchableFieldsByItemId),
    collectionById: readonlyMap(collections.collectionById),
    directItemIdsByCollectionId: readonlyMap(
      collections.directItemIdsByCollectionId,
    ),
    childCollectionIdsByCollectionId: readonlyMap(
      collections.childCollectionIdsByCollectionId,
    ),
    collectionPathById: readonlyMap(collections.collectionPathById),
    tagByNormalizedName: readonlyMap(tagByNormalizedName),
    normalizedTagNameByTagId: readonlyMap(normalizedTagNameByTagId),
    tagIdsByNormalizedName: readonlyMap(tagIdsByNormalizedName),
    unfiledItemIds: readonlySet(unfiledItemIds),
    untaggedItemIds: readonlySet(untaggedItemIds),
    pdfCapableItemIds: readonlySet(pdfCapableItemIds),
  });
}

function numericNotifierIds(ids: readonly (string | number)[]): number[] {
  const out = new Set<number>();
  for (const value of ids) {
    const direct = Math.floor(Number(value));
    if (Number.isFinite(direct) && direct > 0) out.add(direct);
    if (typeof value === "string") {
      for (const token of value.match(/\d+/g) || []) {
        const id = Math.floor(Number(token));
        if (id > 0) out.add(id);
      }
    }
  }
  return [...out];
}

function relationItemNotifierIds(
  type: string,
  ids: readonly (string | number)[],
  extraData: Readonly<Record<string, unknown>>,
): number[] {
  const out = new Set<number>();
  const add = (value: unknown): void => {
    const id = Math.floor(Number(value));
    if (Number.isFinite(id) && id > 0) out.add(id);
  };
  for (const raw of ids) {
    if (typeof raw === "number") {
      add(raw);
      continue;
    }
    const parts = raw.match(/\d+/g) || [];
    if (type === "item-tag") add(parts[0]);
    else if (type === "collection-item") add(parts[1] ?? parts[0]);
  }
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    add(record.itemID ?? record.itemId);
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(extraData, 0);
  return [...out];
}

export class LibraryIndexService {
  private readonly states = new Map<number, LibraryState>();
  private metrics: MutableMetrics = {
    fullBuilds: 0,
    itemsGetAllCalls: 0,
    projectedTopLevelItems: 0,
    incrementalItemUpdates: 0,
    incrementalCollectionUpdates: 0,
    coalescedRebuilds: 0,
    staleBuildDiscards: 0,
  };

  constructor(private readonly yieldEvery = 250) {}

  getMetrics(): LibraryIndexMetrics {
    return Object.freeze({ ...this.metrics });
  }

  resetMetricsForTests(): void {
    for (const key of Object.keys(this.metrics) as Array<
      keyof MutableMetrics
    >) {
      this.metrics[key] = 0;
    }
  }

  peekSnapshot(libraryID: number): LibraryIndexSnapshot | undefined {
    return this.states.get(Math.floor(libraryID))?.snapshot;
  }

  private pendingChanges(state: LibraryState): PendingIndexChanges {
    state.pendingChanges ||= pendingIndexChanges();
    return state.pendingChanges;
  }

  private takePendingChanges(state: LibraryState): PendingIndexChanges {
    const changes = state.pendingChanges || pendingIndexChanges();
    state.pendingChanges = pendingIndexChanges();
    return changes;
  }

  private requeueChanges(
    state: LibraryState,
    changes: PendingIndexChanges,
  ): void {
    const pending = this.pendingChanges(state);
    changes.itemIds.forEach((id) => pending.itemIds.add(id));
    changes.collectionIds.forEach((id) => pending.collectionIds.add(id));
    pending.libraryName ||= changes.libraryName;
    pending.fullRebuild ||= changes.fullRebuild;
  }

  private shouldQueueChanges(state: LibraryState): boolean {
    return Boolean(
      !state.snapshot ||
      state.loadTask ||
      state.reconciling ||
      state.backgroundRefreshTask,
    );
  }

  private queueItemChanges(state: LibraryState, ids: number[]): void {
    const pending = this.pendingChanges(state);
    ids.forEach((id) => pending.itemIds.add(id));
  }

  private queueCollectionChanges(state: LibraryState, ids: number[]): void {
    const pending = this.pendingChanges(state);
    ids.forEach((id) => pending.collectionIds.add(id));
  }

  private queueLibraryNameChange(state: LibraryState): void {
    this.pendingChanges(state).libraryName = true;
  }

  private queueFullRebuild(state: LibraryState): void {
    state.epoch += 1;
    this.pendingChanges(state).fullRebuild = true;
  }

  private publishSnapshot(
    state: LibraryState,
    snapshot: LibraryIndexSnapshot,
  ): void {
    state.snapshot = Object.freeze({ ...snapshot, epoch: state.epoch });
  }

  private async reconcileChanges(
    libraryID: number,
    state: LibraryState,
    changes: PendingIndexChanges,
  ): Promise<void> {
    state.reconciling = true;
    try {
      if (changes.libraryName) this.patchLibraryName(libraryID, true);
      if (changes.collectionIds.size) {
        await this.patchCollections(
          libraryID,
          [...changes.collectionIds],
          true,
        );
      }
      if (changes.itemIds.size) {
        await this.patchItems(libraryID, [...changes.itemIds], true);
      }
    } finally {
      state.reconciling = false;
    }
  }

  private schedulePendingReconciliation(libraryID: number): void {
    const state = this.states.get(libraryID);
    if (!state?.snapshot) return;
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    state.rebuildTimer = setTimeout(() => {
      state.rebuildTimer = undefined;
      if (state.loadTask || state.backgroundRefreshTask || state.reconciling) {
        this.schedulePendingReconciliation(libraryID);
        return;
      }
      const changes = this.takePendingChanges(state);
      if (!hasPendingIndexChanges(changes)) return;
      if (changes.fullRebuild) {
        this.startBackgroundRefresh(libraryID, state, changes);
        return;
      }
      let failed = false;
      void this.reconcileChanges(libraryID, state, changes)
        .catch((error) => {
          failed = true;
          this.requeueChanges(state, changes);
          globalThis.Zotero?.debug?.(
            `[llm-for-zotero] Library index reconciliation failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          if (!failed && hasPendingIndexChanges(this.pendingChanges(state))) {
            this.schedulePendingReconciliation(libraryID);
          }
        });
    }, 100);
  }

  private startBackgroundRefresh(
    libraryID: number,
    state: LibraryState,
    coveredChanges: PendingIndexChanges,
  ): void {
    if (state.backgroundRefreshTask) {
      this.requeueChanges(state, coveredChanges);
      return;
    }
    this.metrics.coalescedRebuilds += 1;
    let failed = false;
    const task = (async () => {
      const snapshot = await this.buildSnapshot(libraryID, state.epoch);
      const trailing = this.takePendingChanges(state);
      this.publishSnapshot(state, snapshot);
      await this.reconcileChanges(libraryID, state, trailing);
      const duringReconciliation = this.takePendingChanges(state);
      if (trailing.fullRebuild) {
        duringReconciliation.fullRebuild = true;
      }
      this.requeueChanges(state, duringReconciliation);
    })()
      .catch((error) => {
        failed = true;
        coveredChanges.fullRebuild = true;
        this.requeueChanges(state, coveredChanges);
        globalThis.Zotero?.debug?.(
          `[llm-for-zotero] Library index rebuild failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        if (state.backgroundRefreshTask === task) {
          state.backgroundRefreshTask = undefined;
        }
        if (!failed && hasPendingIndexChanges(this.pendingChanges(state))) {
          this.schedulePendingReconciliation(libraryID);
        }
      });
    state.backgroundRefreshTask = task;
  }

  private async loadInitialSnapshot(
    libraryID: number,
    state: LibraryState,
  ): Promise<LibraryIndexSnapshot> {
    let snapshot = await this.buildSnapshot(libraryID, state.epoch);
    let changes = this.takePendingChanges(state);
    if (changes.fullRebuild) {
      this.metrics.staleBuildDiscards += 1;
      snapshot = await this.buildSnapshot(libraryID, state.epoch);
      changes = this.takePendingChanges(state);
    }
    this.publishSnapshot(state, snapshot);
    try {
      await this.reconcileChanges(libraryID, state, changes);
    } catch (error) {
      state.snapshot = undefined;
      throw error;
    }
    const trailing = this.takePendingChanges(state);
    if (changes.fullRebuild) trailing.fullRebuild = true;
    this.requeueChanges(state, trailing);
    if (hasPendingIndexChanges(trailing)) {
      this.schedulePendingReconciliation(libraryID);
    }
    return state.snapshot!;
  }

  async getSnapshot(libraryID: number): Promise<LibraryIndexSnapshot> {
    const normalized = Math.floor(Number(libraryID));
    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error("A positive library ID is required");
    }
    let state = this.states.get(normalized);
    if (!state) {
      state = { epoch: 0 };
      this.states.set(normalized, state);
    }
    if (state.snapshot) {
      if (
        state.pendingChanges &&
        hasPendingIndexChanges(state.pendingChanges) &&
        !state.rebuildTimer &&
        !state.backgroundRefreshTask &&
        !state.reconciling
      ) {
        this.schedulePendingReconciliation(normalized);
      }
      return state.snapshot;
    }
    if (state.loadTask) return state.loadTask;
    const task = this.loadInitialSnapshot(normalized, state).finally(() => {
      const current = this.states.get(normalized);
      if (current?.loadTask === task) current.loadTask = undefined;
    });
    state.loadTask = task;
    return task;
  }

  invalidate(libraryID?: number): void {
    if (Number.isFinite(libraryID) && Number(libraryID) > 0) {
      const id = Math.floor(Number(libraryID));
      const state = this.states.get(id) || { epoch: 0 };
      if (state.loadTask || state.backgroundRefreshTask) {
        this.queueFullRebuild(state);
        this.states.set(id, state);
        return;
      }
      state.epoch += 1;
      state.snapshot = undefined;
      this.states.set(id, state);
      return;
    }
    for (const state of this.states.values()) {
      if (state.loadTask || state.backgroundRefreshTask) {
        this.queueFullRebuild(state);
        continue;
      }
      state.epoch += 1;
      state.snapshot = undefined;
    }
  }

  clearForTests(): void {
    for (const state of this.states.values()) {
      if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    }
    this.states.clear();
    this.resetMetricsForTests();
  }

  private async buildSnapshot(
    libraryID: number,
    epoch: number,
  ): Promise<LibraryIndexSnapshot> {
    this.metrics.fullBuilds += 1;
    this.metrics.itemsGetAllCalls += 1;
    const rawItems: Zotero.Item[] = await Zotero.Items.getAll(
      libraryID,
      true,
      true,
      false,
    );
    const itemById = new Map<number, LibraryIndexItem>();
    const topLevelItemOrder: number[] = [];
    const attachmentById = new Map<number, LibraryIndexAttachment>();
    const childAttachmentIdsByItemId = new Map<number, readonly number[]>();
    const pdfAttachmentIdsByItemId = new Map<number, readonly number[]>();
    const childNoteIdsByItemId = new Map<number, readonly number[]>();
    const childNoteById = new Map<number, LibraryIndexChildNote>();
    const parentItemIdByChildId = new Map<number, number>();
    const searchableFieldsByItemId = new Map<
      number,
      LibraryIndexSearchableFields
    >();
    let projectedCount = 0;
    for (const rawItem of rawItems) {
      const projected = projectItem(rawItem);
      if (!projected || projected.item.libraryID !== libraryID) continue;
      const record = projected.item;
      itemById.set(record.itemId, record);
      topLevelItemOrder.push(record.itemId);
      const attachmentIds = projected.attachments.map(
        (attachment) => attachment.attachmentId,
      );
      childAttachmentIdsByItemId.set(
        record.itemId,
        Object.freeze(attachmentIds),
      );
      pdfAttachmentIdsByItemId.set(
        record.itemId,
        Object.freeze(
          projected.attachments
            .filter((attachment) => attachment.isContextEligiblePdf)
            .map((attachment) => attachment.attachmentId),
        ),
      );
      childNoteIdsByItemId.set(
        record.itemId,
        Object.freeze([...projected.childNoteIds]),
      );
      for (const note of projected.childNotes) {
        childNoteById.set(note.noteId, note);
        parentItemIdByChildId.set(note.noteId, record.itemId);
      }
      for (const attachment of projected.attachments) {
        attachmentById.set(attachment.attachmentId, attachment);
        if (attachment.parentItemId) {
          parentItemIdByChildId.set(
            attachment.attachmentId,
            attachment.parentItemId,
          );
        }
      }
      searchableFieldsByItemId.set(
        record.itemId,
        searchable(record, projected.attachmentTitles),
      );
      projectedCount += 1;
      if (projectedCount % this.yieldEvery === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    this.metrics.projectedTopLevelItems += projectedCount;
    const partial = {
      libraryID,
      libraryName: resolveLibraryName(libraryID),
      epoch,
      builtAt: Date.now(),
      itemById,
      topLevelItemOrder: Object.freeze(topLevelItemOrder),
      attachmentById,
      childAttachmentIdsByItemId,
      pdfAttachmentIdsByItemId,
      childNoteIdsByItemId,
      childNoteById,
      parentItemIdByChildId,
      searchableFieldsByItemId,
    };
    return rebuildDerived(partial);
  }

  private libraryIDsForItemIds(ids: number[]): Set<number> {
    const libraryIDs = new Set<number>();
    for (const id of ids) {
      let ownerResolved = false;
      const live = Zotero.Items.get(id) || null;
      if (Number(live?.libraryID) > 0) {
        libraryIDs.add(Number(live?.libraryID));
        ownerResolved = true;
      }
      for (const [libraryID, state] of this.states) {
        if (
          state.snapshot?.itemById.has(id) ||
          state.snapshot?.childNoteById.has(id) ||
          state.snapshot?.attachmentById.has(id)
        ) {
          libraryIDs.add(libraryID);
          ownerResolved = true;
        }
      }
      if (!ownerResolved) {
        // Delete/erase notifications often arrive after Zotero has removed the
        // live object. A cold build has no installed ownership map yet, so any
        // unresolved ID must invalidate every in-flight candidate build. This
        // is deliberately conservative and prevents a projected-but-erased
        // object from being installed when multiple libraries are loading.
        for (const [libraryID, state] of this.states) {
          if (state.loadTask) libraryIDs.add(libraryID);
        }
      }
    }
    return libraryIDs;
  }

  private libraryIDsForCollectionIds(ids: number[]): Set<number> {
    const libraryIDs = new Set<number>();
    for (const id of ids) {
      let ownerResolved = false;
      let live: Zotero.Collection | null = null;
      try {
        live = Zotero.Collections.get(id) || null;
      } catch {
        live = null;
      }
      if (Number(live?.libraryID) > 0) {
        libraryIDs.add(Number(live?.libraryID));
        ownerResolved = true;
      }
      for (const [libraryID, state] of this.states) {
        if (state.snapshot?.collectionById.has(id)) {
          libraryIDs.add(libraryID);
          ownerResolved = true;
        }
      }
      if (!ownerResolved) {
        for (const [libraryID, state] of this.states) {
          if (state.loadTask) libraryIDs.add(libraryID);
        }
      }
    }
    return libraryIDs;
  }

  private libraryIDsForGroupIds(ids: number[]): Set<number> {
    const libraryIDs = new Set<number>();
    const groups = (
      Zotero as unknown as {
        Groups?: {
          get?: (groupID: number) => { libraryID?: unknown } | undefined;
          getLibraryIDFromGroupID?: (
            groupID: number,
          ) => number | false | undefined;
        };
      }
    ).Groups;
    for (const id of ids) {
      try {
        const libraryID = Number(
          groups?.getLibraryIDFromGroupID?.(id) ?? groups?.get?.(id)?.libraryID,
        );
        if (Number.isFinite(libraryID) && libraryID > 0) {
          libraryIDs.add(Math.floor(libraryID));
          continue;
        }
      } catch {
        // A deleted group may already be absent from Zotero's group cache.
      }
      // Some synthetic and legacy notifier producers send the library ID
      // directly. Only accept that interpretation for a state we own.
      if (this.states.has(id)) libraryIDs.add(id);
    }
    return libraryIDs;
  }

  private patchLibraryName(libraryID: number, force = false): void {
    const state = this.states.get(libraryID);
    if (!state) return;
    if (!force && this.shouldQueueChanges(state)) {
      this.queueLibraryNameChange(state);
      return;
    }
    const snapshot = state.snapshot;
    if (!snapshot) {
      this.queueLibraryNameChange(state);
      return;
    }
    const libraryName = resolveLibraryName(libraryID);
    if (libraryName === snapshot.libraryName) return;
    state.snapshot = Object.freeze({
      ...snapshot,
      epoch: state.epoch,
      libraryName,
    });
  }

  private async patchItems(
    libraryID: number,
    ids: number[],
    force = false,
  ): Promise<void> {
    const state = this.states.get(libraryID);
    const snapshot = state?.snapshot;
    if (!state) return;
    if (!snapshot || (!force && this.shouldQueueChanges(state))) {
      this.queueItemChanges(state, ids);
      return;
    }
    const topLevelIds = new Set<number>();
    for (const id of ids) {
      const live = Zotero.Items.get(id) || null;
      const previousParent = snapshot.parentItemIdByChildId.get(id);
      if (previousParent) topLevelIds.add(previousParent);
      // A previously standalone note or attachment may now be a child. Patch
      // its old top-level slot as well as its new parent so the stale standalone
      // record is removed in the same atomic snapshot publication.
      if (snapshot.itemById.has(id)) topLevelIds.add(id);
      const parent = Number(live?.parentID);
      if (Number.isFinite(parent) && parent > 0) topLevelIds.add(parent);
      else topLevelIds.add(id);
    }
    const previousItems = new Map<number, LibraryIndexItem | undefined>();
    for (const id of topLevelIds) {
      previousItems.set(id, snapshot.itemById.get(id));
    }

    type Projection = ReturnType<typeof projectItem>;
    const projections = new Map<number, Projection>();
    for (const id of topLevelIds) {
      const live = Zotero.Items.get(id) || null;
      const projected = live ? projectItem(live) : null;
      projections.set(
        id,
        projected?.item.libraryID === libraryID ? projected : null,
      );
    }

    const itemUpdates = new Map<number, LibraryIndexItem>();
    const itemDeletes = new Set<number>();
    const attachmentUpdates = new Map<number, LibraryIndexAttachment>();
    const attachmentDeletes = new Set<number>();
    const childAttachmentUpdates = new Map<number, readonly number[]>();
    const childAttachmentDeletes = new Set<number>();
    const pdfAttachmentUpdates = new Map<number, readonly number[]>();
    const pdfAttachmentDeletes = new Set<number>();
    const childNoteUpdates = new Map<number, readonly number[]>();
    const childNoteDeletes = new Set<number>();
    const childNoteRecordUpdates = new Map<number, LibraryIndexChildNote>();
    const childNoteRecordDeletes = new Set<number>();
    const childParentUpdates = new Map<number, number>();
    const childParentDeletes = new Set<number>();
    const searchableUpdates = new Map<number, LibraryIndexSearchableFields>();
    const searchableDeletes = new Set<number>();
    const orderAdds: number[] = [];
    const orderDeletes = new Set<number>();

    for (const id of topLevelIds) {
      const previous = previousItems.get(id);
      const projected = projections.get(id) || null;
      for (const attachmentId of snapshot.childAttachmentIdsByItemId.get(id) ||
        []) {
        attachmentDeletes.add(attachmentId);
        childParentDeletes.add(attachmentId);
      }
      for (const noteId of snapshot.childNoteIdsByItemId.get(id) || []) {
        childNoteRecordDeletes.add(noteId);
        childParentDeletes.add(noteId);
      }
      if (!projected) {
        itemDeletes.add(id);
        childAttachmentDeletes.add(id);
        pdfAttachmentDeletes.add(id);
        childNoteDeletes.add(id);
        searchableDeletes.add(id);
        if (previous) orderDeletes.add(id);
        continue;
      }
      itemUpdates.set(id, projected.item);
      const attachmentIds = projected.attachments.map(
        (attachment) => attachment.attachmentId,
      );
      childAttachmentUpdates.set(id, Object.freeze(attachmentIds));
      pdfAttachmentUpdates.set(
        id,
        Object.freeze(
          projected.attachments
            .filter((attachment) => attachment.isContextEligiblePdf)
            .map((attachment) => attachment.attachmentId),
        ),
      );
      childNoteUpdates.set(id, Object.freeze([...projected.childNoteIds]));
      for (const note of projected.childNotes) {
        childNoteRecordUpdates.set(note.noteId, note);
        childParentUpdates.set(note.noteId, id);
      }
      for (const attachment of projected.attachments) {
        attachmentUpdates.set(attachment.attachmentId, attachment);
        if (attachment.parentItemId) {
          childParentUpdates.set(attachment.attachmentId, id);
        }
      }
      searchableUpdates.set(
        id,
        searchable(projected.item, projected.attachmentTitles),
      );
      if (!previous) orderAdds.push(id);
    }

    let order: readonly number[] = snapshot.topLevelItemOrder;
    if (orderAdds.length || orderDeletes.size) {
      const nextOrder = orderDeletes.size
        ? snapshot.topLevelItemOrder.filter((id) => !orderDeletes.has(id))
        : [...snapshot.topLevelItemOrder];
      const present = new Set(nextOrder);
      for (const id of orderAdds) {
        if (!present.has(id)) {
          present.add(id);
          nextOrder.push(id);
        }
      }
      order = Object.freeze(nextOrder);
    }

    const itemById = patchMap(snapshot.itemById, itemUpdates, itemDeletes);
    const pdfAttachmentIdsByItemId = patchMap(
      snapshot.pdfAttachmentIdsByItemId,
      pdfAttachmentUpdates,
      pdfAttachmentDeletes,
    );

    const unfiledAdds = new Set<number>();
    const unfiledDeletes = new Set<number>();
    const untaggedAdds = new Set<number>();
    const untaggedDeletes = new Set<number>();
    const pdfAdds = new Set<number>();
    const pdfDeletes = new Set<number>();
    const setMembership = (
      base: ReadonlySet<number>,
      adds: Set<number>,
      deletes: Set<number>,
      id: number,
      shouldContain: boolean,
    ): void => {
      if (shouldContain && !base.has(id)) adds.add(id);
      if (!shouldContain && base.has(id)) deletes.add(id);
    };
    for (const id of topLevelIds) {
      const item = itemById.get(id);
      setMembership(
        snapshot.unfiledItemIds,
        unfiledAdds,
        unfiledDeletes,
        id,
        Boolean(item && !item.deleted && !item.collectionIds.length),
      );
      setMembership(
        snapshot.untaggedItemIds,
        untaggedAdds,
        untaggedDeletes,
        id,
        Boolean(
          item &&
          !item.deleted &&
          !item.tags.length &&
          !item.automaticTags.length,
        ),
      );
      setMembership(
        snapshot.pdfCapableItemIds,
        pdfAdds,
        pdfDeletes,
        id,
        Boolean(
          item &&
          !item.deleted &&
          (pdfAttachmentIdsByItemId.get(id)?.length || 0) > 0,
        ),
      );
    }

    type TagMembershipDelta = {
      manualAdds: Set<number>;
      manualDeletes: Set<number>;
      automaticAdds: Set<number>;
      automaticDeletes: Set<number>;
    };
    const tagDeltas = new Map<string, TagMembershipDelta>();
    const ensureTagDelta = (normalizedName: string): TagMembershipDelta => {
      const existing = tagDeltas.get(normalizedName);
      if (existing) return existing;
      const created = {
        manualAdds: new Set<number>(),
        manualDeletes: new Set<number>(),
        automaticAdds: new Set<number>(),
        automaticDeletes: new Set<number>(),
      };
      tagDeltas.set(normalizedName, created);
      return created;
    };
    const tagVariantsByNormalizedName = (
      values: readonly string[],
    ): Map<string, Set<string>> => {
      const variantsByName = new Map<string, Set<string>>();
      for (const value of values) {
        const normalized = normalizeLibraryIndexTagIdentity(value);
        if (!normalized) continue;
        const variants = variantsByName.get(normalized) || new Set<string>();
        variants.add(value);
        variantsByName.set(normalized, variants);
      }
      return variantsByName;
    };
    const recordTagChannelDelta = (
      itemId: number,
      beforeValues: readonly string[],
      afterValues: readonly string[],
      automatic: boolean,
    ): void => {
      if (sameStringMembers(beforeValues, afterValues)) return;
      const beforeVariants = tagVariantsByNormalizedName(beforeValues);
      const afterVariants = tagVariantsByNormalizedName(afterValues);
      for (const normalizedName of new Set([
        ...beforeVariants.keys(),
        ...afterVariants.keys(),
      ])) {
        const previous =
          beforeVariants.get(normalizedName) || new Set<string>();
        const next = afterVariants.get(normalizedName) || new Set<string>();
        const wasPresent = previous.size > 0;
        const isPresent = next.size > 0;
        // A changed item commonly carries many unchanged co-tags. Rebuilding
        // those identities scans every one of their members, so only record an
        // identity whose membership or exact display variants changed.
        if (
          wasPresent === isPresent &&
          sameStringMembers([...previous], [...next])
        ) {
          continue;
        }
        // Variant-only changes (for example `Foo` -> `foo`) still refresh the
        // display variants and reverse tag-ID mapping even when membership is
        // unchanged after exact identity normalization.
        const delta = ensureTagDelta(normalizedName);
        if (wasPresent === isPresent) continue;
        const adds = automatic ? delta.automaticAdds : delta.manualAdds;
        const deletes = automatic
          ? delta.automaticDeletes
          : delta.manualDeletes;
        (isPresent ? adds : deletes).add(itemId);
      }
    };
    for (const id of topLevelIds) {
      const before = previousItems.get(id);
      const after = itemById.get(id);
      const beforeVisible = Boolean(before && !before.deleted);
      const afterVisible = Boolean(after && !after.deleted);
      recordTagChannelDelta(
        id,
        beforeVisible ? before?.tags || [] : [],
        afterVisible ? after?.tags || [] : [],
        false,
      );
      recordTagChannelDelta(
        id,
        beforeVisible ? before?.automaticTags || [] : [],
        afterVisible ? after?.automaticTags || [] : [],
        true,
      );
    }
    const tagUpdates = new Map<string, LibraryIndexTag>();
    const tagDeletes = new Set<string>();
    const tagIdUpdates = new Map<number, string>();
    const tagIdDeletes = new Set<number>();
    const reverseTagIdUpdates = new Map<string, readonly number[]>();
    const reverseTagIdDeletes = new Set<string>();
    for (const [normalizedName, delta] of tagDeltas) {
      const previous = snapshot.tagByNormalizedName.get(normalizedName);
      const previousManual = previous?.manualItemIds || new Set<number>();
      const previousAutomatic = previous?.automaticItemIds || new Set<number>();
      const manual = patchSet(
        previousManual,
        delta.manualAdds,
        delta.manualDeletes,
      );
      const automatic = patchSet(
        previousAutomatic,
        delta.automaticAdds,
        delta.automaticDeletes,
      );
      const variants = new Set<string>();
      for (const itemId of new Set<number>([...manual, ...automatic])) {
        const item = itemById.get(itemId);
        if (!item || item.deleted) continue;
        for (const value of item.tags) {
          if (normalizeLibraryIndexTagIdentity(value) !== normalizedName)
            continue;
          variants.add(value);
        }
        for (const value of item.automaticTags) {
          if (normalizeLibraryIndexTagIdentity(value) !== normalizedName)
            continue;
          variants.add(value);
        }
      }
      if (!manual.size && !automatic.size) {
        tagDeletes.add(normalizedName);
      } else {
        tagUpdates.set(
          normalizedName,
          Object.freeze({
            normalizedName,
            displayVariants: Object.freeze([...variants].sort()),
            manualItemIds: manual,
            automaticItemIds: automatic,
          }),
        );
      }
      for (const tagId of snapshot.tagIdsByNormalizedName.get(normalizedName) ||
        []) {
        tagIdDeletes.add(tagId);
      }
      const nextTagIds = new Set<number>();
      for (const variant of variants) {
        try {
          const tagId = Number(Zotero.Tags.getID(variant));
          if (Number.isFinite(tagId) && tagId > 0) {
            tagIdUpdates.set(tagId, normalizedName);
            nextTagIds.add(tagId);
          }
        } catch {
          // The name-based reverse index remains authoritative.
        }
      }
      if (nextTagIds.size) {
        reverseTagIdUpdates.set(normalizedName, Object.freeze([...nextTagIds]));
      } else {
        reverseTagIdDeletes.add(normalizedName);
      }
    }

    const affectedCollections = new Set<number>();
    const collectionAdds = new Map<number, Set<number>>();
    const collectionDeletes = new Map<number, Set<number>>();
    for (const id of topLevelIds) {
      const before = new Set(previousItems.get(id)?.collectionIds || []);
      const after = new Set(itemById.get(id)?.collectionIds || []);
      for (const collectionId of new Set([...before, ...after])) {
        if (before.has(collectionId) === after.has(collectionId)) continue;
        affectedCollections.add(collectionId);
        const deltas = after.has(collectionId)
          ? collectionAdds
          : collectionDeletes;
        const members = deltas.get(collectionId) || new Set<number>();
        members.add(id);
        deltas.set(collectionId, members);
      }
    }
    const directCollectionUpdates = new Map<number, ReadonlySet<number>>();
    const directCollectionDeletes = new Set<number>();
    for (const collectionId of affectedCollections) {
      const members = patchSet(
        snapshot.directItemIdsByCollectionId.get(collectionId) ||
          new Set<number>(),
        collectionAdds.get(collectionId) || new Set<number>(),
        collectionDeletes.get(collectionId) || new Set<number>(),
      );
      if (!members.size && !snapshot.collectionById.has(collectionId)) {
        directCollectionDeletes.add(collectionId);
      } else {
        directCollectionUpdates.set(collectionId, members);
      }
    }

    state.snapshot = Object.freeze({
      ...snapshot,
      epoch: state.epoch,
      itemById,
      topLevelItemOrder: order,
      attachmentById: patchMap(
        snapshot.attachmentById,
        attachmentUpdates,
        attachmentDeletes,
      ),
      childAttachmentIdsByItemId: patchMap(
        snapshot.childAttachmentIdsByItemId,
        childAttachmentUpdates,
        childAttachmentDeletes,
      ),
      pdfAttachmentIdsByItemId,
      childNoteIdsByItemId: patchMap(
        snapshot.childNoteIdsByItemId,
        childNoteUpdates,
        childNoteDeletes,
      ),
      childNoteById: patchMap(
        snapshot.childNoteById,
        childNoteRecordUpdates,
        childNoteRecordDeletes,
      ),
      parentItemIdByChildId: patchMap(
        snapshot.parentItemIdByChildId,
        childParentUpdates,
        childParentDeletes,
      ),
      searchableFieldsByItemId: patchMap(
        snapshot.searchableFieldsByItemId,
        searchableUpdates,
        searchableDeletes,
      ),
      directItemIdsByCollectionId: patchMap(
        snapshot.directItemIdsByCollectionId,
        directCollectionUpdates,
        directCollectionDeletes,
      ),
      tagByNormalizedName: patchMap(
        snapshot.tagByNormalizedName,
        tagUpdates,
        tagDeletes,
      ),
      normalizedTagNameByTagId: patchMap(
        snapshot.normalizedTagNameByTagId,
        tagIdUpdates,
        tagIdDeletes,
      ),
      tagIdsByNormalizedName: patchMap(
        snapshot.tagIdsByNormalizedName,
        reverseTagIdUpdates,
        reverseTagIdDeletes,
      ),
      unfiledItemIds: patchSet(
        snapshot.unfiledItemIds,
        unfiledAdds,
        unfiledDeletes,
      ),
      untaggedItemIds: patchSet(
        snapshot.untaggedItemIds,
        untaggedAdds,
        untaggedDeletes,
      ),
      pdfCapableItemIds: patchSet(
        snapshot.pdfCapableItemIds,
        pdfAdds,
        pdfDeletes,
      ),
    });
    this.metrics.incrementalItemUpdates += topLevelIds.size;
  }

  private async patchCollections(
    libraryID: number,
    ids: number[],
    force = false,
  ): Promise<void> {
    const state = this.states.get(libraryID);
    const snapshot = state?.snapshot;
    if (!state) return;
    if (!snapshot || (!force && this.shouldQueueChanges(state))) {
      this.queueCollectionChanges(state, ids);
      return;
    }
    const collectionUpdates = new Map<number, LibraryIndexCollection>();
    const collectionDeletes = new Set<number>();
    const directUpdates = new Map<number, ReadonlySet<number>>();
    const directDeletes = new Set<number>();
    const childUpdates = new Map<number, readonly number[]>();
    const childDeletes = new Set<number>();
    const membershipAffectedItemIds = new Set<number>();
    const affected = new Set(ids);
    const childMembershipAffected = new Set<number>();
    const previousCollections = new Map<
      number,
      LibraryIndexCollection | undefined
    >();
    const liveById = new Map<number, Zotero.Collection | null>();
    const getLive = (id: number): Zotero.Collection | null => {
      if (liveById.has(id)) return liveById.get(id) || null;
      let collection: Zotero.Collection | null = null;
      try {
        collection = Zotero.Collections.get(id) || null;
      } catch {
        collection = null;
      }
      liveById.set(id, collection);
      return collection;
    };
    for (const id of ids) {
      const previousCollection = snapshot.collectionById.get(id);
      const liveCollection = getLive(id);
      const oldParent = previousCollection?.parentCollectionId || 0;
      const rawNewParent = Number(liveCollection?.parentID);
      const newParent =
        Number.isFinite(rawNewParent) && rawNewParent > 0
          ? Math.floor(rawNewParent)
          : 0;
      const lifecycleChanged = Boolean(
        previousCollection &&
        liveCollection &&
        previousCollection.deleted !==
          Boolean(
            (liveCollection as Zotero.Collection & { deleted?: unknown })
              .deleted,
          ),
      );
      if (oldParent && (oldParent !== newParent || lifecycleChanged)) {
        affected.add(oldParent);
        childMembershipAffected.add(oldParent);
      }
      if (newParent && oldParent !== newParent) {
        affected.add(newParent);
        childMembershipAffected.add(newParent);
      }
    }
    for (const id of affected) {
      const collection = getLive(id);
      const previousCollection = snapshot.collectionById.get(id);
      previousCollections.set(id, previousCollection);
      const previousMembers =
        snapshot.directItemIdsByCollectionId.get(id) || new Set<number>();
      if (!collection || Number(collection.libraryID) !== libraryID) {
        previousMembers.forEach((itemId) =>
          membershipAffectedItemIds.add(itemId),
        );
        collectionDeletes.add(id);
        directDeletes.add(id);
        childDeletes.add(id);
        continue;
      }
      const parent = Number(collection.parentID);
      const deleted = Boolean(
        (collection as Zotero.Collection & { deleted?: unknown }).deleted,
      );
      collectionUpdates.set(
        id,
        Object.freeze({
          collectionId: id,
          libraryID,
          name: text(collection.name) || `Collection ${id}`,
          parentCollectionId:
            Number.isFinite(parent) && parent > 0 ? Math.floor(parent) : 0,
          deleted,
        }),
      );
      const deletedChanged =
        Boolean(previousCollection) && previousCollection?.deleted !== deleted;
      if (!previousCollection) directUpdates.set(id, new Set<number>());
      if (!previousCollection || deletedChanged) {
        // Incremental and cold projections both include trashed item records.
        // Ask Zotero for deleted children too, then refresh those item records
        // so their own collection IDs remain the canonical membership source.
        const currentMembers = positiveIds(
          collection.getChildItems?.(true, true) || [],
        );
        previousMembers.forEach((itemId) =>
          membershipAffectedItemIds.add(itemId),
        );
        currentMembers.forEach((itemId) =>
          membershipAffectedItemIds.add(itemId),
        );
        childMembershipAffected.add(id);
      }
      if (childMembershipAffected.has(id) || !previousCollection) {
        const previousChildren =
          snapshot.childCollectionIdsByCollectionId.get(id) || [];
        const nextChildren = positiveIds(
          collection.getChildCollections?.(true, false) || [],
        );
        if (!sameNumberMembers(previousChildren, nextChildren)) {
          childUpdates.set(id, Object.freeze(nextChildren));
        }
      }
    }
    const pathRoots = new Set<number>();
    for (const id of ids) {
      const before = previousCollections.get(id);
      const after = collectionUpdates.get(id);
      if (
        !before ||
        !after ||
        before.name !== after.name ||
        before.parentCollectionId !== after.parentCollectionId
      ) {
        pathRoots.add(id);
      }
    }
    const pathAffected = new Set<number>();
    const addPathSubtree = (
      root: number,
      childrenByCollectionId: ReadonlyMap<number, readonly number[]>,
    ): void => {
      const pending = [root];
      const visited = new Set<number>();
      while (pending.length) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        pathAffected.add(current);
        for (const child of childrenByCollectionId.get(current) || []) {
          pending.push(child);
        }
      }
    };
    for (const root of pathRoots) {
      addPathSubtree(root, snapshot.childCollectionIdsByCollectionId);
    }
    const collectionById = patchMap(
      snapshot.collectionById,
      collectionUpdates,
      collectionDeletes,
    );
    const childCollectionIdsByCollectionId = patchMap(
      snapshot.childCollectionIdsByCollectionId,
      childUpdates,
      childDeletes,
    );
    for (const root of pathRoots) {
      addPathSubtree(root, childCollectionIdsByCollectionId);
    }
    const pathUpdates = new Map<number, string>();
    const pathDeletes = new Set<number>();
    const computedPaths = new Map<number, string>();
    const resolvePath = (id: number, seen = new Set<number>()): string => {
      const computed = computedPaths.get(id);
      if (computed !== undefined) return computed;
      const collection = collectionById.get(id);
      if (!collection) return "";
      if (seen.has(id)) return collection.name;
      seen.add(id);
      const parent = collection.parentCollectionId;
      const parentPath =
        parent && collectionById.has(parent)
          ? !pathAffected.has(parent)
            ? snapshot.collectionPathById.get(parent) ||
              resolvePath(parent, seen)
            : resolvePath(parent, seen)
          : "";
      const path = parentPath
        ? `${parentPath} / ${collection.name}`
        : collection.name;
      computedPaths.set(id, path);
      return path;
    };
    for (const id of pathAffected) {
      if (!collectionById.has(id)) {
        pathDeletes.add(id);
        continue;
      }
      const path = resolvePath(id);
      if (snapshot.collectionPathById.get(id) !== path) {
        pathUpdates.set(id, path);
      }
    }
    const collectionPathById = patchMap(
      snapshot.collectionPathById,
      pathUpdates,
      pathDeletes,
    );
    state.snapshot = Object.freeze({
      ...snapshot,
      epoch: state.epoch,
      collectionById,
      directItemIdsByCollectionId: patchMap(
        snapshot.directItemIdsByCollectionId,
        directUpdates,
        directDeletes,
      ),
      childCollectionIdsByCollectionId,
      collectionPathById,
    });
    this.metrics.incrementalCollectionUpdates += affected.size;
    if (membershipAffectedItemIds.size) {
      await this.patchItems(libraryID, [...membershipAffectedItemIds], force);
    }
  }

  private scheduleRebuild(libraryID: number): void {
    const state = this.states.get(libraryID);
    if (!state) return;
    this.queueFullRebuild(state);
    if (state.snapshot) this.schedulePendingReconciliation(libraryID);
  }

  async handleChange(change: ZoteroChangeEvent): Promise<void> {
    const ids = numericNotifierIds(change.ids);
    const explicitLibraryID = Math.floor(
      Number(
        (change.extraData as { libraryID?: unknown; libraryId?: unknown })
          .libraryID || (change.extraData as { libraryId?: unknown }).libraryId,
      ),
    );
    if (
      change.event === "refresh" ||
      change.event === "redraw" ||
      change.type === "refresh"
    ) {
      const refreshLibraryIDs = new Set<number>();
      if (explicitLibraryID > 0) refreshLibraryIDs.add(explicitLibraryID);
      // Zotero's refresh:trash notification carries library IDs in `ids`,
      // not item IDs. Resolve this shape before ownership lookup so an item
      // whose ID equals a library ID cannot divert the invalidation.
      if (change.event === "refresh" && change.type === "trash") {
        ids.forEach((libraryID) => refreshLibraryIDs.add(libraryID));
      }
      for (const libraryID of refreshLibraryIDs.size
        ? refreshLibraryIDs
        : this.states.keys()) {
        this.scheduleRebuild(libraryID);
      }
      return;
    }
    if (change.type === "group") {
      const groupLibraryIDs = this.libraryIDsForGroupIds(ids);
      if (explicitLibraryID > 0) groupLibraryIDs.add(explicitLibraryID);
      if (!groupLibraryIDs.size && this.states.size === 1) {
        groupLibraryIDs.add(this.states.keys().next().value as number);
      }
      for (const libraryID of groupLibraryIDs) {
        this.patchLibraryName(libraryID);
      }
      return;
    }
    const libraryIDs =
      change.type === "collection"
        ? this.libraryIDsForCollectionIds(ids)
        : this.libraryIDsForItemIds(ids);
    if (explicitLibraryID > 0) libraryIDs.add(explicitLibraryID);
    if (!libraryIDs.size && this.states.size === 1) {
      libraryIDs.add(this.states.keys().next().value as number);
    }
    if (change.type === "item" || change.type === "file") {
      for (const libraryID of libraryIDs) await this.patchItems(libraryID, ids);
      return;
    }
    if (change.type === "collection") {
      for (const libraryID of libraryIDs.size
        ? libraryIDs
        : this.states.keys()) {
        if (ids.length) await this.patchCollections(libraryID, ids);
        else this.scheduleRebuild(libraryID);
      }
      return;
    }
    if (change.type === "collection-item" || change.type === "item-tag") {
      const itemIds = relationItemNotifierIds(
        change.type,
        change.ids,
        change.extraData,
      );
      const relationLibraries = this.libraryIDsForItemIds(itemIds);
      if (explicitLibraryID > 0) relationLibraries.add(explicitLibraryID);
      for (const libraryID of relationLibraries) {
        await this.patchItems(libraryID, itemIds);
      }
      return;
    }
    if (change.type === "tag") {
      // Resolve only the members of the changed tag. The old reverse mapping
      // covers rename/delete, while Zotero's current membership covers a new
      // or merged tag. No full-library projection is needed.
      for (const [libraryID, state] of this.states) {
        if (this.shouldQueueChanges(state)) {
          this.queueFullRebuild(state);
          continue;
        }
        const snapshot = state.snapshot;
        if (!snapshot) continue;
        const tagNames = Array.isArray(
          (change.extraData as { tagNames?: unknown }).tagNames,
        )
          ? ((change.extraData as { tagNames: unknown[] }).tagNames || [])
              .map(text)
              .filter(Boolean)
          : [];
        if (!ids.length && !tagNames.length) {
          this.scheduleRebuild(libraryID);
          continue;
        }
        const affected = new Set<number>();
        for (const tagId of ids) {
          const oldName = snapshot.normalizedTagNameByTagId.get(tagId);
          if (oldName) {
            const oldTag = snapshot.tagByNormalizedName.get(oldName);
            for (const itemId of oldTag?.manualItemIds || [])
              affected.add(itemId);
            for (const itemId of oldTag?.automaticItemIds || []) {
              affected.add(itemId);
            }
          }
          try {
            for (const itemId of await Zotero.Tags.getTagItems(
              libraryID,
              tagId,
            )) {
              affected.add(itemId);
            }
          } catch {
            // Deleted tags no longer have current members; the old mapping
            // above is sufficient for that case.
          }
        }
        for (const tagName of tagNames) {
          const normalizedName = normalizeLibraryIndexTagIdentity(tagName);
          const oldTag = snapshot.tagByNormalizedName.get(normalizedName);
          for (const itemId of oldTag?.manualItemIds || [])
            affected.add(itemId);
          for (const itemId of oldTag?.automaticItemIds || []) {
            affected.add(itemId);
          }
          // The notifier name is the best source for the current tag ID,
          // while indexed variants cover rename/delete events that report an
          // old spelling. Resolve both: a case-only variant can receive a new
          // Zotero tag ID and introduce members that were not in the old set.
          for (const variant of new Set([
            tagName,
            ...(oldTag?.displayVariants || []),
          ])) {
            try {
              const tagId = Number(Zotero.Tags.getID(variant));
              if (!Number.isFinite(tagId) || tagId <= 0) continue;
              for (const itemId of await Zotero.Tags.getTagItems(
                libraryID,
                tagId,
              )) {
                affected.add(itemId);
              }
            } catch {
              // Deleted/renamed variants may no longer have a current ID.
            }
          }
        }
        if (affected.size) {
          await this.patchItems(libraryID, [...affected]);
        } else if (ids.length && !tagNames.length) {
          // An unresolvable tag event is rare and ambiguous. Coalesce it with
          // any sync storm rather than publishing a knowingly stale snapshot.
          this.scheduleRebuild(libraryID);
        }
      }
    }
  }

  orderedItemIds(
    snapshot: LibraryIndexSnapshot,
    candidates?: ReadonlySet<number>,
  ): number[] {
    return candidates
      ? snapshot.topLevelItemOrder.filter((id) => candidates.has(id))
      : [...snapshot.topLevelItemOrder];
  }

  tagItemIds(
    snapshot: LibraryIndexSnapshot,
    name: string,
    includeAutomatic: boolean,
  ): Set<number> {
    const tag = snapshot.tagByNormalizedName.get(
      normalizeLibraryIndexTagIdentity(name),
    );
    if (!tag) return new Set();
    return new Set([
      ...tag.manualItemIds,
      ...(includeAutomatic ? tag.automaticItemIds : []),
    ]);
  }
}

export const libraryIndexService = new LibraryIndexService();

zoteroChangeDispatcher.subscribe("library-index", (change) =>
  libraryIndexService.handleChange(change),
);
