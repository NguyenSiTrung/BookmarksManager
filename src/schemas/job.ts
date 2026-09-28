import { z } from "./z";
import { DEFAULT_BATCH_SIZE } from "../jobs/estimate";
import { RestructureProposal, RestructureAssignment } from "./restructure";

/**
 * A persisted, resumable batch job (spec FR7, PROJECT_PLAN.md §7). Jobs live
 * in the Dexie `jobs` table so they survive an MV3 service-worker restart and
 * can be paused or canceled from the UI. The row carries everything needed to
 * resume: what to process (`bookmarkIds` and/or a `cursor`), how far it got
 * (`progress`), the tokens/cost it has spent so far (`usage`), and the
 * `batchSize` the job was enqueued with — so a resume slices the work set
 * exactly as the original run did and can neither skip nor re-send a batch.
 */

/**
 * The two job kinds: an ad-hoc selection analysis (categorize + tags) or a
 * whole-library scan (categorize + tags, misfiled, near-duplicate).
 */
export const JobKind = z.enum([
  "analyze_selection",
  "library_scan",
  "restructure",
]);
export type JobKind = z.infer<typeof JobKind>;

/** The closed job lifecycle. */
export const JobStatus = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "canceled",
  "failed",
]);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * Committed-batch progress. `committedBatches` counts only batches whose
 * results were durably written, so a restart resumes from the last commit
 * rather than replaying a half-written batch. `processedCount` is the number
 * of bookmarks the committed batches covered.
 */
export const JobProgress = z.strictObject({
  totalBatches: z.number().int().min(0),
  committedBatches: z.number().int().min(0),
  processedCount: z.number().int().min(0),
});
export type JobProgress = z.infer<typeof JobProgress>;

/**
 * Per-job usage roll-up (FR8). Mirrors the `UsageMeter` totals: summed input
 * and output tokens, the summed USD cost when the provider reported one
 * (`costUsd` stays absent when no response did), and the number of requests
 * folded in. The `usage` table keeps the per-request rows this summarises.
 */
export const JobUsage = z.strictObject({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
  requests: z.number().int().min(0),
});
export type JobUsage = z.infer<typeof JobUsage>;

/**
 * The `restructure` job's carried plan (spec FR8.10): the LLM proposal that
 * was vetted once at enqueue (never re-sent on resume) plus the per-bookmark
 * assignments Jev has committed so far — keyed by bookmarkId, last write
 * wins, so resuming after a mid-batch suspension can neither duplicate an
 * assignment nor lose a committed one.
 */
export const RestructureJobPlan = z.strictObject({
  proposal: RestructureProposal,
  assignments: z.array(RestructureAssignment),
});
export type RestructureJobPlan = z.infer<typeof RestructureJobPlan>;

/**
 * One `jobs` row. `id` is a caller-generated uuid (the job service owns it);
 * `bookmarkIds` is the explicit work set, while `cursor` is an opaque
 * resumption offset for very large scans — at least one of the two must be
 * present so a job is always resumable. `batchSize` is the bookmark batch size
 * the job was enqueued with; it is the single source of truth a resume slices
 * by, so it can never re-send or skip a committed batch. `error` is populated
 * only for a `failed` job. `createdAt`/`updatedAt` are ISO timestamps;
 * `updatedAt` moves on every status/progress write.
 */
export const Job = z
  .strictObject({
    id: z.uuid(),
    kind: JobKind,
    status: JobStatus,
    progress: JobProgress,
    batchSize: z.number().int().positive().default(DEFAULT_BATCH_SIZE),
    bookmarkIds: z.array(z.string().min(1)).optional(),
    cursor: z.number().int().min(0).optional(),
    usage: JobUsage,
    /**
     * `restructure` jobs only: the vetted proposal + committed assignments.
     * Required on a `restructure` job, rejected on any other kind.
     */
    restructure: RestructureJobPlan.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    error: z.string().max(1_000).optional(),
  })
  .superRefine((job, ctx) => {
    if (job.bookmarkIds === undefined && job.cursor === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["bookmarkIds"],
        message: "a job must carry a bookmark id set or a cursor to resume from",
      });
    }
    if (job.bookmarkIds !== undefined && job.bookmarkIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["bookmarkIds"],
        message: "bookmarkIds must be non-empty when present",
      });
    }
    if (job.progress.committedBatches > job.progress.totalBatches) {
      ctx.addIssue({
        code: "custom",
        path: ["progress", "committedBatches"],
        message: "committedBatches must not exceed totalBatches",
      });
    }
    if (job.kind === "restructure" && job.restructure === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["restructure"],
        message: "a restructure job must carry its vetted proposal",
      });
    }
    if (job.kind !== "restructure" && job.restructure !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["restructure"],
        message: "only a restructure job may carry a plan",
      });
    }
  });
export type Job = z.infer<typeof Job>;
