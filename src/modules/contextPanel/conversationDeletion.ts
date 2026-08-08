import type { ConversationSystem } from "../../shared/types";
import {
  activeGlobalConversationByLibrary,
  activePaperConversationByPaper,
  chatHistory,
  getAbortController,
  getPendingRequestId,
  loadedConversationKeys,
  selectedModelCache,
  selectedReasoningCache,
  selectedReasoningProviderCache,
  setAbortController,
  setCancelledRequestId,
  setPendingRequestId,
} from "./state";
import { clearConversationSummary as clearConversationSummaryFromCache } from "./conversationSummaryCache";
import {
  conversationRepository,
  type ConversationCatalogEntry,
} from "../../core/conversations/repository";
import {
  buildPaperStateKey,
  getLastUsedUpstreamGlobalConversationKey,
  getLastUsedPaperConversationKey,
  getLockedGlobalConversationKey,
  removeLastUsedUpstreamGlobalConversationKey,
  removeLastUsedPaperConversationKey,
  setLockedGlobalConversationKey,
} from "./prefHelpers";
import {
  clearOwnerAttachmentRefs,
  replaceOwnerAttachmentRefs,
} from "../../utils/attachmentRefStore";
import type {
  PendingConversationDeletionEntry,
  PendingFinalizeOutcome,
  PendingTurnDeletionEntry,
} from "../../core/conversations/pendingDeletionStore";
import type { Message } from "./types";
import {
  collectAttachmentHashesFromMessages,
  findTurnPairByTimestamps,
} from "./turnMessageUtils";
import { removeConversationAttachmentFiles } from "./attachmentStorage";
import {
  buildClaudeScope,
  invalidateClaudeConversationSession,
} from "../../claudeCode/runtime";
import {
  activeClaudeGlobalConversationByLibrary,
  activeClaudePaperConversationByPaper,
  buildClaudeLibraryStateKey,
  buildClaudePaperStateKey,
} from "../../claudeCode/state";
import {
  getLastUsedClaudeGlobalConversationKey,
  getLastUsedClaudePaperConversationKey,
  removeLastUsedClaudeGlobalConversationKey,
  removeLastUsedClaudePaperConversationKey,
} from "../../claudeCode/prefs";
import { getRegisteredConversationScope } from "../../shared/conversationRegistry";
import { archiveCodexAppServerThread } from "../../codexAppServer/nativeClient";
import {
  activeCodexGlobalConversationByLibrary,
  activeCodexPaperConversationByPaper,
  buildCodexLibraryStateKey,
  buildCodexPaperStateKey,
} from "../../codexAppServer/state";
import {
  getLastUsedCodexGlobalConversationKey,
  getLastUsedCodexPaperConversationKey,
  removeLastUsedCodexGlobalConversationKey,
  removeLastUsedCodexPaperConversationKey,
} from "../../codexAppServer/prefs";
import {
  clearAgentConversationState,
  clearDeletedAgentConversationState,
} from "./agentConversationCleanup";
import { resolveConversationRefForKey } from "../../shared/conversationRef";
import {
  getConversationScopeValidationDetails,
  type ConversationRegistryRow,
  type ConversationScopeValidationDetails,
} from "../../shared/conversationRegistry";

type ConversationDeletionKind = "global" | "paper";

export type ConversationDeletionTarget = {
  conversationID?: string;
  conversationKey: number;
  kind: ConversationDeletionKind;
  conversationSystem: ConversationSystem;
  libraryID: number;
  paperItemID?: number;
  providerSessionId?: string | null;
};

export type ConversationDeletionIssueCode =
  | "cancel_pending_request"
  | "runtime_cache"
  | "agent_state"
  | "claude_session"
  | "codex_thread_archive"
  | "message_rows"
  | "attachment_refs"
  | "attachment_files"
  | "catalog_row"
  | "remembered_selection"
  | "attachment_gc";

export type ConversationDeletionIssue = {
  code: ConversationDeletionIssueCode;
  message: string;
  error?: unknown;
};

export type ConversationDeletionResult = {
  ok: boolean;
  blocked: boolean;
  errors: ConversationDeletionIssue[];
  warnings: ConversationDeletionIssue[];
};

