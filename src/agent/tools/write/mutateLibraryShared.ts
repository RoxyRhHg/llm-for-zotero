/**
 * Shared helpers used by the focused facade tools for building
 * confirmation cards, normalizing inputs, and executing operations.
 */
import type { AgentPendingField, AgentToolContext } from "../../types";
import type {
  LibraryMutationUndo,
  ApplyTagsOperation,
  MoveToCollectionOperation,
  UpdateMetadataOperation,
  LibraryMutationOperation,
  LibraryMutationService,
} from "../../services/libraryMutationService";
import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  LibraryItemTarget,
  LibraryPaperTarget,
  ZoteroGateway,
} from "../../services/zoteroGateway";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "../../services/zoteroGateway";
import { pushUndoEntry } from "../../store/undoStore";
import { recordChange } from "../../store/changeJournal";
import {
  normalizePositiveInt,
  normalizeStringArray,
  validateObject,
} from "../shared";

// ── Tag assignment helpers ──────────────────────────────────────────────────

export function getTagAssignmentFieldId(operation: ApplyTagsOperation): string {
  return `tagAssignments:${operation.id || "apply_tags"}`;
}

export function getTagAssignments(
  operation: ApplyTagsOperation,
): Array<{ itemId: number; tags: string[] }> {
  if (operation.assignments?.length) {
    return operation.assignments.map((assignment) => ({
      itemId: assignment.itemId,
      tags: Array.isArray(assignment.tags) ? assignment.tags : [],
    }));
  }
  if (!operation.itemIds?.length) {
    return [];
  }
  return operation.itemIds.map((itemId) => ({
    itemId,
    tags: operation.tags || [],
  }));
}

export function buildTagAssignmentField(
  operation: ApplyTagsOperation,
  zoteroGateway: ZoteroGateway,
) {
  const assignments = getTagAssignments(operation);
  if (!assignments.length) {
    return null;
  }
  const summaryByRequestedItemId = buildItemSummaryByRequestedItemId(
    assignments.map((assignment) => assignment.itemId),
    zoteroGateway,
  );
  return {
    type: "tag_assignment_table" as const,
    id: getTagAssignmentFieldId(operation),
    label: "Suggested tags to add",
    rows: assignments.map((assignment) => {
      const target = summaryByRequestedItemId.get(assignment.itemId);
      const itemTypeLabel = formatItemTypeLabel(target?.itemType);
      const details = [
        target?.firstCreator || target?.year ? "" : itemTypeLabel,
        target?.firstCreator || "",
        target?.year || "",
      ].filter(Boolean);
      return {
        id: `${assignment.itemId}`,
        label: target?.title || `Item ${assignment.itemId}`,
        description: details.join(" | ") || undefined,
        value: assignment.tags,
        placeholder: "tag-one, tag-two",
      };
    }),
  };
}

export function normalizeTagAssignmentsFromResolution(
  value: unknown,
): Array<{ itemId: number; tags: string[] }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return null;
      }
      const itemId = normalizePositiveInt(entry.id);
      const tags = normalizeStringArray(entry.value);
      if (!itemId || !tags?.length) {
        return null;
      }
      return { itemId, tags };
    })
    .filter((entry): entry is { itemId: number; tags: string[] } =>
      Boolean(entry),
    );
}

/**
 * Reads a checklist field's answer off a confirmation resolution.
 *
 * The renderer's checklist accessor returns the *checked* row ids as strings
 * (`agentTrace/render.ts` `getSelectedIds`), so the three states a caller must
 * tell apart are:
 *   - `undefined` — no resolution at all (the `auto_approve` / non-HITL path).
 *     The caller keeps its original operation.
 *   - `[]` — the user was asked and unchecked everything. This is a decision,
 *     not an absence, and destructive callers must surface it as an error
 *     rather than proceeding with the full list.
 *   - a non-empty array — the rows to act on.
 *
 * Row ids are whatever the field author put in `items[].id`: numeric item ids
 * (trash, merge), array indices including `"0"` (import identifiers), or file
 * paths (import local files). This returns them verbatim; use
 * `normalizeChecklistItemIdsFromResolution` when the ids are Zotero item ids.
 */
