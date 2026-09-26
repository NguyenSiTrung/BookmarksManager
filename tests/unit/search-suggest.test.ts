import { describe, expect, it } from "vitest";
import { Category } from "../../src/schemas/bookmark";
import { FILTER_KEYS, IS_VALUES } from "../../src/search/query";
import { suggestFilters } from "../../src/search/suggest";
import type { Suggestion, SuggestionSources } from "../../src/search/suggest";

/**
 * Coverage for the query-language autocompleter in `src/search/suggest.ts`
 * (conductor spec §3). The function is total: every test asserts on the
 * returned suggestion list and none expects a throw.
 *
 * Throughout, `apply` splices a suggestion back into the query text the way
 * the UI does when the user accepts it.
 */

const TAGS = ["rust", "machine learning", "Async", "tools", "reading list"];
const FOLDERS = ["Work", "Work stuff", "Dev", "Dev/Rust", "personal"];
const SRC: SuggestionSources = { tags: TAGS, folders: FOLDERS };
const EMPTY: SuggestionSources = { tags: [], folders: [] };

const apply = (text: string, s: Suggestion): string =>
  text.slice(0, s.replaceFrom) + s.insertText + text.slice(s.replaceTo);

const inserts = (ss: Suggestion[]): string[] => ss.map((s) => s.insertText);
const labels = (ss: Suggestion[]): string[] => ss.map((s) => s.label);

const allKeys = FILTER_KEYS.map((k) => `${k}:`);

describe("suggestFilters filter-key completion", () => {
  it("offers every key for an empty query", () => {
    const ss = suggestFilters("", 0, SRC);
    expect(inserts(ss)).toEqual(allKeys);
    for (const s of ss) {
      expect(s.kind).toBe("key");
      expect(s.replaceFrom).toBe(0);
      expect(s.replaceTo).toBe(0);
    }
  });

  it("offers every key on whitespace-only input", () => {
    expect(inserts(suggestFilters("   ", 2, SRC))).toEqual(allKeys);
  });

  it("offers every key after a complete token and a space", () => {
    const ss = suggestFilters("rust ", 5, SRC);
    expect(inserts(ss)).toEqual(allKeys);
    for (const s of ss) {
      expect(s.replaceFrom).toBe(5);
      expect(s.replaceTo).toBe(5);
    }
  });

  const partialKeys: Array<[string, string[]]> = [
    // Prefix matches rank before substring matches; within a group the
    // shorter candidate (then the earlier substring offset) wins.
    ["f", ["folder:", "after:", "before:"]],
    ["t", ["tag:", "after:", "category:"]],
    ["ta", ["tag:"]],
    ["tag", ["tag:"]],
    ["folder", ["folder:"]],
    ["fo", ["folder:", "before:"]],
    ["d", ["domain:", "folder:"]],
    ["i", ["is:", "domain:"]],
    ["b", ["before:"]],
    ["a", ["after:", "tag:", "category:", "domain:"]],
    // Case-insensitive prefix matching folds typed case to canonical keys.
    ["T", ["tag:", "after:", "category:"]],
    ["TAG", ["tag:"]],
    ["FOLDER", ["folder:"]],
    ["xyz", []],
    ["q", []],
  ];

  it.each(partialKeys)("completes partial key %s", (input, expected) => {
    const ss = suggestFilters(input, input.length, SRC);
    expect(inserts(ss)).toEqual(expected);
    for (const s of ss) {
      expect(s.kind).toBe("key");
      expect(s.key).toBe(s.insertText.slice(0, -1));
      expect(s.replaceFrom).toBe(0);
      expect(s.replaceTo).toBe(input.length);
    }
  });

  it("keeps the negation prefix outside the replacement span", () => {
    const text = "-f";
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(["folder:", "after:", "before:"]);
    expect(apply(text, ss[0]!)).toBe("-folder:");
    const neg = suggestFilters("-t", 2, SRC);
    expect(inserts(neg)).toEqual(["tag:", "after:", "category:"]);
    expect(apply("-t", neg[0]!)).toBe("-tag:");
  });

  it("treats a lone dash as a negation marker and offers keys after it", () => {
    const ss = suggestFilters("-", 1, SRC);
    expect(inserts(ss)).toEqual(allKeys);
    expect(apply("-", ss[0]!)).toBe("-tag:");
  });

  it("completes a mid-token cursor by replacing the whole key region", () => {
    const ss = suggestFilters("tag", 2, SRC); // ta|g
    expect(inserts(ss)).toEqual(["tag:"]);
    expect(apply("tag", ss[0]!)).toBe("tag:");
  });

  it("completes a key typed before a colon without losing the value", () => {
    const text = "ta:foo"; // t|a:foo — `ta` is not a key, but `tag:` is.
    const ss = suggestFilters(text, 1, SRC);
    expect(ss[0]!.insertText).toBe("tag:");
    expect(apply(text, ss[0]!)).toBe("tag:foo");
  });

  it("completes a real key's name region in place", () => {
    const text = "tag:rust"; // ta|g:rust
    const ss = suggestFilters(text, 2, SRC);
    expect(inserts(ss)).toEqual(["tag:"]);
    expect(apply(text, ss[0]!)).toBe("tag:rust");
  });

  it("completes the token under the cursor in a multi-token query", () => {
    const text = "rust fol";
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(["folder:"]);
    expect(apply(text, ss[0]!)).toBe("rust folder:");
  });

  it("replaces the token starting at the cursor, not just a point", () => {
    const text = "old query"; // cursor on `query` start
    const ss = suggestFilters(text, 4, SRC);
    expect(ss.length).toBeGreaterThan(0);
    expect(ss[0]!.replaceFrom).toBe(4);
    expect(ss[0]!.replaceTo).toBe(9);
    expect(apply(text, ss[0]!)).toBe("old tag:");
  });

  it.each(["hello", "fo-o", "123"])(
    "offers nothing for non-key text %s",
    (input) => {
      expect(suggestFilters(input, input.length, SRC)).toEqual([]);
    },
  );

  it("completes the second token independently of the first", () => {
    const ss = suggestFilters("a b", 3, SRC);
    expect(inserts(ss)).toEqual(["before:"]);
    expect(apply("a b", ss[0]!)).toBe("a before:");
  });

  it("offers nothing for a bare double dash", () => {
    expect(suggestFilters("--", 2, SRC)).toEqual([]);
  });
});

