import { configurePendingDeletionFinalizers } from "../../core/conversations/pendingDeletionStore";
import {
  finalizeQueuedConversationDeletion,
  finalizeQueuedTurnDeletion,
} from "./conversationDeletion";
import { initAgentSubsystem } from "../../agent";

let configured = false;

// ztoolkit is an ambient plugin global; outside the plugin runtime (unit
// tests) it does not exist, so logging stays best-effort.
function safeLog(message: string, ...args: unknown[]): void {
  try {
    ztoolkit.log(message, ...args);
  } catch {
    /* logging is best-effort outside plugin runtime */
  }
}

export function configurePendingDeletionSubsystem(): void {
  if (configured) return;
  configured = true;
  configurePendingDeletionFinalizers({
    finalizeConversation: (entry) =>
      finalizeQueuedConversationDeletion(entry, {
        log: safeLog,
        getCoreAgentRuntime: initAgentSubsystem,
      }),
    finalizeTurn: (entry) =>
      finalizeQueuedTurnDeletion(entry, { log: safeLog }),
  });
}

export function resetPendingDeletionSubsystemForTests(): void {
  configured = false;
}
