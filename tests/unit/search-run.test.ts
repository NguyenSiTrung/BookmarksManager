import { describe, expect, it } from "vitest";
import { buildIndex, buildTagNameMap } from "../../src/search/index";
import type { SearchIndex, SearchSourceBookmark } from "../../src/search/index";
import { parseQuery } from "../../src/search/query";
import { collectDuplicateIds, runQuery } from "../../src/search/run";
import type { RunQueryContext, RunQueryResult } from "../../src/search/run";
import { searchSource, searchTagDefs } from "../fixtures/search";

/**
 * Coverage for `src/search/run.ts` — the executor half of the query
 * language (conductor spec §1–§2): free-text AND/exact/negation, every
 * filter key with its AND/OR/negation rules, local-time `before:`/`after:`
 * bounds, `is:` flags, relevance vs. tree ordering, and the warnings echo.
 * All inputs are plain `SearchSourceBookmark` data — the module never
 * touches `chrome`.
 */

const tagNames = buildTagNameMap(searchTagDefs);

const ids = (result: RunQueryResult): string[] =>
  result.hits.map((hit) => hit.id);
const sortedIds = (result: RunQueryResult): string[] => ids(result).sort();

/** Millis for a LOCAL wall-clock moment — mirrors the executor's local-time bound math. */
const local = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

// ---------------------------------------------------------------------------
// Shared corpus. treeOrder deliberately differs from insertion order so tests
// prove the caller's order — not the index's — drives term-free results.
// ---------------------------------------------------------------------------

const corpus: SearchSourceBookmark[] = [
  searchSource({
    id: "rust-book",
    title: "Async Rust handbook",
    url: "https://github.com/rust/async-book",
    tagKeys: ["typescript", "reading list"],
    category: "docs",
    dateAdded: local(2024, 6, 15),
    ancestors: [
      { id: "1", title: "Bookmarks bar" },
      { id: "dev", title: "Dev" },
      { id: "rust", title: "Rust" },
    ],
    notes: "borrow checker patterns",
  }),
  searchSource({
    id: "gist",
    title: "Gist snippet",
    url: "https://gist.github.com/u/x",
    tagKeys: [],
    category: "repo",
    dateAdded: local(2023, 1, 20),
    ancestors: [
      { id: "1", title: "Bookmarks bar" },
      { id: "pers", title: "Personal" },
    ],
  }),
  searchSource({
    id: "notexample",
    title: "NotExample tooling",
    url: "https://notexample.com/",
    tagKeys: ["typescript"],
    category: "tool",
    dateAdded: local(2024, 6, 14),
    ancestors: [
      { id: "1", title: "Bookmarks bar" },
      { id: "dev", title: "Dev" },
    ],
  }),
  searchSource({
    id: "dup-a",
    title: "Dup page A",
    url: "https://dup.example/x",
    tagKeys: ["reading list"],
    dateAdded: local(2024, 6, 15),
    ancestors: [
      { id: "1", title: "Bookmarks bar" },
      { id: "dev", title: "Dev" },
      { id: "rust", title: "Rust" },
    ],
  }),
  searchSource({
    id: "dup-b",
    title: "Dup page B",
    url: "https://dup.example/x",
    tagKeys: [],
    dateAdded: local(2025, 2, 1),
    ancestors: [{ id: "1", title: "Bookmarks bar" }],
  }),
  searchSource({
    id: "undated",
    title: "Undated page",
    url: "https://undated.example/",
    tagKeys: [],
    ancestors: [{ id: "1", title: "Bookmarks bar" }],
  }),
  searchSource({
    id: "exsub",
    title: "Example page",
    url: "https://app.example.com/page",
    tagKeys: [],
    ancestors: [],
  }),
];

const corpusIndex: SearchIndex = buildIndex(corpus, tagNames);
/** Reverse-ish of insertion order — never coincides with MiniSearch scores. */
const corpusTree = [
  "undated",
  "exsub",
  "dup-b",
  "dup-a",
  "notexample",
  "gist",
  "rust-book",
];
const corpusCtx: RunQueryContext = {
  treeOrder: corpusTree,
  duplicateIds: collectDuplicateIds(corpus),
};
const run = (query: string): RunQueryResult =>
  runQuery(corpusIndex, query, corpusCtx);

const ALL_TREE = corpusTree;

// ---------------------------------------------------------------------------

