import { describe, expect, it } from "vitest";
import { nearDuplicatePairs } from "../../src/decisions/candidates";
import {
  NEAR_DUPLICATE_COMPARISON_LIMIT,
  NEAR_DUPLICATE_PAIR_LIMIT,
  NEAR_DUPLICATE_TITLE_THRESHOLD,
  planNearDuplicates,
} from "../../src/decisions/near-duplicate-plan";

/**
 * Coverage for `src/decisions/near-duplicate-plan.ts` — the bounded,
 * deterministic planner behind the `nearDuplicatePairs` wrapper
 * (audit-hardening Phase 5 Task 4, improvement I06).
 *
 * The planner must never enumerate every within-domain pair when the library
 * is large (a dominant domain makes that quadratic), must count every
 * candidate attempt including ones later filtered as local duplicates, must
 * cap emitted pairs, and must be byte-for-byte deterministic under input
 * reordering. Small libraries stay under the caps and must match the
 * historical exhaustive semantics exactly.
 */

interface Source {
  id: string;
  title: string;
  url: string;
}

const pad = (n: number): string => String(n).padStart(5, "0");

/** 5k bookmarks on one domain whose titles all share three tokens. */
function dominantDomain(count: number): Source[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `d${pad(i)}`,
    title: `common shared title ${i}`,
    url: `https://example.com/page/${i}`,
  }));
}

/**
 * 5k bookmarks whose URLs all normalize to one key (`utm_source` dropped) —
 * exactly the shape that made the old exclusion set enumerate ~12.5M pairs.
 * Distinct raw URLs keep them out of the exact group; the normalized group
 * catches every pair. Titles are IDENTICAL so that, absent the normalized-URL
 * exclusion, every candidate would exceed the similarity threshold and the
 * fixture would emit qualifying pairs — making the exclusion path, not just
 * the comparison bound, load-bearing.
 */
function normalizedDuplicates(count: number): Source[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${pad(i)}`,
    title: "Identical normalized page",
    url: `https://example.com/dup?utm_source=${i}`,
  }));
}

