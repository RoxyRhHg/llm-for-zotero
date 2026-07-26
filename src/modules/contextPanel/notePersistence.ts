export type NotePersistenceSaveOptions = {
  notifierQueue?: unknown;
};

export type FinalizedNoteBuildContext = {
  noteId: number;
  saveOptions: NotePersistenceSaveOptions;
};

export type FinalizedNoteBuildResult = {
  html: string;
  warnings?: string[];
};

export type FinalizedNotePersistenceResult = {
  noteId: number;
  html: string;
  warnings: string[];
};

type FinalizedNoteParams = {
  note: Zotero.Item;
  initialHtml: string;
  finalize?: (
    context: FinalizedNoteBuildContext,
  ) => Promise<string | FinalizedNoteBuildResult>;
  log?: (message: string, error?: unknown) => void;
};

type NotifierQueueHandle = {
  saveOptions: NotePersistenceSaveOptions;
  commit: () => Promise<void>;
};

function logSafely(
  log: FinalizedNoteParams["log"],
  message: string,
  error: unknown,
): void {
  try {
    log?.(message, error);
  } catch {
    // Diagnostic logging must never change persistence behavior.
  }
}

function createNotifierQueueHandle(): NotifierQueueHandle {
  const notifier = (
    Zotero as unknown as {
      Notifier?: {
        Queue?: new () => unknown;
        commit?: (queue: unknown) => Promise<unknown>;
      };
    }
  ).Notifier;
  if (!notifier?.Queue || typeof notifier.commit !== "function") {
    return {
      saveOptions: {},
      commit: async () => {},
    };
  }
  const queue = new notifier.Queue();
  return {
    saveOptions: { notifierQueue: queue },
    commit: async () => {
      await notifier.commit?.(queue);
    },
  };
}

function stripZoteroNoteWrapper(html: string): string {
  const normalized = (html || "").trim();
  const match = normalized.match(
    /^<div class="zotero-note znv\d+">([\s\S]*)<\/div>$/,
  );
  return (match?.[1] || normalized).trim();
}

function noteHtmlMatches(actual: string, expected: string): boolean {
  return stripZoteroNoteWrapper(actual) === stripZoteroNoteWrapper(expected);
}

async function reloadAndVerifyNote(
  note: Zotero.Item,
  expectedHtml: string,
): Promise<{ matches: boolean; reloaded: boolean }> {
  const reload = (
    note as Zotero.Item & {
      reload?: (
        dataTypes?: string[],
        reloadUnchanged?: boolean,
      ) => Promise<void>;
    }
  ).reload;
  if (typeof reload === "function") {
    await reload.call(note, ["note"], true);
    return {
      matches: noteHtmlMatches(note.getNote() || "", expectedHtml),
      reloaded: true,
    };
  }
  return {
    matches: noteHtmlMatches(note.getNote() || "", expectedHtml),
    reloaded: false,
  };
}

async function persistAndVerifyNoteHtml(
  note: Zotero.Item,
  expectedHtml: string,
  saveOptions: NotePersistenceSaveOptions,
  alreadySaved = false,
): Promise<void> {
  let saveResult: number | boolean | undefined;
  if (!alreadySaved) {
    note.setNote(expectedHtml);
    saveResult = await note.saveTx(saveOptions as never);
  }
  const firstVerification = await reloadAndVerifyNote(note, expectedHtml);
  if (
    firstVerification.matches &&
    (alreadySaved || firstVerification.reloaded || saveResult !== false)
  ) {
    return;
  }

  note.setNote(expectedHtml);
  saveResult = await note.saveTx(saveOptions as never);
  const retryVerification = await reloadAndVerifyNote(note, expectedHtml);
  if (
    retryVerification.matches &&
    (retryVerification.reloaded || saveResult !== false)
  ) {
    return;
  }

  throw new Error("Zotero note content did not persist after retry");
}

function resolveCreatedNoteId(
  note: Zotero.Item,
  saveResult: number | boolean | undefined,
): number {
  const id =
    typeof saveResult === "number" && saveResult > 0 ? saveResult : note.id;
  if (!id || id <= 0) {
    throw new Error("Unable to resolve the newly created Zotero note ID");
  }
  return id;
}

/**
 * Create a Zotero note without exposing an intermediate placeholder to item
 * observers. The first persisted state is always useful content. When assets
 * require a stable note ID, all note and attachment notifications remain in a
 * coordinator-owned queue until final HTML has been persisted and verified.
 */
export async function createFinalizedZoteroNote(
  params: FinalizedNoteParams,
): Promise<FinalizedNotePersistenceResult> {
  const queue = createNotifierQueueHandle();
  const warnings: string[] = [];
  let noteId = 0;
  let finalHtml = params.initialHtml;
  let primaryError: unknown;
  let result: FinalizedNotePersistenceResult | undefined;

  try {
    params.note.setNote(params.initialHtml);
    const saveResult = await params.note.saveTx(queue.saveOptions as never);
    noteId = resolveCreatedNoteId(params.note, saveResult);

    if (params.finalize) {
      try {
        const finalized = await params.finalize({
          noteId,
          saveOptions: queue.saveOptions,
        });
        if (typeof finalized === "string") {
          finalHtml = finalized;
        } else {
          finalHtml = finalized.html;
          warnings.push(...(finalized.warnings || []));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error || "unknown");
        warnings.push(`Note asset finalization failed: ${message}`);
        logSafely(params.log, "LLM: Note asset finalization failed", error);
        finalHtml = params.initialHtml;
      }
    }

    await persistAndVerifyNoteHtml(
      params.note,
      finalHtml,
      queue.saveOptions,
      !params.finalize || noteHtmlMatches(finalHtml, params.initialHtml),
    );
    result = {
      noteId,
      html: finalHtml,
      warnings,
    };
  } catch (error) {
    primaryError = error;
  }

  let commitError: unknown;
  try {
    await queue.commit();
  } catch (error) {
    commitError = error;
    logSafely(
      params.log,
      "LLM: Failed to commit queued note notifications",
      error,
    );
  }

  if (primaryError) throw primaryError;
  if (commitError) throw commitError;
  if (!result) {
    throw new Error("Zotero note persistence completed without a result");
  }
  return result;
}