export function normalizeChecklistSelectionFromResolution(
  resolutionData: unknown,
  fieldId: string,
): string[] | undefined {
  if (!validateObject<Record<string, unknown>>(resolutionData)) {
    return undefined;
  }
  const raw = resolutionData[fieldId];
  if (raw === undefined || raw === null || !Array.isArray(raw)) {
    return undefined;
  }
  return raw
    .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
    .filter((entry) => entry.length > 0);
}

/**
 * `normalizeChecklistSelectionFromResolution` for checklists whose row ids are
 * Zotero item ids. Ids that are not positive integers are dropped, so a
 * malformed payload narrows the operation rather than widening it.
 */
export function normalizeChecklistItemIdsFromResolution(
  resolutionData: unknown,
  fieldId: string,
): number[] | undefined {
  const selected = normalizeChecklistSelectionFromResolution(
    resolutionData,
    fieldId,
  );
  if (selected === undefined) return undefined;
  return selected
    .map((entry) => normalizePositiveInt(entry))
    .filter((id): id is number => Boolean(id));
}

// ── Move assignment helpers ─────────────────────────────────────────────────

export function getMoveAssignmentFieldId(
  operation: MoveToCollectionOperation,
): string {
  return `moveAssignments:${operation.id || "move_to_collection"}`;
}