describe("planNearDuplicates", () => {
  it("bounds a dominant-domain common-title library on both limits", () => {
    const plan = planNearDuplicates(dominantDomain(5_000));
    expect(plan.pairs).toHaveLength(NEAR_DUPLICATE_PAIR_LIMIT);
    expect(plan.comparisons).toBe(NEAR_DUPLICATE_COMPARISON_LIMIT);
    expect(plan.truncated).toBe(true);
    // A meaningful fixture: similar pairs really were found before the cap.
    expect(plan.pairs.length).toBeGreaterThan(0);
  });

  it("is deterministic when a dominant-domain input is reversed", () => {
    const fixture = dominantDomain(5_000);
    const forward = planNearDuplicates(fixture);
    const backward = planNearDuplicates([...fixture].reverse());
    expect(backward).toEqual(forward);
  });

  it("bounds a normalized-duplicate library without enumerating pair sets", () => {
    const plan = planNearDuplicates(normalizedDuplicates(5_000));
    // Identical titles would all qualify — the normalized-URL exclusion is
    // what empties this output (see the mutation note in the test header).
    expect(plan.pairs).toEqual([]);
    expect(plan.comparisons).toBeLessThanOrEqual(
      NEAR_DUPLICATE_COMPARISON_LIMIT,
    );
    expect(plan.truncated).toBe(true);
  });

  it("returns an empty, untruncated plan for no bookmarks", () => {
    expect(planNearDuplicates([])).toEqual({
      pairs: [],
      comparisons: 0,
      truncated: false,
    });
  });

  it("returns an empty, untruncated plan when no URL has a domain", () => {
    const plan = planNearDuplicates([
      { id: "a", title: "Same title", url: "javascript:alert(1)" },
      { id: "b", title: "Same title", url: "javascript:alert(2)" },
    ]);
    expect(plan).toEqual({ pairs: [], comparisons: 0, truncated: false });
  });

  it("excludes pairs sharing a raw URL with no normalized key", () => {
    // `chrome://foo` yields extractDomain "foo" but normalizeUrl null, so the
    // exact-group branch is the ONLY thing that can exclude these two. Two
    // identical raw URLs = the historical exact-duplicate exclusion.
    const duplicateRaw: Source[] = [
      { id: "r1", title: "Identical scheme page", url: "chrome://foo/page" },
      { id: "r2", title: "Identical scheme page", url: "chrome://foo/page" },
      {
        id: "r3",
        title: "Identical scheme page",
        url: "chrome://foo/other-page",
      },
    ];
    const plan = planNearDuplicates(duplicateRaw);
    expect(plan.pairs.map((p) => `${p.a.id}+${p.b.id}`)).toEqual([
      "r1+r3",
      "r2+r3",
    ]);
  });

  it("matches the historical exhaustive semantics when under both caps", () => {
    const small: Source[] = [
      { id: "a", title: "Rust tutorial guide", url: "https://example.com/a" },
      { id: "b", title: "Rust tutorial handbook", url: "https://example.com/b" },
      { id: "c", title: "Rust cookbook", url: "https://example.com/c" },
      { id: "d", title: "Rust tutorial", url: "https://example.com/d" },
      { id: "e", title: "Same title", url: "https://example.com/x" },
      { id: "f", title: "Same title", url: "https://example.com/x" },
      {
        id: "g",
        title: "Same title",
        url: "http://www.example.com/x?utm_source=y",
      },
    ];
    const plan = planNearDuplicates(small);
    expect(plan.pairs).toEqual(nearDuplicatePairs(small));
    expect(plan.truncated).toBe(false);
    // Every unordered same-domain pair was attempted under the caps.
    expect(plan.comparisons).toBe(21);
  });

  it("applies the similarity threshold inclusively under the caps", () => {
    const plan = planNearDuplicates([
      // {guide, rust, tutorial} ∩ {handbook, rust, tutorial} = 2/4 = 0.5
      { id: "a", title: "Rust tutorial guide", url: "https://example.com/a" },
      { id: "b", title: "Rust tutorial handbook", url: "https://example.com/b" },
      // {cookbook, rust} ∩ {rust, tutorial} = 1/3 < 0.5
      { id: "c", title: "Rust cookbook", url: "https://example.com/c" },
      { id: "d", title: "Rust tutorial", url: "https://example.com/d" },
    ]);
    const ids = plan.pairs.map((p) => `${p.a.id}+${p.b.id}`);
    expect(ids).toContain("a+b");
    expect(ids).not.toContain("c+d");
    expect(NEAR_DUPLICATE_TITLE_THRESHOLD).toBe(0.5);
  });

  it("caps emitted pairs but leaves comparisons under the limit when exhaustive", () => {
    // 316 identical-titled, distinct-URL, same-domain bookmarks:
    // C(316,2) = 49770 <= comparison limit, so the whole scan runs; the
    // 500-pair output cap still applies.
    const fixture: Source[] = Array.from({ length: 316 }, (_, i) => ({
      id: `c${pad(i)}`,
      title: "Identical title",
      url: `https://cap.example/${i}`,
    }));
    const plan = planNearDuplicates(fixture);
    expect(plan.comparisons).toBe((316 * 315) / 2);
    expect(plan.comparisons).toBeLessThanOrEqual(
      NEAR_DUPLICATE_COMPARISON_LIMIT,
    );
    expect(plan.pairs).toHaveLength(NEAR_DUPLICATE_PAIR_LIMIT);
    expect(plan.truncated).toBe(true);
  });

  it("sorts selected pairs by similarity then stable ids", () => {
    const plan = planNearDuplicates(dominantDomain(5_000));
    for (let i = 1; i < plan.pairs.length; i++) {
      const prev = plan.pairs[i - 1]!;
      const next = plan.pairs[i]!;
      expect(prev.titleSimilarity).toBeGreaterThanOrEqual(next.titleSimilarity);
      if (prev.titleSimilarity === next.titleSimilarity) {
        const ordered =
          prev.a.id < next.a.id ||
          (prev.a.id === next.a.id && prev.b.id <= next.b.id);
        expect(ordered).toBe(true);
      }
    }
  });

  it("orders pairs by descending similarity, then by stable ids", () => {
    // Titles chosen so the pairwise similarities differ: "a" and "c" are
    // identical (1.0) while a-b and b-c share two of four tokens (0.5, the
    // inclusive threshold). d/e score 0.2 and 0 against everything, below the
    // threshold. A mixed-similarity fixture rules out passing by accident when
    // the similarity comparator is inverted.
    const fixture: Source[] = [
      { id: "a", title: "alpha beta gamma", url: "https://mix.example/a" },
      { id: "b", title: "alpha beta delta", url: "https://mix.example/b" },
      { id: "c", title: "alpha beta gamma", url: "https://mix.example/c" },
      { id: "d", title: "zzz epsilon one", url: "https://mix.example/d" },
      { id: "e", title: "zzz eta two", url: "https://mix.example/e" },
    ];
    const plan = planNearDuplicates(fixture);
    // Only the three "alpha-beta" pairs qualify; d-e shares one token (0.2),
    // below the 0.5 threshold.
    expect(plan.pairs.map((p) => [p.a.id, p.b.id, p.titleSimilarity])).toEqual([
      ["a", "c", 1],
      ["a", "b", 0.5],
      ["b", "c", 0.5],
    ]);
    // Similarity strictly descending, with the id tie-break as the secondary
    // key: the 0.5 pair "a+b" sorts before "b+c" by (a.id, b.id).
    expect(plan.pairs[0]?.titleSimilarity).toBe(1);
    expect(plan.pairs[1]?.titleSimilarity).toBe(0.5);
    expect(plan.pairs[2]?.titleSimilarity).toBe(0.5);
    expect(`${plan.pairs[1]?.a.id}+${plan.pairs[1]?.b.id}`).toBe("a+b");
    expect(`${plan.pairs[2]?.a.id}+${plan.pairs[2]?.b.id}`).toBe("b+c");
  });

  it("preserves normalized-title shortcuts, Unicode tokens, and set similarity", () => {
    const titles = [
      "  ALPHA\t BETA  ",
      "alpha beta",
      "CAFÉ—東京 guide",
      "café 東京 manual",
      "repeat repeat shared",
      "repeat shared other",
      "!!!",
      " !!! ",
      "???",
      "",
      " \n ",
    ];
    const fixture = titles.map((title, i) => ({
      id: `u${i}`,
      title,
      url: `https://unicode.example/${i}`,
    }));
    const plan = planNearDuplicates(fixture);
    expect(plan.comparisons).toBe(55);
    expect(plan.truncated).toBe(false);
    expect(plan.pairs).toEqual([
      {
        a: { ...fixture[0]!, domain: "unicode.example" },
        b: { ...fixture[1]!, domain: "unicode.example" },
        titleSimilarity: 1,
      },
      {
        a: { ...fixture[10]!, domain: "unicode.example" },
        b: { ...fixture[9]!, domain: "unicode.example" },
        titleSimilarity: 1,
      },
      {
        a: { ...fixture[6]!, domain: "unicode.example" },
        b: { ...fixture[7]!, domain: "unicode.example" },
        titleSimilarity: 1,
      },
      {
        a: { ...fixture[4]!, domain: "unicode.example" },
        b: { ...fixture[5]!, domain: "unicode.example" },
        titleSimilarity: 2 / 3,
      },
      {
        a: { ...fixture[2]!, domain: "unicode.example" },
        b: { ...fixture[3]!, domain: "unicode.example" },
        titleSimilarity: 0.5,
      },
    ]);
    expect(planNearDuplicates([...fixture].reverse())).toEqual(plan);
  });

  it("keeps tokenless grouping and duplicate attempts on the bounded path", () => {
    const fixture: Source[] = Array.from({ length: 320 }, (_, i) => ({
      id: `z${pad(i)}`,
      title: `unique${i}`,
      url: `https://bounded.example/${i}`,
    }));
    fixture[0]!.title = "!!!";
    fixture[1]!.title = " !!! ";
    fixture[2]!.title = "???";
    fixture[3]!.title = "???";
    fixture[4]!.title = "CAFÉ—東京 guide";
    fixture[5]!.title = "café 東京 manual";
    const plan = planNearDuplicates(fixture);
    // The Unicode pair is attempted through both shared postings. Each
    // identical tokenless group contributes one attempt; unlike "!!!" and
    // "???", distinct normalized tokenless titles must never pair.
    expect(plan.comparisons).toBe(4);
    expect(plan.truncated).toBe(true);
    const scores = plan.pairs.map((pair) => [
      pair.a.id, pair.b.id, pair.titleSimilarity,
    ]);
    expect(scores).toEqual([
      ["z00000", "z00001", 1],
      ["z00002", "z00003", 1],
      ["z00004", "z00005", 0.5],
    ]);
    expect(planNearDuplicates([...fixture].reverse())).toEqual(plan);
  });

  it("dedupes repeated postings without conflating delimiter-containing ids", () => {
    const fixture: Source[] = Array.from({ length: 320 }, (_, i) => ({
      id: `z${pad(i)}`,
      title: `unique${i}`,
      url: `https://ids.example/${i}`,
    }));
    for (const [i, id] of ["a", "b+c", "a+b", "c"].entries()) {
      fixture[i] = { id, title: "common shared", url: `https://ids.example/${i}` };
    }
    const plan = planNearDuplicates(fixture);
    expect(plan.comparisons).toBe(12);
    expect(plan.truncated).toBe(true);
    expect(plan.pairs.map((pair) => [pair.a.id, pair.b.id])).toEqual([
      ["a", "a+b"],
      ["a", "b+c"],
      ["a", "c"],
      ["a+b", "b+c"],
      ["a+b", "c"],
      ["b+c", "c"],
    ]);
    expect(planNearDuplicates([...fixture].reverse())).toEqual(plan);
  });

  it("recomputes title features after edits rather than reusing an earlier plan", () => {
    const fixture = [
      { id: "a", title: "alpha beta", url: "https://edits.example/a" },
      { id: "b", title: "alpha beta", url: "https://edits.example/b" },
    ];
    expect(planNearDuplicates(fixture).pairs).toHaveLength(1);
    fixture[1]!.title = "totally unrelated";
    expect(planNearDuplicates(fixture).pairs).toEqual([]);
    fixture[1]!.title = "ALPHA BETA";
    expect(planNearDuplicates(fixture).pairs[0]?.titleSimilarity).toBe(1);
  });

  it("keeps the wrapper returning exactly the planned pairs", () => {
    const fixture = dominantDomain(5_000);
    expect(nearDuplicatePairs(fixture)).toEqual(
      planNearDuplicates(fixture).pairs,
    );
  });
});
