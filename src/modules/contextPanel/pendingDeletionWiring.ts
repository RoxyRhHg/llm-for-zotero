import { configurePendingDeletionFinalizers } from "../../core/conversations/pendingDeletionStore";
import {
  finalizeQueuedConversationDeletion,
  finalizeQueuedTurnDeletion,
} from "./conversationDeletion";
import { initAgentSubsystem } from "../../agent";
import {
  ATTACHMENT_GC_MIN_AGE_MS,
  collectAndDeleteUnreferencedBlobs,
} from "../../utils/attachmentRefStore";

let configured = false;
let forcedTurnFinalizeFailures = 0;

// Test-only: make the next N queued-turn finalize attempts fail so workflow
// tests can drive the failed-finalize path through the real runtime.
export function forcePendingTurnFinalizeFailuresForTests(count: number): void {
  forcedTurnFinalizeFailures = Math.max(0, Math.floor(count));
}

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
  const scheduleAttachmentGc = () => {
    void collectAndDeleteUnreferencedBlobs(ATTACHMENT_GC_MIN_AGE_MS).catch(
      (err) => safeLog("LLM: attachment GC after queued deletion failed", err),
    );
  };
  configurePendingDeletionFinalizers({
    finalizeConversation: (entry) =>
      finalizeQueuedConversationDeletion(entry, {
        log: safeLog,
        getCoreAgentRuntime: initAgentSubsystem,
        scheduleAttachmentGc,
      }),
    finalizeTurn: async (entry) => {
      if (forcedTurnFinalizeFailures > 0) {
        forcedTurnFinalizeFailures -= 1;
        safeLog("LLM: workflow-test forced turn finalize failure", entry.id);
        return false;
      }
      return finalizeQueuedTurnDeletion(entry, {
        log: safeLog,
        scheduleAttachmentGc,
      });
    },
  });
}

export function resetPendingDeletionSubsystemForTests(): void {
  configured = false;
}
