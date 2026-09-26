import { describe, expect, it } from "vitest";
import {
  applyDocDiff,
  buildIndex,
  buildTagNameMap,
  createSearchIndex,
  extractDomain,
  toSearchDocument,
} from "../../src/search/index";
import type { SearchDocument } from "../../src/search/index";
import { searchSource, searchTagDefs } from "../fixtures/search";

/**
 * Coverage for `src/search/index.ts`: the MiniSearch document mapping, the
 * configured index (AND combine, prefix + fuzzy, field boosts), and the
 * diff-based incremental update. All inputs are plain `SearchSourceBookmark`
 * data — the module never touches `chrome`.
 */

const tagNames = buildTagNameMap(searchTagDefs);

describe("extractDomain", () => {
  it("strips a leading www. from the hostname", () => {
    expect(extractDomain("https://www.example.com/some/path?q=1")).toBe(
      "example.com",
    );
  });

  it("keeps subdomains and hosts that merely start with www", () => {
    expect(extractDomain("https://gist.github.com/x")).toBe(
      "gist.github.com",
    );
    expect(extractDomain("https://www2.example.com/")).toBe(
      "www2.example.com",
    );
  });

  it("lowercases the host before stripping www.", () => {
    expect(extractDomain("https://WWW.Example.COM/")).toBe("example.com");
  });

  it("returns an empty domain for opaque schemes and unparseable URLs", () => {
    expect(extractDomain("javascript:alert(1)")).toBe("");
    expect(extractDomain("data:text/plain,hello")).toBe("");
    expect(extractDomain("mailto:someone@example.com")).toBe("");
    expect(extractDomain("not a url")).toBe("");
  });
});

describe("buildTagNameMap", () => {
  it("maps tag nameKeys to display names", () => {
    const map = buildTagNameMap(searchTagDefs);
    expect(map.size).toBe(2);
    expect(map.get("reading list")).toBe("Reading List");
    expect(map.get("typescript")).toBe("TypeScript");
  });
});

describe("toSearchDocument", () => {
  it("maps a fully-resolved source into indexed and stored fields", () => {
    const doc = toSearchDocument(
      searchSource({
        id: "bm-1",
        title: "Async Rust patterns",
        url: "https://www.rust-lang.org/learn",
        dateAdded: 1_700_000_000_000,
        ancestors: [
          { id: "1", title: "Bookmarks bar" },
          { id: "f9", title: "Dev" },
          { id: "f10", title: "Rust" },
        ],
        tagKeys: ["reading list", "typescript"],
        category: "docs",
        notes: "Pinned reference.",
      }),
      tagNames,
    );

    expect(doc).toEqual({
      id: "bm-1",
      title: "Async Rust patterns",
      url: "https://www.rust-lang.org/learn",
      domain: "rust-lang.org",
      tags: "Reading List TypeScript",
      notes: "Pinned reference.",
      folderIds: ["1", "f9", "f10"],
      folderTitles: ["Bookmarks bar", "Dev", "Rust"],
      tagKeys: ["reading list", "typescript"],
      dateAdded: 1_700_000_000_000,
      category: "docs",
    });
  });

  it("collects ancestor ids and titles positionally, topmost first", () => {
    const doc = toSearchDocument(
      searchSource({
        id: "bm-deep",
        ancestors: [
          { id: "root-f", title: "Top" },
          { id: "mid-f", title: "Middle" },
        ],
      }),
      tagNames,
    );
    expect(doc.folderIds).toEqual(["root-f", "mid-f"]);
    expect(doc.folderTitles).toEqual(["Top", "Middle"]);
  });

  it("falls back to the nameKey when a tag def is missing", () => {
    const doc = toSearchDocument(
      searchSource({ id: "bm-2", tagKeys: ["orphan key"] }),
      tagNames,
    );
    expect(doc.tags).toBe("orphan key");
    expect(doc.tagKeys).toEqual(["orphan key"]);
  });

  it("emits empty searchable strings and omits absent stored fields", () => {
    const doc = toSearchDocument(searchSource({ id: "bm-3" }), tagNames);
    expect(doc.tags).toBe("");
    expect(doc.notes).toBe("");
    expect(doc.folderIds).toEqual([]);
    expect(doc.folderTitles).toEqual([]);
    expect(doc.tagKeys).toEqual([]);
    expect(doc.category).toBeUndefined();
    expect(doc.dateAdded).toBeUndefined();
    expect("category" in doc).toBe(false);
    expect("dateAdded" in doc).toBe(false);
  });

  it("still maps javascript:/data: URLs — open-disabled is handled elsewhere", () => {
    const jsDoc = toSearchDocument(
      searchSource({
        id: "bm-js",
        title: "Bookmarklet",
        url: "javascript:alert(1)",
      }),
      tagNames,
    );
    expect(jsDoc.url).toBe("javascript:alert(1)");
    expect(jsDoc.domain).toBe("");

    const dataDoc = toSearchDocument(
      searchSource({
        id: "bm-data",
        title: "Inline",
        url: "data:image/png;base64,AAAA",
      }),
      tagNames,
    );
    expect(dataDoc.url).toBe("data:image/png;base64,AAAA");
    expect(dataDoc.domain).toBe("");
  });
});