type ConversationDeletionOperations = {
  preflightDeleteLocalConversationRows: (
    target: ConversationDeletionTarget,
  ) => Promise<void>;
  deleteLocalConversationRows: (
    target: ConversationDeletionTarget,
  ) => Promise<void>;
  clearOwnerAttachmentRefs: typeof clearOwnerAttachmentRefs;
  removeConversationAttachmentFiles: typeof removeConversationAttachmentFiles;
  archiveCodexThread: (threadId: string) => Promise<void>;
  invalidateClaudeConversation: (
    conversationKey: number,
    target: ConversationDeletionTarget,
  ) => Promise<void>;
  clearRememberedSelection: (target: ConversationDeletionTarget) => void;
};

export type ConversationDeletionDeps = {
  log?: (message: string, ...args: unknown[]) => void;
  cancelPendingRequest?: (conversationKey: number) => void;
  clearTransientComposeStateForItem?: (itemId: number) => void;
  resetSessionTokens?: (conversationKey: number) => void;
  scheduleAttachmentGc?: () => void;
  getCoreAgentRuntime?: () => unknown | Promise<unknown>;
  clearAgentToolCaches?: (conversationKey: number) => void;
  clearAgentConversationState?: (conversationKey: number) => Promise<void>;
  operations?: Partial<ConversationDeletionOperations>;
};

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeProviderSessionId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConversationID(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createResult(): ConversationDeletionResult {
  return {
    ok: true,
    blocked: false,
    errors: [],
    warnings: [],
  };
}

export function getConversationDeletionFailureMessage(
  result: Pick<ConversationDeletionResult, "blocked" | "errors">,
): string {
  if (result.errors.some((issue) => issue.code === "catalog_row")) {
    return "Failed to delete conversation because its saved identity is inconsistent. Check logs.";
  }
  if (
    result.blocked &&
    result.errors.some(
      (issue) =>
        issue.code === "codex_thread_archive" || issue.code === "message_rows",
    )
  ) {
    return "Failed to delete conversation. Codex thread was not archived.";
  }
  return "Failed to fully delete conversation. Check logs.";
}

function defaultCancelPendingRequest(conversationKey: number): void {
  const pendingRequestId = getPendingRequestId(conversationKey);
  if (pendingRequestId <= 0) return;
  const ctrl = getAbortController(conversationKey);
  if (ctrl) ctrl.abort();
  setCancelledRequestId(conversationKey, pendingRequestId);
  setPendingRequestId(conversationKey, 0);
  setAbortController(conversationKey, null);
}

function clearSharedRuntimeCaches(
  target: ConversationDeletionTarget,
  deps: ConversationDeletionDeps,
): void {
  const conversationKey = normalizePositiveInt(target.conversationKey);
  if (!conversationKey) return;
  chatHistory.delete(conversationKey);
  loadedConversationKeys.delete(conversationKey);
  selectedModelCache.delete(conversationKey);
  selectedReasoningCache.delete(conversationKey);
  selectedReasoningProviderCache.delete(conversationKey);
  deps.resetSessionTokens?.(conversationKey);
  const composeStateKey =
    target.kind === "paper"
      ? normalizePositiveInt(target.paperItemID)
      : conversationKey;
  if (composeStateKey) {
    deps.clearTransientComposeStateForItem?.(composeStateKey);
  }
  clearConversationSummaryFromCache(conversationKey);
}

function buildOperations(
  deps: ConversationDeletionDeps,
): ConversationDeletionOperations {
  return {
    preflightDeleteLocalConversationRows: async (target) => {
      await conversationRepository.preflightDeleteLocalConversationRows({
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
      });
    },
    deleteLocalConversationRows: async (target) => {
      await conversationRepository.deleteLocalConversationRows({
        system: target.conversationSystem,
        kind: target.kind,
        conversationKey: target.conversationKey,
      });
    },
    clearOwnerAttachmentRefs,
    removeConversationAttachmentFiles,
    archiveCodexThread: (threadId) => archiveCodexAppServerThread({ threadId }),
    invalidateClaudeConversation: async (conversationKey, target) => {
      if (!deps.getCoreAgentRuntime) {
        return;
      }
      await invalidateClaudeConversationSession(
        (await deps.getCoreAgentRuntime()) as any,
        {
          conversationKey,
          scope: buildClaudeScope({
            libraryID: target.libraryID,
            kind: target.kind,
            paperItemID: target.paperItemID,
          }),
        },
      );
    },
    clearRememberedSelection,
    ...deps.operations,
  };
}

function recordIssue(
  result: ConversationDeletionResult,
  list: "errors" | "warnings",
  issue: ConversationDeletionIssue,
  log?: (message: string, ...args: unknown[]) => void,
): void {
  result[list].push(issue);
  if (list === "errors") result.ok = false;
  if ("error" in issue) {
    log?.(issue.message, issue.error);
  } else {
    log?.(issue.message);
  }
}

function summarizeRegistryScope(
  scope: ConversationRegistryRow | null | undefined,
): Record<string, unknown> | null {
  if (!scope) return null;
  return {
    conversationID: scope.conversationID,
    conversationKey: scope.conversationKey,
    system: scope.system,
    kind: scope.kind,
    profileSignature: scope.profileSignature,
    libraryID: scope.libraryID,
    paperItemID: scope.paperItemID,
    valid: scope.valid,
    invalidReason: scope.invalidReason,
  };
}

function summarizeScopeValidationFailure(
  details: ConversationScopeValidationDetails,
): Record<string, unknown> {
  return {
    reason: details.reason || "unknown",
    target: summarizeRegistryScope(details.target),
    registered: summarizeRegistryScope(details.registered),
  };
}

function canCanonicalizeRegistryConversationID(
  details: ConversationScopeValidationDetails,
): boolean {
  const target = details.target;
  const registered = details.registered;
  if (
    details.reason !== "conversation_id_mismatch" ||
    !target ||
    !registered?.valid
  ) {
    return false;
  }
  return (
    registered.conversationKey === target.conversationKey &&
    registered.system === target.system &&
    registered.kind === target.kind &&
    registered.profileSignature === target.profileSignature &&
    registered.libraryID === target.libraryID &&
    (registered.paperItemID || null) === (target.paperItemID || null)
  );
}

async function runStep(
  result: ConversationDeletionResult,
  code: ConversationDeletionIssueCode,
  message: string,
  fn: () => void | Promise<void>,
  log?: (message: string, ...args: unknown[]) => void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    recordIssue(result, "errors", { code, message, error }, log);
  }
}

