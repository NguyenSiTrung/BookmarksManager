import { describe, expect, it } from "vitest";
import { buildLibrarySynopsis } from "../../src/restructure/synopsis";
import {
  RESTRUCTURE_LIMITS,
  RestructureProposal,
  LibrarySynopsis,
} from "../../src/schemas/restructure";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import type { BookmarkMeta } from "../../src/schemas/meta";

/**
 * `buildLibrarySynopsis` produces the only payload the proposal prompt can
 * carry: sorted folder paths, category/tag counts, top domains, and capped
 * representative titles — never URLs, notes, ids, or an unbounded dump.
 */

function folder(
  id: string,
  title: string,
  children: BookmarksTreeNode[] = [],
): BookmarksTreeNode {
  return { id, title, parentId: "p", children };
}
function bm(id: string, title: string, url: string): BookmarksTreeNode {
  return { id, title, url, parentId: "p" };
}
const NOW = "2026-09-28T00:00:00.000Z";
function meta(over: Partial<BookmarkMeta> = {}): BookmarkMeta {
  return { id: over.id ?? "x", tags: [], updatedAt: NOW, ...over };
}

const SIMPLE_TREE: BookmarksTreeNode[] = [
  folder("f1", "Dev", [
    bm("b1", "Zebra tool", "https://a-site.com/z"),
    bm("b2", "Alpha tool", "https://b-site.org/a"),
  ]),
  folder("f2", "News", [bm("b3", "Daily", "https://news-site.com/d")]),
  bm("b4", "Loose", "https://loose-site.io/"),
];

describe("buildLibrarySynopsis", () => {
  it("produces sorted folder paths and counts", () => {
    const syn = buildLibrarySynopsis(SIMPLE_TREE, []);
    expect(syn.folderPaths).toEqual(["Dev", "News"]);
    expect(syn.bookmarkCount).toBe(4);
    expect(syn.categories).toEqual({});
    expect(syn.tags).toEqual({});
    expect(syn.domains.map((d) => d.domain).sort()).toEqual([
      "a-site.com",
      "b-site.org",
      "loose-site.io",
      "news-site.com",
    ]);
  });

  it("counts categories and tags from metas", () => {
    const metas = new Map<string, BookmarkMeta>([
      ["b1", meta({ id: "b1", category: "article", tags: ["tools"] })],
      ["b2", meta({ id: "b2", category: "article", tags: ["tools", "dev"] })],
    ]);
    const syn = buildLibrarySynopsis(SIMPLE_TREE, metas);
    expect(syn.categories).toEqual({ article: 2 });
    expect(syn.tags).toEqual({ dev: 1, tools: 2 });
  });

  it("caps representative titles per folder and truncates them", () => {
    const tree: BookmarksTreeNode[] = [
      folder("f1", "Dev", [
        bm("b1", "First", "https://a-site.com/1"),
        bm("b2", "Second", "https://a-site.com/2"),
        bm("b3", "Third", "https://a-site.com/3"),
        bm("b4", "Fourth", "https://a-site.com/4"),
      ]),
    ];
    const syn = buildLibrarySynopsis(tree, []);
    expect(
      syn.representativeTitles["Dev"]?.length ?? 0,
    ).toBeLessThanOrEqual(RESTRUCTURE_LIMITS.representativeTitles);
  });

  it("never leaks URLs or notes into the synopsis", () => {
    const metas = new Map<string, BookmarkMeta>([
      ["b1", meta({ id: "b1", notes: "private note" })],
    ]);
    const syn = buildLibrarySynopsis(SIMPLE_TREE, metas);
    const serialized = JSON.stringify(syn);
    expect(serialized).not.toContain("a-site.com/z");
    expect(serialized).not.toContain("private note");
    expect(serialized).not.toContain("b1");
  });

  it("excludes sensitive and blocklisted sites", () => {
    const tree: BookmarksTreeNode[] = [
      folder("f1", "Dev", [
        bm("b1", "Bank", "https://mybank.example/login"),
        bm("b2", "Doc", "https://docs.example.com/x"),
      ]),
    ];
    const syn = buildLibrarySynopsis(tree, []);
    const serialized = JSON.stringify(syn);
    expect(serialized).not.toContain("mybank.example");
    expect(syn.bookmarkCount).toBe(1);
  });

  it("handles empty libraries", () => {
    const syn = buildLibrarySynopsis([], []);
    expect(syn).toMatchObject({
      folderPaths: [],
      categories: {},
      tags: {},
      domains: [],
      representativeTitles: {},
      bookmarkCount: 0,
    });
  });

  it("removes blocked-only paths before caps but keeps allowed ancestors and unrelated empty folders", () => {
    const tree = [
      folder("private", "A blocked", [
        folder("private-child", "Child", [
          bm("secret", "Private title", "https://blocked-site.dev/private"),
        ]),
        // Keeping this path would still disclose its blocked-only ancestor.
        folder("private-empty", "Empty"),
      ]),
      folder("mixed", "B mixed", [
        bm("secret2", "Private title 2", "https://blocked-site.dev/other"),
        folder("allowed", "Nested", [bm("public", "Allowed title", "https://allowed-site.dev/")]),
        folder("mixed-empty", "Empty"),
      ]),
      folder("empty", "C empty", [folder("nested-empty", "Nested empty")]),
    ];
    const metas = [
      meta({ id: "secret", tags: ["private-tag"], category: "tool" }),
      meta({ id: "secret2", tags: ["private-tag"], category: "tool" }),
      meta({ id: "public", tags: ["allowed-tag"], category: "article" }),
    ];
    expect(buildLibrarySynopsis(tree, metas, { userBlocklist: ["blocked-site.dev"] })).toEqual({
      folderPaths: ["B mixed", "B mixed/Empty", "B mixed/Nested", "C empty", "C empty/Nested empty"],
      categories: { article: 1 }, tags: { "allowed-tag": 1 },
      domains: [{ domain: "allowed-site.dev", count: 1 }],
      representativeTitles: { "B mixed/Nested": ["Allowed title"] }, bookmarkCount: 1,
    });
    expect(buildLibrarySynopsis(tree, metas, {
      userBlocklist: ["blocked-site.dev"], folderPaths: 1,
    }).folderPaths).toEqual(["B mixed"]);
  });

  it("omits paths supported only by builtin-sensitive or unparseable bookmarks", () => {
    const tree = [
      folder("bank", "Bank-only path", [bm("bankmark", "Bank title", "https://chase.com/")]),
      folder("invalid", "Invalid-only path", [bm("invalidmark", "Invalid title", "not a URL")]),
      folder("empty", "Empty"),
    ];
    expect(buildLibrarySynopsis(tree, []).folderPaths).toEqual(["Empty"]);
  });

  it("keeps unrelated empty roots and folders when every bookmark is blocked", () => {
    const tree: BookmarksTreeNode[] = [{
      id: "0", title: "", children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", children: [
          folder("private", "Blocked-only path", [
            bm("secret", "Private title", "https://blocked-site.dev/private"),
          ]),
          folder("empty", "Harmless empty"),
        ] },
        { id: "2", parentId: "0", title: "Other bookmarks", children: [] },
        { id: "3", parentId: "0", title: "Mobile bookmarks", children: [] },
      ],
    }];
    const synopsis = buildLibrarySynopsis(tree, [], { userBlocklist: ["blocked-site.dev"] });
    expect(synopsis.folderPaths).toEqual([
      "Bookmarks bar/Harmless empty", "Mobile bookmarks", "Other bookmarks",
    ]);
    expect(synopsis.bookmarkCount).toBe(0);
  });

  it("is deterministic — same tree in, same synopsis out", () => {
    const a = buildLibrarySynopsis(SIMPLE_TREE, []);
    const b = buildLibrarySynopsis(SIMPLE_TREE, []);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("respects the folder-path and domain caps", () => {
    const many: BookmarksTreeNode[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(
        folder(`f${String(i).padStart(2, "0")}`, `Folder${i}`, [
          bm(`b${i}`, `t${i}`, `https://d${i}.example.com/`),
        ]),
      );
    }
    const syn = buildLibrarySynopsis(many, [], {
      folderPaths: 5,
      domains: 3,
    });
    expect(syn.folderPaths.length).toBe(5);
    expect(syn.domains.length).toBe(3);
  });

  it("accepts a meta array as well as a map", () => {
    const metas: BookmarkMeta[] = [
      meta({ id: "b1", category: "article" }),
    ];
    const syn = buildLibrarySynopsis(SIMPLE_TREE, metas);
    expect(syn.categories).toEqual({ article: 1 });
  });
});

