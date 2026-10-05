import type { NearDuplicatePair, NearDuplicateSide } from "../decisions/candidates";
import { planNearDuplicates } from "../decisions/near-duplicate-plan";
import { scanNearDuplicatePairs } from "../decisions/duplicates";
import type { DuplicateScanResult } from "../decisions/duplicates";
import { analyzeBookmark } from "../decisions/pipeline";
import type {
  AnalysisBookmark,
  AnalysisCheck,
  AnalysisContext,
  AnalyzeBookmarkResult,
} from "../decisions/pipeline";
import { extractDomain } from "../search/index";
import { db } from "../db/database";
import { appendUsage } from "../db/retention";
import type { Job, NearDuplicatePlanPair } from "../schemas/job";
import type { UsageRecord } from "../schemas/usage";
import {
  attachNearDuplicatePlan,
  bookmarkChecks,
  claimJobOwner,
  commitJobProgress,
  computeTotalBatches,
  getJob,
  JOB_BREAKER_DELAY_MS,
  JOB_BREAKER_THRESHOLD,
  jobChecks,
  jobRunsNearDuplicate,
  jobUsageRollup,
  recordJobItemFailure,
  setJobStatus,
} from "./queue";
import type { PersistedJob } from "./queue";

/**
 * Job runner (spec FR7): the batch loop that drives a persisted `Job` to
 * completion. The `jobs` row is the single source of truth — the runner reads
 * the work set and the committed-batch count from it, processes each batch,
 * and only advances `progress.committedBatches` AFTER the batch's results
 * (decisions + usage rows) are durably written. A fresh runner instance over
 * the same Dexie state therefore resumes from the last committed batch and
 * never re-sends an already-committed batch.
 *
 * Pause, cancel, and owner replacement are honored at every ITEM boundary
 * (J02/J09): the next bookmark request never fires while any of them is
 * live — pause does not drain the rest of the batch. The interrupted
 * batch's durable per-item writes stand but it is not committed, so a
 * resume replays it (at-least-once resumption, not exactly-once external
 * billing — J04's deterministic decision ids make the replay idempotent).
 * A batch-level infrastructure throw (durability, work-set resolution) is
 * not committed; the job is marked `failed` with a redacted, content-free
 * error (only the failure's `code`, never its message or any bookmark
 * content) — but only when the job is still `running`, so a pause/cancel
 * that landed during the same batch wins and no illegal transition is
 * attempted. A `failed` row is resumable: `run` claims a fresh owner and
 * continues from `committedBatches` (J01). Per-bookmark item failures are
 * instead recorded on the row's `itemFailures` ring and skipped (J01);
 * a burst of `retry_later` throttles opens the persisted `breaker`, which
 * delays the next item until `openUntil` (J09).
 *
 * A `library_scan` runs a SECOND phase after its per-bookmark batches: the
 * library-wide near-duplicate pair scan (FR7). The runner drives the DURABLE
 * pair work plan persisted on the row (`job.nearDuplicatePlan`, pair IDs
 * only) in `batchSize`-sized pair batches through an injected
 * `JobScanDuplicatesFn`, under the same snapshot-then-mutate commit
 * discipline — so a resume slices the STORED pairs deterministically and can
 * neither re-plan (editing titles between runs cannot shift the offsets) nor
 * re-send a committed pair batch. A legacy `library_scan` enqueued without a
 * plan acquires exactly one on its first uncommitted run; a legacy row that
 * already committed a batch cannot be reinterpreted and fails typed. An
 * `analyze_selection` never runs this phase.
 *
 * The per-bookmark work is an injected `JobAnalyzeFn`; `createPipelineAnalyzer`
 * adapts the real `analyzeBookmark` pipeline, `createDuplicateScanner` adapts
 * the real near-duplicate scan, and tests inject fakes.
 */

/** The `code` values on a runner failure. */
export type JobRunnerErrorCode =
  | "not_found"
  | "invalid_state"
  | "no_work_set"
  | "invalid_input";

/** Rejection for every failure this module produces. Messages stay redacted. */
export class JobRunnerError extends Error {
  readonly code: JobRunnerErrorCode;

  constructor(code: JobRunnerErrorCode, message: string) {
    super(message);
    this.name = "JobRunnerError";
    this.code = code;
  }
}