function clearRememberedSelection(target: ConversationDeletionTarget): void {
  const conversationKey = target.conversationKey;
  if (target.kind === "global") {
    if (target.conversationSystem === "claude_code") {
      const stateKey = buildClaudeLibraryStateKey(target.libraryID);
      if (
        Math.floor(
          Number(activeClaudeGlobalConversationByLibrary.get(stateKey) || 0),
        ) === conversationKey
      ) {
        activeClaudeGlobalConversationByLibrary.delete(stateKey);
      }
      const persistedKey = Number(
        getLastUsedClaudeGlobalConversationKey(target.libraryID) || 0,
      );
      if (
        Number.isFinite(persistedKey) &&
        Math.floor(persistedKey) === conversationKey
      ) {
        removeLastUsedClaudeGlobalConversationKey(target.libraryID);
      }
      return;
    }
    if (target.conversationSystem === "codex") {
      const stateKey = buildCodexLibraryStateKey(target.libraryID);
      if (
        Math.floor(
          Number(activeCodexGlobalConversationByLibrary.get(stateKey) || 0),
        ) === conversationKey
      ) {
        activeCodexGlobalConversationByLibrary.delete(stateKey);
      }
      const persistedKey = Number(
        getLastUsedCodexGlobalConversationKey(target.libraryID) || 0,
      );
      if (
        Number.isFinite(persistedKey) &&
        Math.floor(persistedKey) === conversationKey
      ) {
        removeLastUsedCodexGlobalConversationKey(target.libraryID);
      }
      return;
    }
    if (
      Math.floor(
        Number(activeGlobalConversationByLibrary.get(target.libraryID) || 0),
      ) === conversationKey
    ) {
      activeGlobalConversationByLibrary.delete(target.libraryID);
    }
    const persistedKey = Number(
      getLastUsedUpstreamGlobalConversationKey(target.libraryID) || 0,
    );
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === conversationKey
    ) {
      removeLastUsedUpstreamGlobalConversationKey(target.libraryID);
    }
    const lockedKey = getLockedGlobalConversationKey(target.libraryID);
    if (
      lockedKey !== null &&
      Number.isFinite(lockedKey) &&
      Math.floor(Number(lockedKey)) === conversationKey
    ) {
      setLockedGlobalConversationKey(target.libraryID, null);
    }
    return;
  }

  const paperItemID = normalizePositiveInt(target.paperItemID);
  if (!paperItemID) return;
  if (target.conversationSystem === "claude_code") {
    const stateKey = buildClaudePaperStateKey(target.libraryID, paperItemID);
    if (
      Math.floor(
        Number(activeClaudePaperConversationByPaper.get(stateKey) || 0),
      ) === conversationKey
    ) {
      activeClaudePaperConversationByPaper.delete(stateKey);
    }
    const persistedKey = Number(
      getLastUsedClaudePaperConversationKey(target.libraryID, paperItemID) || 0,
    );
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === conversationKey
    ) {
      removeLastUsedClaudePaperConversationKey(target.libraryID, paperItemID);
    }
    return;
  }
  if (target.conversationSystem === "codex") {
    const stateKey = buildCodexPaperStateKey(target.libraryID, paperItemID);
    if (
      Math.floor(
        Number(activeCodexPaperConversationByPaper.get(stateKey) || 0),
      ) === conversationKey
    ) {
      activeCodexPaperConversationByPaper.delete(stateKey);
    }
    const persistedKey = Number(
      getLastUsedCodexPaperConversationKey(target.libraryID, paperItemID) || 0,
    );
    if (
      Number.isFinite(persistedKey) &&
      Math.floor(persistedKey) === conversationKey
    ) {
      removeLastUsedCodexPaperConversationKey(target.libraryID, paperItemID);
    }
    return;
  }
  const stateKey = buildPaperStateKey(target.libraryID, paperItemID);
  if (
    Math.floor(Number(activePaperConversationByPaper.get(stateKey) || 0)) ===
    conversationKey
  ) {
    activePaperConversationByPaper.delete(stateKey);
  }
  const persistedKey = Number(
    getLastUsedPaperConversationKey(target.libraryID, paperItemID) || 0,
  );
  if (
    Number.isFinite(persistedKey) &&
    Math.floor(persistedKey) === conversationKey
  ) {
    removeLastUsedPaperConversationKey(target.libraryID, paperItemID);
  }
}

