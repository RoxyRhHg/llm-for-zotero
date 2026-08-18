/**
 * Focused facade tool for creating and deleting Zotero collections (folders).
 * Provides a self-describing schema for managing Zotero collections.
 */
import type { AgentToolDefinition } from "../../types";
import {
  LibraryMutationService,
  type CreateCollectionOperation,
  type DeleteCollectionOperation,
} from "../../services/libraryMutationService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject, normalizePositiveInt } from "../shared";
import { executeAndRecordUndo } from "./mutateLibraryShared";

type ManageCollectionsInput = {
  operation: CreateCollectionOperation | DeleteCollectionOperation;
};

export function createManageCollectionsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<ManageCollectionsInput, unknown> {
  const mutationService = new LibraryMutationService(zoteroGateway);

  return {
    spec: {
      name: "manage_collections",
      description:
        "Create or delete Zotero collections (folders). Deleting moves the collection to the Zotero trash, where the user can restore it, and takes any subcollections with it.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["create", "delete"],
            description: "Whether to create or delete a collection.",
          },
          name: {
            type: "string",
            description: "Collection name (required for 'create').",
          },
          parentCollectionId: {
            type: "number",
            description: "Parent collection for nested creation.",
          },
          collectionId: {
            type: "number",
            description: "Collection ID to delete (required for 'delete').",
          },
          deleteItems: {
            type: "boolean",
            description:
              "For 'delete': also move the collection's items to the trash. Defaults to false, which leaves the items in the library, matching Zotero's own 'Delete Collection'.",
          },
          permanent: {
            type: "boolean",
            description:
              "For 'delete': erase permanently instead of trashing. This cannot be undone, so only use it when the user has explicitly asked to delete permanently.",
          },
          libraryID: {
            type: "number",
            description: "Library ID (for group libraries).",
          },
        },
        required: ["action"],
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Manage Collections",
      summaries: {
        onCall: "Preparing collection changes",
        onPending: "Waiting for confirmation on collection changes",
        onApproved: "Applying collection changes",
        onDenied: "Collection changes cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          const resultInner =
            result.result && typeof result.result === "object"
              ? (result.result as Record<string, unknown>)
              : {};
          const name = String(resultInner.name || result.name || "");
          return name ? `Collection "${name}" updated` : "Collection updated";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with an action. Example: { action: "create", name: "My Collection" }',
        );
      }

      const action = args.action;

      if (action === "create") {
        const name =
          typeof args.name === "string" && args.name.trim()
            ? args.name.trim()
            : "";
        if (!name) {
          return fail(
            'action "create" requires a name. Example: { action: "create", name: "Machine Learning" }',
          );
        }
        const operation: CreateCollectionOperation = {
          type: "create_collection",
          name,
          parentCollectionId: normalizePositiveInt(args.parentCollectionId),
          libraryID: normalizePositiveInt(args.libraryID),
        };
        return ok({ operation });
      }

      if (action === "delete") {
        const collectionId = normalizePositiveInt(args.collectionId);
        if (!collectionId) {
          return fail(
            'action "delete" requires a collectionId. Example: { action: "delete", collectionId: 42 }',
          );
        }
        const operation: DeleteCollectionOperation = {
          type: "delete_collection",
          collectionId,
          deleteItems: args.deleteItems === true,
          permanent: args.permanent === true,
        };
        return ok({ operation });
      }

      return fail(
        'action must be "create" or "delete". Example: { action: "create", name: "My Folder" }',
      );
    },

    createPendingAction(input) {
      const operation = input.operation;

      if (operation.type === "create_collection") {
        const parentSummary = operation.parentCollectionId
          ? zoteroGateway.getCollectionSummary(operation.parentCollectionId)
          : null;
        const parentLabel = parentSummary
          ? parentSummary.path || parentSummary.name
          : null;
        const description = parentLabel
          ? `Create collection "${operation.name}" inside "${parentLabel}".`
          : `Create top-level collection "${operation.name}".`;

        return {
          toolName: "manage_collections",
          title: "Create collection",
          description,
          confirmLabel: "Create",
          cancelLabel: "Cancel",
          fields: [
            {
              type: "text" as const,
              id: "description",
              label: "Action",
              value: description,
            },
          ],
        };
      }

      // delete_collection
      const collection = zoteroGateway.getCollectionSummary(
        operation.collectionId,
      );
      const collectionLabel = collection
        ? collection.path || collection.name
        : `Collection ${operation.collectionId}`;
      // The card has to be exact about what is destroyed: this used to promise
      // items were safe and the delete was undoable while calling `eraseTx`,
      // which permanently erased the collection and every subcollection.
      const snapshot = zoteroGateway.snapshotCollectionForDelete({
        collectionId: operation.collectionId,
      });
      const subcollectionCount = snapshot?.childCollectionCount ?? 0;
      const subcollectionNote = subcollectionCount
        ? ` Its ${subcollectionCount} subcollection${subcollectionCount === 1 ? "" : "s"} will go with it.`
        : "";
      const itemsNote = operation.deleteItems
        ? " The items it contains will be moved to the trash as well."
        : " The items it contains will stay in your library.";
      const description = operation.permanent
        ? `Permanently erase collection "${collectionLabel}".${subcollectionNote}${itemsNote} This cannot be undone.`
        : `Move collection "${collectionLabel}" to the Zotero trash.${subcollectionNote}${itemsNote} You can restore it from the trash, or undo this.`;

      return {
        toolName: "manage_collections",
        title: operation.permanent
          ? "Permanently erase collection"
          : "Delete collection",
        description,
        confirmLabel: operation.permanent ? "Erase permanently" : "Delete",
        cancelLabel: "Cancel",
        fields: [
          {
            type: "text" as const,
            id: "description",
            label: "Action",
            value: description,
          },
        ],
      };
    },

    applyConfirmation(input, _resolutionData) {
      // Text fields are read-only; pass through unchanged
      return ok(input);
    },

    async execute(input, context) {
      return executeAndRecordUndo(
        mutationService,
        input.operation,
        context,
        "manage_collections",
      );
    },
  };
}
