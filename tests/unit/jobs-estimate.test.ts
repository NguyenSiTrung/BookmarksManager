import { describe, expect, it } from "vitest";
import { planNearDuplicates } from "../../src/decisions/near-duplicate-plan";
import { estimateTokens } from "../../src/jev/budget";
import { estimateJobCost } from "../../src/jobs/estimate";

/**
 * Pre-run cost estimation (spec FR7, PROJECT_PLAN.md §8.3, improvement I06).
 *
 * `estimateJobCost` folds `estimateTokens` over the minimized `{title, url}`
 * bookmark payloads — deliberately a token LOWER BOUND — and now also counts
 * the AI requests a job will make: one per bookmark plus one per planned
 * near-duplicate pair for a `library_scan`. The pair count comes from the same
 * bounded `planNearDuplicates` planner the runner and enqueue use, so the
 * pre-start estimate never under-reports a library scan by a whole phase.
 */

/** Four bookmarks forming two same-domain, identical-title pairs. */
const PAIR_BOOKMARKS = [
  { id: "bm-1", title: "Rust Async Guide", url: "https://docs.rs/async" },
  {
    id: "bm-2",
    title: "Rust Async Guide",
    url: "https://docs.rs/async-old",
  },
  { id: "bm-3", title: "Tokio Tutorial", url: "https://tokio.rs/tutorial" },
  {
    id: "bm-4",
    title: "Tokio Tutorial",
    url: "https://tokio.rs/tutorial-v1",
  },
];

describe("estimateJobCost", () => {
  it("derives the estimate purely from estimateTokens over the batch payload", () => {
    const bookmark = {
      id: "bm-1",
      title: "t",
      url: "https://x.co",
    };
    const estimate = estimateJobCost({ bookmarks: [bookmark], batchSize: 1 });

    // One bookmark, one batch — the payload is the minimized bookmark array,
    // never the id (the pipeline sends `{title, url}`).
    const payload = [{ title: bookmark.title, url: bookmark.url }];
    expect(estimate.totalBatches).toBe(1);
    expect(estimate.batches).toHaveLength(1);
    expect(estimate.batches[0]?.inputTokens).toBe(estimateTokens(payload));
    expect(estimate.inputTokens).toBe(estimateTokens(payload));
    // Exact derived value for this known input (see the assertion above).
    expect(estimate.inputTokens).toBe(12);
  });

  it("sums per-batch estimates across batches", () => {
    const bookmarks = [
      { id: "a", title: "a", url: "https://a.example" },
      { id: "b", title: "b", url: "https://b.example" },
      { id: "c", title: "c", url: "https://c.example" },
    ];
    const estimate = estimateJobCost({ bookmarks, batchSize: 2 });
    expect(estimate.totalBatches).toBe(2);
    expect(estimate.batches.map((batch) => batch.batchIndex)).toEqual([0, 1]);
    // The fold only ever scores the minimized `{title, url}` payload.
    const expected =
      estimateTokens([
        { title: bookmarks[0]!.title, url: bookmarks[0]!.url },
        { title: bookmarks[1]!.title, url: bookmarks[1]!.url },
      ]) +
      estimateTokens([
        { title: bookmarks[2]!.title, url: bookmarks[2]!.url },
      ]);
    expect(estimate.inputTokens).toBe(expected);
  });

  it("returns an empty estimate for no bookmarks", () => {
    const estimate = estimateJobCost({ bookmarks: [], kind: "library_scan" });
    expect(estimate).toEqual({
      totalBatches: 0,
      inputTokens: 0,
      batches: [],
      requests: 0,
      pairs: 0,
      comparisons: 0,
      truncated: false,
      pairLimit: 500,
    });
  });

  it("counts one request per bookmark plus one per planned pair for a library_scan", () => {
    const plan = planNearDuplicates(PAIR_BOOKMARKS);
    const estimate = estimateJobCost({
      kind: "library_scan",
      bookmarks: PAIR_BOOKMARKS,
    });

    // The exact spec expectation: each selected pair is an AI request.
    expect(estimate.requests).toBe(PAIR_BOOKMARKS.length + plan.pairs.length);
    expect(estimate.pairs).toBe(plan.pairs.length);
    expect(estimate.comparisons).toBe(plan.comparisons);
    expect(estimate.truncated).toBe(plan.truncated);
    expect(estimate.truncated).toBe(false);
    // A07/FR7: totalBatches mirrors `progress.totalBatches` on the persisted
    // row — 1 bookmark batch + 1 pair batch (2 pairs at the default batch
    // size of 5) — while the token fold still covers bookmark payloads only.
    expect(estimate.totalBatches).toBe(2);
    expect(estimate.batches).toHaveLength(1);
  });

  it("counts a passed plan instead of re-planning the pairs", async () => {
    const plan = planNearDuplicates(PAIR_BOOKMARKS);
    const truncatedPlan = { ...plan, truncated: true };
    const estimate = estimateJobCost({
      kind: "library_scan",
      bookmarks: PAIR_BOOKMARKS,
      plan: truncatedPlan,
    });
    // The supplied plan's own counts flow straight through — the pair
    // batches derive from its length, not a second planning pass.
    expect(estimate.pairs).toBe(plan.pairs.length);
    expect(estimate.truncated).toBe(true);
    expect(estimate.requests).toBe(PAIR_BOOKMARKS.length + plan.pairs.length);
    // An ignored plan on a non-scan kind folds bookmark batches alone.
    const selection = estimateJobCost({
      kind: "analyze_selection",
      bookmarks: PAIR_BOOKMARKS,
      plan: truncatedPlan,
    });
    expect(selection.pairs).toBe(0);
    expect(selection.requests).toBe(PAIR_BOOKMARKS.length);
    expect(selection.totalBatches).toBe(1);
  });

  it("counts only the bookmark requests for an analyze_selection", () => {
    const estimate = estimateJobCost({
      kind: "analyze_selection",
      bookmarks: PAIR_BOOKMARKS,
    });
    expect(estimate.requests).toBe(PAIR_BOOKMARKS.length);
    expect(estimate.pairs).toBe(0);
    expect(estimate.truncated).toBe(false);
  });

  it("treats an omitted kind as a per-bookmark-only estimate", () => {
    const estimate = estimateJobCost({ bookmarks: PAIR_BOOKMARKS });
    expect(estimate.requests).toBe(PAIR_BOOKMARKS.length);
    expect(estimate.pairs).toBe(0);
  });

  it("reports zero pairs for a library with no qualifying pair", () => {
    const bookmarks = [
      { id: "a", title: "Alpha", url: "https://a.example/" },
      { id: "b", title: "Beta", url: "https://b.example/" },
    ];
    const estimate = estimateJobCost({
      kind: "library_scan",
      bookmarks,
    });
    expect(estimate.pairs).toBe(0);
    expect(estimate.requests).toBe(2);
    expect(estimate.truncated).toBe(false);
  });

  it("mirrors a truncated bounded plan in the request count", () => {
    // 33 identical-title, distinct-URL same-domain bookmarks → 528 candidate
    // pairs, capped by the planner to the 500-pair output limit.
    const bookmarks = Array.from({ length: 33 }, (_value, index) => ({
      id: `bm-${index}`,
      title: "Same Title",
      url: `https://same.example/${index}`,
    }));
    const plan = planNearDuplicates(bookmarks);
    const estimate = estimateJobCost({ kind: "library_scan", bookmarks });

    expect(plan.truncated).toBe(true);
    expect(estimate.truncated).toBe(true);
    expect(estimate.pairs).toBe(500);
    expect(estimate.requests).toBe(bookmarks.length + 500);
  });
});