export async function finalizeConversationDeletion(
  target: ConversationDeletionTarget,
  deps: ConversationDeletionDeps = {},
): Promise<ConversationDeletionResult> {
  const result = createResult();
  const conversationKey = normalizePositiveInt(target.conversationKey);
  const libraryID = normalizePositiveInt(target.libraryID);
  const log = deps.log;
  if (!conversationKey || !libraryID) {
    recordIssue(
      result,
      "errors",
      {
        code: "catalog_row",
        message: "LLM: Cannot delete conversation with invalid identity",
      },
      log,
    );
    return result;
  }

  const targetConversationID = normalizeConversationID(target.conversationID);
  const resolvedRef = targetConversationID
    ? null
    : await resolveConversationRefForKey(conversationKey);
  const conversationID =
    targetConversationID || resolvedRef?.conversationID || "";
  let normalizedTarget: ConversationDeletionTarget = {
    ...target,
    conversationID: conversationID || undefined,
    conversationKey,
    libraryID,
    paperItemID: normalizePositiveInt(target.paperItemID) || undefined,
  };
  let scopeValidation = await getConversationScopeValidationDetails({
    conversationID: normalizedTarget.conversationID,
    conversationKey,
    system: normalizedTarget.conversationSystem,
    kind: normalizedTarget.kind,
    libraryID,
    paperItemID: normalizedTarget.paperItemID,
  });
  if (canCanonicalizeRegistryConversationID(scopeValidation)) {
    normalizedTarget = {
      ...normalizedTarget,
      conversationID: scopeValidation.registered?.conversationID || undefined,
    };
    scopeValidation = await getConversationScopeValidationDetails({
      conversationID: normalizedTarget.conversationID,
      conversationKey,
      system: normalizedTarget.conversationSystem,
      kind: normalizedTarget.kind,
      libraryID,
      paperItemID: normalizedTarget.paperItemID,
    });
  }
  if (!scopeValidation.valid) {
    result.blocked = true;
    recordIssue(
      result,
      "errors",
      {
        code: "catalog_row",
        message:
          "LLM: Refused to delete conversation with mismatched registry scope",
        error: summarizeScopeValidationFailure(scopeValidation),
      },
      log,
    );
    return result;
  }
  const operations = buildOperations(deps);

  await runStep(
    result,
    "cancel_pending_request",
    "LLM: Failed to cancel pending request for deleted conversation",
    () =>
      (deps.cancelPendingRequest || defaultCancelPendingRequest)(
        conversationKey,
      ),
    log,
  );

  if (normalizedTarget.conversationSystem === "claude_code") {
    await runStep(
      result,
      "claude_session",
      "LLM: Failed to invalidate deleted Claude conversation",
      () =>
        operations.invalidateClaudeConversation(
          conversationKey,
          normalizedTarget,
        ),
      log,
    );
  }

  const codexThreadId =
    normalizedTarget.conversationSystem === "codex"
      ? normalizeProviderSessionId(normalizedTarget.providerSessionId)
      : "";
  if (codexThreadId) {
    const preflightErrorCount = result.errors.length;
    await runStep(
      result,
      "message_rows",
      "LLM: Failed to validate local conversation rows before archiving Codex thread",
      () => operations.preflightDeleteLocalConversationRows(normalizedTarget),
      log,
    );
    if (result.errors.length > preflightErrorCount) {
      result.blocked = true;
      return result;
    }
    try {
      await operations.archiveCodexThread(codexThreadId);
    } catch (error) {
      result.blocked = true;
      recordIssue(
        result,
        "errors",
        {
          code: "codex_thread_archive",
          message:
            "LLM: Failed to archive Codex thread; local conversation was not deleted",
          error,
        },
        log,
      );
      return result;
    }
  }

  const localDeleteErrorCount = result.errors.length;
  await runStep(
    result,
    "message_rows",
    "LLM: Failed to delete local conversation rows",
    () => operations.deleteLocalConversationRows(normalizedTarget),
    log,
  );
  if (result.errors.length > localDeleteErrorCount) {
    return result;
  }
  await runStep(
    result,
    "runtime_cache",
    "LLM: Failed to clear deleted conversation runtime caches",
    () => clearSharedRuntimeCaches(normalizedTarget, deps),
    log,
  );

  const agentHadError = await clearDeletedAgentConversationState(
    {
      clearAgentToolCaches: deps.clearAgentToolCaches,
      clearAgentConversationState:
        deps.clearAgentConversationState || clearAgentConversationState,
      log: log || (() => {}),
    },
    conversationKey,
    normalizedTarget.kind,
  );
  if (agentHadError) {
    recordIssue(result, "errors", {
      code: "agent_state",
      message: "LLM: Failed to fully clear deleted agent conversation state",
    });
  }
  await runStep(
    result,
    "attachment_refs",
    "LLM: Failed to clear deleted conversation attachment refs",
    () => operations.clearOwnerAttachmentRefs("conversation", conversationKey),
    log,
  );
  await runStep(
    result,
    "attachment_files",
    "LLM: Failed to remove deleted conversation attachment files",
    () => operations.removeConversationAttachmentFiles(conversationKey),
    log,
  );
  await runStep(
    result,
    "remembered_selection",
    "LLM: Failed to clear deleted conversation selection state",
    () => operations.clearRememberedSelection(normalizedTarget),
    log,
  );
  await runStep(
    result,
    "attachment_gc",
    "LLM: Failed to schedule deleted conversation attachment GC",
    () => deps.scheduleAttachmentGc?.(),
    log,
  );

  return result;
}

