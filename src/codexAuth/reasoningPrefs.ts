import { config } from "../../package.json";

const CODEX_DIRECT_REASONING_PREF_KEY = `${config.prefsPrefix}.codexDirectReasoningSelections`;

type ZoteroPrefsAPI = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

function getPrefs(): ZoteroPrefsAPI | undefined {
  return (Zotero as unknown as { Prefs?: ZoteroPrefsAPI } | undefined)?.Prefs;
}

function selectionKey(groupId: string, model: string): string {
  return `${groupId.trim()}\u0000${model.trim().toLowerCase()}`;
}

function readSelections(): Record<string, string> {
  const raw = getPrefs()?.get?.(CODEX_DIRECT_REASONING_PREF_KEY, true);
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const selections: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        selections[key] = value.trim();
      }
    }
    return selections;
  } catch (_error) {
    return {};
  }
}

export function getCodexDirectReasoningSelection(
  groupId: string,
  model: string,
): string {
  return readSelections()[selectionKey(groupId, model)] || "auto";
}

export function setCodexDirectReasoningSelection(
  groupId: string,
  model: string,
  selection: string,
): void {
  const key = selectionKey(groupId, model);
  const value = selection.trim() || "auto";
  const selections = readSelections();
  if (selections[key] === value) return;
  selections[key] = value;
  getPrefs()?.set?.(
    CODEX_DIRECT_REASONING_PREF_KEY,
    JSON.stringify(selections),
    true,
  );
}
