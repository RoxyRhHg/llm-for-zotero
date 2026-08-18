import { config } from "../../package.json";
import {
  normalizeAgentLibraryWriteMode,
  type AgentLibraryWriteMode,
} from "../shared/agentLibraryWriteMode";

const PREF_KEY = `${config.prefsPrefix}.agentLibraryWriteMode`;

/**
 * Reads the in-plugin agent's library write mode.
 *
 * Defaults to `safe` on anything unreadable — a missing or corrupt pref must
 * never be the reason an unattended whole-library rewrite is permitted.
 */
export function getAgentLibraryWriteMode(): AgentLibraryWriteMode {
  try {
    const raw = (
      Zotero as unknown as {
        Prefs?: { get?: (key: string, global?: boolean) => unknown };
      }
    ).Prefs?.get?.(PREF_KEY, true);
    return normalizeAgentLibraryWriteMode(
      typeof raw === "string" ? raw.trim().toLowerCase() : raw,
    );
  } catch {
    return "safe";
  }
}

export function setAgentLibraryWriteMode(mode: AgentLibraryWriteMode): void {
  try {
    (
      Zotero as unknown as {
        Prefs?: { set?: (key: string, value: unknown, global?: boolean) => void };
      }
    ).Prefs?.set?.(PREF_KEY, mode === "yolo" ? "yolo" : "safe", true);
  } catch {
    /* a pref we cannot write is not worth failing a turn over */
  }
}