// ── Headless finalizers for the durable pending-deletion queue ────────────────
// These run with no live panel (startup sweep, orphaned-window recovery), so
// they must not touch DOM or per-controller state; live panels react to the
// store's events instead.

// Conversation keys are reusable (MAX+1 allocation; paper sessions key on the
// item id) AND conversationIDs are a deterministic hash of the scope, so a
// recycled key reproduces a byte-identical conversationID. Neither value can
// prove ownership. The only sound proof is exact equality against the identity
// witness captured at queue time — the catalog row's createdAt, which a
// re-created row never inherits. Exact equality is strictly stronger than the
// old createdAt-vs-queuedAt ordering test and is immune to clock rollback.
// "stale" intents are simply dropped; "unknown" means ownership could not be
// verified, so nothing destructive may run until a later retry can verify.
async function classifyQueuedConversationDeletionStaleness(
  entry: PendingConversationDeletionEntry,
  log?: (message: string, ...args: unknown[]) => void,
): Promise<"stale" | "fresh" | "unknown" | "unverifiable"> {
  const witness = Math.floor(Number(entry.catalogCreatedAt || 0));
  if (witness <= 0) {
    // Persisted by a build that recorded no witness. The intent is unverifiable
    // now and forever, so drop it rather than gamble on whatever conversation
    // owns the key today. The user's conversation simply reappears and can be
    // deleted again.
    log?.("LLM: dropping queued deletion carrying no identity witness", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
    });
    // "unverifiable", NOT "stale": nothing was deleted and the conversation on
    // this key is still there. Surfaces must not treat this as a deletion.
    return "unverifiable";
  }
  let summary: ConversationCatalogEntry | null = null;
  try {
    summary = await conversationRepository.getCatalogEntry({
      system: entry.system,
      kind: entry.conversationKind,
      conversationKey: entry.conversationKey,
    });
  } catch (err) {
    log?.("LLM: stale-deletion check failed; deferring for retry", err);
    return "unknown";
  }
  if (!summary) {
    // No catalog row owns the key any more: the queued conversation is already
    // gone, so there is nothing left to delete — and nothing may be deleted.
    log?.("LLM: dropping queued deletion — catalog row no longer exists", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
    });
    return "stale";
  }
  if (Math.floor(Number(summary.createdAt || 0)) !== witness) {
    log?.(
      "LLM: dropping stale queued deletion — the key is owned by a different catalog row now",
      {
        conversationKey: entry.conversationKey,
        queuedCatalogCreatedAt: witness,
        currentCatalogCreatedAt: summary.createdAt,
      },
    );
    return "stale";
  }
  const catalogConversationID = normalizeConversationID(summary.conversationID);
  if (
    entry.conversationID &&
    catalogConversationID &&
    catalogConversationID !== entry.conversationID
  ) {
    log?.(
      "LLM: dropping stale queued deletion — catalog row carries a different conversation id",
      {
        conversationKey: entry.conversationKey,
        queuedConversationID: entry.conversationID,
        currentConversationID: catalogConversationID,
      },
    );
    return "stale";
  }
  if (entry.conversationID) {
    let registered: Awaited<ReturnType<typeof getRegisteredConversationScope>> =
      null;
    try {
      registered = await getRegisteredConversationScope(entry.conversationKey);
    } catch (err) {
      log?.(
        "LLM: stale-deletion registry check failed; deferring for retry",
        err,
      );
      return "unknown";
    }
    if (registered && registered.conversationID !== entry.conversationID) {
      log?.(
        "LLM: dropping stale queued deletion — key now registered to another conversation",
        {
          conversationKey: entry.conversationKey,
          queuedConversationID: entry.conversationID,
          currentConversationID: registered.conversationID,
        },
      );
      return "stale";
    }
  }
  return "fresh";
}

