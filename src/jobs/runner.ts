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
import { DEFAULT_BATCH_SIZE } from "./estimate";
import {
  commitJobProgress,
  computeTotalBatches,
  getJob,
  jobChecks,
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
 * or any bookmark content).
 *
 * The per-bookmark work is an injected `JobAnalyzeFn`; `createPipelineAnalyzer`
 * adapts the real `analyzeBookmark` pipeline, and tests inject a fake.
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

export interface RunJobOptions {
  /** The resolved, ordered work set (ids must match `job.bookmarkIds`). */
  readonly bookmarks: readonly AnalysisBookmark[];
  /** Batch size; must match the size used to enqueue the job. */
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
  readonly #now: (() => string) | undefined;

  constructor(deps: { readonly analyze: JobAnalyzeFn; readonly now?: () => string }) {
    this.#analyze = deps.analyze;
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

    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const totalBatches = computeTotalBatches(bookmarks.length, batchSize);
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
    const checks = jobChecks(job.kind);

    for (let index = startBatch; index < totalBatches; index += 1) {
      // Batch boundary: a pause/cancel that landed during the previous batch
      // is observed here, before any further work is sent.
      const current = await getJob(jobId);
      if (current === undefined || current.status !== "running") {
        return current ?? job;
      }

      const batch = bookmarks.slice(index * batchSize, (index + 1) * batchSize);
      try {
        for (const bookmark of batch) {
          const result = await this.#analyze({ bookmark, job: current, checks });
          await attachUsageToJob(result.sent ? result.usage : null, jobId);
        }
      } catch (cause) {
        return await setJobStatus(
          jobId,
          "failed",
          { error: redactFailure(cause) },
          this.#now,
        );
      }

      // Every result in the batch is durable now — commit the progress.
      const committedBatches = index + 1;
      const progress = {
        totalBatches,
        committedBatches,
        processedCount: Math.min(committedBatches * batchSize, bookmarks.length),
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
    readonly now?: () => string;
  },
): Promise<Job> {
  return new JobRunner({
    analyze: options.analyze,
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
 * bookmark is analyzed with the job kind's checks (categorize + tags for an
 * analyze-selection; + misfiled for a library scan).
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
