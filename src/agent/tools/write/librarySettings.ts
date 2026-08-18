/**
 * Zotero preferences and sync state.
 *
 * The whole settings domain scored zero covered operations in the census, so
 * "stop adding automatic tags" or "sort my notes by date" had no path.
 *
 * Deliberately an allowlist rather than open access to `Zotero.Prefs`: that
 * tree also holds sync credentials, the data directory and proxy settings,
 * and an agent able to rewrite those can lock a user out of their own
 * library.
 */
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { ok, fail, validateObject } from "../shared";

type LibrarySettingsInput = {
  action: "list" | "set" | "syncStatus";
  key?: string;
  value?: unknown;
};

export function createLibrarySettingsTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<LibrarySettingsInput, unknown> {
  return {
    spec: {
      name: "library_settings",
      description:
        "Read or change Zotero preferences the agent is allowed to touch, and check sync status. Use action:'list' first — it returns each setting with its current value and what it does.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["list", "set", "syncStatus"],
          },
          key: {
            type: "string",
            description:
              "The preference to change, for action:'set'. Must be one of those returned by action:'list'.",
          },
          value: {
            description: "The new value, for action:'set'.",
          },
        },
      },
      mutability: "write",
      requiresConfirmation: true,
    },

    presentation: {
      label: "Library Settings",
      summaries: {
        onCall: "Reading Zotero settings",
        onPending: "Waiting for confirmation on a settings change",
        onApproved: "Changing setting",
        onDenied: "Settings change cancelled",
        onSuccess: ({ content }) => {
          const result =
            content && typeof content === "object"
              ? (content as Record<string, unknown>)
              : {};
          if (Array.isArray(result.settings)) {
            return `Listed ${result.settings.length} settings`;
          }
          if (result.status === "updated") {
            return `Changed ${String(result.key)}`;
          }
          if (result.status === "refused") {
            return `Refused: ${String(result.reason || "not permitted")}`;
          }
          return "Settings unchanged";
        },
      },
    },

    validate(args: unknown) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail(
          'Expected an object with an action, e.g. { action: "list" }',
        );
      }
      const action = args.action;
      if (action !== "list" && action !== "set" && action !== "syncStatus") {
        return fail("action must be one of: list, set, syncStatus");
      }
      if (action === "set") {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        if (!key) {
          return fail(
            'action "set" requires a key. Call { action: "list" } to see which settings can be changed.',
          );
        }
        if (args.value === undefined) {
          return fail('action "set" requires a value.');
        }
        return ok<LibrarySettingsInput>({ action, key, value: args.value });
      }
      return ok<LibrarySettingsInput>({ action });
    },

    // Reading settings changes nothing, so only a write needs approval.
    shouldRequireConfirmation: (input) => input.action === "set",

    createPendingAction(input) {
      const current = zoteroGateway
        .listSettings()
        .find((entry) => entry.key === input.key);
      const description = current
        ? `Change "${current.description}" (${input.key}) from ${JSON.stringify(current.value)} to ${JSON.stringify(input.value)}.`
        : `Change the Zotero preference ${input.key} to ${JSON.stringify(input.value)}.`;
      return {
        toolName: "library_settings",
        title: "Change a Zotero setting",
        description,
        confirmLabel: "Change",
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

    applyConfirmation(input) {
      return ok(input);
    },

    async execute(input) {
      if (input.action === "list") {
        return { settings: zoteroGateway.listSettings() };
      }
      if (input.action === "syncStatus") {
        return zoteroGateway.getSyncStatus();
      }
      return zoteroGateway.updateSetting({
        key: input.key as string,
        value: input.value,
      });
    },
  };
}