describe("suggestFilters value completion", () => {
  it("offers all tags after tag:", () => {
    const ss = suggestFilters("tag:", 4, SRC);
    expect(labels(ss)).toEqual(TAGS);
    for (const s of ss) {
      expect(s.kind).toBe("value");
      expect(s.key).toBe("tag");
      expect(s.replaceFrom).toBe(4);
      expect(s.replaceTo).toBe(4);
    }
  });

  it("offers all folders after folder:", () => {
    expect(labels(suggestFilters("folder:", 7, SRC))).toEqual(FOLDERS);
  });

  it("offers every Category value after category:", () => {
    const ss = suggestFilters("category:", 9, SRC);
    expect(labels(ss)).toEqual([...Category.options]);
    for (const s of ss) expect(s.key).toBe("category");
  });

  it("offers every IS value after is:, including dead", () => {
    const ss = suggestFilters("is:", 3, SRC);
    expect(labels(ss)).toEqual([...IS_VALUES]);
    for (const s of ss) expect(s.key).toBe("is");
  });

  // Asserted on `label` — the raw value; `insertText` quoting is covered
  // by the dedicated splicing tests below.
  const values: Array<[string, string[]]> = [
    ["tag:ru", ["rust"]],
    ["tag:a", ["Async", "machine learning", "reading list"]],
    ["tag:re", ["reading list"]],
    ["folder:work", ["Work", "Work stuff"]],
    ["folder:dev", ["Dev", "Dev/Rust"]],
    ["category:vid", ["video"]],
    ["category:r", ["repo", "reference", "article", "other"]],
    // `d` also substring-matches `untagged`; `u` substring-matches `duplicate`.
    ["is:u", ["untagged", "duplicate"]],
    ["is:d", ["dead", "duplicate", "untagged"]],
    ["is:du", ["duplicate"]],
    ["is:dead", ["dead"]],
    // Case-insensitive matching, canonical insertion.
    ["tag:AS", ["Async"]],
    ["tag:RUST", ["rust"]],
    ["category:VIDEO", ["video"]],
    ["is:UN", ["untagged"]],
    ["tag:zz", []],
    ["is:x", []],
  ];

  it.each(values)("completes %s", (input, expected) => {
    expect(labels(suggestFilters(input, input.length, SRC))).toEqual(expected);
  });

  it("quotes values containing whitespace on insert", () => {
    const text = "tag:mac";
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(['"machine learning"']);
    expect(apply(text, ss[0]!)).toBe('tag:"machine learning"');
  });

  it("quotes folder titles containing whitespace", () => {
    const text = "folder:work";
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(["Work", '"Work stuff"']);
    expect(apply(text, ss[1]!)).toBe('folder:"Work stuff"');
  });

  it("does not quote values without whitespace", () => {
    const ss = suggestFilters("tag:ru", 6, SRC);
    expect(ss[0]!.insertText).toBe("rust");
    expect(apply("tag:ru", ss[0]!)).toBe("tag:rust");
  });

  it("keeps the negation prefix for negated value filters", () => {
    const dup = suggestFilters("-is:du", 6, SRC);
    expect(inserts(dup)).toEqual(["duplicate"]);
    expect(apply("-is:du", dup[0]!)).toBe("-is:duplicate");

    const ml = suggestFilters("-tag:mac", 8, SRC);
    expect(inserts(ml)).toEqual(['"machine learning"']);
    expect(apply("-tag:mac", ml[0]!)).toBe('-tag:"machine learning"');
  });

  it("completes inside an open quote after a key", () => {
    const text = 'tag:"mac';
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(['"machine learning"']);
    // The stray opening quote is inside the replaced span.
    expect(apply(text, ss[0]!)).toBe('tag:"machine learning"');
  });

  it("completes inside a closed quoted value", () => {
    const text = 'tag:"machine b"';
    const ss = suggestFilters(text, 11, SRC); // tag:"machine| b"
    expect(ss.length).toBeGreaterThan(0);
    expect(apply(text, ss[0]!)).toBe('tag:"machine learning"');
  });

  it("completes when the value region is just an opening quote", () => {
    const text = 'folder:"';
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(["Work", '"Work stuff"', "Dev", "Dev/Rust", "personal"]);
    expect(apply(text, ss[1]!)).toBe('folder:"Work stuff"');
  });

  it("replaces the rest of a mid-value cursor", () => {
    const text = "tag:rzx"; // tag:r|zx — prefix `r` matches, span swallows `zx`
    const ss = suggestFilters(text, 5, SRC);
    expect(ss[0]!.insertText).toBe("rust");
    expect(apply(text, ss[0]!)).toBe("tag:rust");
  });

  it("completes the value of a filter mid-query", () => {
    const text = "tag:ru extra";
    const ss = suggestFilters(text, 6, SRC); // end of `tag:ru`
    expect(ss[0]!.insertText).toBe("rust");
    expect(apply(text, ss[0]!)).toBe("tag:rust extra");
  });

  it("dedupes candidates case-insensitively, keeping first casing", () => {
    const src: SuggestionSources = { tags: ["Rust", "rust", "RUST"], folders: [] };
    const ss = suggestFilters("tag:ru", 6, src);
    expect(inserts(ss)).toEqual(["Rust"]);
  });

  it("returns an empty list when the value source is empty", () => {
    expect(suggestFilters("tag:", 4, EMPTY)).toEqual([]);
    expect(suggestFilters("tag:ru", 6, EMPTY)).toEqual([]);
  });
});

