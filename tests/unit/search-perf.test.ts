import { describe, expect, it } from "vitest";
import { buildIndex, buildTagNameMap } from "../../src/search/index";
import type { SearchSourceBookmark } from "../../src/search/index";
import { collectDuplicateIds, runQuery } from "../../src/search/run";
import type { RunQueryContext } from "../../src/search/run";

/**
 * Phase 2 perf gate (spec NFR): a synthetic 10k-bookmark corpus must build in
 * under 500 ms and answer a median query in under 50 ms. Deterministic data —
 * no randomness, fixed ids/dates — so the input is stable across runs.
 *
 * The MEASUREMENT takes the best of N repetitions, not a single sample. This
 * suite runs ~17 worker processes on one box, so any individual sample can be
 * descheduled mid-flight: single-shot timings were observed swinging from
 * 170 ms to 628 ms for identical work, which made the gate fail on a loaded
 * machine while passing in isolation. The minimum is the standard estimator
 * for a "how fast can this go" budget — it discards scheduler noise instead of
 * averaging it in, so a genuine regression still moves it. Measured across
 * eight full parallel runs, best-of-N held at 264–363 ms (budget 500) and
 * 12–21 ms (budget 50), against a worst single sample of 628 ms.
 *
 * Only the executor path is measured; `collectDuplicateIds` runs once per
 * corpus build here, exactly as callers amortize it per corpus change.
 */

const CORPUS_SIZE = 10_000;
/** Repetitions for the build budget — a longer workload needs more chances. */
const BUILD_SAMPLES = 12;
/** Repetitions per query shape; the median across shapes is then compared. */
const QUERY_SAMPLES = 7;
const DOMAINS = ["example.com", "github.com", "docs.dev", "news.io", "shop.net"];
const FOLDERS = [
  ["Dev"],
  ["Dev", "Rust"],
  ["Dev", "Web", "TS"],
  ["Personal", "Recipes"],
  ["Reference"],
] as const;
const TAG_KEYS = ["typescript", "reading list", "rust", "cooking", "later"];
const TAGS = [
  { name: "TypeScript", nameKey: "typescript" },
  { name: "Reading List", nameKey: "reading list" },
  { name: "Rust", nameKey: "rust" },
  { name: "Cooking", nameKey: "cooking" },
  { name: "Later", nameKey: "later" },
];
const WORDS = [
  "async", "guide", "tutorial", "reference", "release", "design",
  "parser", "storage", "offline", "sync",
];

function corpus(): SearchSourceBookmark[] {
  const out: SearchSourceBookmark[] = [];
  const base = Date.parse("2023-01-01T00:00:00");
  for (let i = 0; i < CORPUS_SIZE; i++) {
    const domain = DOMAINS[i % DOMAINS.length]!;
    const folder = FOLDERS[i % FOLDERS.length]!;
    const tagKeys = i % 4 === 0 ? [] : [TAG_KEYS[i % TAG_KEYS.length]!];
    // Every 500th pair shares a URL so `is:duplicate` has real groups.
    const shared = i % 500 === 0 && i > 0;
    out.push({
      id: `bm${i}`,
      title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`,
      url: shared
        ? "https://dup.example.com/page"
        : `https://www.${domain}/item/${i}?q=${WORDS[i % WORDS.length]}`,
      dateAdded: base + i * 86_400, // ~1.2 days apart
      ancestors: folder.map((title, depth) => ({ id: `f${depth}${title}`, title })),
      tagKeys,
      category: i % 3 === 0 ? "article" : "docs",
      notes: i % 5 === 0 ? `note about ${WORDS[i % WORDS.length]} ${i}` : undefined,
    });
  }
  return out;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("search performance at 10k bookmarks", () => {
  const tagNames = buildTagNameMap(TAGS);
  const docs = corpus();
  const ctx: RunQueryContext = {
    treeOrder: docs.map((doc) => doc.id),
    duplicateIds: collectDuplicateIds(
      docs.map((doc) => ({ id: doc.id, url: doc.url })),
    ),
  };
  let builtIndex: ReturnType<typeof buildIndex>;

  it("builds the index in under 500 ms", () => {
    // Warm-up absorbs module/JIT cost that is not part of the budget.
    builtIndex = buildIndex(docs, tagNames);

    let best = Infinity;
    for (let i = 0; i < BUILD_SAMPLES; i++) {
      const start = performance.now();
      buildIndex(docs, tagNames);
      best = Math.min(best, performance.now() - start);
    }

    // The last build becomes the fixture for the query test below.
    builtIndex = buildIndex(docs, tagNames);
    expect(builtIndex.documentCount).toBe(CORPUS_SIZE);
    expect(best).toBeLessThan(500);
  });

  it("answers the median query in under 50 ms", () => {
    const index = builtIndex ?? buildIndex(docs, tagNames);
    const queries = [
      "async guide",                    // common free text
      "tutorial 9999",                  // rare free text
      'tag:"reading list"',             // quoted filter value
      "domain:github.com",              // filter-only
      "before:2024",                    // date filter-only
      "folder:dev/rust",                // path filter
      "async -tutorial",                // text + negated term
      '"release design"',               // exact phrase
      "is:untagged",                    // flag filter
      "is:duplicate",                   // flag over duplicateIds
      "sync domain:docs.dev",           // mixed text + filter
      "tag:typescript category:article", // cross-key AND
      "",                               // empty → tree order
    ];

    const bests = queries.map((query) => {
      let best = Infinity;
      for (let i = 0; i < QUERY_SAMPLES; i++) {
        const start = performance.now();
        const result = runQuery(index, query, ctx);
        best = Math.min(best, performance.now() - start);
        expect(result.hits.length).toBeGreaterThanOrEqual(0);
      }
      return best;
    });

    // The gate is the MEDIAN of per-shape bests — one slow shape can't fail
    // the suite, a systematically slow executor can.
    expect(median(bests)).toBeLessThan(50);
  });
});