describe("buildIndex + search", () => {
  it("indexes one document per bookmark, including javascript:/data: URLs", () => {
    const index = buildIndex(
      [
        searchSource({
          id: "js",
          title: "Bookmarklet tool",
          url: "javascript:alert(1)",
        }),
        searchSource({
          id: "data",
          title: "Inline image",
          url: "data:image/png;base64,AAAA",
        }),
      ],
      tagNames,
    );
    expect(index.documentCount).toBe(2);
    expect(index.search("bookmarklet").map((r) => r.id)).toEqual(["js"]);
    expect(index.search("inline").map((r) => r.id)).toEqual(["data"]);
  });

  it("ANDs free-text terms: only documents matching every term are returned", () => {
    const index = buildIndex(
      [
        searchSource({
          id: "both",
          title: "Rust async handbook",
          url: "https://a.example/",
        }),
        searchSource({
          id: "rust-only",
          title: "Rust intro",
          url: "https://b.example/",
        }),
        searchSource({
          id: "async-only",
          title: "Async guide",
          url: "https://c.example/",
        }),
      ],
      tagNames,
    );
    expect(index.search("rust async").map((r) => r.id)).toEqual(["both"]);
  });

  it("matches term prefixes", () => {
    const index = buildIndex(
      [
        searchSource({
          id: "ray",
          title: "Raycast launcher",
          url: "https://rl.example/",
        }),
        searchSource({
          id: "other",
          title: "Something else",
          url: "https://o.example/",
        }),
      ],
      tagNames,
    );
    // Field-scoped so the hit can only come from prefix matching on "raycast".
    expect(index.search("ray", { fields: ["title"] }).map((r) => r.id)).toEqual(
      ["ray"],
    );
  });

  it("tolerates typos within the configured fuzzy distance", () => {
    const index = buildIndex(
      [
        searchSource({
          id: "ray",
          title: "Raycast launcher",
          url: "https://rl.example/",
        }),
        searchSource({
          id: "other",
          title: "Something else",
          url: "https://o.example/",
        }),
      ],
      tagNames,
    );
    // "raykast" is one substitution away from "raycast".
    expect(
      index.search("raykast", { fields: ["title"] }).map((r) => r.id),
    ).toEqual(["ray"]);
  });

  it("boosts title over tags over domain over url over notes", () => {
    const names = buildTagNameMap([
      { name: "Quasar Stuff", nameKey: "quasar stuff" },
    ]);
    const index = buildIndex(
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
        // The term lives in this doc's domain (and therefore its URL too);
        // it must still rank below a tags-only hit.
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
      names,
    );
    expect(index.search("quasar").map((r) => r.id)).toEqual([
      "title",
      "tags",
      "domain",
      "url",
      "notes",
    ]);
  });

  it("exposes the stored filter/display fields on every search result", () => {
    const index = buildIndex(
      [
        searchSource({
          id: "stored",
          title: "Deep doc",
          url: "https://d.example/x",
          dateAdded: 1_700_000_000_000,
          ancestors: [
            { id: "1", title: "Bookmarks bar" },
            { id: "f7", title: "Dev" },
          ],
          tagKeys: ["typescript"],
          category: "docs",
        }),
      ],
      tagNames,
    );
    const hit = index.search("deep")[0];
    expect(hit?.id).toBe("stored");
    expect(hit?.title).toBe("Deep doc");
    expect(hit?.url).toBe("https://d.example/x");
    expect(hit?.domain).toBe("d.example");
    expect(hit?.folderIds).toEqual(["1", "f7"]);
    expect(hit?.folderTitles).toEqual(["Bookmarks bar", "Dev"]);
    expect(hit?.tagKeys).toEqual(["typescript"]);
    expect(hit?.dateAdded).toBe(1_700_000_000_000);
    expect(hit?.category).toBe("docs");
  });
});

