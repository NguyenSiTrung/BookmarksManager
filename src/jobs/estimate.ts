import { estimateTokens } from "../jev/budget";

/**
 * Pre-run cost estimation for batch jobs (spec FR7 "before a job starts, show
 * a cost estimate derived from the token estimate"; PROJECT_PLAN.md §8.3).
 * Pure module — no `chrome`, DOM, React, `fetch`, clock, or Dexie access — so
 * the estimate can be computed anywhere (including the side panel before the
 * job is queued).
 *
 * The estimate is a LOWER BOUND: it folds `estimateTokens` over the per-batch
 * bookmark payloads (`{title, url}`, the minimized shape the pipeline sends)
 * and ignores the fixed question/candidate scaffolding the pipeline adds to
 * each request. That is deliberate — the bookmark payload is the only part
 * that scales with the selection, so the estimate tracks the marginal cost of
 * adding bookmarks while staying a pure function of the input.
 */

/** The default batch size shared with `src/jobs/queue.ts` and the runner. */
export const DEFAULT_BATCH_SIZE = 5;

/** The minimal bookmark shape the estimate folds over — never notes. */
export interface EstimateBookmark {
  readonly title: string;
  readonly url: string;
}

/** One batch's estimated input tokens. */
export interface BatchCostEstimate {
  readonly batchIndex: number;
  readonly inputTokens: number;
}

/** The whole-job estimate: batch breakdown plus the summed total. */
export interface JobCostEstimate {
  readonly totalBatches: number;
  readonly inputTokens: number;
  readonly batches: readonly BatchCostEstimate[];
}

export interface EstimateJobCostOptions {
  /** The bookmarks the job will analyze, in order. */
  readonly bookmarks: readonly EstimateBookmark[];
  /** Bookmark batch size; defaults to {@link DEFAULT_BATCH_SIZE}. */
  readonly batchSize?: number;
}

/**
 * Estimate a job's input tokens from its bookmark payloads. Bookmarks are
 * chunked in order into `batchSize` groups; each batch is scored with
 * `estimateTokens` over its `{title, url}` payload, and the totals are summed.
 * An empty selection yields zero batches and zero tokens.
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
  return { totalBatches: batches.length, inputTokens, batches };
}
