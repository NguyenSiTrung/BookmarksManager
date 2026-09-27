import type { AnalysisCheck } from "../decisions/pipeline";
import { db } from "../db/database";
import { Job, JobUsage } from "../schemas/job";
import type { JobKind, JobProgress, JobStatus } from "../schemas/job";
import { DEFAULT_BATCH_SIZE } from "./estimate";

/**
 * Job queue (spec FR7/FR8): the persisted, resumable batch-job state machine
 * over the Dexie `jobs` table plus the per-job `usage` roll-up. The `jobs`
 * row is the single source of truth — it carries the work set
 * (`bookmarkIds`/`cursor`), how far the job got (`progress`), and the tokens
 * and cost spent so far (`usage`), so a fresh service worker can resume a
 * job after an MV3 restart.
 *
 * This module owns enqueue and the lifecycle transitions; the batch loop
 * lives in `./runner.ts`. Errors are typed `JobQueueError`s with redacted,
 * content-free messages.
 */

export { DEFAULT_BATCH_SIZE } from "./estimate";

/** The `code` values on a queue failure. */
export type JobQueueErrorCode =
  | "invalid_input"
  | "not_found"
  | "illegal_transition"
  | "persist_failed";

/** Rejection for every failure this module produces. Messages stay redacted. */
export class JobQueueError extends Error {
  readonly code: JobQueueErrorCode;

  constructor(code: JobQueueErrorCode, message: string) {
    super(message);
    this.name = "JobQueueError";
    this.code = code;
  }
}

/**
 * Legal status transitions. `running` includes itself so a runner can
 * re-enter an already-running job idempotently; terminal states have no
 * outgoing edges.
 */
const LEGAL_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ["running", "paused", "canceled"],
  running: ["running", "paused", "completed", "canceled", "failed"],
  paused: ["running", "canceled"],
  completed: [],
  canceled: [],
  failed: [],
};

/** Whether `to` is a legal next status from `from`. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * The library-wide near-duplicate pair-phase marker (spec FR7: a library scan
 * is "categorize + tags, misfiled, near-duplicate"). It is NOT an
 * `AnalysisCheck` — it is not a per-bookmark question set — so it is kept
 * separate from the per-bookmark checks in {@link bookmarkChecks}.
 */
export const NEAR_DUPLICATE_CHECK = "near_duplicate" as const;

/**
 * A job kind's phases: the per-bookmark `AnalysisCheck`s (see
 * `ANALYSIS_CHECKS` in pipeline.ts) plus, for a library scan, the library-wide
 * {@link NEAR_DUPLICATE_CHECK} pair phase.
 */
export type JobCheck = AnalysisCheck | typeof NEAR_DUPLICATE_CHECK;

/**
 * The checks a job kind asks for. An `analyze_selection` runs categorize +
 * tags; a `library_scan` also runs the misfiled per-bookmark check AND the
 * near-duplicate pair phase (FR7).
 */
export function jobChecks(kind: JobKind): readonly JobCheck[] {
  return kind === "library_scan"
    ? ["categorize", "tags", "misfiled", NEAR_DUPLICATE_CHECK]
    : ["categorize", "tags"];
}

/**
 * The per-bookmark `AnalysisCheck`s among `checks` — drops the library-wide
 * {@link NEAR_DUPLICATE_CHECK} marker so the per-bookmark pipeline only ever
 * receives the question sets it knows.
 */
export function bookmarkChecks(
  checks: readonly JobCheck[],
): readonly AnalysisCheck[] {
  return checks.filter(
    (check): check is AnalysisCheck => check !== NEAR_DUPLICATE_CHECK,
  );
}

/** True when `kind`'s phases include the near-duplicate pair phase. */
export function jobRunsNearDuplicate(kind: JobKind): boolean {
  return jobChecks(kind).includes(NEAR_DUPLICATE_CHECK);
}

/**
 * Number of batches a work set of `count` bookmarks splits into. Throws a
 * `JobQueueError("invalid_input")` for a non-positive batch size or a
 * negative/non-integer count.
 */
export function computeTotalBatches(
  count: number,
  batchSize: number = DEFAULT_BATCH_SIZE,
): number {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new JobQueueError(
      "invalid_input",
      "batchSize must be a positive integer.",
    );
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new JobQueueError(
      "invalid_input",
      "count must be a non-negative integer.",
    );
  }
  return Math.ceil(count / batchSize);
}

function nowIso(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))();
}

async function requireJob(id: string): Promise<Job> {
  const job = await db.jobs.get(id);
  if (job === undefined) {
    throw new JobQueueError("not_found", `No job ${JSON.stringify(id)}.`);
  }
  return job;
}

export interface EnqueueJobOptions {
  readonly kind: JobKind;
  /** Explicit work set; at least one of this or `cursor` is required. */
  readonly bookmarkIds?: readonly string[];
  /** Opaque resumption offset for very large scans. */
  readonly cursor?: number;
  /** Batch size persisted on the row and used to seed `progress.totalBatches`. */
  readonly batchSize?: number;
  /** Caller-supplied uuid (defaults to `crypto.randomUUID()`). */
  readonly id?: string;
  /** Injectable clock for deterministic timestamps. */
  readonly now?: () => string;
}

