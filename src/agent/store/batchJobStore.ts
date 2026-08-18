/**
 * Durable progress for long-running batch jobs.
 *
 * Everything a paged action knew — page cursor, target list, taxonomy — lived
 * in local variables inside one `execute()` frame. `startOffset` was in every
 * paged schema and documented as a resume offset, but nothing ever wrote or
 * read it across a process boundary. So a restart at page 7 of 30 lost
 * everything except the pages already committed to Zotero: the user's library
 * was half-reorganised and the job had no memory of it.
 *
 * Schema and lifecycle follow the plugin's existing durable stores.
 */

const BATCH_JOBS_TABLE = "llm_for_zotero_agent_batch_jobs";

export type BatchJobStatus = "running" | "completed" | "cancelled" | "failed";

export type BatchJobRecord = {
  jobId: string;
  conversationKey: number;
  action: string;
  /** The tool arguments the job was started with, so a resume replays them. */
  inputJson: string;
  /** Frozen decisions the job must not re-derive on resume (e.g. a tag set). */
  planJson?: string;
  cursor: number;
  appliedCount: number;
  totalCount?: number;
  status: BatchJobStatus;
  createdAt: number;
  updatedAt: number;
};

type JobRow = {
  job_id: string;
  conversation_key: number;
  action: string;
  input_json: string;
  plan_json: string | null;
  cursor: number;
  applied_count: number;
  total_count: number | null;
  status: string;
  created_at: number;
  updated_at: number;
};

function hasDb(): boolean {
  try {
    return Boolean(
      (Zotero as unknown as { DB?: { queryAsync?: unknown } }).DB?.queryAsync,
    );
  } catch {
    return false;
  }
}

function normalizeStatus(value: unknown): BatchJobStatus {
  return value === "completed" ||
    value === "cancelled" ||
    value === "failed"
    ? value
    : "running";
}

function toRecord(row: JobRow): BatchJobRecord {
  return {
    jobId: row.job_id,
    conversationKey: Number(row.conversation_key) || 0,
    action: row.action,
    inputJson: row.input_json,
    planJson: row.plan_json ?? undefined,
    cursor: Number(row.cursor) || 0,
    appliedCount: Number(row.applied_count) || 0,
    totalCount:
      row.total_count === null || row.total_count === undefined
        ? undefined
        : Number(row.total_count),
    status: normalizeStatus(row.status),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export async function initAgentBatchJobStore(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${BATCH_JOBS_TABLE} (
        job_id TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        action TEXT NOT NULL,
        input_json TEXT NOT NULL,
        plan_json TEXT,
        cursor INTEGER NOT NULL,
        applied_count INTEGER NOT NULL,
        total_count INTEGER,
        status TEXT NOT NULL CHECK(status IN ('running','completed','cancelled','failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${BATCH_JOBS_TABLE}_conv_idx
       ON ${BATCH_JOBS_TABLE} (conversation_key, status, updated_at)`,
    );
  });
}

export async function createBatchJob(params: {
  jobId: string;
  conversationKey: number;
  action: string;
  input: unknown;
  plan?: unknown;
  totalCount?: number;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${BATCH_JOBS_TABLE}
     (job_id, conversation_key, action, input_json, plan_json, cursor, applied_count, total_count, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'running', ?, ?)`,
    [
      params.jobId,
      params.conversationKey,
      params.action,
      JSON.stringify(params.input ?? {}),
      params.plan === undefined ? null : JSON.stringify(params.plan),
      params.totalCount ?? null,
      params.now,
      params.now,
    ],
  );
}

/**
 * Records progress after a page is applied.
 *
 * Called after the write lands, never before: a cursor ahead of the library
 * would skip work on resume, which is worse than repeating a page.
 */
export async function advanceBatchJob(params: {
  jobId: string;
  cursor: number;
  appliedCount: number;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_JOBS_TABLE}
     SET cursor = ?, applied_count = ?, updated_at = ?
     WHERE job_id = ?`,
    [params.cursor, params.appliedCount, params.now, params.jobId],
  );
}

export async function finishBatchJob(params: {
  jobId: string;
  status: Exclude<BatchJobStatus, "running">;
  now: number;
}): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(
    `UPDATE ${BATCH_JOBS_TABLE} SET status = ?, updated_at = ? WHERE job_id = ?`,
    [params.status, params.now, params.jobId],
  );
}

export async function getBatchJob(
  jobId: string,
): Promise<BatchJobRecord | null> {
  if (!hasDb()) return null;
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_JOBS_TABLE} WHERE job_id = ?`,
    [jobId],
  )) as unknown as JobRow[] | null;
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? toRecord(row) : null;
}

/**
 * Jobs left running by a crash or a quit. The batch tool offers to resume
 * these rather than silently restarting from zero and repaying for pages the
 * user already approved.
 */
export async function listResumableBatchJobs(
  conversationKey: number,
): Promise<BatchJobRecord[]> {
  if (!hasDb()) return [];
  const rows = (await Zotero.DB.queryAsync(
    `SELECT * FROM ${BATCH_JOBS_TABLE}
     WHERE conversation_key = ? AND status = 'running'
     ORDER BY updated_at DESC`,
    [conversationKey],
  )) as unknown as JobRow[] | null;
  return Array.isArray(rows) ? rows.map(toRecord) : [];
}

export async function clearAgentBatchJobs(): Promise<void> {
  if (!hasDb()) return;
  await Zotero.DB.queryAsync(`DELETE FROM ${BATCH_JOBS_TABLE}`);
}
