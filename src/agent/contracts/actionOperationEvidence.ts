import type {
  AgentActionCapability,
  AgentToolActionDescriptor,
  AgentToolDefinition,
} from "../types";
import type { LibraryMutationOperation } from "../services/libraryMutationService";
import { isRegisteredLibraryMutationOperation } from "../services/libraryMutation/handlerRegistry";

export type CollectionSummary = {
  collectionId: number;
  libraryID: number;
  name: string;
  path?: string;
};

export type ActionContractGateway = {
  getCollectionSummary(collectionId: number): CollectionSummary | null;
  listCollectionSummaries(libraryID: number): CollectionSummary[];
  /** Native collection state for scope freezing; must not use a search snapshot. */
  listCurrentCollectionSummaries?(libraryID: number): CollectionSummary[];
  /** Direct native members used to freeze and revalidate action scope. */
  listCurrentCollectionTargetIds?(params: {
    libraryID: number;
    collectionId: number;
    targetKind: "papers" | "items";
  }): number[];
  listCollectionPaperTargets(params: {
    libraryID: number;
    collectionId: number;
  }): Promise<{ papers: Array<{ itemId: number }> }>;
  listCollectionItemTargets(params: {
    libraryID: number;
    collectionId: number;
  }): Promise<{ items: Array<{ itemId: number }> }>;
  getItem(itemId: number): Zotero.Item | null;
  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): { fields: Record<string, string>; creators: unknown[] } | null;
};

export type PreparedActionExecution = {
  descriptor: AgentToolActionDescriptor;
  capability: AgentActionCapability;
  operations: LibraryMutationOperation[];
  requestedTargets: string[];
  destinationCollectionIds: number[];
  alreadySatisfiedTargets: string[];
  verifiedFacts: string[];
};

function nestedOperationResult(
  content: unknown,
): Record<string, unknown> | null {
  if (!content || typeof content !== "object") return null;
  let current = content as Record<string, unknown>;
  for (let depth = 0; depth < 3; depth += 1) {
    if (
      typeof current.operation === "string" &&
      current.result &&
      typeof current.result === "object"
    ) {
      return current.result as Record<string, unknown>;
    }
    if (!current.result || typeof current.result !== "object") break;
    current = current.result as Record<string, unknown>;
  }
  return current;
}

const CAPABILITY_BY_OPERATION: Partial<
  Record<LibraryMutationOperation["type"], AgentActionCapability>
> = {
  update_metadata: "zotero.metadata",
  apply_tags: "zotero.tags",
  remove_tags: "zotero.tags",
  set_item_tags: "zotero.tags",
  update_library_tag: "zotero.tags",
  move_to_collection: "zotero.collections",
  remove_from_collection: "zotero.collections",
  set_item_collections: "zotero.collections",
  create_collection: "zotero.collections",
  update_collection: "zotero.collections",
  delete_collection: "zotero.collections",
  save_note: "zotero.notes",
  save_notes_batch: "zotero.notes",
  import_identifiers: "zotero.import",
  import_local_files: "zotero.import",
  create_items: "zotero.import",
  trash_items: "zotero.trash",
  restore_from_trash: "zotero.trash",
  merge_items: "zotero.trash",
  delete_attachment: "zotero.attachments",
  rename_attachment: "zotero.attachments",
  relink_attachment: "zotero.attachments",
};