function normalizeCollectionKey(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function describeCollection(
  collection: ReturnType<ZoteroGateway["getCollectionSummary"]>,
): string {
  return collection ? collection.path || collection.name : "unknown collection";
}

type MoveAssignmentItemSummary = {
  itemId: number;
  itemType?: string;
  title: string;
  firstCreator?: string;
  year?: string;
  collectionIds: number[];
};

function normalizeDisplayText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatItemTypeLabel(itemType: string | undefined): string {
  if (!itemType) return "";
  if (itemType === "journalArticle") return "Journal article";
  if (itemType === "conferencePaper") return "Conference paper";
  return itemType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

function firstCreatorLabel(creators: EditableArticleCreator[]): string {
  const creator = creators[0];
  if (!creator) return "";
  return (
    creator.name ||
    [creator.firstName, creator.lastName].filter(Boolean).join(" ")
  ).trim();
}

function normalizeCollectionIds(
  item: Zotero.Item | null | undefined,
): number[] {
  const raw = item?.getCollections?.() || [];
  return raw
    .map((value: unknown) => Math.floor(Number(value)))
    .filter((value: number) => Number.isFinite(value) && value > 0);
}

function getMoveAssignmentItemSummary(
  itemId: number,
  zoteroGateway: ZoteroGateway,
): MoveAssignmentItemSummary | null {
  const item = zoteroGateway.getItem(itemId);
  const snapshot = zoteroGateway.getEditableArticleMetadata(item);
  if (!snapshot) return getFallbackMoveAssignmentItemSummary(itemId, item);
  const parentItem = zoteroGateway.getItem(snapshot.itemId);
  const displayTitle =
    snapshot.title ||
    snapshot.fields.title ||
    (typeof parentItem?.getDisplayTitle === "function"
      ? parentItem.getDisplayTitle()
      : "") ||
    `Item ${snapshot.itemId || itemId}`;
  return {
    itemId: snapshot.itemId || itemId,
    itemType: snapshot.itemType,
    title: displayTitle,
    firstCreator: firstCreatorLabel(snapshot.creators) || undefined,
    year: snapshot.fields.date.match(/\b(19|20)\d{2}\b/)?.[0] || undefined,
    collectionIds: normalizeCollectionIds(parentItem || item),
  };
}

function getFallbackMoveAssignmentItemSummary(
  itemId: number,
  item: Zotero.Item | null | undefined,
): MoveAssignmentItemSummary | null {
  if (!item) return null;
  const isNote = Boolean((item as any).isNote?.());
  const isAttachment = Boolean(item.isAttachment?.());
  const itemType = isNote ? "note" : isAttachment ? "attachment" : undefined;
  const displayTitle =
    normalizeDisplayText((item as any).getNoteTitle?.()) ||
    normalizeDisplayText(item.getField?.("title")) ||
    normalizeDisplayText(item.getDisplayTitle?.()) ||
    `${formatItemTypeLabel(itemType) || "Item"} ${itemId}`;
  return {
    itemId,
    itemType,
    title: displayTitle,
    collectionIds: normalizeCollectionIds(item),
  };
}

function summarizeMoveAssignmentTarget(
  target: LibraryItemTarget | LibraryPaperTarget,
): MoveAssignmentItemSummary {
  const itemTarget = target as LibraryItemTarget;
  return {
    itemId: target.itemId,
    itemType: itemTarget.itemType,
    title: target.title,
    firstCreator: target.firstCreator,
    year: target.year,
    collectionIds: target.collectionIds,
  };
}

function buildItemSummaryByRequestedItemId(
  itemIds: number[],
  zoteroGateway: ZoteroGateway,
): Map<number, MoveAssignmentItemSummary> {
  const summaryByRequestedItemId = new Map<number, MoveAssignmentItemSummary>();
  if (
    typeof zoteroGateway.getBibliographicItemTargetsByItemIds === "function"
  ) {
    for (const itemId of itemIds) {
      const target = zoteroGateway.getBibliographicItemTargetsByItemIds([
        itemId,
      ])[0];
      if (!target) continue;
      summaryByRequestedItemId.set(
        itemId,
        summarizeMoveAssignmentTarget(target),
      );
    }
  }
  for (const itemId of itemIds) {
    if (summaryByRequestedItemId.has(itemId)) continue;
    const target = zoteroGateway.getPaperTargetsByItemIds([itemId])[0];
    if (!target) continue;
    summaryByRequestedItemId.set(itemId, summarizeMoveAssignmentTarget(target));
  }
  for (const itemId of itemIds) {
    if (summaryByRequestedItemId.has(itemId)) continue;
    const genericSummary = getMoveAssignmentItemSummary(itemId, zoteroGateway);
    if (genericSummary) {
      summaryByRequestedItemId.set(itemId, genericSummary);
    }
  }
  return summaryByRequestedItemId;
}

export function getMoveAssignments(
  operation: MoveToCollectionOperation,
): Array<{
  itemId: number;
  targetCollectionId?: number;
  targetCollectionName?: string;
  targetCollectionPath?: string;
}> {
  if (operation.assignments?.length) {
    return operation.assignments;
  }
  if (!operation.itemIds?.length) {
    return [];
  }
  return operation.itemIds.map((itemId) => ({
    itemId,
    targetCollectionId: operation.targetCollectionId,
    targetCollectionName: operation.targetCollectionName,
    targetCollectionPath: operation.targetCollectionPath,
  }));
}

export function buildCollectionSelectOptions(
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
): Array<{
  id: string;
  label: string;
  name: string;
  path: string;
}> {
  const libraryID = zoteroGateway.resolveLibraryID({
    request: context.request,
    item: context.item,
  });
  if (!libraryID) {
    return [];
  }
  const summaries = zoteroGateway.listCollectionSummaries(libraryID);
  return summaries.map((collection) => ({
    id: `${collection.collectionId}`,
    label: collection.path || collection.name,
    name: collection.name,
    path: collection.path || collection.name,
  }));
}

function resolveInitialCollectionSelection(
  assignment: ReturnType<typeof getMoveAssignments>[number],
  options: ReturnType<typeof buildCollectionSelectOptions>,
): string | undefined {
  if (assignment.targetCollectionId) {
    const direct = options.find(
      (option) => option.id === `${assignment.targetCollectionId}`,
    );
    if (direct) return direct.id;
  }
  const pathKey = normalizeCollectionKey(assignment.targetCollectionPath);
  if (pathKey) {
    const pathMatch = options.find(
      (option) => normalizeCollectionKey(option.path) === pathKey,
    );
    if (pathMatch) return pathMatch.id;
  }
  const nameKey = normalizeCollectionKey(assignment.targetCollectionName);
  if (nameKey) {
    const matches = options.filter(
      (option) =>
        normalizeCollectionKey(option.name) === nameKey ||
        normalizeCollectionKey(option.path) === nameKey,
    );
    if (matches.length === 1) {
      return matches[0].id;
    }
  }
  return undefined;
}

export function buildMoveAssignmentField(
  operation: MoveToCollectionOperation,
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
) {
  const assignments = getMoveAssignments(operation);
  if (!assignments.length) {
    return null;
  }
  const options = buildCollectionSelectOptions(zoteroGateway, context);
  if (!options.length) {
    return null;
  }
  const itemIds = assignments.map((assignment) => assignment.itemId);
  const summaryByRequestedItemId = buildItemSummaryByRequestedItemId(
    itemIds,
    zoteroGateway,
  );
  return {
    type: "assignment_table" as const,
    id: getMoveAssignmentFieldId(operation),
    label:
      assignments.length === 1 ? "Destination folder" : "Destination folders",
    options: [
      { id: "__skip__", label: "Leave untouched" },
      ...options.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    ],
    rows: assignments.map((assignment) => {
      const target = summaryByRequestedItemId.get(assignment.itemId);
      const currentCollections = (target?.collectionIds || [])
        .map((collectionId) => zoteroGateway.getCollectionSummary(collectionId))
        .filter(Boolean)
        .map((collection) => describeCollection(collection));
      const itemTypeLabel = formatItemTypeLabel(target?.itemType);
      const details = [
        target?.firstCreator || target?.year ? "" : itemTypeLabel,
        target?.firstCreator || "",
        target?.year || "",
        currentCollections.length
          ? `Current: ${currentCollections.join(", ")}`
          : "Current: unfiled",
      ].filter(Boolean);
      return {
        id: `${assignment.itemId}`,
        label: target?.title || `Item ${assignment.itemId}`,
        description: details.join(" | "),
        value:
          resolveInitialCollectionSelection(assignment, options) || "__skip__",
        checked: true,
      };
    }),
  };
}

export function normalizeMoveAssignmentsFromResolution(
  value: unknown,
): Array<{ itemId: number; targetCollectionId: number }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => {
      if (!validateObject<Record<string, unknown>>(entry)) {
        return null;
      }
      if (entry.checked === false || entry.value === "__skip__") {
        return null;
      }
      const itemId = normalizePositiveInt(entry.id);
      const targetCollectionId = normalizePositiveInt(entry.value);
      if (!itemId || !targetCollectionId) {
        return null;
      }
      return { itemId, targetCollectionId };
    })
    .filter((entry): entry is { itemId: number; targetCollectionId: number } =>
      Boolean(entry),
    );
}