describe("runQuery — free-text terms", () => {
  it("ANDs multiple terms across fields", () => {
    // "rust" hits title+url, "checker" hits notes — the doc has both.
    expect(ids(run("rust checker"))).toEqual(["rust-book"]);
    expect(ids(run("rust async handbook"))).toEqual(["rust-book"]);
  });

  it("inherits prefix matching and fuzzy typo tolerance from the index", () => {
    expect(ids(run("hand"))).toEqual(["rust-book"]); // prefix of "handbook"
    expect(ids(run("hndbook"))).toEqual(["rust-book"]); // one deletion off
  });

  it("excludes hits matching a negated term", () => {
    expect(ids(run("rust -handbook"))).toEqual([]);
    // Negation alone: all docs minus the rust one, in tree order.
    expect(ids(run("-rust"))).toEqual([
      "undated",
      "exsub",
      "dup-b",
      "dup-a",
      "notexample",
      "gist",
    ]);
  });

  it("ANDs the words of a non-exact term containing spaces", () => {
    // Parser turns `p"age b"` into one term with text "page b".
    const q = parseQuery('p"age b"');
    expect(q.terms).toEqual([{ text: "page b", exact: false, negated: false }]);
    expect(ids(runQuery(corpusIndex, q, corpusCtx))).toEqual(["dup-b"]);
  });

  it("returns a display-ready stored-field shape on hits", () => {
    const hit = run("rust").hits[0];
    expect(hit?.id).toBe("rust-book");
    expect(hit?.title).toBe("Async Rust handbook");
    expect(hit?.url).toBe("https://github.com/rust/async-book");
    expect(hit?.domain).toBe("github.com");
    expect(hit?.folderTitles).toEqual(["Bookmarks bar", "Dev", "Rust"]);
    expect(hit?.tagKeys).toEqual(["typescript", "reading list"]);
    expect(hit?.category).toBe("docs");
    expect(hit?.dateAdded).toBe(local(2024, 6, 15));
  });
});

describe("runQuery — exact phrases", () => {
  const sources: SearchSourceBookmark[] = [
    searchSource({
      id: "adjacent-title",
      title: "Async Rust handbook",
      url: "https://p1.example/",
    }),
    searchSource({
      id: "scattered-title",
      title: "Rust async patterns",
      url: "https://p2.example/",
    }),
    searchSource({
      id: "in-notes",
      title: "Unrelated",
      url: "https://p3.example/",
      notes: "all about async rust stuff",
    }),
    searchSource({
      id: "split-fields",
      title: "Async patterns",
      url: "https://p4.example/",
      notes: "rust guide",
    }),
    searchSource({
      id: "prefix-only",
      title: "Asynchronous rust",
      url: "https://p5.example/",
    }),
  ];
  const index = buildIndex(sources, tagNames);
  const ctx: RunQueryContext = {
    treeOrder: [
      "prefix-only",
      "split-fields",
      "in-notes",
      "scattered-title",
      "adjacent-title",
    ],
  };
  const runPhrase = (query: string): RunQueryResult =>
    runQuery(index, query, ctx);

  it("matches the literal phrase, not scattered words", () => {
    // in-notes keeps: its words share only `notes`, which is indexed but not
    // stored — adjacency can't be disproved, so the hit is kept.
    expect(ids(runPhrase('"async rust"'))).toEqual([
      "adjacent-title",
      "in-notes",
    ]);
  });

  it("drops hits whose words only co-occur across different fields", () => {
    // split-fields has "async" in title and "rust" in notes — the phrase can
    // live in neither, so neither the positive nor the negated form keeps it.
    expect(ids(runPhrase('"async rust"'))).not.toContain("split-fields");
    expect(ids(runPhrase('-"async rust"'))).toEqual([
      "prefix-only",
      "split-fields",
      "scattered-title",
    ]);
  });

  it("matches a single-word exact term verbatim — no prefix or fuzzy", () => {
    // "asynchronous" is not the token "async".
    expect(sortedIds(runPhrase('"async"'))).toEqual([
      "adjacent-title",
      "in-notes",
      "scattered-title",
      "split-fields",
    ]);
    // The same word unquoted does prefix-match "asynchronous".
    expect(sortedIds(runPhrase("async"))).toEqual([
      "adjacent-title",
      "in-notes",
      "prefix-only",
      "scattered-title",
      "split-fields",
    ]);
    expect(ids(runPhrase('-"async"'))).toEqual(["prefix-only"]);
  });
});