export async function finalizeQueuedConversationDeletion(
  entry: PendingConversationDeletionEntry,
  deps: ConversationDeletionDeps = {},
): Promise<boolean | PendingFinalizeOutcome> {
  const staleness = await classifyQueuedConversationDeletionStaleness(
    entry,
    deps.log,
  );
  if (staleness === "unverifiable") {
    // Withdraw the row, but report DROPPED: nothing was deleted, so the chat
    // the user is looking at is still alive. Surfaces must not tombstone it or
    // evict the user from it.
    return { ok: true, dropped: true };
  }
  if (staleness === "stale") {
    // The queued conversation is genuinely gone (no catalog row owns the key,
    // or the key now belongs to a different conversation). Report a plain
    // completion: surfaces must NOT restore anyone onto this key — that is how
    // a deleted chat came back as an empty "New chat" — and the write-ahead row
    // must not be retried against the key's new owner.
    return true;
  }
  if (staleness === "unknown") {
    // Ownership could not be verified; nothing destructive has run yet, so
    // report a retry-safe failure instead of risking the key's new owner.
    return false;
  }
  let paperItemID = Number(entry.paperItemID || 0) || undefined;
  if (entry.conversationKind === "paper" && !paperItemID) {
    const summary = await conversationRepository.getCatalogEntry({
      system: entry.system,
      kind: "paper",
      conversationKey: entry.conversationKey,
    });
    paperItemID = Number(summary?.paperItemID || 0) || undefined;
  }
  const result = await finalizeConversationDeletion(
    {
      conversationID: entry.conversationID,
      conversationKey: entry.conversationKey,
      kind: entry.conversationKind,
      conversationSystem: entry.system,
      libraryID: entry.libraryID,
      paperItemID,
      providerSessionId: entry.providerSessionId,
    },
    deps,
  );
  if (result.ok) return true;
  // Every failure that aborts BEFORE local rows are deleted early-returns with
  // one of these markers; retrying those is safe. Any other failure happened
  // AFTER the destructive delete — report success to the queue so the undo
  // affordance cannot claim to restore a chat whose rows are already gone.
  const retrySafe =
    result.blocked ||
    result.errors.some(
      (issue) =>
        issue.code === "codex_thread_archive" ||
        issue.code === "message_rows" ||
        issue.code === "catalog_row",
    );
  if (retrySafe) {
    // The individual issues were logged as they were recorded, but nothing
    // recorded the DECISION. Without it the log cannot distinguish "deferred,
    // will retry" from "gave up", which is exactly what the user's
    // "Failed to fully delete conversation. Check logs." toast points at.
    deps.log?.("LLM: queued conversation deletion deferred; will retry", {
      conversationKey: entry.conversationKey,
      conversationID: entry.conversationID,
      blocked: result.blocked,
      errors: result.errors,
    });
    return false;
  }
  deps.log?.(
    "LLM: queued conversation deletion completed with cleanup errors",
    result.errors,
  );
  return true;
}