/** One bookmark's analysis request, plus its job context. */
export interface JobAnalyzeInput {
  readonly bookmark: AnalysisBookmark;
  readonly job: Job;
  /** The checks the job kind asks for (see `jobChecks`). */
  readonly checks: readonly AnalysisCheck[];
}

/** Analyze one bookmark on behalf of a job. */
export type JobAnalyzeFn = (
  input: JobAnalyzeInput,
) => Promise<AnalyzeBookmarkResult>;

/** One pair batch's near-duplicate scan request, plus its job context. */
export interface JobScanDuplicatesInput {
  /** The pair batch to scan (a deterministic slice of the library's pairs). */
  readonly pairs: readonly NearDuplicatePair[];
  readonly job: Job;
}

/** Scan one batch of near-duplicate pairs on behalf of a job. */
export type JobScanDuplicatesFn = (
  input: JobScanDuplicatesInput,
) => Promise<DuplicateScanResult>;

export interface RunJobOptions {
  /** The resolved, ordered work set (ids must match `job.bookmarkIds`). */
  readonly bookmarks: readonly AnalysisBookmark[];
  /**
   * Optional assertion of the batch size. The job's persisted `batchSize` is
   * authoritative — the runner slices and computes `totalBatches` from it — so
   * this is only accepted when it equals that value; a mismatch is rejected
   * with `invalid_input` (fail closed) rather than silently re-slicing, which
   * could skip or re-send a committed batch.
   */
  readonly batchSize?: number;
  /** Already claimed by the coordinated production entry before async setup. */
  readonly ownerGeneration?: number;
}

/** Statuses from which a job can never be run again. `failed` is
 * resumable (J01) — it re-enters through the owner claim below. */
const TERMINAL: ReadonlySet<Job["status"]> = new Set([
  "completed",
  "canceled",
]);

/**
 * Failure codes that end the JOB rather than the item (J01): egress-gate
 * refusals that revoke every future send (consent/key/permission revoked
 * mid-scan), permanently broken provider configuration, and the
 * pipeline's own contract failures. Every other analyzer error —
 * `retry_later`, `timeout`, `transport`, `http_error`, `invalid_response`,
 * `answer_mismatch`, `apply_failed`, `stale`, `bookmark_gone`, unknowns —
 * is a per-ITEM outcome: recorded on the row and skipped.
 */
const JOB_FATAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "unregistered_scope",
  "request_not_allowed",
  "unlisted_model",
  "https_only",
  "unlisted_origin",
  "no_consent",
  "no_permission",
  "no_key",
  "auth",
  "incompatible",
  "model_mismatch",
  "invalid_request",
  "invalid_input",
  "persist_failed",
  "provider",
  "budget_exceeded",
  "illegal_transition",
]);

/** Longest single in-worker wait while the breaker is open (J09). MV3
 * kills an idle worker around 30s — each chunk re-checks the row, so a
 * pause/cancel is still honored at the next item boundary. */
const BREAKER_WAIT_CHUNK_MS = 15_000;

function isoNow(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))();
}

/**
 * Attach a job's `jobId` to the `usage` row an analysis persisted, so the
 * job's usage roll-up picks it up. The pipeline writes the row without a
 * `jobId` (it does not know the job); the runner links it. When the analyzer
 * returns a row without an id (a custom analyzer), it is added fresh.
 */
async function attachUsageToJob(
  usage: UsageRecord | null,
  jobId: string,
): Promise<void> {
  if (usage === null) return;
  const { id, ...rest } = usage;
  if (id === undefined) {
    await appendUsage({ ...rest, jobId });
    return;
  }
  await db.usage.update(id, { jobId });
}

/**
 * Link every `usage` row a scan persisted to the job. The near-duplicate
 * service writes one row per pair egress without a `jobId` (it does not know
 * the job); the runner links each. Rows without an id (a custom scanner) are
 * added fresh.
 */
async function attachScanUsageToJob(
  result: DuplicateScanResult,
  jobId: string,
): Promise<void> {
  if (!result.sent) return;
  for (const row of result.usage) {
    await attachUsageToJob(row, jobId);
  }
}