describe("runQuery — tag:", () => {
  const cases: Array<[string, string[]]> = [
    ["tag:typescript", ["notexample", "rust-book"]],
    // Case-insensitive against the nameKey.
    ["tag:TypeScript", ["notexample", "rust-book"]],
    ['tag:"reading list"', ["dup-a", "rust-book"]],
    // Repeated tag: filters must ALL match (AND).
    ['tag:typescript tag:"reading list"', ["rust-book"]],
    ["tag:typescript -tag:\"reading list\"", ["notexample"]],
    [
      "-tag:typescript",
      ["undated", "exsub", "dup-b", "dup-a", "gist"],
    ],
    ["tag:nonexistent", []],
  ];

  it.each(cases)("%s → %j", (query, expected) => {
    expect(ids(run(query))).toEqual(expected);
  });
});

describe("runQuery — folder:", () => {
  const cases: Array<[string, string[]]> = [
    // Subtree semantics: any ancestor titled "Dev".
    ["folder:Dev", ["dup-a", "notexample", "rust-book"]],
    ["folder:dev", ["dup-a", "notexample", "rust-book"]],
    ["folder:Rust", ["dup-a", "rust-book"]],
    ["folder:Personal", ["gist"]],
    [
      'folder:"Bookmarks bar"',
      ["undated", "dup-b", "dup-a", "notexample", "gist", "rust-book"],
    ],
    // A `/` value is a contiguous ancestor path, in order.
    ["folder:dev/rust", ["dup-a", "rust-book"]],
    ["folder:rust/dev", []],
    ['folder:"bookmarks bar"/dev', ["dup-a", "notexample", "rust-book"]],
    // Repeated folder: filters OR within the key.
    [
      "folder:Dev folder:Personal",
      ["dup-a", "notexample", "gist", "rust-book"],
    ],
    // Negation ANDs over the OR.
    ["folder:Dev -folder:Rust", ["notexample"]],
    ["-folder:Dev", ["undated", "exsub", "dup-b", "gist"]],
    ["folder:Nope", []],
  ];

  it.each(cases)("%s → %j", (query, expected) => {
    expect(ids(run(query))).toEqual(expected);
  });
});

describe("runQuery — domain:", () => {
  const cases: Array<[string, string[]]> = [
    // Host or any subdomain of the value.
    ["domain:github.com", ["gist", "rust-book"]],
    ["domain:gist.github.com", ["gist"]],
    // "example.com" must NOT match "notexample.com" (or the .example hosts).
    ["domain:example.com", ["exsub"]],
    ["domain:notexample.com", ["notexample"]],
    // A www. prefix on the filter value is ignored; case-insensitive.
    ["domain:WWW.EXAMPLE.COM", ["exsub"]],
    ["domain:dup.example", ["dup-b", "dup-a"]],
    // OR within the key.
    [
      "domain:github.com domain:dup.example",
      ["dup-b", "dup-a", "gist", "rust-book"],
    ],
    // Negated value ANDs over the positive OR.
    ["domain:github.com -domain:gist.github.com", ["rust-book"]],
  ];

  it.each(cases)("%s → %j", (query, expected) => {
    expect(ids(run(query))).toEqual(expected);
  });
});

describe("runQuery — category:", () => {
  const cases: Array<[string, string[]]> = [
    ["category:docs", ["rust-book"]],
    // OR within the key.
    ["category:tool category:repo", ["notexample", "gist"]],
    // Uncategorized docs still satisfy a negated category filter.
    [
      "-category:docs",
      ["undated", "exsub", "dup-b", "dup-a", "notexample", "gist"],
    ],
    ["category:article", []],
    [
      "-category:repo -category:docs",
      ["undated", "exsub", "dup-b", "dup-a", "notexample"],
    ],
  ];

  it.each(cases)("%s → %j", (query, expected) => {
    expect(ids(run(query))).toEqual(expected);
  });
});

