import { describe, expect, it } from "vitest";
import { buildIndex, buildTagNameMap } from "../../src/search/index";
import type { SearchSourceBookmark } from "../../src/search/index";
import { collectDuplicateIds, runQuery } from "../../src/search/run";
import type { RunQueryContext } from "../../src/search/run";

/**
 * Phase 2 perf gate (spec NFR): a synthetic 10k-bookmark corpus must build in
 * under 500 ms and answer a median query in under 50 ms. Deterministic data —
 * no randomness, fixed ids/dates — so the test is stable across runs.
 *
 * Only the executor path is measured; `collectDuplicateIds` runs once per
 * corpus build here, exactly as callers amortize it per corpus change.
 */

const CORPUS_SIZE = 10_000;
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

  it("builds the index in under 500 ms", () => {
    const start = performance.now();
    const index = buildIndex(docs, tagNames);
    const elapsed = performance.now() - start;
    expect(index.documentCount).toBe(CORPUS_SIZE);
    expect(elapsed).toBeLessThan(500);
  });

  it("answers the median query in under 50 ms", () => {
    const index = buildIndex(docs, tagNames);
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

    const medians = queries.map((query) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        const result = runQuery(index, query, ctx);
        samples.push(performance.now() - start);
        expect(result.hits.length).toBeGreaterThanOrEqual(0);
      }
      return median(samples);
    });

    // The gate is the MEDIAN across query shapes — one slow shape can't fail
    // the suite, a systematically slow executor can.
    expect(median(medians)).toBeLessThan(50);
  });
});