/** Extract a content-free failure code from a thrown cause, if any. */
export function failureCode(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/** A redacted, content-free failure message for the `failed` job row. */
export function redactFailure(cause: unknown): string {
  const code = failureCode(cause);
  return code === undefined
    ? "The job failed while analyzing a bookmark."
    : `The job failed while analyzing a bookmark (${code}).`;
}

/** One planned pair side, re-hydrated from the live work set. */
function toPairSide(bookmark: AnalysisBookmark): NearDuplicateSide {
  return {
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    domain: extractDomain(bookmark.url),
  };
}

/**
 * Re-hydrate the persisted near-duplicate work plan (pair IDs only) into the
 * scanner's `NearDuplicatePair`s, preserving the plan's order. Titles/URLs/
 * domains come from the CURRENT work set for the planned IDs, so the pair
 * SET and its slicing are frozen even when a title was edited since enqueue.
 * A plan that references an id outside the work set is a caller error, never
 * silently dropped (which would shift every later batch offset).
 */
function hydrateNearDuplicatePairs(
  pairs: readonly NearDuplicatePlanPair[],
  bookmarks: readonly AnalysisBookmark[],
): NearDuplicatePair[] {
  const byId = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  return pairs.map((pair) => {
    const first = byId.get(pair.a);
    const second = byId.get(pair.b);
    if (first === undefined || second === undefined) {
      throw new JobRunnerError(
        "invalid_input",
        "The stored near-duplicate plan references a bookmark outside the job's work set.",
      );
    }
    return {
      a: toPairSide(first),
      b: toPairSide(second),
      titleSimilarity: 0,
    };
  });
}

/**
 * Drives one persisted job through its batches. Construct with the analysis
 * dependency; call {@link JobRunner.run} per job.
 */
export class JobRunner {
  readonly #analyze: JobAnalyzeFn;
  readonly #scanDuplicates: JobScanDuplicatesFn | undefined;
  readonly #now: (() => string) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: {
    readonly analyze: JobAnalyzeFn;
    /** The near-duplicate pair-phase dependency; a library_scan needs it. */
    readonly scanDuplicates?: JobScanDuplicatesFn;
    readonly now?: () => string;
    /** Injectable wait for the breaker's delayed resume (tests fake it). */
    readonly sleep?: (ms: number) => Promise<void>;
  }) {
    this.#analyze = deps.analyze;
    this.#scanDuplicates = deps.scanDuplicates;
    this.#now = deps.now;
    this.#sleep =
      deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Read the live row for the next item boundary (J09): waits out the
   * persisted breaker (`openUntil`), in chunks capped under the MV3 idle
   * limit, re-reading the row after every wait so a pause/cancel/owner
   * replacement is honored per item. Returns `undefined` when this owner
   * may no longer send (paused, canceled, terminal, or superseded).
   */
  async #nextItem(
    jobId: string,
    ownerGeneration: number,
  ): Promise<PersistedJob | undefined> {
    for (;;) {
      const live = await getJob(jobId);
      if (
        live === undefined ||
        live.ownerGeneration !== ownerGeneration ||
        live.status !== "running"
      ) {
        return undefined;
      }
      const openUntil = live.breaker?.openUntil;
      const nowMs = Date.parse(isoNow(this.#now));
      if (openUntil === undefined || Date.parse(openUntil) <= nowMs) {
        return live;
      }
      await this.#sleep(
        Math.min(Date.parse(openUntil) - nowMs, BREAKER_WAIT_CHUNK_MS),
      );
    }
  }

  /**
   * Record one analyzer failure as a per-item outcome (J01/J09): a
   * job-fatal code rethrows (the outer catch marks the job `failed`);
   * anything else is appended to `itemFailures` and skipped. A
   * `retry_later` burst past {@link JOB_BREAKER_THRESHOLD} opens the
   * persisted breaker in the same write. Returns the updated consecutive
   * throttle count (session-local; a restart needs a fresh burst).
   */
  async #recordItemOutcome(
    jobId: string,
    item: string,
    cause: unknown,
    consecutiveThrottles: number,
    ownerGeneration: number,
  ): Promise<number> {
    const code = failureCode(cause) ?? "internal_error";
    if (JOB_FATAL_ERROR_CODES.has(code)) throw cause;
    const throttles = code === "retry_later" ? consecutiveThrottles + 1 : 0;
    const openBreakerUntil =
      throttles >= JOB_BREAKER_THRESHOLD
        ? new Date(
            Date.parse(isoNow(this.#now)) + JOB_BREAKER_DELAY_MS,
          ).toISOString()
        : undefined;
    await recordJobItemFailure(
      jobId,
      {
        item,
        code,
        ...(openBreakerUntil === undefined ? {} : { openBreakerUntil }),
      },
      this.#now,
      ownerGeneration,
    );
    return throttles;
  }

  /**
   * Run (or resume) the job `jobId`. Returns the final job row — `completed`,
   * `paused`/`canceled` (stopped at a batch boundary), or `failed`. Throws
   * `JobRunnerError` only for a caller error (unknown/terminal job, empty work
   * set, or a work set that does not match the persisted ids).
   */
  async run(jobId: string, options: RunJobOptions): Promise<Job> {
    let job = await getJob(jobId);
    if (job === undefined) {
      throw new JobRunnerError("not_found", `No job ${JSON.stringify(jobId)}.`);
    }
    if (TERMINAL.has(job.status)) {
      throw new JobRunnerError(
        "invalid_state",
        `Cannot run a job that is already ${job.status}.`,
      );
    }
    if (job.status === "paused") return job;
    if (options.ownerGeneration !== undefined && job.ownerGeneration !== options.ownerGeneration) return job;

    // The persisted `batchSize` is authoritative: a resume must slice the work
    // set exactly as the original run did, so it can never skip or re-send a
    // committed batch. A differing override is rejected rather than honoured.
    const batchSize = job.batchSize;
    if (options.batchSize !== undefined && options.batchSize !== batchSize) {
      throw new JobRunnerError(
        "invalid_input",
        "The supplied batchSize does not match the job's persisted batchSize.",
      );
    }

    // J02: resume tolerates deleted ids. Committed batches stay positional
    // in the ORIGINAL persisted id list — those items were already
    // processed whether or not they still exist. Only the UNCOMMITTED
    // window (`bookmarkIds` past the committed boundary) is re-sliced,
    // filtered to the live supplied set: a mid-window deletion can never
    // silently skip a live bookmark (re-slicing the WHOLE filtered list
    // would shift later live ids into committed positions). An id OUTSIDE
    // the persisted set still fails typed.
    const supplied = options.bookmarks;
    const liveById = new Map(supplied.map((bookmark) => [bookmark.id, bookmark]));
    let committedBookmarkBatches = 0;
    let bookmarks: readonly AnalysisBookmark[];
    if (job.bookmarkIds !== undefined) {
      const allowed = new Set(job.bookmarkIds);
      if (supplied.some((bookmark) => !allowed.has(bookmark.id))) {
        throw new JobRunnerError(
          "invalid_input",
          "The supplied bookmarks do not match the job's persisted bookmarkIds.",
        );
      }
      const persistedBookmarkBatches = computeTotalBatches(
        job.bookmarkIds.length,
        batchSize,
      );
      committedBookmarkBatches = Math.min(
        job.progress.committedBatches,
        persistedBookmarkBatches,
      );
      bookmarks = job.bookmarkIds
        .slice(committedBookmarkBatches * batchSize)
        .flatMap((id) => {
          const bookmark = liveById.get(id);
          return bookmark === undefined ? [] : [bookmark];
        });
    } else {
      if (supplied.length === 0) {
        throw new JobRunnerError(
          "no_work_set",
          "The job has no bookmarks to process.",
        );
      }
      bookmarks = supplied;
    }
    // A `library_scan` runs the near-duplicate pair phase (FR7); with no
    // injected scanner it could only compute zero pair batches and complete as
    // if the scan were whole — silently reintroducing the very FR7 gap this
    // phase exists to close. Fail closed BEFORE any status change or work is
    // sent. An `analyze_selection` never runs the pair phase, so it is
    // unaffected.
    const scanDuplicates = this.#scanDuplicates;
    if (jobRunsNearDuplicate(job.kind) && scanDuplicates === undefined) {
      throw new JobRunnerError(
        "invalid_input",
        "A library_scan requires a scanDuplicates dependency.",
      );
    }

    // The per-bookmark batches come first, then the library-wide
    // near-duplicate pair batches (a `library_scan` only). A `library_scan`'s
    // pairs come from the DURABLE plan persisted on the row (Task 5): a resume
    // slices exactly the planned work set, so editing titles between runs can
    // neither skip nor re-send a committed pair batch.
    const liveIds = new Set(supplied.map((bookmark) => bookmark.id));

    const runsPairs = jobRunsNearDuplicate(job.kind);
    // `bookmarkBatchCount` is the number of REMAINING bookmark batches
    // (over the filtered uncommitted window); pair batches follow it.
    const bookmarkBatchCount = computeTotalBatches(bookmarks.length, batchSize);
    const bookmarkPhaseEnd = committedBookmarkBatches + bookmarkBatchCount;
    const storedPlan = job.nearDuplicatePlan;
    // The pair plan stays positional in the ORIGINAL persisted list (J02):
    // a committed pair window covers fixed plan positions, and deletions
    // are filtered WITHIN an uncommitted batch — never by re-slicing the
    // plan, which would let a live pair slide into a committed position
    // and be silently skipped.
    let planPairs: readonly NearDuplicatePlanPair[] = [];
    if (runsPairs) {
      if (storedPlan !== undefined) {
        // An endpoint that was never in the persisted work set is a
        // corrupt plan, not a deletion — a typed failure. (Deleted
        // endpoints ARE in the set: a deleted bookmark keeps its id in
        // `bookmarkIds`; a cursor job references the live supplied set.)
        const reference =
          job.bookmarkIds !== undefined
            ? new Set(job.bookmarkIds)
            : liveIds;
        if (
          storedPlan.pairs.some(
            (pair) => !reference.has(pair.a) || !reference.has(pair.b),
          )
        ) {
          throw new JobRunnerError(
            "invalid_input",
            "The stored near-duplicate plan references bookmarks outside the persisted work set.",
          );
        }
        planPairs = storedPlan.pairs;
      } else if (job.progress.committedBatches > 0) {
        // A pre-Task-5 row already committed a batch without a stored plan:
        // its committed offsets may be bookmark OR pair batches, so the pair
        // work set cannot be reconstructed unambiguously. Fail typed rather
        // than silently re-slicing (which could skip or re-send a batch).
        throw new JobRunnerError(
          "invalid_input",
          "A committed library_scan has no stored near-duplicate plan to resume from.",
        );
      }
    }
    let pairBatchCount = runsPairs
      ? computeTotalBatches(planPairs.length, batchSize)
      : 0;
    let totalBatches = bookmarkPhaseEnd + pairBatchCount;

    const claimed = options.ownerGeneration === undefined
      ? await claimJobOwner(jobId, this.#now) : await getJob(jobId);
    if (claimed === undefined) return (await getJob(jobId)) ?? job;
    const ownerGeneration = options.ownerGeneration ?? claimed.ownerGeneration;
    if (claimed.ownerGeneration !== ownerGeneration || claimed.status !== "running") return claimed;

    // A legacy uncommitted library_scan acquires its plan exactly once, now
    // that an owner is claimed. The write is atomic and never overwrites an
    // existing plan, so a racing owner cannot change the work set under us.
    if (runsPairs && storedPlan === undefined) {
      const acquired = await attachNearDuplicatePlan(
        jobId,
        planNearDuplicates(bookmarks),
        this.#now,
        ownerGeneration,
      );
      const persisted = acquired.nearDuplicatePlan;
      if (persisted === undefined) return acquired;
      planPairs = persisted.pairs;
      pairBatchCount = computeTotalBatches(planPairs.length, batchSize);
      totalBatches = bookmarkPhaseEnd + pairBatchCount;
    }

    job = await setJobStatus(
      jobId,
      "running",
      {
        progress: {
          ...claimed.progress,
          // A resume after deletions may recompute fewer batches than are
          // already committed — the stored committed count must stay <= the
          // written total or the row fails its own schema refinement.
          totalBatches: Math.max(totalBatches, claimed.progress.committedBatches),
        },
      },
      this.#now,
      ownerGeneration,
    );
    const startBatch = job.progress.committedBatches;
    const checks = bookmarkChecks(jobChecks(job.kind));
    // Items the committed positional windows covered in the ORIGINAL id
    // list — all real ids, so exact unless the last window was partial.
    const committedBookmarkCount = Math.min(
      committedBookmarkBatches * batchSize,
      job.bookmarkIds?.length ?? 0,
    );

    if (startBatch >= totalBatches) {
      // J02: everything left was deleted (or already committed) — the work
      // set is empty, so end terminal here rather than leave an immortal
      // `running` row.
      return await setJobStatus(
        jobId,
        "completed",
        {
          progress: {
            totalBatches: Math.max(totalBatches, job.progress.committedBatches),
            committedBatches: Math.max(totalBatches, job.progress.committedBatches),
            processedCount: Math.max(
              committedBookmarkCount + bookmarks.length,
              job.progress.processedCount,
            ),
          },
          usage: await jobUsageRollup(jobId),
        },
        this.#now,
        ownerGeneration,
      );
    }

    let consecutiveThrottles = 0;
    for (let index = startBatch; index < totalBatches; index += 1) {
      // Batch boundary: a pause/cancel that landed during the previous batch
      // is observed here, before any further work is sent.
      const current = await getJob(jobId);
      if (current === undefined || current.status !== "running" || current.ownerGeneration !== ownerGeneration) {
        return current ?? job;
      }

      try {
        if (index < bookmarkPhaseEnd) {
          const batch = bookmarks.slice(
            (index - committedBookmarkBatches) * batchSize,
            (index - committedBookmarkBatches + 1) * batchSize,
          );
          for (const bookmark of batch) {
            // The control fence AND the circuit breaker are observed before
            // EVERY paid request (J02/J09): pause, cancel, and owner
            // replacement stop the next item — never deferred to a batch
            // boundary — and an open breaker delays the next item.
            const live = await this.#nextItem(jobId, ownerGeneration);
            if (live === undefined) return (await getJob(jobId)) ?? job;
            let result: AnalyzeBookmarkResult;
            try {
              result = await this.#analyze({
                bookmark,
                job: live,
                checks,
              });
            } catch (cause) {
              consecutiveThrottles = await this.#recordItemOutcome(
                jobId,
                bookmark.id,
                cause,
                consecutiveThrottles,
                ownerGeneration,
              );
              continue;
            }
            await attachUsageToJob(result.sent ? result.usage : null, jobId);
            consecutiveThrottles = 0;
          }
        } else if (scanDuplicates !== undefined) {
          const pairIndex = index - bookmarkPhaseEnd;
          // Deleted-endpoint pairs are filtered WITHIN this positional
          // window — the slicing over the original plan never shifts, so
          // a committed pair window cannot swallow a live pair (J02).
          const liveBatch = planPairs
            .slice(pairIndex * batchSize, (pairIndex + 1) * batchSize)
            .filter((pair) => liveIds.has(pair.a) && liveIds.has(pair.b));
          if (liveBatch.length > 0) {
            const live = await this.#nextItem(jobId, ownerGeneration);
            if (live === undefined) return (await getJob(jobId)) ?? job;
            let result: DuplicateScanResult | undefined;
            try {
              result = await scanDuplicates({
                pairs: hydrateNearDuplicatePairs(liveBatch, supplied),
                job: live,
              });
            } catch (cause) {
              consecutiveThrottles = await this.#recordItemOutcome(
                jobId,
                `pair-batch:${pairIndex}`,
                cause,
                consecutiveThrottles,
                ownerGeneration,
              );
              result = undefined;
            }
            if (result !== undefined) {
              await attachScanUsageToJob(result, jobId);
              consecutiveThrottles = 0;
            }
          }
        }
      } catch (cause) {
        // A pause/cancel may have landed during this batch. Only a job that is
        // still `running` may move to `failed`; otherwise that transition is
        // illegal, so return the current row unchanged (redaction preserved).
        const latest = await getJob(jobId);
        if (latest === undefined || latest.status !== "running" || latest.ownerGeneration !== ownerGeneration) {
          return latest ?? job;
        }
        return await setJobStatus(
          jobId,
          "failed",
          { error: redactFailure(cause) },
          this.#now,
          ownerGeneration,
        );
      }

      // Every result in the batch is durable now — commit the progress. The
      // processed count tracks the bookmarks the committed per-bookmark
      // batches covered: the positional committed window in the ORIGINAL
      // id list plus the remaining items covered so far — so it saturates
      // at the count of items actually processed once the pair phase
      // begins.
      const committedBatches = index + 1;
      const coveredBookmarkBatches = Math.min(
        Math.max(committedBatches - committedBookmarkBatches, 0),
        bookmarkBatchCount,
      );
      const progress = {
        totalBatches,
        committedBatches,
        processedCount:
          committedBookmarkCount +
          Math.min(coveredBookmarkBatches * batchSize, bookmarks.length),
      };
      const usage = await jobUsageRollup(jobId);
      job = await commitJobProgress(jobId, progress, usage, this.#now, ownerGeneration);
    }

    const last = await getJob(jobId);
    if (last === undefined || last.status !== "running" || last.ownerGeneration !== ownerGeneration) {
      return last ?? job;
    }
    return await setJobStatus(
      jobId,
      "completed",
      {
        progress: {
          totalBatches,
          committedBatches: totalBatches,
          processedCount: committedBookmarkCount + bookmarks.length,
        },
        usage: await jobUsageRollup(jobId),
      },
      this.#now,
      ownerGeneration,
    );
  }
}