// ── Metadata review helpers ─────────────────────────────────────────────────

export const METADATA_FIELD_DISPLAY_LABELS: Record<string, string> = {
  title: "Title",
  shortTitle: "Short title",
  abstractNote: "Abstract",
  publicationTitle: "Journal",
  journalAbbreviation: "Journal abbreviation",
  proceedingsTitle: "Proceedings title",
  date: "Date",
  volume: "Volume",
  issue: "Issue",
  pages: "Pages",
  DOI: "DOI",
  url: "URL",
  language: "Language",
  extra: "Extra",
  ISSN: "ISSN",
  ISBN: "ISBN",
  publisher: "Publisher",
  place: "Place",
};

export function formatCreatorsDisplay(
  creators: EditableArticleCreator[],
): string {
  return creators
    .map((c) => {
      if (c.name) return c.name;
      return [c.firstName, c.lastName].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("; ");
}

export function buildUpdateMetadataReviewField(
  operation: UpdateMetadataOperation,
  zoteroGateway: ZoteroGateway,
  context: AgentToolContext,
  itemTitle: string,
  showTitle: boolean,
): Extract<AgentPendingField, { type: "review_table" }> | null {
  const item = zoteroGateway.resolveMetadataItem({
    itemId: operation.itemId,
    paperContext: operation.paperContext,
    request: context.request,
    item: context.item,
  });
  const snapshot = zoteroGateway.getEditableArticleMetadata(item);
  const rows: Extract<AgentPendingField, { type: "review_table" }>["rows"] = [];

  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(operation.metadata, fieldName))
      continue;
    const newValue = operation.metadata[fieldName] ?? "";
    const label = METADATA_FIELD_DISPLAY_LABELS[fieldName] || fieldName;
    const before = snapshot?.fields[fieldName] ?? "";
    rows.push({
      key: fieldName,
      label,
      before,
      after: newValue,
      multiline: fieldName === "abstractNote",
    });
  }

  if (operation.metadata.creators !== undefined) {
    const before = snapshot ? formatCreatorsDisplay(snapshot.creators) : "";
    const after = formatCreatorsDisplay(operation.metadata.creators);
    rows.push({ key: "creators", label: "Authors", before, after });
  }

  if (!rows.length) return null;

  return {
    type: "review_table",
    id: `metadataReview:${operation.id}`,
    label: showTitle ? itemTitle : undefined,
    rows,
  };
}

