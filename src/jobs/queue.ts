import type { AnalysisCheck } from "../decisions/pipeline";
import {
  NEAR_DUPLICATE_COMPARISON_LIMIT,
  NEAR_DUPLICATE_PAIR_LIMIT,
} from "../decisions/near-duplicate-plan";
import type { NearDuplicatePlan } from "../decisions/near-duplicate-plan";
import { db } from "../db/database";
import { pruneTerminalJobsLocked } from "../db/retention";
import { Job, JobUsage, MAX_JOB_BOOKMARK_IDS, NEAR_DUPLICATE_PLAN_VERSION } from "../schemas/job";
import type {
  JobKind,
  JobProgress,
  JobStatus,
  NearDuplicateJobPlan,
  RestructureJobPlan,
} from "../schemas/job";
import type { RestructureAssignment } from "../schemas/restructure";
import { DEFAULT_BATCH_SIZE } from "./estimate";
import { waitForJob } from "./coordinator";

/** Validated queue reads/writes always materialize legacy fence defaults. */
type PersistedJob = Job & { ownerGeneration: number; controlRevision: number };

function parseJob(value: unknown): PersistedJob {
  const job = Job.parse(value);
  return {
    ...job,
    ownerGeneration: job.ownerGeneration ?? 0,
    controlRevision: job.controlRevision ?? 0,
  };
}

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
  | "persist_failed"
  | "job_in_progress";

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
  paused: ["paused", "running", "canceled"],
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
  if (kind === "restructure") {
    // A restructure job runs no analysis checks — its per-bookmark work is
    // the proposed-folder assignment the injected analyzer performs.
    return [];
  }
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

/**
 * Reduce a planner `NearDuplicatePlan` to the persisted, content-free job
 * plan: canonically-ordered pair IDs plus the planner's limits, format
 * version, and truncation state. Titles, URLs, domains, and notes never land
 * here.
 */
export function toNearDuplicateJobPlan(
  plan: NearDuplicatePlan,
): NearDuplicateJobPlan {
  return {
    version: NEAR_DUPLICATE_PLAN_VERSION,
    pairLimit: NEAR_DUPLICATE_PAIR_LIMIT,
    comparisonLimit: NEAR_DUPLICATE_COMPARISON_LIMIT,
    pairs: plan.pairs.map((pair) => ({ a: pair.a.id, b: pair.b.id })),
    comparisons: plan.comparisons,
    truncated: plan.truncated,
  };
}

async function requireJob(id: string): Promise<PersistedJob> {
  const job = await db.jobs.get(id);
  if (job === undefined) {
    throw new JobQueueError("not_found", `No job ${JSON.stringify(id)}.`);
  }
  return parseJob(job);
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
  /**
   * `restructure` jobs only: the vetted proposal persisted on the row so a
   * resume never re-sends the proposal LLM call. Rejected for other kinds
   * by the `Job` schema's superRefine.
   */
  readonly restructureProposal?: RestructureJobPlan["proposal"];
  /**
   * `library_scan` jobs only: the bounded near-duplicate work plan resolved at
   * enqueue (pairs + planner accounting), reduced to the durable, content-free
   * `nearDuplicatePlan` on the row. Rejected for other kinds. Omitting it
   * leaves a legacy bookmark-only row (the runner acquires one plan on the
   * first uncommitted run).
   */
  readonly nearDuplicatePlan?: NearDuplicatePlan;
}

/**
 * Create and persist a `pending` job. The resolved `batchSize` is stored on
 * the row (the single source of truth a resume slices by) and
 * `progress.totalBatches` is computed from the work set and that size — for a
 * `library_scan` with a pair plan, that includes the pair batches, so the
 * pre-run total is truthful. A cursor-only job starts at zero batches (the
 * runner fills it in once the work set is resolved). The caller must pass a
 * non-empty `bookmarkIds` or a `cursor`, otherwise the row could not resume.
 */