describe("RestructureProposal", () => {
  it("accepts a bounded proposal", () => {
    const parsed = RestructureProposal.safeParse({
      folders: [
        { path: "dev/tools", description: "Developer utilities." },
        { path: "news", description: "" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects duplicate folder paths", () => {
    const parsed = RestructureProposal.safeParse({
      folders: [
        { path: "dev", description: "" },
        { path: "dev", description: "" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects over-limit folders, depth, and description", () => {
    const tooMany = {
      folders: Array.from(
        { length: RESTRUCTURE_LIMITS.folders + 1 },
        (_, i) => ({ path: `f${i}`, description: "" }),
      ),
    };
    expect(RestructureProposal.safeParse(tooMany).success).toBe(false);
    const tooDeep = {
      folders: [
        {
          path: "a/b/c/d/e",
          description: "",
        },
      ],
    };
    expect(RestructureProposal.safeParse(tooDeep).success).toBe(false);
    const tooLongDesc = {
      folders: [{ path: "a", description: "x".repeat(RESTRUCTURE_LIMITS.description + 1) }],
    };
    expect(RestructureProposal.safeParse(tooLongDesc).success).toBe(false);
  });

  it("rejects empty proposals and empty paths", () => {
    expect(RestructureProposal.safeParse({ folders: [] }).success).toBe(false);
    expect(
      RestructureProposal.safeParse({ folders: [{ path: "", description: "" }] })
        .success,
    ).toBe(false);
  });
});

describe("LibrarySynopsis", () => {
  it("round-trips the built synopsis through the wire schema", () => {
    const syn = buildLibrarySynopsis(SIMPLE_TREE, []);
    const parsed = LibrarySynopsis.safeParse(syn);
    expect(parsed.success).toBe(true);
  });
});
