type MineruManagerSelectionTarget = (
  attachmentIds: readonly number[],
) => boolean | void;

type ZoteroItemResolver = (
  attachmentId: number,
) => Zotero.Item | null | undefined;

const selectionTargets = new Set<MineruManagerSelectionTarget>();
let pendingAttachmentIds: number[] | null = null;

function normalizeAttachmentIds(attachmentIds: readonly number[]): number[] {
  return [
    ...new Set(
      attachmentIds.filter(
        (attachmentId) => Number.isInteger(attachmentId) && attachmentId > 0,
      ),
    ),
  ];
}

function isPdfAttachment(item: Zotero.Item | null | undefined): boolean {
  return Boolean(
    item?.isAttachment?.() && item.attachmentContentType === "application/pdf",
  );
}

export function collectMineruPdfAttachmentIds(
  items: readonly Zotero.Item[],
  resolveItem: ZoteroItemResolver = (attachmentId) =>
    Zotero.Items.get(attachmentId),
): number[] {
  const attachmentIds: number[] = [];

  for (const item of items) {
    if (!item) continue;
    if (isPdfAttachment(item)) {
      attachmentIds.push(item.id);
      continue;
    }
    if (!item.isRegularItem?.()) continue;

    let childIds: number[] = [];
    try {
      childIds = item.getAttachments();
    } catch {
      continue;
    }
    for (const childId of childIds) {
      const child = resolveItem(childId);
      if (isPdfAttachment(child)) attachmentIds.push(childId);
    }
  }

  return normalizeAttachmentIds(attachmentIds);
}

export function requestMineruManagerSelection(
  attachmentIds: readonly number[],
): boolean {
  const normalized = normalizeAttachmentIds(attachmentIds);
  if (!normalized.length) return false;

  pendingAttachmentIds = normalized;
  let handled = false;
  for (const target of selectionTargets) {
    try {
      handled = target(normalized) !== false || handled;
    } catch {
      /* keep the request pending for another/next manager target */
    }
  }
  if (handled) pendingAttachmentIds = null;
  return true;
}

export function registerMineruManagerSelectionTarget(
  target: MineruManagerSelectionTarget,
): () => void {
  selectionTargets.add(target);
  if (pendingAttachmentIds) {
    try {
      if (target(pendingAttachmentIds) !== false) {
        pendingAttachmentIds = null;
      }
    } catch {
      /* leave the request pending so a later target can apply it */
    }
  }

  return () => {
    selectionTargets.delete(target);
  };
}

export function hasPendingMineruManagerSelection(): boolean {
  return Boolean(pendingAttachmentIds?.length);
}

export function clearMineruManagerNavigationForTests(): void {
  selectionTargets.clear();
  pendingAttachmentIds = null;
}
