import { estimateTokens } from "../jev/budget";
import {
  NEAR_DUPLICATE_PAIR_LIMIT,
  planNearDuplicates,
} from "../decisions/near-duplicate-plan";
import type { NearDuplicatePlan } from "../decisions/near-duplicate-plan";
import type {
  BatchCostEstimate,
  JobCostEstimate,
  JobKind,
} from "../schemas/job";

/**
 * Pre-run cost estimation for batch jobs (spec FR7 "before a job starts, show
 * a cost estimate derived from the token estimate"; PROJECT_PLAN.md §8.3;
 * improvement I06). Pure module — no `chrome`, DOM, React, `fetch`, clock, or
 * Dexie access — so the estimate can be computed anywhere (including the side
 * panel before the job is queued).
 *
 * The TOKEN estimate is a LOWER BOUND: it folds `estimateTokens` over the
 * per-batch bookmark payloads (`{title, url}`, the minimized shape the
 * pipeline sends) and ignores the fixed question/candidate scaffolding the
 * pipeline adds to each request. That is deliberate — the bookmark payload is
 * the only part that scales with the selection, so the estimate tracks the
 * marginal cost of adding bookmarks while staying a pure function of the
 * input.
 *
 * The REQUEST estimate counts every AI request the job will make: one per
 * bookmark plus, for a `library_scan`, one per near-duplicate pair the same
 * bounded planner the runner/enqueue use would select. A `truncated` plan is
 * a bounded shortlist (see {@link NEAR_DUPLICATE_PAIR_LIMIT}), so the request
 * count for a large library is itself a lower bound.
 */

/** The default batch size shared with `src/jobs/queue.ts` and the runner. */
export const DEFAULT_BATCH_SIZE = 5;

/** The minimal bookmark shape the estimate folds over — never notes. */
export interface EstimateBookmark {
  /** Stable Chrome bookmark id (never sent; identifies pairs). */
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** The canonical estimate shapes live in `schemas/job` (shared with the start-reply wire contract); re-exported here for the estimate's callers. */
export type { BatchCostEstimate, JobCostEstimate };

export interface EstimateJobCostOptions {
  /** The bookmarks the job will analyze, in order. */
  readonly bookmarks: readonly EstimateBookmark[];
  /**
   * The job kind. A `library_scan` also requests one call per near-duplicate
   * pair; every other kind (or an omitted kind) is bookmark-only.
   */
  readonly kind?: JobKind;
  /** Bookmark batch size; defaults to {@link DEFAULT_BATCH_SIZE}. */
  readonly batchSize?: number;
  /**
   * An already-computed near-duplicate plan to count instead of re-planning.
   * A start path that computed the persisted plan passes it here so the
   * estimate and the row agree and the planner runs once. Ignored unless
   * `kind` is `"library_scan"`.
   */
  readonly plan?: NearDuplicatePlan;
}

/**
 * Estimate a job's input tokens and request count from its work set.
 * Bookmarks are chunked in order into `batchSize` groups and each batch is
 * scored with `estimateTokens` over its `{title, url}` payload; a
 * `library_scan` additionally plans its near-duplicate pairs with the bounded
 * planner and folds each pair into the request count. An empty selection
 * yields zero batches and zero tokens.
 */
export function estimateJobCost(
  options: EstimateJobCostOptions,
): JobCostEstimate {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError("batchSize must be a positive integer.");
  }
  const batches: BatchCostEstimate[] = [];
  for (let start = 0; start < options.bookmarks.length; start += batchSize) {
    const chunk = options.bookmarks.slice(start, start + batchSize);
    batches.push({
      batchIndex: batches.length,
      inputTokens: estimateTokens(
        chunk.map((bookmark) => ({
          title: bookmark.title,
          url: bookmark.url,
        })),
      ),
    });
  }
  const inputTokens = batches.reduce(
    (total, batch) => total + batch.inputTokens,
    0,
  );
  const plan =
    options.kind === "library_scan"
      ? (options.plan ?? planNearDuplicates(options.bookmarks))
      : { pairs: [], comparisons: 0, truncated: false };
  // `totalBatches` mirrors `progress.totalBatches` on the persisted row:
  // bookmark batches plus the pair batches a `library_scan` drives after
  // them, chunked at the same size (`enqueueJob`/`JobRunner` share the
  // formula). `batches[]` stays the bookmark-only token fold — pair batches
  // add requests, not folded input tokens.
  const pairBatches =
    options.kind === "library_scan"
      ? Math.ceil(plan.pairs.length / batchSize)
      : 0;
  return {
    totalBatches: batches.length + pairBatches,
    inputTokens,
    batches,
    requests: options.bookmarks.length + plan.pairs.length,
    pairs: plan.pairs.length,
    comparisons: plan.comparisons,
    truncated: plan.truncated,
    pairLimit: NEAR_DUPLICATE_PAIR_LIMIT,
  };
}
