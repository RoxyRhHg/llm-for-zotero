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
    finalizeTurn: (entry) =>
      finalizeQueuedTurnDeletion(entry, {
        log: safeLog,
        scheduleAttachmentGc,
      }),
  });
}

export function resetPendingDeletionSubsystemForTests(): void {
  configured = false;
}
