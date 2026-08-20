/**
 * Which library writes can be taken back, and therefore which ones need to be
 * asked about first.
 *
 * The agent used to confirm every write. One request that created a
 * collection and filed a paper into it raised two cards; a three-step request
 * raised three. That is a wizard, not an agent — and it stopped buying much
 * safety once Stages 0–6 gave every reversible write a journalled, working
 * inverse. So the burden is now proportional to reversibility.
 *
 * The list below is an ALLOWLIST of operations known to record a working
 * inverse, verified by the workflow suite against a real Zotero library.
 * Anything not on it confirms. That direction matters: a new write tool added
 * later is treated as irreversible until someone deliberately says otherwise,
 * so forgetting to update this file costs a confirmation prompt rather than a
 * user's data.
 */

/**
 * Tools whose ordinary validated outcomes are journalled with a serialized
 * inverse that survives restart. Input-specific exceptions are handled below.
 *
 * Some of these can still be irreversible for particular inputs — a
 * collection delete with `permanent: true`, a library-wide tag delete — which
 * `isIrreversibleWrite` handles per input below.
 */
const REVERSIBLE_TOOLS = new Set([
  // Collections and membership
  "manage_collections",
  "collection_update",
  "move_to_collection",
  "library_update",
  // Items
  "create_items",
  "reparent_items",
  "relate_items",
  "update_metadata",
  "apply_tags",
  "set_item_tags",
  // Renaming a tag is reversible. Merge/delete/colour exceptions are caught
  // from the validated operation below.
  "tag_update",
  // Notes
  "note_write",
  "note_write_batch",
  "write_notes_batch",
  // Trash is itself the undo-friendly path. `library_delete` is the facade
  // the model actually calls; its irreversible mode ('merge') is caught by
  // the per-input check below rather than by omitting the whole tool.
  "trash_items",
  "restore_from_trash",
  "library_delete",
  // Attachments: rename and relink record inverses; delete trashes
  "manage_attachments",
  "attachment_update",
  // Import adds; the inverse trashes what it added
  "import_identifiers",
  "import_local_files",
  "library_import",
  // Saved searches trash rather than erase
  "saved_search_update",
  // Undo/revert are themselves the recovery mechanism
  "undo_last_action",
  "revert_changes",
]);

/**
 * The shapes a flag can arrive in.
 *
 * This layer runs on the tool's VALIDATED input, and `validate()` reshapes
 * the model's arguments: `collection_update` turns
 * `{action:'delete', permanent:true}` into
 * `{operation:{type:'delete_collection', permanent:true}}`, and the
 * delegating facades strip `kind` before handing off. Reading only the top
 * level therefore missed `permanent` entirely and let a permanent erase
 * through with no confirmation — found by driving the real UI, because every
 * test until then fed this function the shape it expected rather than the
 * shape it gets.
 */
function candidateRecords(input: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: input, depth: 0 },
  ];
  const seen = new Set<object>();
  while (pending.length) {
    const { value, depth } = pending.shift()!;
    if (
      depth > 4 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    records.push(record);
    pending.push(
      { value: record.delegateInput, depth: depth + 1 },
      { value: record.operation, depth: depth + 1 },
    );
  }
  return records;
}

function readString(source: unknown, key: string): string {
  for (const record of candidateRecords(source)) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function readBoolean(source: unknown, key: string): boolean {
  return candidateRecords(source).some((record) => record[key] === true);
}

/**
 * Whether this specific call cannot be undone, and so must be confirmed even
 * in `auto` mode.
 *
 * Each case here is one where the inverse genuinely does not exist, not one
 * where it was merely inconvenient to write:
 *
 * - a permanent erase records no undo by design
 * - deleting a tag library-wide discards which items carried it, so restoring
 *   the tag would not restore the assignments
 * - a merge moves children onto the survivor and deduplicates attachments by
 *   hash, so the originals no longer exist to give back
 * - a script or a shell command can do anything, including things this layer
 *   cannot model
 */
export function isIrreversibleWrite(toolName: string, input: unknown): boolean {
  // Anything the layer does not recognise is treated as irreversible.
  if (!REVERSIBLE_TOOLS.has(toolName)) return true;

  if (readBoolean(input, "permanent")) return true;

  const action = readString(input, "action");
  const kind = readString(input, "kind");
  const mode = readString(input, "mode");
  const operationType = readString(input, "type");

  // The tag *object*, not tags on items: library_update kind:'tag' delete.
  if (
    kind === "tag" &&
    (action === "delete" || action === "merge" || action === "setColor")
  ) {
    return true;
  }
  // The dedicated tag tool, same operation.
  if (
    (toolName === "tag_update" || operationType === "update_library_tag") &&
    (action === "merge" || action === "setColor")
  ) {
    return true;
  }
  if (
    (toolName === "tag_update" || operationType === "update_library_tag") &&
    action === "delete"
  ) {
    return true;
  }
  // Replacing a saved search discards its previous condition set. Creating a
  // new one and trashing one both have durable inverses.
  if (
    toolName === "saved_search_update" &&
    operationType === "save_saved_search" &&
    candidateRecords(input).some((record) => Number(record.savedSearchId) > 0)
  ) {
    return true;
  }
  // A missing linked file has no previous path to restore after relinking.
  if (
    (toolName === "attachment_update" && action === "relink") ||
    operationType === "relink_attachment"
  ) {
    return true;
  }
  // Merging is not fully reversible; restoring the duplicates returns records
  // stripped of their attachments, notes and tags.
  if (mode === "merge" || operationType === "merge_items") return true;

  return false;
}

/**
 * Whether a write needs a confirmation card, given the user's chosen mode.
 */
export function writeNeedsConfirmation(params: {
  mode: "auto" | "safe" | "yolo";
  toolName: string;
  input: unknown;
}): boolean {
  // Restart recovery is intentionally user-steered even in yolo mode. A
  // checkpoint proves where execution stopped, not that replaying the
  // remaining external/model work is still what the user wants.
  if (
    params.toolName === "library_batch" &&
    candidateRecords(params.input).some(
      (record) =>
        record.kind === "resume" ||
        (typeof record.resumeJobId === "string" && record.resumeJobId.trim()),
    )
  ) {
    return true;
  }
  if (params.mode === "safe") return true;
  if (params.mode === "yolo") return false;
  return isIrreversibleWrite(params.toolName, params.input);
}