describe("runQuery — before:/after:", () => {
  const cases: Array<[string, string[]]> = [
    // after: includes the period (>= its start), no upper bound.
    ["after:2024", ["dup-b", "dup-a", "notexample", "rust-book"]],
    // before: excludes the period (< its start).
    ["before:2024", ["gist"]],
    ["after:2024-06", ["dup-b", "dup-a", "notexample", "rust-book"]],
    ["before:2024-06", ["gist"]],
    // Day precision: Jun 15 noon is inside Jun 15; Jun 14 is not.
    ["after:2024-06-15", ["dup-b", "dup-a", "rust-book"]],
    ["before:2024-06-15", ["notexample", "gist"]],
    ["after:2024-06-14 before:2024-06-16", ["dup-a", "notexample", "rust-book"]],
    // A doc with no dateAdded never matches a positive date filter …
    ["-after:2024", ["undated", "exsub", "gist"]],
    // … and always matches a negated one.
    [
      "-before:2024",
      ["undated", "exsub", "dup-b", "dup-a", "notexample", "rust-book"],
    ],
  ];

  it.each(cases)("%s → %j", (query, expected) => {
    expect(ids(run(query))).toEqual(expected);
  });

  describe("precision boundaries (local time)", () => {
    const edge = buildIndex(
      [
        searchSource({
          id: "jan1",
          title: "January first",
          url: "https://jan1.example/",
          dateAdded: local(2024, 1, 1, 0, 0),
        }),
        searchSource({
          id: "feb29",
          title: "Leap day",
          url: "https://feb29.example/",
          dateAdded: local(2024, 2, 29, 0, 0),
        }),
        searchSource({
          id: "mar1",
          title: "March first",
          url: "https://mar1.example/",
          dateAdded: local(2024, 3, 1, 0, 0),
        }),
        searchSource({
          id: "dec31",
          title: "Year end",
          url: "https://dec31.example/",
          dateAdded: local(2024, 12, 31, 23, 59),
        }),
      ],
      tagNames,
    );
    const edgeCtx: RunQueryContext = {
      treeOrder: ["dec31", "mar1", "feb29", "jan1"],
    };
    const runEdge = (query: string): RunQueryResult =>
      runQuery(edge, query, edgeCtx);

    const cases: Array<[string, string[]]> = [
      // Year bound start = Jan 1 00:00 local: exactly-on-the-bound counts for
      // after:, not for before:.
      ["after:2024", ["dec31", "mar1", "feb29", "jan1"]],
      ["before:2024", []],
      ["before:2025", ["dec31", "mar1", "feb29", "jan1"]],
      ["after:2025", []],
      // Month precision.
      ["after:2024-02", ["dec31", "mar1", "feb29"]],
      ["before:2024-03", ["feb29", "jan1"]],
      // Day precision on a leap-day edge.
      ["after:2024-02-29", ["dec31", "mar1", "feb29"]],
      ["before:2024-02-29", ["jan1"]],
      ["after:2024-02-29 before:2024-03-01", ["feb29"]],
      // Year < 100 must not pick up the 1900 constructor offset.
      ["after:0000", ["dec31", "mar1", "feb29", "jan1"]],
      ["before:0000", []],
    ];

    it.each(cases)("%s → %j", (query, expected) => {
      expect(ids(runEdge(query))).toEqual(expected);
    });
  });
});

describe("runQuery — is:", () => {
  it("is:duplicate keeps only members of a duplicate group", () => {
    expect(ids(run("is:duplicate"))).toEqual(["dup-b", "dup-a"]);
    expect(ids(run("-is:duplicate"))).toEqual([
      "undated",
      "exsub",
      "notexample",
      "gist",
      "rust-book",
    ]);
  });

  it("is:untagged keeps docs with an empty tagKeys list", () => {
    expect(ids(run("is:untagged"))).toEqual([
      "undated",
      "exsub",
      "dup-b",
      "gist",
    ]);
  });

  it("is: filters AND with each other and with negation", () => {
    // dup-a is a duplicate but tagged; dup-b is both.
    expect(ids(run("is:duplicate is:untagged"))).toEqual(["dup-b"]);
    expect(ids(run("is:untagged -is:duplicate"))).toEqual([
      "undated",
      "exsub",
      "gist",
    ]);
  });

  it("is:duplicate matches nothing when no duplicateIds context is given", () => {
    const noDupCtx: RunQueryContext = { treeOrder: corpusTree };
    expect(ids(runQuery(corpusIndex, "is:duplicate", noDupCtx))).toEqual([]);
    expect(ids(runQuery(corpusIndex, "-is:duplicate", noDupCtx))).toEqual(
      ALL_TREE,
    );
  });
});