// ── Execution + undo helpers ────────────────────────────────────────────────

/**
 * Execute a single operation via the mutation service and register undo.
 * Used by the focused facade tools for single-operation calls.
 */
export async function executeAndRecordUndo(
  mutationService: LibraryMutationService,
  operation: LibraryMutationOperation,
  context: AgentToolContext,
  facadeToolName: string,
): Promise<{ result: unknown }> {
  const executed = await mutationService.executeOperation(operation, context);
  if (executed.undo) {
    pushUndoEntry(context.request.conversationKey, {
      id: `undo-${facadeToolName}-${Date.now()}`,
      toolName: facadeToolName,
      description: executed.undo.description,
      revert: executed.undo.revert,
    });
  }
  // The in-memory stack above is the fast path for "undo that" in the current
  // conversation. The journal is the durable one: it survives a restart, has
  // no ten-entry ceiling, and is what the history panel reads.
  await journalMutation({
    context,
    operation,
    facadeToolName,
    undo: executed.undo ?? null,
  });
  return { result: executed.result };
}

let journalSequence = 0;

async function journalMutation(params: {
  context: AgentToolContext;
  operation: LibraryMutationOperation;
  facadeToolName: string;
  undo: LibraryMutationUndo | null;
}): Promise<void> {
  const { context, operation, undo } = params;
  // A batch job supplies its own run id so its pages revert as one unit;
  // ordinary turns group by conversation, which is what the history lists.
  const runId =
    context.request.agentRunId || `conv-${context.request.conversationKey}`;
  journalSequence += 1;
  try {
    await recordChange({
      entryId: `${runId}-${Date.now()}-${journalSequence}`,
      runId,
      conversationKey: context.request.conversationKey,
      operation: operation.type,
      description: undo?.description || `Applied ${operation.type}`,
      inverse: undo?.inverseOperations?.length
        ? undo.inverseOperations
        : undefined,
      irreversibleReason: undo?.inverseOperations?.length
        ? undefined
        : undo?.irreversibleReason ||
          (undo
            ? "This change can only be undone in the current session"
            : `${operation.type} did not record a way to undo it`),
      itemCount: countAffected(operation),
      now: Date.now(),
    });
  } catch {
    // A journal write must never fail the mutation that already landed.
  }
}

function countAffected(operation: LibraryMutationOperation): number {
  const record = operation as unknown as Record<string, unknown>;
  for (const key of ["itemIds", "identifiers", "filePaths", "otherItemIds"]) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  const assignments = record.assignments;
  if (Array.isArray(assignments)) return assignments.length;
  return 1;
}

/**
 * Execute multiple operations via the mutation service and register a single
 * grouped undo entry. Used by facade tools that support batching (e.g.
 * update_metadata with multiple items).
 */