/**
 * Create and persist a `pending` job. The resolved `batchSize` is stored on
 * the row (the single source of truth a resume slices by) and
 * `progress.totalBatches` is computed from the work set and that size; a
 * cursor-only job starts at zero batches (the runner fills it in once the work
 * set is resolved). The caller must pass a non-empty `bookmarkIds` or a
 * `cursor`, otherwise the row could not resume.
 */
export async function enqueueJob(options: EnqueueJobOptions): Promise<Job> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (options.bookmarkIds === undefined && options.cursor === undefined) {
    throw new JobQueueError(
      "invalid_input",
      "A job needs a bookmark id set or a cursor to resume from.",
    );
  }
  if (options.bookmarkIds !== undefined && options.bookmarkIds.length === 0) {
    throw new JobQueueError(
      "invalid_input",
      "bookmarkIds must be non-empty when present.",
    );
  }
  const totalBatches =
    options.bookmarkIds === undefined
      ? 0
      : computeTotalBatches(options.bookmarkIds.length, batchSize);
  const timestamp = nowIso(options.now);
  let job: Job;
  try {
    job = Job.parse({
      id: options.id ?? crypto.randomUUID(),
      kind: options.kind,
      status: "pending",
      progress: { totalBatches, committedBatches: 0, processedCount: 0 },
      batchSize,
      ...(options.bookmarkIds === undefined
        ? {}
        : { bookmarkIds: [...options.bookmarkIds] }),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch {
    throw new JobQueueError("invalid_input", "The job description is invalid.");
  }
  await db.jobs.add(job);
  return job;
}

/** Read one job, or `undefined` when it does not exist. */
export async function getJob(id: string): Promise<Job | undefined> {
  return db.jobs.get(id);
}

/** Optional fields a status change may also write. */
export interface JobStatusPatch {
  readonly progress?: JobProgress;
  readonly usage?: JobUsage;
  /** Redacted failure text; set only when moving to `failed`. */
  readonly error?: string;
}

/**
 * Move a job to `to`, enforcing the legal-transition table, and persist it.
 * `patch` may carry the final `progress`/`usage` (and a redacted `error` for a
 * failure). Throws `JobQueueError("illegal_transition")` on a disallowed move
 * and `not_found` for an unknown job.
 */
export async function setJobStatus(
  id: string,
  to: JobStatus,
  patch: JobStatusPatch = {},
  now?: () => string,
): Promise<Job> {
  const job = await requireJob(id);
  if (!canTransition(job.status, to)) {
    throw new JobQueueError(
      "illegal_transition",
      `Cannot move a ${job.status} job to ${to}.`,
    );
  }
  const base = {
    ...job,
    status: to,
    progress: patch.progress ?? job.progress,
    usage: patch.usage ?? job.usage,
    updatedAt: nowIso(now),
  };
  const updated = Job.parse(
    patch.error === undefined ? base : { ...base, error: patch.error },
  );
  await db.jobs.put(updated);
  return updated;
}

/** Pause a pending or running job. */
export function pauseJob(id: string, now?: () => string): Promise<Job> {
  return setJobStatus(id, "paused", {}, now);
}

/** Resume a paused job. */
export function resumeJob(id: string, now?: () => string): Promise<Job> {
  return setJobStatus(id, "running", {}, now);
}

/** Cancel a non-terminal job. */
export function cancelJob(id: string, now?: () => string): Promise<Job> {
  return setJobStatus(id, "canceled", {}, now);
}

/**
 * Durably write a committed batch's `progress` and rolled-up `usage`. The
 * runner calls this ONLY after every result in the batch is persisted, so the
 * counter never advances ahead of the work.
 */
export async function commitJobProgress(
  id: string,
  progress: JobProgress,
  usage: JobUsage,
  now?: () => string,
): Promise<Job> {
  const job = await requireJob(id);
  const updated = Job.parse({
    ...job,
    progress,
    usage,
    updatedAt: nowIso(now),
  });
  await db.jobs.put(updated);
  return updated;
}

/**
 * Roll up a job's `usage` rows (those carrying its `jobId`) into a
 * `JobUsage`: summed tokens, request count, and the summed USD cost only when
 * at least one response reported a cost — mirroring `UsageMeter.costUsd`
 * ("no cost data" is `undefined`, never `$0.00`).
 */
export async function jobUsageRollup(id: string): Promise<JobUsage> {
  const rows = await db.usage.where("jobId").equals(id).toArray();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawCost = false;
  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    if (row.costUsd !== undefined) {
      sawCost = true;
      costUsd += row.costUsd;
    }
  }
  return JobUsage.parse({
    inputTokens,
    outputTokens,
    requests: rows.length,
    ...(sawCost ? { costUsd } : {}),
  });
}
