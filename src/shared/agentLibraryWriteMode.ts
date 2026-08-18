/**
 * How much the in-plugin agent may change the Zotero library without asking.
 *
 * This is deliberately a SEPARATE key from `agentPermissionMode`. That one's
 * on-screen help text promises users it "affects Claude Code's bridge
 * permission mode only; Zotero MCP and tool-specific safety checks can still
 * require confirmation" — a promise the MCP path still keeps. Reusing the
 * stored value would silently convert consent given for bash prompting into
 * consent for unattended whole-library rewrites.
 *
 * - `safe`   — every library write is reviewed. Batch jobs pause per page.
 * - `yolo`   — the model's judgement decides. Batch jobs run to completion
 *              without per-page review. Nothing about this makes a write
 *              unrecoverable: every run is journalled with its inverse, and
 *              the checkpoint panel can revert it.
 */
export type AgentLibraryWriteMode = "safe" | "yolo";

export function normalizeAgentLibraryWriteMode(
  value: unknown,
): AgentLibraryWriteMode {
  return value === "yolo" ? "yolo" : "safe";
}

export function getAgentLibraryWriteModeDescription(): string {
  return "safe reviews every library change before it happens, and batch jobs pause on each page. yolo lets the agent apply changes on its own judgement, including whole-library batch jobs — every run is still recorded and can be reverted from the agent history.";
}