export async function executeAndRecordUndoBatch(
  mutationService: LibraryMutationService,
  operations: LibraryMutationOperation[],
  context: AgentToolContext,
  facadeToolName: string,
): Promise<{ appliedCount: number; results: unknown[] }> {
  const results: unknown[] = [];
  const undoEntries: LibraryMutationUndo[] = [];
  for (const operation of operations) {
    const executed = await mutationService.executeOperation(operation, context);
    results.push(executed.result);
    if (executed.undo) {
      undoEntries.push(executed.undo);
    }
  }
  // Journal each operation individually so a batch is as revertible as a
  // single write. This helper journalled nothing at all, so update_metadata
  // over several items -- its only caller -- left no history.
  for (let index = 0; index < operations.length; index += 1) {
    await journalMutation({
      context,
      operation: operations[index],
      facadeToolName,
      undo: undoEntries[index] ?? null,
    });
  }
  if (undoEntries.length) {
    pushUndoEntry(context.request.conversationKey, {
      id: `undo-${facadeToolName}-batch-${Date.now()}`,
      toolName: facadeToolName,
      description: `Undo ${undoEntries.length} ${facadeToolName} change${
        undoEntries.length === 1 ? "" : "s"
      }`,
      revert: async () => {
        for (const undo of [...undoEntries].reverse()) {
          await undo.revert();
        }
      },
    });
  }
  return { appliedCount: results.length, results };
}

// ── Metadata & Creator normalization ─────────────────────────────────────────

export function normalizeStringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return null;
}

export function normalizeCreator(
  value: unknown,
): EditableArticleCreator | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  const creatorType =
    typeof value.creatorType === "string" && value.creatorType.trim()
      ? value.creatorType.trim()
      : "author";
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : undefined;
  const firstName =
    typeof value.firstName === "string" && value.firstName.trim()
      ? value.firstName.trim()
      : undefined;
  const lastName =
    typeof value.lastName === "string" && value.lastName.trim()
      ? value.lastName.trim()
      : undefined;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode: name ? 1 : 0,
  };
}

export function normalizeCreatorsList(
  raw: unknown,
): EditableArticleCreator[] | null {
  if (Array.isArray(raw)) {
    const list = raw
      .map((entry) => normalizeCreator(entry))
      .filter((entry): entry is EditableArticleCreator => Boolean(entry));
    return list.length ? list : null;
  }
  // Model may send a comma/semicolon-separated string like "Stefan Leutgeb, Jill K. Leutgeb"
  if (typeof raw === "string" && raw.trim()) {
    const names = raw
      .split(/;|,(?![^(]*\))/)
      .map((name) => name.trim())
      .filter(Boolean);
    if (!names.length) return null;
    return names.map((name) => ({
      creatorType: "author",
      name,
      fieldMode: 1 as const,
    }));
  }
  return null;
}

/**
 * Normalize a metadata patch from tool input.
 * Handles nested `.fields` objects (e.g. from query_library snapshots),
 * the "creators"/"authors" alias, and string/number/boolean field coercion.
 * Skips un-normalizable fields instead of aborting the entire patch.
 */
export function normalizeMetadataPatch(
  value: unknown,
): EditableArticleMetadataPatch | null {
  if (!validateObject<Record<string, unknown>>(value)) return null;
  // Flatten nested .fields object (e.g. from metadata snapshots)
  const normalizedValue = validateObject<Record<string, unknown>>(value.fields)
    ? {
        ...(value.fields as Record<string, unknown>),
        ...value,
      }
    : value;
  const metadata: EditableArticleMetadataPatch = {};
  for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalizedValue, fieldName))
      continue;
    const normalized = normalizeStringValue(normalizedValue[fieldName]);
    if (normalized === null) continue;
    metadata[fieldName as EditableArticleMetadataField] = normalized;
  }
  // Accept "creators" or "authors" (common model alias). Handle arrays and
  // comma/semicolon-separated strings. Non-parseable values are silently skipped
  // so they do not abort the entire patch.
  const rawCreators = Object.prototype.hasOwnProperty.call(
    normalizedValue,
    "creators",
  )
    ? normalizedValue.creators
    : Object.prototype.hasOwnProperty.call(normalizedValue, "authors")
      ? normalizedValue.authors
      : undefined;
  if (rawCreators !== undefined) {
    const creators = normalizeCreatorsList(rawCreators);
    if (creators !== null) {
      metadata.creators = creators;
    }
  }
  return Object.keys(metadata).length ? metadata : null;
}