describe("suggestFilters free-form and unknown keys", () => {
  const noValues: Array<[string, number?]> = [
    ["domain:"],
    ["domain:exa"],
    ["-domain:exa"],
    ["before:"],
    ["before:202"],
    ["after:2024-0"],
    ["-after:1"],
    ["title:ab"], // unknown key → free text
    ["notes:x"],
    ["TAG:ru"], // uppercase key is not a filter key
    ["http://x"], // pasted URLs stay free text
    ["mailto:a"],
    ["a:b"],
    [":foo"],
    ["tag:rust domain:g"],
  ];

  it.each(noValues)("offers nothing inside %s", (input, cursor) => {
    expect(suggestFilters(input, cursor ?? input.length, SRC)).toEqual([]);
  });

  it("offers no value suggestions mid-date", () => {
    expect(suggestFilters("before:2024", 9, SRC)).toEqual([]);
  });
});

describe("suggestFilters quoted free text", () => {
  const insideQuotes: Array<[string, number]> = [
    ['"ta', 3],
    ['"tag:', 5],
    ['"hello wo', 8],
    ['-"ta', 4],
    ['foo "ta', 7],
    ['"a" "b', 6],
  ];

  it.each(insideQuotes)(
    "offers no key suggestions inside an open quote: %s",
    (input, cursor) => {
      expect(suggestFilters(input, cursor, SRC)).toEqual([]);
    },
  );

  it("offers nothing inside a closed quoted phrase", () => {
    expect(suggestFilters('"ab"', 2, SRC)).toEqual([]);
  });

  it("offers nothing for free text that is not a key prefix", () => {
    expect(suggestFilters("a-b", 3, SRC)).toEqual([]);
    expect(suggestFilters("foo.bar", 4, SRC)).toEqual([]);
    expect(suggestFilters("日本語", 3, SRC)).toEqual([]);
  });
});

