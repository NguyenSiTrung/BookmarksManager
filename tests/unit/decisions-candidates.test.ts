import { describe, expect, it } from "vitest";
import {
  FOLDER_CANDIDATE_LIMIT,
  NEAR_DUPLICATE_COMPARISON_LIMIT,
  NEAR_DUPLICATE_PAIR_LIMIT,
  NEAR_DUPLICATE_TITLE_THRESHOLD,
  NONE_FOLDER_OPTION,
  RERANK_CANDIDATE_LIMIT,
  TAG_CANDIDATE_LIMIT,
  folderCandidates,
  misfiledCandidates,
  nearDuplicatePairs,
  rerankCandidates,
  tagCandidates,
} from "../../src/decisions/candidates";
import { planNearDuplicates } from "../../src/decisions/near-duplicate-plan";
import { tagNameKey } from "../../src/schemas/meta";
import type { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import { buildSearchHandle, runQuery } from "../../src/search/run";
import type { SearchHit } from "../../src/search/index";
import type {
  BookmarkItem,
  FlattenedTree,
  FolderNode,
} from "../../src/sync/tree";

/**
 * Coverage for `src/decisions/candidates.ts` — the pure pre-filters that
 * shortlist tags, folders, near-duplicate pairs, and rerank candidates for
 * Jev question sets (spec FR3, plan §9.1). Everything here runs on plain
 * data; no `chrome` is involved.
 */

const NOW = "2026-09-27T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function tag(name: string, description?: string): TagDef {
  return {
    name,
    nameKey: tagNameKey(name),
    ...(description === undefined ? {} : { description }),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function metaRow(id: string, tags: string[]): BookmarkMeta {
  return { id, tags, updatedAt: NOW };
}

function folder(
  id: string,
  title: string,
  path: string[] = [],
  over: Partial<FolderNode> = {},
): FolderNode {
  return {
    id,
    title,
    path,
    kind: "folder",
    childIds: [],
    isRoot: false,
    isManaged: false,
    depth: path.length,
    ...over,
  };
}

function bm(
  id: string,
  title: string,
  url: string,
  parentId?: string,
): BookmarkItem {
  return {
    id,
    title,
    url,
    ...(parentId === undefined ? {} : { parentId }),
    path: [],
    kind: "bookmark",
    isRoot: false,
    isManaged: false,
    depth: 1,
  };
}

function treeOf(
  folders: FolderNode[],
  bookmarks: BookmarkItem[] = [],
): FlattenedTree {
  return {
    folders: new Map(folders.map((f) => [f.id, f])),
    bookmarks: new Map(bookmarks.map((b) => [b.id, b])),
  };
}

const noUsage = { bookmarks: [], metas: [] };

// ---------------------------------------------------------------------------
// tagCandidates
// ---------------------------------------------------------------------------

describe("tagCandidates", () => {
  const subject = {
    title: "Async Rust patterns",
    url: "https://github.com/rust/async-book",
  };

  it("handles empty tag libraries and empty usage corpora", () => {
    expect(tagCandidates(subject, [], noUsage)).toEqual([]);
    // An empty usage corpus still keyword-matches.
    const out = tagCandidates(subject, [tag("Rust")], noUsage);
    expect(out.map((c) => c.nameKey)).toEqual(["rust"]);
  });

  it("ranks tags on title, URL, and description token overlap", () => {
    const titleMatch = tagCandidates(
      subject,
      [tag("Cooking"), tag("Rust"), tag("Gardening")],
      noUsage,
    );
    expect(titleMatch[0]?.nameKey).toBe("rust");
    expect(titleMatch[0]?.score).toBeGreaterThan(titleMatch[1]?.score ?? -1);
    // Title shares nothing with the tag names; the URL still picks them out.
    const urlMatch = tagCandidates(
      { title: "totally different words", url: "https://github.com/rust/x" },
      [tag("aaa"), tag("GitHub"), tag("Rust")],
      noUsage,
    );
    expect(urlMatch.map((c) => c.nameKey).slice(0, 2)).toEqual([
      "github",
      "rust",
    ]);
    const descriptionMatch = tagCandidates(
      { title: "Bread baking basics", url: "https://x.example/" },
      [tag("Cooking", "bread and pastry recipes"), tag("Cars")],
      noUsage,
    );
    expect(descriptionMatch[0]?.nameKey).toBe("cooking");
  });

  it("boosts tags already used on the subject's domain", () => {
    const usage = {
      bookmarks: [
        { id: "x1", url: "https://github.com/a" },
        { id: "x2", url: "https://github.com/b" },
        { id: "y1", url: "https://recipes.io/c" },
      ],
      metas: [
        metaRow("x1", ["oss"]),
        metaRow("x2", ["oss"]),
        metaRow("y1", ["recipes"]),
      ],
    };
    const out = tagCandidates(
      { title: "unrelated words here", url: "https://github.com/z" },
      [tag("oss"), tag("recipes"), tag("github")],
      usage,
    );
    // github: 1 domain-token keyword hit. oss: 2 same-domain uses.
    // recipes: used only on another domain → no domain overlap.
    expect(out[0]?.nameKey).toBe("oss");
    expect(out[0]?.score).toBe(2);
  });

  it("breaks ties by nameKey so output is input-order independent", () => {
    const defs = [tag("zebra"), tag("apple"), tag("mango")];
    const a = tagCandidates(subject, defs, noUsage).map((c) => c.nameKey);
    const b = tagCandidates(
      subject,
      [...defs].reverse(),
      noUsage,
    ).map((c) => c.nameKey);
    expect(a).toEqual(["apple", "mango", "zebra"]);
    expect(b).toEqual(a);
  });

  it("caps the shortlist at 30 but keeps zero-overlap tags under it", () => {
    const defs = [tag("rust")].concat(
      Array.from({ length: 40 }, (_, i) => tag(`t${String(i).padStart(2, "0")}`)),
    );
    const capped = tagCandidates(subject, defs, noUsage);
    expect(capped).toHaveLength(TAG_CANDIDATE_LIMIT);
    expect(capped[0]?.nameKey).toBe("rust");
    // The remaining slots fall back to nameKey order — deterministic.
    const tail = capped.slice(1).map((c) => c.nameKey);
    expect(tail).toEqual([...tail].sort());
    const under = tagCandidates(
      subject,
      [tag("unrelated-one"), tag("unrelated-two")],
      noUsage,
    );
    expect(under.map((c) => c.nameKey)).toEqual([
      "unrelated-one",
      "unrelated-two",
    ]);
    expect(under.every((c) => c.score === 0)).toBe(true);
  });

  it("carries name, nameKey, and description through and dedupes on nameKey", () => {
    const out = tagCandidates(subject, [tag("Rust", "The Rust language")], noUsage);
    expect(out[0]).toMatchObject({
      nameKey: "rust",
      name: "Rust",
      description: "The Rust language",
    });
    const deduped = tagCandidates(
      subject,
      [tag("Rust"), tag("rust")], // same nameKey
      noUsage,
    );
    expect(deduped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// folderCandidates
// ---------------------------------------------------------------------------

describe("folderCandidates", () => {
  const subject = {
    title: "Rust borrow checker",
    url: "https://github.com/rust/rfcs",
  };
  const folders = [
    folder("f-food", "Recipes", ["Bookmarks bar"]),
    folder("f-rust", "Rust", ["Bookmarks bar", "Dev"]),
    folder("f-misc", "Misc", []),
  ];

  it("returns an empty ranked list plus the none option and excludes root/managed folders", () => {
    const empty = folderCandidates(subject, treeOf([]));
    expect(empty.candidates).toEqual([]);
    expect(empty.none).toBe(NONE_FOLDER_OPTION);
    const filtered = folderCandidates(
      subject,
      treeOf([
        folder("0", "", [], { isRoot: true }),
        folder("f-managed", "Rust managed stuff", ["Bookmarks bar"], {
          isManaged: true,
        }),
        folder("f-ok", "Ok", ["Bookmarks bar"]),
      ]),
    );
    expect(filtered.candidates.map((c) => c.id)).toEqual(["f-ok"]);
  });

  it("ranks by path-token overlap while keeping zero-overlap folders under the cap", () => {
    const set = folderCandidates(subject, treeOf(folders));
    expect(set.candidates[0]?.id).toBe("f-rust");
    expect(set.candidates[0]?.path).toEqual([
      "Bookmarks bar",
      "Dev",
      "Rust",
    ]);
    expect(set.none).toBe("none");
    // Top-N, not a filter: non-matching folders stay listed.
    expect(set.candidates.map((c) => c.id)).toContain("f-misc");
    expect(set.candidates.map((c) => c.id)).toContain("f-food");
  });

  it("caps at 50 folders and breaks score ties by path then id", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      folder(
        `f${String(i).padStart(3, "0")}`,
        `Folder ${String(i).padStart(3, "0")}`,
        ["Bookmarks bar"],
      ),
    );
    const capped = folderCandidates(subject, treeOf(many));
    expect(capped.candidates).toHaveLength(FOLDER_CANDIDATE_LIMIT);
    // All score the same → path tie-break → insertion-independent ids.
    expect(capped.candidates.map((c) => c.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `f${String(i).padStart(3, "0")}`),
    );
    const tied = folderCandidates(
      { title: "zzz", url: "https://z.example/" },
      treeOf([
        folder("b", "Beta", ["Root"]),
        folder("a", "Alpha", ["Root"]),
      ]),
    );
    expect(tied.candidates.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// misfiledCandidates
// ---------------------------------------------------------------------------

describe("misfiledCandidates", () => {
  const item = bm("i1", "Rust borrow checker", "https://github.com/x", "f-misc");

  it("always includes the current folder, marked, when it ranked", () => {
    const set = misfiledCandidates(
      item,
      treeOf([
        folder("f-misc", "Misc", ["Bookmarks bar"]),
        folder("f-rust", "Rust", ["Bookmarks bar", "Dev"]),
      ]),
    );
    const current = set.candidates.find((c) => c.id === "f-misc");
    expect(current?.current).toBe(true);
    // Ranked folder is still there and unmarked.
    const rust = set.candidates.find((c) => c.id === "f-rust");
    expect(rust).toBeDefined();
    expect(rust?.current).toBeUndefined();
    expect(set.none).toBe("none");
  });

  it("appends the current folder beyond the cap when it did not rank", () => {
    const crowded = Array.from({ length: FOLDER_CANDIDATE_LIMIT }, (_, i) =>
      folder(`r${i}`, `Rust ${i}`, ["Bookmarks bar"]),
    );
    const set = misfiledCandidates(
      item, // parent f-misc, scores 0 against a "rust"-themed subject
      treeOf([folder("f-misc", "Misc", ["Bookmarks bar"]), ...crowded]),
    );
    expect(set.candidates).toHaveLength(FOLDER_CANDIDATE_LIMIT + 1);
    const last = set.candidates[set.candidates.length - 1];
    expect(last?.id).toBe("f-misc");
    expect(last?.current).toBe(true);
  });

  it("includes a managed current folder and degrades when the parent is unknown", () => {
    const managedItem = bm("i2", "Anything", "https://a.example/", "f-m");
    const managed = misfiledCandidates(
      managedItem,
      treeOf([
        folder("f-m", "Managed home", ["Bookmarks bar"], { isManaged: true }),
        folder("f-other", "Other", ["Bookmarks bar"]),
      ]),
    );
    const current = managed.candidates.find((c) => c.id === "f-m");
    expect(current?.current).toBe(true);
    // …but a managed folder never appears as a *ranked* suggestion.
    expect(managed.candidates[0]?.id).toBe("f-other");
    expect(managed.candidates[0]?.current).toBeUndefined();
    const orphan = bm("i3", "Rust", "https://r.example/", "missing");
    const unknown = misfiledCandidates(orphan, treeOf([folder("f-a", "A", [])]));
    expect(unknown.candidates.every((c) => c.current !== true)).toBe(true);
    expect(unknown.none).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// nearDuplicatePairs
// ---------------------------------------------------------------------------

describe("nearDuplicatePairs", () => {
  const near = (id: string, title: string, url: string) => ({
    id,
    title,
    url,
  });

  it("returns [] on empty input and ignores URLs with no real domain", () => {
    expect(nearDuplicatePairs([])).toEqual([]);
    // Distinct raw URLs — no exact group; opaque scheme → no domain →
    // the "same domain" precondition can never hold.
    const opaque = nearDuplicatePairs([
      near("a", "Same title", "javascript:alert(1)"),
      near("b", "Same title", "javascript:alert(2)"),
    ]);
    expect(opaque).toEqual([]);
  });

  it("pairs same-domain bookmarks with similar titles", () => {
    const out = nearDuplicatePairs([
      near("a", "Rust tutorial part 1", "https://example.com/a"),
      near("b", "Rust tutorial part 1", "https://example.com/b"),
      near("c", "Completely different", "https://example.com/c"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.a.id).toBe("a");
    expect(out[0]?.b.id).toBe("b");
    expect(out[0]?.a.domain).toBe("example.com");
    expect(out[0]?.b.url).toBe("https://example.com/b");
    expect(out[0]?.titleSimilarity).toBe(1);
  });

  it("does not pair the same title across different domains and applies the 0.5 threshold inclusively", () => {
    const crossDomain = nearDuplicatePairs([
      near("a", "Identical title", "https://one.example/x"),
      near("b", "Identical title", "https://two.example/y"),
    ]);
    expect(crossDomain).toEqual([]);
    // {guide, rust, tutorial} ∩ {handbook, rust, tutorial} = 2/4 = 0.5
    const threshold = nearDuplicatePairs([
      near("a", "Rust tutorial guide", "https://example.com/a"),
      near("b", "Rust tutorial handbook", "https://example.com/b"),
      // {cookbook, rust} ∩ {rust, tutorial} = 1/3 < 0.5
      near("c", "Rust cookbook", "https://example.com/c"),
      near("d", "Rust tutorial", "https://example.com/d"),
    ]);
    const ids = threshold.map((p) => `${p.a.id}+${p.b.id}`);
    expect(ids).toContain("a+b");
    expect(ids).not.toContain("c+d");
    expect(NEAR_DUPLICATE_TITLE_THRESHOLD).toBe(0.5);
  });

  it("excludes pairs the local detector already catches (exact, normalized, group)", () => {
    const exact = nearDuplicatePairs([
      near("a", "Same title", "https://example.com/x"),
      near("b", "Same title", "https://example.com/x"),
    ]);
    expect(exact).toEqual([]);
    const normalized = nearDuplicatePairs([
      near("a", "Same title", "http://www.example.com/x?utm_source=y"),
      near("b", "Same title", "https://example.com/x"),
      near("c", "Same title", "https://example.com/different"),
    ]);
    // a+b is a normalized group → excluded. a+c / b+c differ on path so they
    // are not locally grouped — but "Same title" is identical → they pair.
    const ids = normalized.map((p) => `${p.a.id}+${p.b.id}`).sort();
    expect(ids).toEqual(["a+c", "b+c"]);
    const group = nearDuplicatePairs([
      near("a", "Same page", "https://example.com/x"),
      near("b", "Same page", "https://example.com/x"),
      near("c", "Same page", "https://example.com/x"),
    ]);
    expect(group).toEqual([]);
  });

  it("orders pairs by similarity then id, canonically oriented", () => {
    const out = nearDuplicatePairs([
      near("z2", "Rust tutorial", "https://e.example/2"),
      near("z1", "Rust tutorial", "https://e.example/1"),
      near("m", "Beta gamma delta", "https://e.example/m"),
      near("n", "Beta gamma epsilon", "https://e.example/n"),
    ]);
    // identical titles (sim 1) first; "m+n" scores 2/4 = 0.5 second.
    expect(out.map((p) => `${p.a.id}+${p.b.id}`)).toEqual(["z1+z2", "m+n"]);
    // …and pair orientation is canonical (z1 before z2 by id, not input).
    expect(out[0]?.a.id).toBe("z1");
  });
});

// ---------------------------------------------------------------------------
// nearDuplicatePairs — bounded planner regressions (audit-hardening Task 4)
// ---------------------------------------------------------------------------

describe("nearDuplicatePairs bounded planning", () => {
  const pad = (n: number): string => String(n).padStart(5, "0");
  const near = (id: string, title: string, url: string) => ({
    id,
    title,
    url,
  });

  /** 5k same-domain bookmarks sharing three title tokens. */
  const dominant = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `d${pad(i)}`,
      title: `common shared title ${i}`,
      url: `https://example.com/page/${i}`,
    }));

  it("caps both planner work and wrapper output on a dominant-domain library", () => {
    const plan = planNearDuplicates(dominant(5_000));
    expect(plan.comparisons).toBeLessThanOrEqual(
      NEAR_DUPLICATE_COMPARISON_LIMIT,
    );
    expect(plan.truncated).toBe(true);
    const out = nearDuplicatePairs(dominant(5_000));
    expect(out.length).toBeLessThanOrEqual(NEAR_DUPLICATE_PAIR_LIMIT);
  });

  it("is input-order independent on a large common-token fixture", () => {
    const fixture = dominant(5_000);
    expect(nearDuplicatePairs([...fixture].reverse())).toEqual(
      nearDuplicatePairs(fixture),
    );
  });

  it("excludes a normalized-duplicate library without enumerating pairs", () => {
    // Identical titles: absent the normalized-URL exclusion every pair would
    // qualify, so this fixture pins the exclusion path itself, not just the
    // comparison bound.
    const fixture = Array.from({ length: 5_000 }, (_, i) => ({
      id: `n${pad(i)}`,
      title: "Identical normalized page",
      url: `https://example.com/dup?utm_source=${i}`,
    }));
    expect(nearDuplicatePairs(fixture)).toEqual([]);
  });

  it("excludes pairs sharing a raw URL with no normalized key", () => {
    // `chrome://foo` has domain "foo" but no normalized key, so the raw-URL
    // (exact-group) branch is the only exclusion that can apply.
    const out = nearDuplicatePairs([
      near("r1", "Identical scheme page", "chrome://foo/page"),
      near("r2", "Identical scheme page", "chrome://foo/page"),
      near("r3", "Identical scheme page", "chrome://foo/other-page"),
    ]);
    expect(out.map((p) => `${p.a.id}+${p.b.id}`)).toEqual([
      "r1+r3",
      "r2+r3",
    ]);
  });

  it("still matches the historical snapshot on a small library", () => {
    const small = [
      near("a", "Rust tutorial guide", "https://example.com/a"),
      near("b", "Rust tutorial handbook", "https://example.com/b"),
      near("c", "Rust cookbook", "https://example.com/c"),
      near("d", "Rust tutorial", "https://example.com/d"),
    ];
    expect(nearDuplicatePairs(small).map((p) => `${p.a.id}+${p.b.id}`)).toEqual([
      "a+d",
      "b+d",
      "a+b",
    ]);
  });
});

// ---------------------------------------------------------------------------
// rerankCandidates
// ---------------------------------------------------------------------------

describe("rerankCandidates", () => {
  const hit = (id: string | number, over: Partial<SearchHit> = {}): SearchHit =>
    ({
      id,
      title: `title-${id}`,
      url: `https://hits.example/${id}`,
      domain: "hits.example",
      folderIds: [],
      folderTitles: [],
      tagKeys: [],
      score: 1,
      terms: [],
      queryTerms: [],
      match: {},
      ...over,
    }) as SearchHit;

  it("maps hits to the candidate shape, normalizing ids and empty input", () => {
    expect(rerankCandidates([])).toEqual([]);
    const mapped = rerankCandidates([
      hit("k", {
        title: "Kept",
        url: "https://k.example/?q=1",
        domain: "k.example",
      }),
    ]);
    expect(mapped).toEqual([
      {
        id: "k",
        title: "Kept",
        url: "https://k.example/?q=1",
        domain: "k.example",
      },
    ]);
    const numeric = rerankCandidates([hit(7)]);
    expect(numeric[0]?.id).toBe("7");
  });

  it("takes the top 30 hits in the order runQuery produced them", () => {
    const hits = Array.from({ length: 35 }, (_, i) => hit(`h${i}`));
    const out = rerankCandidates(hits);
    expect(out).toHaveLength(RERANK_CANDIDATE_LIMIT);
    expect(out.map((c) => c.id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `h${i}`),
    );
  });

  it("consumes real runQuery hits end to end", () => {
    const tree = treeOf(
      [folder("f-dev", "Dev", ["Bookmarks bar"])],
      [
        bm("b1", "Rust async book", "https://github.com/rust/async", "f-dev"),
        bm("b2", "Banana bread", "https://baking.example/bread", "f-dev"),
      ],
    );
    const handle = buildSearchHandle(tree, [], []);
    const result = runQuery(handle.index, "rust", handle.ctx);
    const out = rerankCandidates(result.hits);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "b1", domain: "github.com" });
  });
});