export function normalizePath(value: string | undefined): string {
  return (value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function uniqueNumbers(values: number[]): number[] {
  return [
    ...new Set(values.filter((value) => Number.isInteger(value) && value > 0)),
  ];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function itemTarget(itemId: number): string {
  return `item:${itemId}`;
}

export function targetItemId(target: string): number | null {
  const match = target.match(/^item:(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function extractLibraryMutationOperations(
  input: unknown,
): LibraryMutationOperation[] {
  if (!input || typeof input !== "object") return [];
  if (isRegisteredLibraryMutationOperation(input)) return [input];
  const record = input as Record<string, unknown>;
  const operations: LibraryMutationOperation[] = [];
  if (record.operation) {
    operations.push(...extractLibraryMutationOperations(record.operation));
  }
  if (Array.isArray(record.operations)) {
    for (const operation of record.operations) {
      operations.push(...extractLibraryMutationOperations(operation));
    }
  }
  if (record.delegateInput) {
    operations.push(...extractLibraryMutationOperations(record.delegateInput));
  }
  return operations;
}

export function operationItemIds(
  operation: LibraryMutationOperation,
): number[] {
  switch (operation.type) {
    case "update_metadata":
      return operation.itemId ? [operation.itemId] : [];
    case "apply_tags":
      return uniqueNumbers([
        ...(operation.itemIds || []),
        ...(operation.assignments || []).map((entry) => entry.itemId),
      ]);
    case "remove_tags":
    case "trash_items":
      return uniqueNumbers(operation.itemIds);
    case "move_to_collection":
      return uniqueNumbers([
        ...(operation.itemIds || []),
        ...(operation.assignments || []).map((entry) => entry.itemId),
      ]);
    case "remove_from_collection":
      return uniqueNumbers(operation.itemIds);
    case "set_item_tags":
    case "set_item_collections":
    case "reparent_items":
      return uniqueNumbers(operation.assignments.map((entry) => entry.itemId));
    case "save_notes_batch":
      return uniqueNumbers(operation.notes.map((entry) => entry.targetItemId));
    case "save_note":
      return operation.targetItemId ? [operation.targetItemId] : [];
    case "restore_from_trash":
      return uniqueNumbers(operation.itemIds || []);
    case "merge_items":
      return uniqueNumbers([operation.masterItemId, ...operation.otherItemIds]);
    case "delete_attachment":
    case "rename_attachment":
    case "relink_attachment":
      return [operation.attachmentId];
    case "relate_items":
      return uniqueNumbers([operation.itemId, ...operation.relatedItemIds]);
    default:
      return [];
  }
}

export function operationDestinationCollectionIds(
  operation: LibraryMutationOperation,
): number[] {
  switch (operation.type) {
    case "move_to_collection":
      return uniqueNumbers([
        Number(operation.targetCollectionId),
        ...(operation.assignments || []).map((assignment) =>
          Number(assignment.targetCollectionId),
        ),
      ]);
    case "save_note":
      return uniqueNumbers(operation.collections || []);
    case "save_notes_batch":
      return uniqueNumbers(
        operation.notes.flatMap((note) => note.collections || []),
      );
    case "import_identifiers":
    case "import_local_files":
      return operation.targetCollectionId ? [operation.targetCollectionId] : [];
    case "create_items":
      return uniqueNumbers(
        operation.items.flatMap((item) => item.collections || []),
      );
    default:
      return [];
  }
}

export function operationTags(operation: LibraryMutationOperation): string[] {
  switch (operation.type) {
    case "apply_tags":
      return uniqueStrings([
        ...(operation.tags || []),
        ...(operation.assignments || []).flatMap(
          (assignment) => assignment.tags,
        ),
      ]);
    case "set_item_tags":
      return uniqueStrings(
        operation.assignments.flatMap((assignment) => assignment.tags),
      );
    default:
      return [];
  }
}

export function defaultActionDescriptorForTool(
  tool: AgentToolDefinition<any, any>,
): AgentToolActionDescriptor {
  if (tool.spec.name === "file_io") {
    return { kind: "artifact_state", capability: "file.write" };
  }
  if (tool.spec.name === "run_command") {
    return { kind: "execution_only", capability: "command.execute" };
  }
  if (tool.spec.name === "zotero_script") {
    return { kind: "execution_only", capability: "zotero.script" };
  }
  return {
    kind: "semantic_state",
    capability: "zotero.read",
    source:
      tool.spec.mutability === "write" ? "library_mutation" : "zotero_read",
  };
}

function inferDescriptor(
  tool: AgentToolDefinition<any, any>,
  input: unknown,
): AgentToolActionDescriptor {
  const described = tool.describeAction?.(input);
  if (described) return described;
  return defaultActionDescriptorForTool(tool);
}

function capabilityFor(
  descriptor: AgentToolActionDescriptor,
  operations: LibraryMutationOperation[],
): AgentActionCapability {
  return operations.length
    ? CAPABILITY_BY_OPERATION[operations[0].type] || descriptor.capability
    : descriptor.capability;
}

function requestedTargetsFor(
  descriptor: AgentToolActionDescriptor,
  operations: LibraryMutationOperation[],
  input: unknown,
): string[] {
  const itemTargets = operations.flatMap(operationItemIds).map(itemTarget);
  if (itemTargets.length) return uniqueStrings(itemTargets);
  if (
    descriptor.kind === "artifact_state" &&
    input &&
    typeof input === "object"
  ) {
    const filePath = (input as { filePath?: unknown }).filePath;
    return typeof filePath === "string" && filePath.trim()
      ? [`file:${filePath.trim()}`]
      : [];
  }
  return [];
}

function verifiedFactsForInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (record.mode === "full") return ["read_mode:full"];
  return record.delegateInput
    ? verifiedFactsForInput(record.delegateInput)
    : [];
}

function itemTags(item: Zotero.Item | null): string[] {
  const values = item?.getTags?.() || [];
  return values
    .map((entry: unknown) =>
      typeof entry === "string"
        ? entry
        : typeof (entry as { tag?: unknown })?.tag === "string"
          ? (entry as { tag: string }).tag
          : "",
    )
    .filter(Boolean);
}

function itemCollections(item: Zotero.Item | null): number[] {
  return uniqueNumbers(
    (item?.getCollections?.() || []).map((value: unknown) => Number(value)),
  );
}

function normalizeNoteText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)>\s?/g, "$1")
    .replace(/(^|\s)[+-]\s+/g, "$1")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type NoteWriteVerification =
  | { targets: string[]; reason?: never }
  | { targets: null; reason: string };

export function verifyNoteWriteTarget(
  descriptor: Extract<AgentToolActionDescriptor, { kind: "semantic_state" }>,
  content: unknown,
  gateway: ActionContractGateway,
): NoteWriteVerification {
  const action = descriptor.action;
  if (action?.kind !== "note_write") {
    return { targets: null, reason: "The tool has no note-write descriptor." };
  }
  const result = nestedOperationResult(content);
  const noteId = Number(result?.noteId);
  if (!(noteId > 0)) {
    return {
      targets: null,
      reason: "The note mutation returned no stable note ID to verify.",
    };
  }
  const note = noteId > 0 ? gateway.getItem(noteId) : null;
  if (!note) {
    return {
      targets: null,
      reason: `Created note ${noteId} was not readable from Zotero state immediately after mutation.`,
    };
  }
  if (note.isNote?.() !== true || Boolean(note.deleted)) {
    return {
      targets: null,
      reason: `Zotero item ${noteId} is not a live note after mutation.`,
    };
  }
  if (action.targetNoteId && Number(action.targetNoteId) !== Number(note.id)) {
    return {
      targets: null,
      reason: `The mutation affected note ${note.id}, not requested note ${action.targetNoteId}.`,
    };
  }
  if (
    action.mode === "create" &&
    action.targetItemId &&
    Number(note.parentID) !== Number(action.targetItemId)
  ) {
    return {
      targets: null,
      reason: `Created note ${noteId} is not attached to requested item ${action.targetItemId}.`,
    };
  }
  if (
    action.destinationCollectionIds.length &&
    !action.destinationCollectionIds.every((collectionId) =>
      itemCollections(note).includes(collectionId),
    )
  ) {
    return {
      targets: null,
      reason: `Created note ${noteId} is missing one or more requested collection memberships.`,
    };
  }
  if (action.expectedText?.trim()) {
    const actual = normalizeNoteText(String(note.getNote?.() || ""));
    const expected = normalizeNoteText(action.expectedText);
    const textMatches =
      action.mode === "edit" ? actual === expected : actual.includes(expected);
    if (!textMatches) {
      return {
        targets: null,
        reason: `Stored content for note ${noteId} does not satisfy the requested note text.`,
      };
    }
  }
  return { targets: [itemTarget(noteId)] };
}

function assignmentTags(
  operation: Extract<LibraryMutationOperation, { type: "apply_tags" }>,
  itemId: number,
): string[] {
  return (
    operation.assignments?.find((entry) => entry.itemId === itemId)?.tags ||
    operation.tags ||
    []
  );
}

function moveTargetCollection(
  operation: Extract<LibraryMutationOperation, { type: "move_to_collection" }>,
  itemId: number,
): number | undefined {
  return (
    operation.assignments?.find((entry) => entry.itemId === itemId)
      ?.targetCollectionId || operation.targetCollectionId
  );
}

export function targetSatisfied(
  operation: LibraryMutationOperation,
  itemId: number,
  gateway: ActionContractGateway,
): boolean | null {
  const item = gateway.getItem(itemId);
  switch (operation.type) {
    case "apply_tags": {
      const actual = new Set(itemTags(item));
      return assignmentTags(operation, itemId).every((tag) => actual.has(tag));
    }
    case "remove_tags": {
      const actual = new Set(itemTags(item));
      return operation.tags.every((tag) => !actual.has(tag));
    }
    case "set_item_tags": {
      const expected = operation.assignments.find(
        (entry) => entry.itemId === itemId,
      )?.tags;
      if (!expected) return null;
      const actual = [...itemTags(item)].sort();
      return JSON.stringify(actual) === JSON.stringify([...expected].sort());
    }
    case "update_metadata": {
      const snapshot = gateway.getEditableArticleMetadata(item);
      if (!snapshot) return false;
      return Object.entries(operation.metadata).every(([field, value]) => {
        if (field === "creators") {
          return JSON.stringify(snapshot.creators) === JSON.stringify(value);
        }
        return snapshot.fields[field] === String(value ?? "");
      });
    }
    case "move_to_collection": {
      const target = moveTargetCollection(operation, itemId);
      if (!target) return null;
      const memberships = itemCollections(item);
      if (!memberships.includes(target)) return false;
      if (operation.mode !== "move") return true;
      return operation.from === "all"
        ? memberships.length === 1
        : !memberships.includes(Number(operation.from));
    }
    case "remove_from_collection":
      return !itemCollections(item).includes(operation.collectionId);
    case "set_item_collections": {
      const expected = operation.assignments.find(
        (entry) => entry.itemId === itemId,
      )?.collectionIds;
      if (!expected) return null;
      return (
        JSON.stringify(itemCollections(item).sort()) ===
        JSON.stringify([...expected].sort())
      );
    }
    case "trash_items":
      return Boolean(
        (item as (Zotero.Item & { deleted?: boolean }) | null)?.deleted,
      );
    case "restore_from_trash":
      return item
        ? !(item as Zotero.Item & { deleted?: boolean }).deleted
        : false;
    case "delete_attachment":
      return (
        !item || Boolean((item as Zotero.Item & { deleted?: boolean }).deleted)
      );
    case "rename_attachment": {
      if (!item) return false;
      const attachment = item as Zotero.Item & {
        getFilename?: () => string;
      };
      return (
        attachment.getFilename?.() === operation.newName ||
        attachment.getField?.("title") === operation.newName
      );
    }
    case "relink_attachment": {
      if (!item) return false;
      const actualPath = (
        item as Zotero.Item & { getFilePath?: () => string | false }
      ).getFilePath?.();
      return actualPath === operation.newPath;
    }
    default:
      return null;
  }
}

export function targetSatisfiedFromResult(
  operation: LibraryMutationOperation,
  itemId: number,
  content: unknown,
  gateway: ActionContractGateway,
): boolean | null {
  const result = nestedOperationResult(content);
  if (!result) return null;
  if (operation.type === "save_notes_batch") {
    const notes = Array.isArray(result.notes) ? result.notes : [];
    const row = notes.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        Number((entry as { targetItemId?: unknown }).targetItemId) === itemId,
    ) as { status?: unknown; noteId?: unknown } | undefined;
    const noteId = Number(row?.noteId);
    return row?.status === "created" && noteId > 0
      ? Boolean(gateway.getItem(noteId))
      : false;
  }
  return null;
}

export function createdSemanticTargets(
  operations: LibraryMutationOperation[],
  content: unknown,
  gateway: ActionContractGateway,
): string[] | null {
  if (operations.length !== 1) return null;
  const operation = operations[0];
  const result = nestedOperationResult(content);
  if (!result) return null;
  if (operation.type === "save_note") {
    const noteId = Number(result.noteId);
    if (!noteId || !gateway.getItem(noteId)) return null;
    const expectedCollections = operation.collections || [];
    if (
      expectedCollections.length &&
      !expectedCollections.every((collectionId) =>
        itemCollections(gateway.getItem(noteId)).includes(collectionId),
      )
    ) {
      return null;
    }
    return [itemTarget(noteId)];
  }
  if (operation.type === "create_items") {
    const rows = Array.isArray(result.items) ? result.items : [];
    const itemIds = rows
      .filter(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { status?: unknown }).status === "created",
      )
      .map((row) => Number((row as { itemId?: unknown }).itemId))
      .filter((itemId) => itemId > 0 && Boolean(gateway.getItem(itemId)));
    return itemIds.length === operation.items.length
      ? itemIds.map(itemTarget)
      : null;
  }
  if (operation.type === "import_identifiers") {
    const itemIds = Array.isArray(result.itemIds)
      ? result.itemIds
          .map(Number)
          .filter((itemId) => itemId > 0 && Boolean(gateway.getItem(itemId)))
      : [];
    if (itemIds.length !== operation.identifiers.length) return null;
    if (
      operation.targetCollectionId &&
      !itemIds.every((itemId) =>
        itemCollections(gateway.getItem(itemId)).includes(
          operation.targetCollectionId!,
        ),
      )
    ) {
      return null;
    }
    return itemIds.map(itemTarget);
  }
  if (operation.type === "import_local_files") {
    const rows = Array.isArray(result.items) ? result.items : [];
    const itemIds = rows
      .filter(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { status?: unknown }).status === "imported",
      )
      .map((row) => Number((row as { itemId?: unknown }).itemId))
      .filter((itemId) => itemId > 0 && Boolean(gateway.getItem(itemId)));
    if (itemIds.length !== operation.filePaths.length) return null;
    if (
      operation.targetCollectionId &&
      !itemIds.every((itemId) =>
        itemCollections(gateway.getItem(itemId)).includes(
          operation.targetCollectionId!,
        ),
      )
    ) {
      return null;
    }
    return itemIds.map(itemTarget);
  }
  return null;
}

