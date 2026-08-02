import type { Message } from "./types";
import { normalizeAttachmentContentHash } from "./normalizers";
import { extractManagedBlobHash } from "./attachmentStorage";

export const cloneTurnMessageForUndo = (message: Message): Message => ({
  ...message,
  selectedTexts: Array.isArray(message.selectedTexts)
    ? [...message.selectedTexts]
    : undefined,
  selectedTextSources: Array.isArray(message.selectedTextSources)
    ? [...message.selectedTextSources]
    : undefined,
  selectedTextPaperContexts: Array.isArray(message.selectedTextPaperContexts)
    ? [...message.selectedTextPaperContexts]
    : undefined,
  selectedTextNoteContexts: Array.isArray(message.selectedTextNoteContexts)
    ? [...message.selectedTextNoteContexts]
    : undefined,
  screenshotImages: Array.isArray(message.screenshotImages)
    ? [...message.screenshotImages]
    : undefined,
  paperContexts: Array.isArray(message.paperContexts)
    ? [...message.paperContexts]
    : undefined,
  fullTextPaperContexts: Array.isArray(message.fullTextPaperContexts)
    ? [...message.fullTextPaperContexts]
    : undefined,
  citationPaperContexts: Array.isArray(message.citationPaperContexts)
    ? [...message.citationPaperContexts]
    : undefined,
  attachments: Array.isArray(message.attachments)
    ? message.attachments.map((attachment) => ({ ...attachment }))
    : undefined,
  generatedImages: Array.isArray(message.generatedImages)
    ? message.generatedImages.map((image) => ({ ...image }))
    : undefined,
});

export const findTurnPairByTimestamps = (
  history: Message[],
  userTimestamp: number,
  assistantTimestamp: number,
): {
  userIndex: number;
  userMessage: Message;
  assistantMessage: Message;
} | null => {
  const normalizedUserTimestamp = Number.isFinite(userTimestamp)
    ? Math.floor(userTimestamp)
    : 0;
  const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
    ? Math.floor(assistantTimestamp)
    : 0;
  if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) {
    return null;
  }
  for (let index = 0; index < history.length - 1; index++) {
    const userMessage = history[index];
    const assistantMessage = history[index + 1];
    if (!userMessage || !assistantMessage) continue;
    if (userMessage.role !== "user" || assistantMessage.role !== "assistant") {
      continue;
    }
    if (
      Math.floor(userMessage.timestamp) === normalizedUserTimestamp &&
      Math.floor(assistantMessage.timestamp) === normalizedAssistantTimestamp
    ) {
      return { userIndex: index, userMessage, assistantMessage };
    }
  }
  return null;
};

export const collectAttachmentHashesFromMessages = (
  messages: Message[],
): string[] => {
  const hashes = new Set<string>();
  for (const message of messages) {
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    for (const attachment of attachments) {
      if (!attachment || attachment.category === "image") continue;
      const contentHash =
        normalizeAttachmentContentHash(attachment.contentHash) ||
        extractManagedBlobHash(attachment.storedPath);
      if (!contentHash) continue;
      hashes.add(contentHash);
    }
  }
  return Array.from(hashes);
};
