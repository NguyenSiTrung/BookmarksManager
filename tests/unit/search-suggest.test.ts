import { describe, expect, it } from "vitest";
import { Category } from "../../src/schemas/bookmark";
import { FILTER_KEYS, IS_VALUES } from "../../src/search/query";
import { suggestFilters } from "../../src/search/suggest";
import type { Suggestion, SuggestionSources } from "../../src/search/suggest";

/**
 * Coverage for the query-language autocompleter in `src/search/suggest.ts`
 * (conductor spec §3). The function is total: every test asserts on the
 * returned suggestion list and none expects a throw.
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
  it("offers every key for empty, whitespace, or space-after-token inputs", () => {
    const ssEmpty = suggestFilters("", 0, SRC);
    expect(inserts(ssEmpty)).toEqual(allKeys);
    expect(inserts(suggestFilters("   ", 2, SRC))).toEqual(allKeys);

    const ssSpace = suggestFilters("rust ", 5, SRC);
    expect(inserts(ssSpace)).toEqual(allKeys);
    for (const s of ssSpace) {
      expect(s.replaceFrom).toBe(5);
      expect(s.replaceTo).toBe(5);
    }
  });

  it("completes partial keys correctly", () => {
    const partialKeys: Array<[string, string[]]> = [
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
      ["T", ["tag:", "after:", "category:"]],
      ["TAG", ["tag:"]],
      ["FOLDER", ["folder:"]],
      ["xyz", []],
      ["q", []],
    ];

    for (const [input, expected] of partialKeys) {
      const ss = suggestFilters(input, input.length, SRC);
      expect(inserts(ss)).toEqual(expected);
      for (const s of ss) {
        expect(s.kind).toBe("key");
        expect(s.key).toBe(s.insertText.slice(0, -1));
        expect(s.replaceFrom).toBe(0);
        expect(s.replaceTo).toBe(input.length);
      }
    }
  });

  it("handles negation prefixes, dashes, and mid-token cursors", () => {
    const text = "-f";
    const ss = suggestFilters(text, text.length, SRC);
    expect(inserts(ss)).toEqual(["folder:", "after:", "before:"]);
    expect(apply(text, ss[0]!)).toBe("-folder:");

    const neg = suggestFilters("-t", 2, SRC);
    expect(inserts(neg)).toEqual(["tag:", "after:", "category:"]);
    expect(apply("-t", neg[0]!)).toBe("-tag:");

    const dash = suggestFilters("-", 1, SRC);
    expect(inserts(dash)).toEqual(allKeys);
    expect(apply("-", dash[0]!)).toBe("-tag:");

    const mid = suggestFilters("tag", 2, SRC);
    expect(inserts(mid)).toEqual(["tag:"]);
    expect(apply("tag", mid[0]!)).toBe("tag:");

    const beforeColon = suggestFilters("ta:foo", 1, SRC);
    expect(beforeColon[0]!.insertText).toBe("tag:");
    expect(apply("ta:foo", beforeColon[0]!)).toBe("tag:foo");

    const realKey = suggestFilters("tag:rust", 2, SRC);
    expect(inserts(realKey)).toEqual(["tag:"]);
    expect(apply("tag:rust", realKey[0]!)).toBe("tag:rust");

    const multi = suggestFilters("rust fol", 8, SRC);
    expect(inserts(multi)).toEqual(["folder:"]);
    expect(apply("rust fol", multi[0]!)).toBe("rust folder:");

    const oldQuery = suggestFilters("old query", 4, SRC);
    expect(oldQuery[0]!.replaceFrom).toBe(4);
    expect(oldQuery[0]!.replaceTo).toBe(9);
    expect(apply("old query", oldQuery[0]!)).toBe("old tag:");

    for (const nonKey of ["hello", "fo-o", "123", "--"]) {
      expect(suggestFilters(nonKey, nonKey.length, SRC)).toEqual([]);
    }

    const secToken = suggestFilters("a b", 3, SRC);
    expect(inserts(secToken)).toEqual(["before:"]);
    expect(apply("a b", secToken[0]!)).toBe("a before:");
  });
});

describe("suggestFilters value completion", () => {
  it("offers full sets for tag:, folder:, category:, is:", () => {
    const ssTags = suggestFilters("tag:", 4, SRC);
    expect(labels(ssTags)).toEqual(TAGS);
    for (const s of ssTags) {
      expect(s.kind).toBe("value");
      expect(s.key).toBe("tag");
      expect(s.replaceFrom).toBe(4);
      expect(s.replaceTo).toBe(4);
    }
    expect(labels(suggestFilters("folder:", 7, SRC))).toEqual(FOLDERS);
    expect(labels(suggestFilters("category:", 9, SRC))).toEqual([...Category.options]);
    expect(labels(suggestFilters("is:", 3, SRC))).toEqual([...IS_VALUES]);
  });

  it("completes prefix-matching values for different keys", () => {
    const values: Array<[string, string[]]> = [
      ["tag:ru", ["rust"]],
      ["tag:a", ["Async", "machine learning", "reading list"]],
      ["tag:re", ["reading list"]],
      ["folder:work", ["Work", "Work stuff"]],
      ["folder:dev", ["Dev", "Dev/Rust"]],
      ["category:vid", ["video"]],
      ["category:r", ["repo", "reference", "article", "other"]],
      ["is:u", ["untagged", "duplicate"]],
      ["is:d", ["dead", "duplicate", "untagged"]],
      ["is:du", ["duplicate"]],
      ["is:dead", ["dead"]],
      ["tag:AS", ["Async"]],
      ["tag:RUST", ["rust"]],
      ["category:VIDEO", ["video"]],
      ["is:UN", ["untagged"]],
      ["tag:zz", []],
      ["is:x", []],
    ];

    for (const [input, expected] of values) {
      expect(labels(suggestFilters(input, input.length, SRC))).toEqual(expected);
    }
  });

  it("handles quoting, whitespace, and negations on value completion", () => {
    const textTag = "tag:mac";
    const ssTag = suggestFilters(textTag, textTag.length, SRC);
    expect(inserts(ssTag)).toEqual(['"machine learning"']);
    expect(apply(textTag, ssTag[0]!)).toBe('tag:"machine learning"');

    const textFolder = "folder:work";
    const ssFolder = suggestFilters(textFolder, textFolder.length, SRC);
    expect(inserts(ssFolder)).toEqual(["Work", '"Work stuff"']);
    expect(apply(textFolder, ssFolder[1]!)).toBe('folder:"Work stuff"');

    const ssPlain = suggestFilters("tag:ru", 6, SRC);
    expect(ssPlain[0]!.insertText).toBe("rust");
    expect(apply("tag:ru", ssPlain[0]!)).toBe("tag:rust");

    const dup = suggestFilters("-is:du", 6, SRC);
    expect(inserts(dup)).toEqual(["duplicate"]);
    expect(apply("-is:du", dup[0]!)).toBe("-is:duplicate");

    const ml = suggestFilters("-tag:mac", 8, SRC);
    expect(inserts(ml)).toEqual(['"machine learning"']);
    expect(apply("-tag:mac", ml[0]!)).toBe('-tag:"machine learning"');

    const openQ = suggestFilters('tag:"mac', 8, SRC);
    expect(inserts(openQ)).toEqual(['"machine learning"']);
    expect(apply('tag:"mac', openQ[0]!)).toBe('tag:"machine learning"');

    const closedQ = suggestFilters('tag:"machine b"', 11, SRC);
    expect(apply('tag:"machine b"', closedQ[0]!)).toBe('tag:"machine learning"');

    const onlyQ = suggestFilters('folder:"', 8, SRC);
    expect(inserts(onlyQ)).toEqual(["Work", '"Work stuff"', "Dev", "Dev/Rust", "personal"]);

    const midVal = suggestFilters("tag:rzx", 5, SRC);
    expect(apply("tag:rzx", midVal[0]!)).toBe("tag:rust");

    const midQuery = suggestFilters("tag:ru extra", 6, SRC);
    expect(apply("tag:ru extra", midQuery[0]!)).toBe("tag:rust extra");

    const dedupSrc: SuggestionSources = { tags: ["Rust", "rust", "RUST"], folders: [] };
    expect(inserts(suggestFilters("tag:ru", 6, dedupSrc))).toEqual(["Rust"]);

    expect(suggestFilters("tag:", 4, EMPTY)).toEqual([]);
    expect(suggestFilters("tag:ru", 6, EMPTY)).toEqual([]);
  });
});

describe("suggestFilters free-form and unknown keys", () => {
  it("offers nothing for date, domain, or unknown keys", () => {
    const noValues: Array<[string, number?]> = [
      ["domain:"],
      ["domain:exa"],
      ["-domain:exa"],
      ["before:"],
      ["before:202"],
      ["after:2024-0"],
      ["-after:1"],
      ["title:ab"],
      ["notes:x"],
      ["TAG:ru"],
      ["http://x"],
      ["mailto:a"],
      ["a:b"],
      [":foo"],
      ["tag:rust domain:g"],
    ];
    for (const [input, cursor] of noValues) {
      expect(suggestFilters(input, cursor ?? input.length, SRC)).toEqual([]);
    }
    expect(suggestFilters("before:2024", 9, SRC)).toEqual([]);
  });
});

describe("suggestFilters quoted free text", () => {
  it("offers no key suggestions inside open or closed quotes", () => {
    const insideQuotes: Array<[string, number]> = [
      ['"ta', 3],
      ['"tag:', 5],
      ['"hello wo', 8],
      ['-"ta', 4],
      ['foo "ta', 7],
      ['"a" "b', 6],
    ];
    for (const [input, cursor] of insideQuotes) {
      expect(suggestFilters(input, cursor, SRC)).toEqual([]);
    }
    expect(suggestFilters('"ab"', 2, SRC)).toEqual([]);
    expect(suggestFilters("a-b", 3, SRC)).toEqual([]);
    expect(suggestFilters("foo.bar", 4, SRC)).toEqual([]);
    expect(suggestFilters("日本語", 3, SRC)).toEqual([]);
  });
});

describe("suggestFilters spans splice correctly", () => {
  it("splices suggestions accurately into target text", () => {
    const splices: Array<[string, number, number, string]> = [
      ["f", 1, 0, "folder:"],
      ["-f", 2, 0, "-folder:"],
      ["tag", 0, 0, "tag:"],
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
    for (const [input, cursor, pick, expected] of splices) {
      const ss = suggestFilters(input, cursor, SRC);
      expect(ss.length).toBeGreaterThan(pick);
      expect(apply(input, ss[pick]!)).toBe(expected);
    }
  });
});

describe("suggestFilters edge cases and totality", () => {
  it("clamps out-of-range cursors", () => {
    expect(inserts(suggestFilters("tag:ru", 999, SRC))).toEqual(["rust"]);
    expect(inserts(suggestFilters("", -3, SRC))).toEqual(allKeys);
    expect(inserts(suggestFilters("tag", Number.NaN, SRC))).toEqual(allKeys);
  });

  it("never throws on arbitrary or nasty input", () => {
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