export async function finalizeQueuedTurnDeletion(
  entry: PendingTurnDeletionEntry,
  deps: {
    log?: (message: string, ...args: unknown[]) => void;
    scheduleAttachmentGc?: () => void;
  } = {},
): Promise<boolean> {
  const log = deps.log || (() => {});
  try {
    await conversationRepository.deleteTurnMessages({
      system: entry.system,
      conversationKey: entry.conversationKey,
      userTimestamp: entry.userTimestamp,
      assistantTimestamp: entry.assistantTimestamp,
    });
  } catch (err) {
    log("LLM: queued turn deletion failed to delete rows", err);
    return false;
  }
  const history = chatHistory.get(entry.conversationKey);
  if (history) {
    const pair = findTurnPairByTimestamps(
      history,
      entry.userTimestamp,
      entry.assistantTimestamp,
    );
    if (pair) {
      history.splice(pair.userIndex, 2);
      chatHistory.set(entry.conversationKey, history);
    }
  }
  try {
    const remaining =
      chatHistory.get(entry.conversationKey) ||
      ((await conversationRepository.loadMessages({
        system: entry.system,
        conversationKey: entry.conversationKey,
      })) as unknown as Message[]);
    await replaceOwnerAttachmentRefs(
      "conversation",
      entry.conversationKey,
      collectAttachmentHashesFromMessages(remaining),
    );
  } catch (err) {
    log("LLM: queued turn deletion completed with stale attachment refs", err);
  }
  deps.scheduleAttachmentGc?.();
  return true;
}
