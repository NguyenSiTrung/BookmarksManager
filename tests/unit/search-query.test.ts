import { describe, expect, it } from "vitest";
import { Category } from "../../src/schemas/bookmark";
import { parseQuery } from "../../src/search/query";
import type { QueryFilter, QueryTerm, QueryWarning } from "../../src/search/query";

/**
 * Coverage for the query-language parser in `src/search/query.ts`
 * (conductor spec §2). The parser is total: every test asserts on the
 * returned AST + warnings and none expects a throw.
 */

const term = (text: string, over: Partial<QueryTerm> = {}): QueryTerm => ({
  text,
  exact: false,
  negated: false,
  ...over,
});

const warn = (token: string, message: string): QueryWarning => ({ token, message });

// Warning copy is pinned verbatim: it is user-visible UI text.
const MISSING = (key: string) => `Missing value for ${key}:`;
const INVALID_DATE = "Invalid date — use YYYY, YYYY-MM, or YYYY-MM-DD";
const UNKNOWN_CATEGORY =
  "Unknown category — expected one of: article, docs, tool, video, repo, reference, shopping, social, other";
const UNKNOWN_IS = "Unknown is: value — expected one of: duplicate, untagged, dead";
const DEAD_UNAVAILABLE = "Link checking isn't available yet";

describe("parseQuery free text", () => {
  it("returns an empty AST for empty or whitespace-only input", () => {
    expect(parseQuery("")).toEqual({ terms: [], filters: [], warnings: [] });
    for (const input of ["   ", "\t\n ", "\u00A0", "\r\n"]) {
      expect(parseQuery(input)).toEqual({ terms: [], filters: [], warnings: [] });
    }
  });

  it("collects bare words as terms in source order", () => {
    expect(parseQuery("async rust patterns").terms).toEqual([
      term("async"),
      term("rust"),
      term("patterns"),
    ]);
  });

  it("treats a quoted string as one exact term, preserving inner spaces", () => {
    expect(parseQuery('"async rust"').terms).toEqual([
      term("async rust", { exact: true }),
    ]);
  });

  it("handles negation and quotation edge cases", () => {
    const q = parseQuery('foo -bar -"exact phrase"');
    expect(q.terms).toEqual([
      term("foo"),
      term("bar", { negated: true }),
      term("exact phrase", { exact: true, negated: true }),
    ]);
    expect(parseQuery('"-foo"').terms).toEqual([term("-foo", { exact: true })]);
    expect(parseQuery('"" - ""')).toEqual({ terms: [], filters: [], warnings: [] });
    expect(parseQuery("-")).toEqual({ terms: [], filters: [], warnings: [] });
    expect(parseQuery('a"b c"d').terms).toEqual([term("ab cd")]);
  });
});

describe("parseQuery filters", () => {
  it("parses valid filters", () => {
    const cases: Array<[string, QueryFilter[]]> = [
      ["tag:rust", [{ key: "tag", value: "rust", negated: false }]],
      ["tag:Async", [{ key: "tag", value: "Async", negated: false }]],
      ["folder:Work", [{ key: "folder", value: "Work", negated: false }]],
      ["folder:Dev/Rust", [{ key: "folder", value: "Dev/Rust", negated: false }]],
      ["domain:github.com", [{ key: "domain", value: "github.com", negated: false }]],
      ["category:tool", [{ key: "category", value: "tool", negated: false }]],
      [
        "before:2024",
        [{ key: "before", value: { precision: "year", year: 2024 }, negated: false }],
      ],
      [
        "after:2024-06",
        [{ key: "after", value: { precision: "month", year: 2024, month: 6 }, negated: false }],
      ],
      [
        "before:2024-06-15",
        [{ key: "before", value: { precision: "day", year: 2024, month: 6, day: 15 }, negated: false }],
      ],
      ["is:duplicate", [{ key: "is", value: "duplicate", negated: false }]],
      ["is:untagged", [{ key: "is", value: "untagged", negated: false }]],
      ["-tag:old", [{ key: "tag", value: "old", negated: true }]],
      ["-domain:example.com", [{ key: "domain", value: "example.com", negated: true }]],
      ["-is:duplicate", [{ key: "is", value: "duplicate", negated: true }]],
      [
        "-before:1999",
        [{ key: "before", value: { precision: "year", year: 1999 }, negated: true }],
      ],
      ['folder:"Work stuff"', [{ key: "folder", value: "Work stuff", negated: false }]],
      ['tag:"machine learning"', [{ key: "tag", value: "machine learning", negated: false }]],
      ['domain:"example.com"', [{ key: "domain", value: "example.com", negated: false }]],
    ];

    for (const [input, expected] of cases) {
      const q = parseQuery(input);
      expect(q.filters).toEqual(expected);
      expect(q.terms).toEqual([]);
      expect(q.warnings).toEqual([]);
    }
  });

  it("handles repeated filters and preserves category options", () => {
    expect(parseQuery("tag:a tag:b -tag:c").filters).toEqual([
      { key: "tag", value: "a", negated: false },
      { key: "tag", value: "b", negated: false },
      { key: "tag", value: "c", negated: true },
    ]);
    expect(parseQuery("domain:a.com category:tool domain:b.com category:repo").filters).toEqual([
      { key: "domain", value: "a.com", negated: false },
      { key: "category", value: "tool", negated: false },
      { key: "domain", value: "b.com", negated: false },
      { key: "category", value: "repo", negated: false },
    ]);
    for (const value of Category.options) {
      expect(parseQuery(`category:${value}`).filters).toEqual([
        { key: "category", value, negated: false },
      ]);
    }
  });
});

