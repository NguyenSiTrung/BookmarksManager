import { estimateTokens } from "../jev/budget";
import {
  NEAR_DUPLICATE_PAIR_LIMIT,
  planNearDuplicates,
} from "../decisions/near-duplicate-plan";
import type { JobKind } from "../schemas/job";

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

/** One batch's estimated input tokens. */
export interface BatchCostEstimate {
  readonly batchIndex: number;
  readonly inputTokens: number;
}

/** The whole-job estimate: batch breakdown, token total, and request counts. */
export interface JobCostEstimate {
  /** Bookmark batches the token fold covers. */
  readonly totalBatches: number;
  /** Lower-bound input tokens over the minimized bookmark payloads. */
  readonly inputTokens: number;
  readonly batches: readonly BatchCostEstimate[];
  /** Total AI requests: one per bookmark plus one per planned pair. */
  readonly requests: number;
  /** Near-duplicate pairs the scan will request (the bounded shortlist). */
  readonly pairs: number;
  /** Candidate attempts the planner made while selecting those pairs. */
  readonly comparisons: number;
  /** `true` when the pair plan is bounded — more pairs may exist. */
  readonly truncated: boolean;
  /** The planner's pair cap, so the UI can disclose the truncation scope. */
  readonly pairLimit: number;
}

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
      ? planNearDuplicates(options.bookmarks)
      : { pairs: [], comparisons: 0, truncated: false };
  return {
    totalBatches: batches.length,
    inputTokens,
    batches,
    requests: options.bookmarks.length + plan.pairs.length,
    pairs: plan.pairs.length,
    comparisons: plan.comparisons,
    truncated: plan.truncated,
    pairLimit: NEAR_DUPLICATE_PAIR_LIMIT,
  };
}