describe("suggestFilters spans splice correctly", () => {
  const splices: Array<[string, number, number, string]> = [
    // input, cursor, pick index, resulting query text
    ["f", 1, 0, "folder:"],
    ["-f", 2, 0, "-folder:"],
    ["tag", 0, 0, "tag:"], // cursor before the token still edits it
    ["tag", 2, 0, "tag:"],
    ["rust ", 5, 0, "rust tag:"],
    ["tag:ru", 6, 0, "tag:rust"],
    ["-tag:ru", 7, 0, "-tag:rust"],
    ["tag:mac", 7, 0, 'tag:"machine learning"'],
    ['tag:"mac', 8, 0, 'tag:"machine learning"'],
    ["is:d", 4, 0, "is:dead"],
    ["folder:dev", 10, 1, "folder:Dev/Rust"],
    ["ta:foo", 1, 0, "tag:foo"],
  ];

  it.each(splices)(
    "splices %s at cursor %i via suggestion %i",
    (input, cursor, pick, expected) => {
      const ss = suggestFilters(input, cursor, SRC);
      expect(ss.length).toBeGreaterThan(pick);
      expect(apply(input, ss[pick]!)).toBe(expected);
    },
  );
});

describe("suggestFilters edge cases and totality", () => {
  it("clamps out-of-range cursors", () => {
    expect(inserts(suggestFilters("tag:ru", 999, SRC))).toEqual(["rust"]);
    expect(inserts(suggestFilters("", -3, SRC))).toEqual(allKeys);
    expect(inserts(suggestFilters("tag", Number.NaN, SRC))).toEqual(allKeys);
  });

  it("never throws on arbitrary input", () => {
    const nasty: Array<[string, number]> = [
      ['"', 1],
      ['"""', 2],
      ["-", 1],
      ["--", 1],
      ["---", 2],
      ['-"', 2],
      [":", 1],
      [":::", 2],
      [":-", 2],
      ["-:", 2],
      ["tag::x", 5],
      ["tag:x:y", 7],
      ["::tag:x", 3],
      ["😀", 1],
      ["tag:😀", 5],
      ['folder:"', 8],
      ['folder:"a', 9],
      ['category:"tool', 14],
      ["\uD800", 1],
      ["tag:\uD800", 5],
      ["a\u00A0b", 3],
      ["tag:a\u00A0b", 7],
      ["is:dead is:dead", 15],
      ["\r\n\t", 3],
      ["`tick`", 3],
      ["'single'", 3],
      ["©:x", 3],
      ["tag:a b", 4],
    ];
    for (const [input, cursor] of nasty) {
      expect(() => suggestFilters(input, cursor, SRC)).not.toThrow();
      const ss = suggestFilters(input, cursor, SRC);
      expect(Array.isArray(ss)).toBe(true);
      for (const s of ss) {
        expect(s.kind === "key" || s.kind === "value").toBe(true);
        expect(typeof s.key).toBe("string");
        expect(typeof s.label).toBe("string");
        expect(typeof s.insertText).toBe("string");
        expect(s.replaceFrom).toBeGreaterThanOrEqual(0);
        expect(s.replaceTo).toBeLessThanOrEqual(input.length);
        expect(s.replaceFrom).toBeLessThanOrEqual(s.replaceTo);
      }
    }
  });

  it("survives generated garbage at every cursor position", () => {
    // Deterministic LCG so failures reproduce (mirrors the parser test).
    let seed = 0x2f6e2b1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = ' \t\n"()-:tzbq/\\😀\uD800x9kae.rs';
    for (let n = 0; n < 200; n++) {
      const len = Math.floor(rand() * 30);
      let s = "";
      for (let i = 0; i < len; i++) {
        s += alphabet.charAt(Math.floor(rand() * alphabet.length));
      }
      const cursor = Math.floor(rand() * (len + 2));
      expect(() => suggestFilters(s, cursor, SRC)).not.toThrow();
      const ss = suggestFilters(s, cursor, SRC);
      for (const su of ss) {
        expect(su.replaceFrom).toBeLessThanOrEqual(su.replaceTo);
        expect(su.replaceFrom).toBeGreaterThanOrEqual(0);
        expect(su.replaceTo).toBeLessThanOrEqual(s.length);
      }
    }
  });

  it("does not mutate or read beyond its sources", () => {
    const tags = Object.freeze(["rust", "machine learning"]);
    const folders = Object.freeze(["Work"]);
    const frozen: SuggestionSources = { tags, folders };
    const ss = suggestFilters("tag:", 4, frozen);
    expect(inserts(ss)).toEqual(["rust", '"machine learning"']);
    expect(tags).toEqual(["rust", "machine learning"]);
  });
});