describe("runQuery — cross-key AND and mixed queries", () => {
  const cases: Array<[string, string[]]> = [
    ["tag:typescript category:tool", ["notexample"]],
    ["tag:typescript -category:tool", ["rust-book"]],
    ["domain:github.com category:repo", ["gist"]],
    ["folder:Dev domain:github.com", ["rust-book"]],
    ["folder:Dev after:2024-06-15", ["dup-a", "rust-book"]],
    ["rust folder:Rust", ["rust-book"]],
    ["dup is:untagged", ["dup-b"]],
    ['page tag:"reading list"', ["dup-a"]],
    ["checker category:docs", ["rust-book"]],
    // Filter + negated term.
    ["dup -folder:Rust", ["dup-b"]],
    // Negated term + negated filter.
    ["dup -page -folder:Rust", []],
  ];

  it.each(cases)("%s → %j", (query, expected) => {
    expect(ids(run(query))).toEqual(expected);
  });
});

describe("runQuery — ordering", () => {
  // Mirrors the field-boost corpus of search-index.test.ts; insertion and
  // tree order both differ from the expected relevance order.
  const boostNames = buildTagNameMap([
    { name: "Quasar Stuff", nameKey: "quasar stuff" },
  ]);
  const boostIndex = buildIndex(
    [
      searchSource({
        id: "title",
        title: "Quasar guide",
        url: "https://t.example/",
      }),
      searchSource({
        id: "tags",
        title: "Other",
        url: "https://g.example/",
        tagKeys: ["quasar stuff"],
      }),
      searchSource({
        id: "domain",
        title: "Other",
        url: "https://quasar.example.net/",
      }),
      searchSource({
        id: "url",
        title: "Other",
        url: "https://u.example/quasar-cli",
      }),
      searchSource({
        id: "notes",
        title: "Other",
        url: "https://n.example/",
        notes: "quasar config",
      }),
    ],
    boostNames,
  );
  const boostCtx: RunQueryContext = {
    treeOrder: ["notes", "url", "domain", "tags", "title"],
  };
  const runBoost = (query: string): RunQueryResult =>
    runQuery(boostIndex, query, boostCtx);

  it("orders free-text results by relevance, not tree order", () => {
    expect(ids(runBoost("quasar"))).toEqual([
      "title",
      "tags",
      "domain",
      "url",
      "notes",
    ]);
  });

  it("orders filter-only results in tree order", () => {
    expect(ids(runBoost("is:untagged"))).toEqual([
      "notes",
      "url",
      "domain",
      "title",
    ]);
  });

  it("orders negated-only results in tree order", () => {
    expect(ids(runBoost("-guide"))).toEqual(["notes", "url", "domain", "tags"]);
  });

  it("returns all docs in tree order for an empty query", () => {
    expect(ids(runBoost(""))).toEqual(["notes", "url", "domain", "tags", "title"]);
    expect(ids(runBoost("   "))).toEqual([
      "notes",
      "url",
      "domain",
      "tags",
      "title",
    ]);
  });
});

describe("runQuery — input forms and warnings", () => {
  it("accepts a raw string or a pre-parsed ParsedQuery identically", () => {
    const fromString = run("tag:typescript");
    const fromParsed = runQuery(
      corpusIndex,
      parseQuery("tag:typescript"),
      corpusCtx,
    );
    expect(ids(fromParsed)).toEqual(ids(fromString));
    expect(fromParsed.warnings).toEqual(fromString.warnings);
  });

  it("echoes parser warnings through while still running the rest", () => {
    const result = run("before:bad rust");
    expect(result.warnings).toEqual([
      {
        token: "before:bad",
        message: "Invalid date — use YYYY, YYYY-MM, or YYYY-MM-DD",
      },
    ]);
    expect(ids(result)).toEqual(["rust-book"]);
  });

  it("is:dead warns, matches nothing, and leaves the rest runnable", () => {
    const result = run("is:dead");
    expect(result.warnings).toEqual([
      { token: "is:dead", message: "Link checking isn't available yet" },
    ]);
    expect(ids(result)).toEqual(ALL_TREE);
  });
});

describe("collectDuplicateIds", () => {
  it("unions exact and normalized group members", () => {
    // http/https pair is a normalized-only duplicate.
    const ids = collectDuplicateIds([
      { id: "a", url: "https://x.example/1" },
      { id: "b", url: "http://x.example/1" },
      { id: "c", url: "https://y.example/" },
    ]);
    expect(ids).toEqual(new Set(["a", "b"]));
  });

  it("returns an empty set when nothing groups", () => {
    expect(collectDuplicateIds([])).toEqual(new Set());
    expect(
      collectDuplicateIds([
        { id: "a", url: "https://a.example/" },
        { id: "b", url: "https://b.example/" },
      ]),
    ).toEqual(new Set());
  });
});