describe("parseQuery is:", () => {
  it("warns and ignores is:dead and -is:dead", () => {
    expect(parseQuery("is:dead")).toEqual({
      filters: [],
      terms: [],
      warnings: [warn("is:dead", DEAD_UNAVAILABLE)],
    });
    expect(parseQuery("-is:dead")).toEqual({
      filters: [],
      terms: [],
      warnings: [warn("-is:dead", DEAD_UNAVAILABLE)],
    });
  });

  it("warns on empty or unknown is: values", () => {
    expect(parseQuery("is:").warnings).toEqual([warn("is:", MISSING("is"))]);
    for (const input of ["is:foo", "is:Duplicate", "is:dead2", "-is:up"]) {
      const q = parseQuery(input);
      expect(q.filters).toEqual([]);
      expect(q.terms).toEqual([]);
      expect(q.warnings).toEqual([warn(input, UNKNOWN_IS)]);
    }
  });
});

describe("parseQuery before:/after: dates", () => {
  it("parses valid dates with various precisions", () => {
    const valid: Array<[string, QueryFilter[]]> = [
      ["before:2024", [{ key: "before", value: { precision: "year", year: 2024 }, negated: false }]],
      ["after:1999", [{ key: "after", value: { precision: "year", year: 1999 }, negated: false }]],
      ["after:2024-06", [{ key: "after", value: { precision: "month", year: 2024, month: 6 }, negated: false }]],
      ["before:2024-06-15", [{ key: "before", value: { precision: "day", year: 2024, month: 6, day: 15 }, negated: false }]],
      ["after:2024-02-29", [{ key: "after", value: { precision: "day", year: 2024, month: 2, day: 29 }, negated: false }]],
      ["before:0000", [{ key: "before", value: { precision: "year", year: 0 }, negated: false }]],
      ["after:9999-12-31", [{ key: "after", value: { precision: "day", year: 9999, month: 12, day: 31 }, negated: false }]],
      ['after:"2024"', [{ key: "after", value: { precision: "year", year: 2024 }, negated: false }]],
    ];
    for (const [input, expected] of valid) {
      const q = parseQuery(input);
      expect(q.filters).toEqual(expected);
      expect(q.warnings).toEqual([]);
    }
  });

  it("warns and drops invalid dates", () => {
    const invalid = [
      "before:202",
      "before:20245",
      "before:2024-6",
      "before:2024-06-1",
      "before:2024-13",
      "before:2024-00",
      "before:2024-02-30",
      "before:2024-04-31",
      "after:2023-02-29",
      "before:yesterday",
      "after:2024/06/15",
      "before:2024-06-15x",
      "before:-2024",
    ];
    for (const input of invalid) {
      const q = parseQuery(input);
      expect(q.filters).toEqual([]);
      expect(q.terms).toEqual([]);
      expect(q.warnings).toEqual([warn(input, INVALID_DATE)]);
    }
  });

  it("handles missing date values or spaces after colon", () => {
    expect(parseQuery("before:").warnings).toEqual([warn("before:", MISSING("before"))]);
    expect(parseQuery("-after:").warnings).toEqual([warn("-after:", MISSING("after"))]);
    const q = parseQuery("before: 2024");
    expect(q.warnings).toEqual([warn("before:", MISSING("before"))]);
    expect(q.filters).toEqual([]);
    expect(q.terms).toEqual([term("2024")]);
  });
});

describe("parseQuery unknown keys → free text", () => {
  it("treats unknown keys as free text", () => {
    const cases: Array<[string, string]> = [
      ["title:foo", "title:foo"],
      ["notes:bar", "notes:bar"],
      ["url:https://x", "url:https://x"],
      ["https://example.com/?a=b:c", "https://example.com/?a=b:c"],
      ["javascript:void(0)", "javascript:void(0)"],
      ["mailto:a@b.com", "mailto:a@b.com"],
      ["is2:duplicate", "is2:duplicate"],
      ["categoryy:tool", "categoryy:tool"],
      ["TAG:rust", "TAG:rust"],
      ["Tag:rust", "Tag:rust"],
      [":foo", ":foo"],
      ["a:b:c", "a:b:c"],
      ["日本語:値", "日本語:値"],
    ];
    for (const [input, text] of cases) {
      const q = parseQuery(input);
      expect(q.terms).toEqual([term(text)]);
      expect(q.filters).toEqual([]);
      expect(q.warnings).toEqual([]);
    }
  });

  it("handles quotes and negation on unknown keys", () => {
    expect(parseQuery('title:"foo bar"').terms).toEqual([term("title:foo bar")]);
    expect(parseQuery("-title:foo").terms).toEqual([
      term("title:foo", { negated: true }),
    ]);
  });
});