export function prepareActionExecution(
  tool: AgentToolDefinition<any, any>,
  input: unknown,
  gateway: ActionContractGateway,
): PreparedActionExecution {
  const descriptor = inferDescriptor(tool, input);
  const operations = extractLibraryMutationOperations(input);
  const capability = capabilityFor(descriptor, operations);
  const noteAction =
    descriptor.kind === "semantic_state" &&
    descriptor.action?.kind === "note_write"
      ? descriptor.action
      : null;
  const requestedTargets = requestedTargetsFor(descriptor, operations, input);
  if (!requestedTargets.length && noteAction) {
    const noteTargetId =
      noteAction.targetNoteId ||
      (noteAction.mode === "create" ? noteAction.targetItemId : undefined);
    if (noteTargetId) requestedTargets.push(itemTarget(noteTargetId));
  }
  const destinationCollectionIds = uniqueNumbers([
    ...operations.flatMap(operationDestinationCollectionIds),
    ...(noteAction?.destinationCollectionIds || []),
  ]);
  const verifiedFacts = verifiedFactsForInput(input);
  const alreadySatisfiedTargets: string[] = [];
  for (const target of requestedTargets) {
    const itemId = targetItemId(target);
    if (!itemId) continue;
    const relevant = operations.filter((operation) =>
      operationItemIds(operation).includes(itemId),
    );
    if (
      relevant.length &&
      relevant.every(
        (operation) => targetSatisfied(operation, itemId, gateway) === true,
      )
    ) {
      alreadySatisfiedTargets.push(target);
    }
  }
  return {
    descriptor,
    capability,
    operations,
    requestedTargets,
    destinationCollectionIds,
    alreadySatisfiedTargets,
    verifiedFacts,
  };
}
