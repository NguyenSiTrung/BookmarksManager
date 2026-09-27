import { nearDuplicatePairs } from "../decisions/candidates";
import type { NearDuplicatePair } from "../decisions/candidates";
import { scanNearDuplicatePairs } from "../decisions/duplicates";
import type { DuplicateScanResult } from "../decisions/duplicates";
import { analyzeBookmark } from "../decisions/pipeline";
import type {
  AnalysisBookmark,
  AnalysisCheck,
  AnalysisContext,
  AnalyzeBookmarkResult,
} from "../decisions/pipeline";
import { db } from "../db/database";
import type { Job } from "../schemas/job";
import type { PresetId } from "../schemas/provider";
import type { UsageRecord } from "../schemas/usage";
import {
  bookmarkChecks,
  commitJobProgress,
  computeTotalBatches,
  getJob,
  jobChecks,
  jobRunsNearDuplicate,
  jobUsageRollup,
  setJobStatus,
} from "./queue";

/**
 * Job runner (spec FR7): the batch loop that drives a persisted `Job` to
 * completion. The `jobs` row is the single source of truth — the runner reads
 * the work set and the committed-batch count from it, processes each batch,
 * and only advances `progress.committedBatches` AFTER the batch's results
 * (decisions + usage rows) are durably written. A fresh runner instance over
 * the same Dexie state therefore resumes from the last committed batch and
 * never re-sends an already-committed batch.
 *
 * Pause and cancel are observed at a batch boundary: the runner re-reads the
 * row before each batch and stops when the status is no longer `running`.
 * A batch that throws is not committed; the job is marked `failed` with a
 * redacted, content-free error (only the failure's `code`, never its message
 * or any bookmark content) — but only when the job is still `running`, so a
 * pause/cancel that landed during the same batch wins and no illegal
 * transition is attempted.
 *
 * A `library_scan` runs a SECOND phase after its per-bookmark batches: the
 * library-wide near-duplicate pair scan (FR7). The runner computes the pairs
 * (`nearDuplicatePairs`) and drives them in `batchSize`-sized pair batches
 * through an injected `JobScanDuplicatesFn`, under the same
 * snapshot-then-mutate commit discipline — so a resume slices the pairs
 * deterministically and never re-sends a committed pair batch. An
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
}

/** Statuses from which a job can no longer be run. */
const TERMINAL: ReadonlySet<Job["status"]> = new Set([
  "completed",
  "failed",
  "canceled",
]);

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
    await db.usage.add({ ...rest, jobId });
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
function failureCode(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/** A redacted, content-free failure message for the `failed` job row. */
function redactFailure(cause: unknown): string {
  const code = failureCode(cause);
  return code === undefined
    ? "The job failed while analyzing a bookmark."
    : `The job failed while analyzing a bookmark (${code}).`;
}

/**
 * Drives one persisted job through its batches. Construct with the analysis
 * dependency; call {@link JobRunner.run} per job.
 */
export class JobRunner {
  readonly #analyze: JobAnalyzeFn;
  readonly #scanDuplicates: JobScanDuplicatesFn | undefined;
  readonly #now: (() => string) | undefined;

  constructor(deps: {
    readonly analyze: JobAnalyzeFn;
    /** The near-duplicate pair-phase dependency; a library_scan needs it. */
    readonly scanDuplicates?: JobScanDuplicatesFn;
    readonly now?: () => string;
  }) {
    this.#analyze = deps.analyze;
    this.#scanDuplicates = deps.scanDuplicates;
    this.#now = deps.now;
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

    const bookmarks = options.bookmarks;
    if (bookmarks.length === 0) {
      throw new JobRunnerError(
        "no_work_set",
        "The job has no bookmarks to process.",
      );
    }
    if (job.bookmarkIds !== undefined) {
      const expected = job.bookmarkIds;
      const matches =
        expected.length === bookmarks.length &&
        expected.every((id, index) => id === bookmarks[index]?.id);
      if (!matches) {
        throw new JobRunnerError(
          "invalid_input",
          "The supplied bookmarks do not match the job's persisted bookmarkIds.",
        );
      }
    }

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

    // The per-bookmark batches come first, then the library-wide near-duplicate
    // pair batches (a `library_scan` only). Pairs are computed from the stable
    // work set, so a resume slices them exactly as the original run did.
    const bookmarkBatchCount = computeTotalBatches(bookmarks.length, batchSize);
    const pairs = jobRunsNearDuplicate(job.kind)
      ? nearDuplicatePairs(bookmarks)
      : [];
    const pairBatchCount = computeTotalBatches(pairs.length, batchSize);
    const totalBatches = bookmarkBatchCount + pairBatchCount;

    const startBatch = job.progress.committedBatches;
    if (startBatch > totalBatches) {
      throw new JobRunnerError(
        "invalid_input",
        "The committed-batch count exceeds the batch count for this work set.",
      );
    }

    job = await setJobStatus(
      jobId,
      "running",
      { progress: { ...job.progress, totalBatches } },
      this.#now,
    );
    const checks = bookmarkChecks(jobChecks(job.kind));

    for (let index = startBatch; index < totalBatches; index += 1) {
      // Batch boundary: a pause/cancel that landed during the previous batch
      // is observed here, before any further work is sent.
      const current = await getJob(jobId);
      if (current === undefined || current.status !== "running") {
        return current ?? job;
      }

      try {
        if (index < bookmarkBatchCount) {
          const batch = bookmarks.slice(
            index * batchSize,
            (index + 1) * batchSize,
          );
          for (const bookmark of batch) {
            const result = await this.#analyze({
              bookmark,
              job: current,
              checks,
            });
            await attachUsageToJob(result.sent ? result.usage : null, jobId);
          }
        } else if (scanDuplicates !== undefined) {
          const pairIndex = index - bookmarkBatchCount;
          const batch = pairs.slice(
            pairIndex * batchSize,
            (pairIndex + 1) * batchSize,
          );
          const result = await scanDuplicates({ pairs: batch, job: current });
          await attachScanUsageToJob(result, jobId);
        }
      } catch (cause) {
        // A pause/cancel may have landed during this batch. Only a job that is
        // still `running` may move to `failed`; otherwise that transition is
        // illegal, so return the current row unchanged (redaction preserved).
        const latest = await getJob(jobId);
        if (latest === undefined || latest.status !== "running") {
          return latest ?? job;
        }
        return await setJobStatus(
          jobId,
          "failed",
          { error: redactFailure(cause) },
          this.#now,
        );
      }

      // Every result in the batch is durable now — commit the progress. The
      // processed count tracks the bookmarks the committed per-bookmark
      // batches covered, so it saturates at the work-set size once the pair
      // phase begins.
      const committedBatches = index + 1;
      const committedBookmarkBatches = Math.min(
        committedBatches,
        bookmarkBatchCount,
      );
      const progress = {
        totalBatches,
        committedBatches,
        processedCount: Math.min(
          committedBookmarkBatches * batchSize,
          bookmarks.length,
        ),
      };
      const usage = await jobUsageRollup(jobId);
      job = await commitJobProgress(jobId, progress, usage, this.#now);
    }

    const last = await getJob(jobId);
    if (last === undefined || last.status !== "running") {
      return last ?? job;
    }
    return await setJobStatus(
      jobId,
      "completed",
      {
        progress: {
          totalBatches,
          committedBatches: totalBatches,
          processedCount: bookmarks.length,
        },
        usage: await jobUsageRollup(jobId),
      },
      this.#now,
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
  readonly preset: PresetId;
  readonly model: string;
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
  return ({ bookmark, checks }) =>
    analyzeBookmark({
      bookmark,
      context: options.context,
      preset: options.preset,
      model: options.model,
      checks,
    });
}

export interface DuplicateScannerOptions {
  readonly preset: PresetId;
  readonly model: string;
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
  return ({ pairs }) =>
    scanNearDuplicatePairs({
      pairs,
      preset: options.preset,
      model: options.model,
    });
}