describe("parseQuery warnings for malformed known-key values", () => {
  it("warns on malformed known-key values", () => {
    const cases: Array<[string, QueryWarning[]]> = [
      ["tag:", [warn("tag:", MISSING("tag"))]],
      ['tag:""', [warn('tag:""', MISSING("tag"))]],
      ["folder:", [warn("folder:", MISSING("folder"))]],
      ["domain:", [warn("domain:", MISSING("domain"))]],
      ["category:", [warn("category:", MISSING("category"))]],
      ["category:bogus", [warn("category:bogus", UNKNOWN_CATEGORY)]],
      ["category:Video", [warn("category:Video", UNKNOWN_CATEGORY)]],
      ["-category:nope", [warn("-category:nope", UNKNOWN_CATEGORY)]],
      ["is:", [warn("is:", MISSING("is"))]],
      ["is:foo", [warn("is:foo", UNKNOWN_IS)]],
      ["before:see-me", [warn("before:see-me", INVALID_DATE)]],
      ["-after:13-45", [warn("-after:13-45", INVALID_DATE)]],
    ];
    for (const [input, warnings] of cases) {
      const q = parseQuery(input);
      expect(q.warnings).toEqual(warnings);
      expect(q.filters).toEqual([]);
      expect(q.terms).toEqual([]);
    }
  });

  it("keeps the valid parts of a query that also has warnings", () => {
    const q = parseQuery("rust before:bad tag:x category:nope");
    expect(q.terms).toEqual([term("rust")]);
    expect(q.filters).toEqual([{ key: "tag", value: "x", negated: false }]);
    expect(q.warnings).toEqual([
      warn("before:bad", INVALID_DATE),
      warn("category:nope", UNKNOWN_CATEGORY),
    ]);
  });
});

describe("parseQuery mixed queries", () => {
  it("parses a full query end to end", () => {
    const q = parseQuery(
      'rust -draft tag:async tag:"borrow checker" -folder:"old stuff" ' +
        "domain:github.com category:tool after:2024-01 before:2025 " +
        'is:untagged -is:duplicate title:x "exact phrase" -"nope phrase"',
    );
    expect(q.terms).toEqual([
      term("rust"),
      term("draft", { negated: true }),
      term("title:x"),
      term("exact phrase", { exact: true }),
      term("nope phrase", { exact: true, negated: true }),
    ]);
    expect(q.filters).toEqual([
      { key: "tag", value: "async", negated: false },
      { key: "tag", value: "borrow checker", negated: false },
      { key: "folder", value: "old stuff", negated: true },
      { key: "domain", value: "github.com", negated: false },
      { key: "category", value: "tool", negated: false },
      { key: "after", value: { precision: "month", year: 2024, month: 1 }, negated: false },
      { key: "before", value: { precision: "year", year: 2025 }, negated: false },
      { key: "is", value: "untagged", negated: false },
      { key: "is", value: "duplicate", negated: true },
    ]);
    expect(q.warnings).toEqual([]);
  });
});

describe("parseQuery totality", () => {
  it("never throws and stays well-formed on edge cases", () => {
    const nasty: string[] = [
      '"',
      '"""',
      "-",
      "--",
      "---",
      '-"',
      '-"-',
      ":",
      ":::",
      ":-",
      "-:",
      "tag::x",
      "tag:x:y",
      "::tag:x",
      "a\u0000b",
      "😀 tag:😀",
      '"foo',
      'foo"',
      'folder:"',
      'folder:"a',
      'category:"tool',
      "before:2024-",
      "before:-2024-06",
      "\uD800",
      "is:dead is:dead is:dead",
      "\r\n\t",
      "'single'",
      "`tick`",
      String.raw`a\b`,
      "©:x",
      "a\u00A0b",
      "tag:a\u00A0b",
    ];

    for (const input of nasty) {
      const q = parseQuery(input);
      expect(Array.isArray(q.terms)).toBe(true);
      expect(Array.isArray(q.filters)).toBe(true);
      expect(Array.isArray(q.warnings)).toBe(true);
      for (const w of q.warnings) {
        expect(typeof w.token).toBe("string");
        expect(typeof w.message).toBe("string");
        expect(w.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("survives generated garbage", () => {
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ' \t\n"()-:tzbq/\\😀\uD800x9kae.rs';
    for (let n = 0; n < 300; n++) {
      const len = Math.floor(rand() * 40);
      let s = "";
      for (let i = 0; i < len; i++) {
        s += alphabet.charAt(Math.floor(rand() * alphabet.length));
      }
      expect(() => parseQuery(s)).not.toThrow();
      const q = parseQuery(s);
      expect(Array.isArray(q.terms)).toBe(true);
      expect(Array.isArray(q.filters)).toBe(true);
      expect(Array.isArray(q.warnings)).toBe(true);
    }
  });
});
