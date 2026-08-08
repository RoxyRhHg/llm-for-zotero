// A short-lived tombstone for conversations whose deletion just committed.
//
// pendingDeletionStore drops its entry BEFORE it notifies "finalized", so
// isConversationPendingDeletion() already reads false while panels react to
// that event. Any surface still mounted on the deleted key would re-seed a bare
// catalog row (INSERT OR IGNORE, user_turn_count 0, title NULL) and the chat
// would reappear in history as an empty "New chat". The tombstone closes that
// window. Deliberate navigation to the key lifts it, so a recycled key can
// still legitimately start a new chat once the deletion has settled.
export const RECENTLY_DELETED_CONVERSATION_TTL_MS = 60_000;

const tombstones = new Map<number, number>();

function normalizeKey(conversationKey: number): number {
  return Number.isFinite(conversationKey) && conversationKey > 0
    ? Math.floor(conversationKey)
    : 0;
}

function prune(now: number): void {
  for (const [key, deletedAt] of Array.from(tombstones.entries())) {
    if (now - deletedAt >= RECENTLY_DELETED_CONVERSATION_TTL_MS) {
      tombstones.delete(key);
    }
  }
}

export function markConversationRecentlyDeleted(
  conversationKey: number,
  now: number = Date.now(),
): void {
  const key = normalizeKey(conversationKey);
  if (!key) return;
  prune(now);
  tombstones.set(key, now);
}

export function isConversationRecentlyDeleted(
  conversationKey: number,
  now: number = Date.now(),
): boolean {
  const key = normalizeKey(conversationKey);
  if (!key) return false;
  const deletedAt = tombstones.get(key);
  if (deletedAt === undefined) return false;
  if (now - deletedAt >= RECENTLY_DELETED_CONVERSATION_TTL_MS) {
    tombstones.delete(key);
    return false;
  }
  return true;
}

// A user deliberately navigating to (or creating on) the key means the key is
// alive again — the tombstone must not block its catalog row.
export function forgetRecentlyDeletedConversation(
  conversationKey: number,
): void {
  const key = normalizeKey(conversationKey);
  if (!key) return;
  tombstones.delete(key);
}

export function resetRecentlyDeletedConversationsForTests(): void {
  tombstones.clear();
}