/** Convenience wrapper around {@link JobRunner.run}. */
export function runJob(
  jobId: string,
  options: RunJobOptions & {
    readonly analyze: JobAnalyzeFn;
    readonly scanDuplicates?: JobScanDuplicatesFn;
    readonly now?: () => string;
  },
): Promise<Job> {
  return new JobRunner({
    analyze: options.analyze,
    ...(options.scanDuplicates === undefined
      ? {}
      : { scanDuplicates: options.scanDuplicates }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }).run(jobId, options);
}

export interface PipelineAnalyzerOptions {
  readonly context: AnalysisContext;
  /** Jev provider the client is bound to — a preset id or `"custom"`. */
  readonly providerId: string;
  readonly model: string;
  /**
   * The user's own blocklist (normalized hosts). A job's analysis skips a
   * user-blocklisted bookmark exactly like a built-in-sensitive one. Absent
   * means the user has added no entries.
   */
  readonly userBlocklist?: readonly string[];
}

/**
 * Adapt the real `analyzeBookmark` pipeline into a {@link JobAnalyzeFn}: each
 * bookmark is analyzed with the job kind's per-bookmark checks (categorize +
 * tags for an analyze-selection; + misfiled for a library scan). The
 * library-wide near-duplicate pair phase is a separate dependency
 * ({@link createDuplicateScanner}).
 */
export function createPipelineAnalyzer(
  options: PipelineAnalyzerOptions,
): JobAnalyzeFn {
  return ({ bookmark, checks, job }) =>
    analyzeBookmark({
      bookmark,
      context: options.context,
      providerId: options.providerId,
      model: options.model,
      checks,
      job: { id: job.id, ownerGeneration: job.ownerGeneration ?? 0 },
      ...(options.userBlocklist === undefined
        ? {}
        : { userBlocklist: options.userBlocklist }),
    });
}

export interface DuplicateScannerOptions {
  /** Jev provider the client is bound to — a preset id or `"custom"`. */
  readonly providerId: string;
  readonly model: string;
  /**
   * The user's own blocklist (normalized hosts). A pair with a side on a
   * user-blocklisted host is skipped exactly like a built-in-sensitive one.
   * Absent means the user has added no entries.
   */
  readonly userBlocklist?: readonly string[];
}

/**
 * Adapt the real near-duplicate scan service (`scanNearDuplicatePairs`) into a
 * {@link JobScanDuplicatesFn}: the runner slices the library's pairs and this
 * scans one batch — one `jev_decisions` request per pair, one
 * `merge_duplicates` decision and one `usage` row per sendable pair.
 */
export function createDuplicateScanner(
  options: DuplicateScannerOptions,
): JobScanDuplicatesFn {
  return ({ pairs, job }) =>
    scanNearDuplicatePairs({
      pairs,
      job: { id: job.id, ownerGeneration: job.ownerGeneration ?? 0 },
      providerId: options.providerId,
      model: options.model,
      ...(options.userBlocklist === undefined
        ? {}
        : { userBlocklist: options.userBlocklist }),
    });
}