describe("applyDocDiff", () => {
  const docA = (): SearchDocument =>
    toSearchDocument(
      searchSource({
        id: "a",
        title: "Alpha shared note",
        url: "https://a.example/",
      }),
      tagNames,
    );
  const docB = (): SearchDocument =>
    toSearchDocument(
      searchSource({
        id: "b",
        title: "Beta shared note",
        url: "https://b.example/",
      }),
      tagNames,
    );
  const docC = (): SearchDocument =>
    toSearchDocument(
      searchSource({
        id: "c",
        title: "Gamma shared note",
        url: "https://c.example/",
        notes: "placeholder",
      }),
      tagNames,
    );
  const docCv2 = (): SearchDocument =>
    toSearchDocument(
      searchSource({
        id: "c",
        title: "Gamma shared revised note",
        url: "https://c2.example/",
        notes: "updated",
      }),
      tagNames,
    );
  const docD = (): SearchDocument =>
    toSearchDocument(
      searchSource({
        id: "d",
        title: "Delta shared note",
        url: "https://d.example/",
      }),
      tagNames,
    );

  it("add, discard, and replace produce the same result sets as a full rebuild", () => {
    const live = buildIndex(
      [
        searchSource({
          id: "a",
          title: "Alpha shared note",
          url: "https://a.example/",
        }),
        searchSource({
          id: "b",
          title: "Beta shared note",
          url: "https://b.example/",
        }),
        searchSource({
          id: "c",
          title: "Gamma shared note",
          url: "https://c.example/",
          notes: "placeholder",
        }),
      ],
      tagNames,
    );

    applyDocDiff(live, {
      add: [docD()],
      discard: ["b"],
      replace: [docCv2()],
    });

    const fresh = buildIndex(
      [
        searchSource({
          id: "a",
          title: "Alpha shared note",
          url: "https://a.example/",
        }),
        searchSource({
          id: "c",
          title: "Gamma shared revised note",
          url: "https://c2.example/",
          notes: "updated",
        }),
        searchSource({
          id: "d",
          title: "Delta shared note",
          url: "https://d.example/",
        }),
      ],
      tagNames,
    );

    expect(live.documentCount).toBe(fresh.documentCount);
    const queries = [
      "shared",
      "alpha",
      "gamma",
      "revised",
      "delta",
      "beta",
      "placeholder",
      "updated",
      "shared revised",
    ];
    for (const q of queries) {
      const liveIds = live
        .search(q)
        .map((r) => r.id)
        .sort();
      const freshIds = fresh
        .search(q)
        .map((r) => r.id)
        .sort();
      expect(liveIds, `query "${q}"`).toEqual(freshIds);
    }
  });

  it("drops discarded documents and swaps replaced ones atomically", () => {
    const index = createSearchIndex();
    index.addAll([docA(), docB(), docC()]);

    applyDocDiff(index, { discard: ["b"], replace: [docCv2()] });

    expect(index.has("b")).toBe(false);
    expect(index.search("beta")).toEqual([]);
    expect(index.search("placeholder")).toEqual([]);
    expect(index.search("revised").map((r) => r.id)).toEqual(["c"]);
    expect(index.documentCount).toBe(2);
  });

  it("is tolerant: unknown discards skip, add/replace upsert by id", () => {
    const index = createSearchIndex();
    index.addAll([docA()]);

    // Discarding an id that was never indexed is a no-op, not a throw.
    applyDocDiff(index, { discard: ["missing"] });
    expect(index.documentCount).toBe(1);

    // Adding a doc whose id already exists replaces it.
    applyDocDiff(index, {
      add: [
        toSearchDocument(
          searchSource({
            id: "a",
            title: "Alpha renamed",
            url: "https://a.example/",
          }),
          tagNames,
        ),
      ],
    });
    expect(index.documentCount).toBe(1);
    expect(index.search("renamed").map((r) => r.id)).toEqual(["a"]);
    expect(index.search("note")).toEqual([]);

    // Replacing an id that is not indexed adds it.
    applyDocDiff(index, { replace: [docB()] });
    expect(index.has("b")).toBe(true);
    expect(index.documentCount).toBe(2);
  });
});
