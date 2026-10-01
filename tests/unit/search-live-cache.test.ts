import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";

/**
 * `src/search/live-cache.ts` coverage: the pure, Chrome/React-free cache the
 * live search hook delegates to. The cache owns the MiniSearch index, keeps
 * one {@link SearchDocument} per bookmark, and reuses a document whenever
 * every input it depends on is unchanged — its own fields, its meta row, its
 * ancestor folder chain, and the resolved tag display names. Duplicate
 * grouping is amortized to corpus shape: it reruns only when the set of
 * `{id, url}` pairs changes, never on a metadata or tree-order edit.
 *
 * The document builder and the duplicate collector are the module boundary
 * the cache wraps; spying on them (via the repo's importOriginal mock
 * pattern) proves which work the cache actually performed.
 */

vi.mock("../../src/search/index", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/search/index")>();
  return { ...actual, toSearchDocument: vi.fn(actual.toSearchDocument) };
});
vi.mock("../../src/search/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/search/run")>();
  return { ...actual, collectDuplicateIds: vi.fn(actual.collectDuplicateIds) };
});

import { toSearchDocument } from "../../src/search/index";
import { collectDuplicateIds, runQuery } from "../../src/search/run";
import type { SearchIndexHandle } from "../../src/search/run";
import { createLiveSearchCache } from "../../src/search/live-cache";

const buildDocument = vi.mocked(toSearchDocument);
const collectDupes = vi.mocked(collectDuplicateIds);