export async function enqueueJob(options: EnqueueJobOptions): Promise<PersistedJob> {
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
  if (
    options.bookmarkIds !== undefined &&
    options.bookmarkIds.length > MAX_JOB_BOOKMARK_IDS
  ) {
    throw new JobQueueError(
      "invalid_input",
      `bookmarkIds is capped at ${MAX_JOB_BOOKMARK_IDS} ids.`,
    );
  }
  if (
    options.nearDuplicatePlan !== undefined &&
    options.kind !== "library_scan"
  ) {
    throw new JobQueueError(
      "invalid_input",
      "Only a library_scan may carry a near-duplicate plan.",
    );
  }
  const nearDuplicatePlan =
    options.nearDuplicatePlan === undefined
      ? undefined
      : toNearDuplicateJobPlan(options.nearDuplicatePlan);
  const pairBatches =
    nearDuplicatePlan === undefined
      ? 0
      : computeTotalBatches(nearDuplicatePlan.pairs.length, batchSize);
  const totalBatches =
    options.bookmarkIds === undefined
      ? 0
      : computeTotalBatches(options.bookmarkIds.length, batchSize) +
        pairBatches;
  const timestamp = nowIso(options.now);
  let job: PersistedJob;
  try {
    job = parseJob({
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
      ...(options.restructureProposal === undefined
        ? {}
        : {
            restructure: {
              proposal: options.restructureProposal,
              assignments: [],
            },
          }),
      ...(nearDuplicatePlan === undefined
        ? {}
        : { nearDuplicatePlan }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch {
    throw new JobQueueError("invalid_input", "The job description is invalid.");
  }
  // One live job per kind (A07): a second start while a same-kind job is
  // pending, running, or paused must refuse, never strand the first job's
  // bookkeeping mid-flight. The check and the insert share one transaction,
  // so two racing starts cannot both pass.
  return db.transaction("rw", db.jobs, async () => {
    const live = await findLiveJobByKind(options.kind);
    if (live !== undefined) {
      throw new JobQueueError(
        "job_in_progress",
        `A ${options.kind} job is already ${live.status} (job ${live.id}); cancel it before starting another.`,
      );
    }
    await db.jobs.add(job);
    // A08: cap terminal job rows — oldest-first, in the same transaction.
    await pruneTerminalJobsLocked();
    return job;
  });
}

/**
 * The statuses a job may occupy while still unfinished (A07): everything a
 * start guard must treat as "live". Terminal rows have empty outgoing
 * transitions in `LEGAL_TRANSITIONS` and never block a restart.
 */
export const LIVE_JOB_STATUSES = ["pending", "running", "paused"] as const;

/**
 * The non-terminal job of `kind`, if one exists (A07). Inside
 * `enqueueJob`'s transaction this reads within the atomic check; callers may
 * also use it as a cheap preflight to skip work a live row would reject
 * anyway — the transaction remains the only authoritative check.
 */
export async function findLiveJobByKind(
  kind: JobKind,
): Promise<PersistedJob | undefined> {
  const row = await db.jobs
    .where("status")
    .anyOf(...LIVE_JOB_STATUSES)
    .and((job) => job.kind === kind)
    .first();
  return row === undefined ? undefined : parseJob(row);
}

/** Read one job, or `undefined` when it does not exist. */
export async function getJob(id: string): Promise<PersistedJob | undefined> {
  const job = await db.jobs.get(id);
  return job === undefined ? undefined : parseJob(job);
}

/**
 * Attach the durable near-duplicate work plan to a legacy `library_scan` that
 * was enqueued without one (Task 5). Acquires EXACTLY ONE plan: an existing
 * `nearDuplicatePlan` is left untouched, and a non-library-scan row is a
 * no-op, so two racing owners can never overwrite each other's work set. The
 * caller (the runner) is responsible for rejecting an already-committed
 * plan-less row before calling this — its committed offsets are ambiguous.
 */
export async function attachNearDuplicatePlan(
  id: string,
  plan: NearDuplicatePlan,
  now?: () => string,
  ownerGeneration?: number,
): Promise<PersistedJob> {
  return db.transaction("rw", db.jobs, async () => {
    const job = await requireJob(id);
    if (ownerGeneration !== undefined && job.ownerGeneration !== ownerGeneration) {
      return job;
    }
    if (job.status !== "running" && job.status !== "pending") return job;
    if (job.kind !== "library_scan" || job.nearDuplicatePlan !== undefined) {
      return job;
    }
    const updated = parseJob({
      ...job,
      nearDuplicatePlan: toNearDuplicateJobPlan(plan),
      updatedAt: nowIso(now),
    });
    await db.jobs.put(updated);
    return updated;
  });
}

/**
 * Claim the next durable runner generation atomically. A fresh worker may
 * replace an interrupted `running` owner, but never resume user-paused or
 * terminal work merely because an old launch was queued.
 */
export async function claimJobOwner(
  id: string,
  now?: () => string,
): Promise<PersistedJob | undefined> {
  return db.transaction("rw", db.jobs, async () => {
    const job = await requireJob(id);
    if (job.status !== "pending" && job.status !== "running") return undefined;
    const updated = parseJob({
      ...job,
      status: "running",
      ownerGeneration: job.ownerGeneration + 1,
      updatedAt: nowIso(now),
    });
    await db.jobs.put(updated);
    return updated;
  });
}

function ownedWritable(job: Job, generation: number, allowPaused = false): boolean {
  return job.ownerGeneration === generation &&
    (job.status === "running" || (allowPaused && job.status === "paused"));
}

/** Final-attempt admission for a captured owner, not a newly adopted owner. */
export async function assertJobAuthority(
  owner: Pick<Job, "id" | "ownerGeneration">,
): Promise<void> {
  const current = await getJob(owner.id);
  const generation = owner.ownerGeneration ?? 0;
  if (current !== undefined && current.ownerGeneration === generation &&
    (current.status === "running" || current.status === "paused" ||
      (current.status === "pending" && generation === 0))) return;
  throw new JobQueueError("illegal_transition", "The job no longer admits outbound work.");
}

function progressRegresses(job: Job, progress: JobProgress): boolean {
  return progress.committedBatches < job.progress.committedBatches ||
    progress.processedCount < job.progress.processedCount;
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
  ownerGeneration?: number,
): Promise<PersistedJob> {
  return db.transaction("rw", db.jobs, async () => {
    const job = await requireJob(id);
    if (ownerGeneration !== undefined && !ownedWritable(job, ownerGeneration)) return job;
    if (patch.progress !== undefined && progressRegresses(job, patch.progress)) return job;
    if (!canTransition(job.status, to)) {
      throw new JobQueueError(
        "illegal_transition",
        `Cannot move a ${job.status} job to ${to}.`,
      );
    }
    const base = {
      ...job,
      status: to,
      controlRevision: ownerGeneration === undefined &&
        (to === "paused" || to === "canceled" || to === "running")
        ? job.controlRevision + 1 : job.controlRevision,
      progress: patch.progress ?? job.progress,
      usage: patch.usage ?? job.usage,
      updatedAt: nowIso(now),
    };
    const updated = parseJob(
      patch.error === undefined ? base : { ...base, error: patch.error },
    );
    await db.jobs.put(updated);
    // A08: a terminal transition is also a retention write — keep the
    // terminal set capped inside the same transaction rather than waiting
    // for the next enqueue to sweep it.
    if (to === "completed" || to === "failed" || to === "canceled") {
      await pruneTerminalJobsLocked();
    }
    return updated;
  });
}

/** Pause a pending or running job. */
export function pauseJob(id: string, now?: () => string): Promise<PersistedJob> {
  return setJobStatus(id, "paused", {}, now);
}

/**
 * Cold-start recovery is local only. Preserve committed progress and invalidate
 * the interrupted owner's queued callbacks; ordinary user Pause may drain its
 * current batch, but an owner from the previous worker may not dispatch again.
 */
export async function pauseInterruptedJobs(now?: () => string): Promise<void> {
  await db.transaction("rw", db.jobs, async () => {
    const jobs = await db.jobs.where("status").anyOf("running", "pending").toArray();
    for (const row of jobs) {
      let job: PersistedJob;
      try {
        job = parseJob(row);
      } catch {
        // An invalid legacy row must not prevent valid jobs from being paused.
        continue;
      }
      await db.jobs.put({
        ...job,
        status: "paused",
        ownerGeneration: job.ownerGeneration + 1,
        controlRevision: job.controlRevision + 1,
        updatedAt: nowIso(now),
      });
    }
  });
}

/** Resume a paused job. */
export async function resumeJob(
  id: string,
  now?: () => string,
  expectedControlRevision?: number,
): Promise<PersistedJob> {
  const requested = await requireJob(id);
  if (expectedControlRevision === undefined && !canTransition(requested.status, "running")) {
    throw new JobQueueError("illegal_transition", `Cannot move a ${requested.status} job to running.`);
  }
  const revision = expectedControlRevision ?? requested.controlRevision;
  // Shared by JOB_RESUME and RESTRUCTURE_RESUME: never flip intent or read
  // the restart offset until the existing owner's paused batch has settled.
  await waitForJob(id);
  return db.transaction("rw", db.jobs, async () => {
    const job = await requireJob(id);
    if (job.controlRevision !== revision ||
      (job.status !== "paused" && job.status !== "pending" && job.status !== "running")) return job;
    return setJobStatus(id, "running", {}, now);
  });
}

/** Cancel a non-terminal job. */
export function cancelJob(id: string, now?: () => string): Promise<PersistedJob> {
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
  ownerGeneration?: number,
): Promise<PersistedJob> {
  return db.transaction("rw", db.jobs, async () => {
    const job = await requireJob(id);
    if (ownerGeneration !== undefined && !ownedWritable(job, ownerGeneration, true)) return job;
    if (job.status !== "running" && job.status !== "paused" && job.status !== "pending") return job;
    if (progressRegresses(job, progress)) return job;
    const updated = parseJob({
      ...job,
      progress,
      usage,
      updatedAt: nowIso(now),
    });
    await db.jobs.put(updated);
    return updated;
  });
}

/**
 * Merge committed per-bookmark restructure assignments into the job's plan —
 * keyed by `bookmarkId`, last write wins, so a resume after a mid-batch
 * suspension never duplicates an assignment. Rejects non-restructure jobs
 * and unknown rows via `Job.parse`.
 */
export async function mergeRestructureAssignments(
  id: string,
  rows: readonly RestructureAssignment[],
  now?: () => string,
  ownerGeneration?: number,
): Promise<PersistedJob> {
  return db.transaction("rw", db.jobs, async () => {
    const job = await requireJob(id);
    if (ownerGeneration !== undefined && job.ownerGeneration !== ownerGeneration) return job;
    if (job.status !== "running" && job.status !== "paused" && job.status !== "pending") return job;
    if (job.kind !== "restructure" || job.restructure === undefined) {
      throw new JobQueueError(
        "illegal_transition",
        "Only a restructure job carries assignments.",
      );
    }
    const merged = new Map(
      job.restructure.assignments.map((a) => [a.bookmarkId, a]),
    );
    for (const row of rows) merged.set(row.bookmarkId, row);
    const updated = parseJob({
      ...job,
      restructure: {
        proposal: job.restructure.proposal,
        assignments: [...merged.values()],
      },
      updatedAt: nowIso(now),
    });
    await db.jobs.put(updated);
    return updated;
  });
}

/**
 * Roll up a job's `usage` rows (those carrying its `jobId`) into a
 * `JobUsage`: summed tokens, request count, and the summed USD cost only when
 * at least one response reported a cost — mirroring `UsageMeter.costUsd`
 * ("no cost data" is `undefined`, never `$0.00`).
 */
export async function jobUsageRollup(id: string): Promise<JobUsage> {
  // A08: the job's current-month detail lives in `usage`; any expired
  // month has already folded into its (jobId, month) `usageMonths` rows —
  // both carry the `jobId` index, so the job's totals never degrade.
  const [rows, rollups] = await Promise.all([
    db.usage.where("jobId").equals(id).toArray(),
    db.usageMonths.where("jobId").equals(id).toArray(),
  ]);
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawCost = false;
  let requests = 0;
  for (const row of rows) {
    requests += 1;
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    if (row.costUsd !== undefined) {
      sawCost = true;
      costUsd += row.costUsd;
    }
  }
  for (const roll of rollups) {
    requests += roll.requests;
    inputTokens += roll.inputTokens;
    outputTokens += roll.outputTokens;
    if (roll.costUsd !== undefined) {
      sawCost = true;
      costUsd += roll.costUsd;
    }
  }
  return JobUsage.parse({
    inputTokens,
    outputTokens,
    requests,
    ...(sawCost ? { costUsd } : {}),
  });
}
