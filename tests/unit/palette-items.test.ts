import { describe, expect, it } from "vitest";
import { Category } from "../../src/schemas/bookmark";
import type { TagDef } from "../../src/schemas/meta";
import {
  buildPaletteSections,
  flattenPaletteSections,
} from "../../src/entrypoints/sidepanel/palette";
import { createSearchIndex, toSearchDocument } from "../../src/search/index";
import { collectDuplicateIds } from "../../src/search/run";
import type { SearchIndexHandle } from "../../src/search/run";
import type { BookmarkItem, FlattenedTree, FolderNode } from "../../src/sync/tree";

/**
 * `palette.ts` — pure palette item generation for the command palette
 * (Phase 2 Task 4). Sections: Bookmarks (runQuery hits), Views, Folders,
 * Tags, Categories. Commands land in Task 5.
 */

function folder(
  id: string,
  title: string,
  childIds: string[],
  path: string[] = [],
  isRoot = false,
): FolderNode {
  return {
    id,
    kind: "folder",
    parentId: "",
    index: 0,
    title,
    path,
    childIds,
    dateAdded: 0,
    depth: 0,
    isRoot,
    isManaged: false,
  };
}

function bookmark(
  id: string,
  title: string,
  url: string,
  path: string[] = [],
): BookmarkItem {
  return {
    id,
    kind: "bookmark",
    parentId: "1",
    index: 0,
    title,
    url,
    path,
    dateAdded: 0,
    depth: 0,
    isRoot: false,
    isManaged: false,
  };
}

function makeTree(): FlattenedTree {
  const folders = new Map<string, FolderNode>([
    ["0", folder("0", "", ["1", "2"], [], true)],
    ["1", folder("1", "Bookmarks bar", ["10"], ["Bookmarks bar"], true)],
    ["2", folder("2", "Other bookmarks", ["11"], ["Other bookmarks"], true)],
    ["10", folder("10", "Dev", ["b1"], ["Bookmarks bar", "Dev"])],
    ["11", folder("11", "Reading", ["b2"], ["Other bookmarks", "Reading"])],
  ]);
  const bookmarks = new Map<string, BookmarkItem>([
    ["b1", bookmark("b1", "Alpha", "https://a.example/", ["Bookmarks bar", "Dev"])],
    ["b2", bookmark("b2", "Beta", "https://b.example/", ["Other bookmarks", "Reading"])],
    ["b3", bookmark("b3", "Gamma", "https://g.example/", ["Bookmarks bar"])],
  ]);
  bookmarks.get("b3")!.parentId = "1";
  return { folders, bookmarks };
}

const TAGS: readonly TagDef[] = [
  {
    nameKey: "typescript" as TagDef["nameKey"],
    name: "TypeScript",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    nameKey: "rust" as TagDef["nameKey"],
    name: "Rust",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

/** Folder ids aligned with `BookmarkItem.path` titles (topmost first). */
const ANCESTOR_IDS: Record<string, string[]> = {
  b1: ["1", "10"],
  b2: ["2", "11"],
  b3: ["1"],
};

function makeSearch(tree: FlattenedTree): SearchIndexHandle {
  const index = createSearchIndex();
  const docs = [...tree.bookmarks.values()].map((item) =>
    toSearchDocument(
      {
        id: item.id,
        title: item.title,
        url: item.url,
        dateAdded: item.dateAdded,
        ancestors: item.path.map((title, i) => ({
          id: ANCESTOR_IDS[item.id]?.[i] ?? `anc-${i}`,
          title,
        })),
        tagKeys: [],
      },
      new Map(),
    ),
  );
  index.addAll(docs);
  return {
    index,
    ctx: {
      treeOrder: [...tree.bookmarks.keys()],
      duplicateIds: collectDuplicateIds([...tree.bookmarks.values()]),
    },
  };
}

describe("buildPaletteSections", () => {
  const tree = makeTree();
  const search = makeSearch(tree);

  it("with an empty query lists jump sections and no bookmark section", () => {
    const sections = buildPaletteSections({
      query: "",
      search,
      tree,
      tagDefs: TAGS,
    });
    const labels = sections.map((s) => s.label);
    expect(labels).toEqual(["Views", "Folders", "Tags", "Categories"]);

    const views = sections[0]!.items.map((i) => i.label);
    expect(views).toEqual([
      "All bookmarks",
      "Recently saved",
      "Untagged",
      "Duplicates",
    ]);
    // All folders with titles — fixed roots are real jump targets; only the
    // synthetic root "0" (empty title) is excluded.
    const folderItems = sections[1]!.items.map((i) => i.label);
    expect(folderItems).toEqual([
      "Bookmarks bar",
      "Other bookmarks",
      "Dev",
      "Reading",
    ]);
    // Tag display names, not nameKeys.
    expect(sections[2]!.items.map((i) => i.label)).toEqual([
      "TypeScript",
      "Rust",
    ]);
    expect(sections[3]!.items.map((i) => i.label)).toEqual(
      Category.options.map((c) => c.charAt(0).toUpperCase() + c.slice(1)),
    );
  });

  it("puts matching bookmarks first for a text query", () => {
    const sections = buildPaletteSections({
      query: "beta",
      search,
      tree,
      tagDefs: TAGS,
    });
    expect(sections[0]?.label).toBe("Bookmarks");
    const hits = sections[0]!.items;
    expect(hits.every((i) => i.kind === "bookmark")).toBe(true);
    expect(hits.map((i) => i.label)).toEqual(["Beta"]);
    // Nothing else contains "beta" — every jump section drops out.
    expect(sections.map((s) => s.label)).toEqual(["Bookmarks"]);
  });

  it("narrows jump targets by query substring", () => {
    const sections = buildPaletteSections({
      query: "dev",
      search,
      tree,
      tagDefs: TAGS,
    });
    // "dev" free-text hits no indexed field (folder titles are stored, not
    // searched) — but the Dev folder jump target matches the substring.
    expect(sections.map((s) => s.label)).toEqual(["Folders"]);
    expect(sections[0]!.items.map((i) => i.label)).toEqual(["Dev"]);
  });

  it("jump items carry the view they activate", () => {
    const sections = buildPaletteSections({
      query: "",
      search,
      tree,
      tagDefs: TAGS,
    });
    const flat = flattenPaletteSections(sections);
    const dev = flat.find((i) => i.label === "Dev");
    expect(dev?.kind).toBe("jump");
    expect(dev && dev.kind === "jump" ? dev.view : null).toEqual({
      kind: "folder",
      folderId: "10",
    });
    const tag = flat.find((i) => i.label === "TypeScript");
    expect(tag && tag.kind === "jump" ? tag.view : null).toEqual({
      kind: "tag",
      nameKey: "typescript",
    });
  });

  it("a null index still yields jump targets (bookmarks degrade out)", () => {
    const sections = buildPaletteSections({
      query: "dev",
      search: null,
      tree,
      tagDefs: TAGS,
    });
    // No index → no Bookmarks section, but jump targets still narrow.
    expect(sections.map((s) => s.label)).toEqual(["Folders"]);
    expect(sections[0]!.items.map((i) => i.label)).toEqual(["Dev"]);
  });

  it("never throws on garbage input", () => {
    expect(() =>
      buildPaletteSections({
        query: "\u0000{{{ -::",
        search,
        tree,
        tagDefs: TAGS,
      }),
    ).not.toThrow();
  });
});