beforeEach(() => {
  buildDocument.mockClear();
  collectDupes.mockClear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMeta(
  id: string,
  fields: Partial<Pick<BookmarkMeta, "tags" | "category" | "notes">> = {},
): BookmarkMeta {
  return {
    id,
    tags: fields.tags ?? [],
    ...(fields.category === undefined ? {} : { category: fields.category }),
    ...(fields.notes === undefined ? {} : { notes: fields.notes }),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTag(name: string): TagDef {
  return {
    name,
    nameKey: name.trim().toLowerCase(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A bookmark node whose URL is derived from its id unless overridden. */
function bookmark(
  id: string,
  overrides: Partial<BookmarksTreeNode> = {},
): BookmarksTreeNode {
  return {
    id,
    title: `Bookmark ${id}`,
    url: `https://www.${id}.example/`,
    ...overrides,
  };
}

/**
 * One-level tree: root "0" → "1" Bookmarks bar → children. `flattenTree`
 * reads `parentId` verbatim, so fixtures get it assigned explicitly here.
 */
function makeTree(children: BookmarksTreeNode[]): FlattenedTree {
  const withParents = (
    nodes: BookmarksTreeNode[],
    parentId: string,
  ): BookmarksTreeNode[] =>
    nodes.map((node) => ({
      ...node,
      parentId,
      ...(node.children === undefined
        ? {}
        : { children: withParents(node.children, node.id) }),
    }));
  return flattenTree([
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          title: "Bookmarks bar",
          parentId: "0",
          children: withParents(children, "1"),
        },
      ],
    },
  ]);
}

/** Sorted hit ids for `query` against a live handle. */
function ids(query: string, handle: SearchIndexHandle): string[] {
  return runQuery(handle.index, query, handle.ctx)
    .hits.map((hit) => String(hit.id))
    .sort();
}

describe("createLiveSearchCache", () => {
  it("builds every document once and groups duplicates once on the first update", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const handle = createLiveSearchCache().update(tree, [], []);

    expect(handle.index.documentCount).toBe(2);
    expect(buildDocument).toHaveBeenCalledTimes(2);
    expect(collectDupes).toHaveBeenCalledTimes(1);
    expect(handle.ctx.treeOrder).toEqual(["a", "b"]);
  });

  it("rebuilds only the edited document and never reruns duplicate grouping", () => {
    const tree = makeTree([bookmark("a"), bookmark("b"), bookmark("c")]);
    const cache = createLiveSearchCache();
    const first = cache.update(tree, [], []);
    const index = first.index;
    buildDocument.mockClear();
    collectDupes.mockClear();

    const second = cache.update(
      tree,
      [makeMeta("b", { notes: "fresh needle" })],
      [],
    );

    expect(second.index).toBe(index);
    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(buildDocument.mock.calls[0]?.[0]?.id).toBe("b");
    expect(collectDupes).not.toHaveBeenCalled();
    expect(ids("needle", second)).toEqual(["b"]);
  });

  it("rebuilds a document when its tags, category, or notes change", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const cache = createLiveSearchCache();
    const defs = [makeTag("TypeScript")];
    cache.update(tree, [makeMeta("a")], defs);

    buildDocument.mockClear();
    collectDupes.mockClear();
    const tagged = cache.update(
      tree,
      [makeMeta("a", { tags: ["typescript"] })],
      defs,
    );
    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(ids('tag:"typescript"', tagged)).toEqual(["a"]);

    buildDocument.mockClear();
    const categorized = cache.update(
      tree,
      [makeMeta("a", { tags: ["typescript"], category: "docs" })],
      defs,
    );
    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(ids("category:docs", categorized)).toEqual(["a"]);

    buildDocument.mockClear();
    const noted = cache.update(
      tree,
      [
        makeMeta("a", {
          tags: ["typescript"],
          category: "docs",
          notes: "extra note",
        }),
      ],
      defs,
    );
    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(ids("extra", noted)).toEqual(["a"]);
    expect(collectDupes).not.toHaveBeenCalled();
  });

  it("rebuilds descendant documents when an ancestor folder is renamed", () => {
    const tree = makeTree([
      {
        id: "fld",
        title: "Deep",
        children: [bookmark("leaf"), bookmark("leaf2")],
      },
      bookmark("other"),
    ]);
    const cache = createLiveSearchCache();
    cache.update(tree, [], []);
    buildDocument.mockClear();
    collectDupes.mockClear();

    const renamed = makeTree([
      {
        id: "fld",
        title: "Wide",
        children: [bookmark("leaf"), bookmark("leaf2")],
      },
      bookmark("other"),
    ]);
    const handle = cache.update(renamed, [], []);

    // Exactly the two descendants' ancestor paths changed.
    expect(buildDocument).toHaveBeenCalledTimes(2);
    expect(collectDupes).not.toHaveBeenCalled();
    expect(ids("folder:wide", handle)).toEqual(["leaf", "leaf2"]);
    expect(ids("folder:deep", handle)).toEqual([]);
  });

  it("rebuilds descendants when a folder is moved under a new parent", () => {
    const tree = makeTree([
      {
        id: "fld",
        title: "Deep",
        children: [bookmark("leaf")],
      },
      {
        id: "dest",
        title: "Destination",
        children: [],
      },
    ]);
    const cache = createLiveSearchCache();
    cache.update(tree, [], []);
    buildDocument.mockClear();
    collectDupes.mockClear();

    const moved = makeTree([
      {
        id: "dest",
        title: "Destination",
        children: [
          {
            id: "fld",
            title: "Deep",
            children: [bookmark("leaf")],
          },
        ],
      },
    ]);
    const handle = cache.update(moved, [], []);

    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(ids("folder:destination/deep", handle)).toEqual(["leaf"]);
    expect(collectDupes).not.toHaveBeenCalled();
  });

  it("adds and discards only the changed documents", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const cache = createLiveSearchCache();
    cache.update(tree, [], []);
    buildDocument.mockClear();
    collectDupes.mockClear();

    const after = makeTree([bookmark("a"), bookmark("c")]);
    const handle = cache.update(after, [], []);

    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(buildDocument.mock.calls[0]?.[0]?.id).toBe("c");
    expect(handle.index.has("b")).toBe(false);
    expect(handle.index.has("c")).toBe(true);
    expect(handle.index.documentCount).toBe(2);
    // The corpus shape changed (b → c), so duplicates rerun.
    expect(collectDupes).toHaveBeenCalledTimes(1);
  });

  it("reruns duplicate grouping only when the id/url corpus changes", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const cache = createLiveSearchCache();
    cache.update(tree, [], []);
    buildDocument.mockClear();
    collectDupes.mockClear();

    // A metadata-only edit must not touch the corpus.
    cache.update(tree, [makeMeta("a", { notes: "quiet" })], []);
    expect(collectDupes).not.toHaveBeenCalled();

    // Changing one URL to match the other creates a duplicate pair.
    const dup = makeTree([
      bookmark("a", { url: "https://dup.example/" }),
      bookmark("b", { url: "https://dup.example/" }),
    ]);
    const handle = cache.update(
      dup,
      [makeMeta("a", { notes: "quiet" })],
      [],
    );

    expect(collectDupes).toHaveBeenCalledTimes(1);
    expect(ids("is:duplicate", handle)).toEqual(["a", "b"]);
  });

  it("keeps documents and duplicate ids when only tree order changes", () => {
    const tree = makeTree([
      bookmark("a", { index: 0 }),
      bookmark("b", { index: 1 }),
    ]);
    const cache = createLiveSearchCache();
    const first = cache.update(tree, [], []);
    const index = first.index;
    buildDocument.mockClear();
    collectDupes.mockClear();

    const reordered = makeTree([
      bookmark("a", { index: 1 }),
      bookmark("b", { index: 0 }),
    ]);
    const handle = cache.update(reordered, [], []);

    expect(handle.index).toBe(index);
    expect(buildDocument).not.toHaveBeenCalled();
    expect(collectDupes).not.toHaveBeenCalled();
    expect(handle.ctx.treeOrder).toEqual(["b", "a"]);
  });

  it("rebuilds documents whose resolved display name changes when only tagDefs change", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const cache = createLiveSearchCache();
    // `a` carries the tag; the meta nameKey is held constant throughout — only
    // the tag DEFINITION's display name changes (a label rename), so the def
    // nameKey must stay "reading list" while the display name flips.
    const metas = [makeMeta("a", { tags: ["reading list"] })];
    /** A def whose nameKey is pinned to the meta's key, renaming only display. */
    const label = (name: string): TagDef => ({
      ...makeTag(name),
      nameKey: "reading list",
    });
    cache.update(tree, metas, [label("Reading List")]);
    expect(ids("reading", cache.update(tree, metas, [label("Reading List")])))
      .toEqual(["a"]);
    buildDocument.mockClear();
    collectDupes.mockClear();

    const handle = cache.update(tree, metas, [label("Deep Reads")]);

    // Only the dependent document rebuilds; duplicate grouping is unaffected.
    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(buildDocument.mock.calls[0]?.[0]?.id).toBe("a");
    expect(collectDupes).not.toHaveBeenCalled();
    // The new display name is searchable; the stale one is gone.
    expect(ids("deep", handle)).toEqual(["a"]);
    expect(ids("reads", handle)).toEqual(["a"]);
    expect(ids("reading", handle)).toEqual([]);
    expect(ids('tag:"reading list"', handle)).toEqual(["a"]);
  });

  it("rebuilds documents that depend on a renamed tag label", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const cache = createLiveSearchCache();
    cache.update(
      tree,
      [makeMeta("a", { tags: ["typescript"] })],
      [makeTag("TypeScript")],
    );
    buildDocument.mockClear();
    collectDupes.mockClear();

    // A rename propagates through meta rows (see renameTag): the tag key and
    // the def change together.
    const handle = cache.update(
      tree,
      [makeMeta("a", { tags: ["ts"] })],
      [makeTag("TS")],
    );

    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(collectDupes).not.toHaveBeenCalled();
    expect(ids('tag:"ts"', handle)).toEqual(["a"]);
    expect(ids('tag:"typescript"', handle)).toEqual([]);
    expect(ids("typescript", handle)).toEqual([]);
  });

  it("releases cached state on clear so the next update rebuilds from scratch", () => {
    const tree = makeTree([bookmark("a"), bookmark("b")]);
    const cache = createLiveSearchCache();
    const first = cache.update(tree, [], []);

    cache.clear();
    buildDocument.mockClear();
    collectDupes.mockClear();

    const second = cache.update(tree, [], []);
    expect(second.index).not.toBe(first.index);
    expect(buildDocument).toHaveBeenCalledTimes(2);
    expect(collectDupes).toHaveBeenCalledTimes(1);
  });

  it("stays selective across a large corpus", () => {
    const nodes: BookmarksTreeNode[] = [];
    const metas: BookmarkMeta[] = [];
    for (let i = 0; i < 2_000; i++) {
      nodes.push(bookmark(`bm${i}`, { index: i }));
      if (i % 4 === 0) metas.push(makeMeta(`bm${i}`, { tags: ["typescript"] }));
    }
    const tree = makeTree(nodes);
    const defs = [makeTag("TypeScript")];
    const cache = createLiveSearchCache();

    cache.update(tree, metas, defs);
    expect(buildDocument).toHaveBeenCalledTimes(2_000);

    buildDocument.mockClear();
    collectDupes.mockClear();
    const head = metas[0]!;
    const edited = [
      makeMeta(head.id, { tags: ["typescript"], notes: "needle" }),
      ...metas.slice(1),
    ];
    const handle = cache.update(tree, edited, defs);

    expect(buildDocument).toHaveBeenCalledTimes(1);
    expect(buildDocument.mock.calls[0]?.[0]?.id).toBe(head.id);
    expect(collectDupes).not.toHaveBeenCalled();
    expect(ids("needle", handle)).toEqual([head.id]);
  });
});
