import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import type { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import { runQuery } from "../../src/search/run";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";
import { useSearchIndex } from "../../src/ui/hooks/useSearchIndex";
import type { SearchIndexHandle } from "../../src/ui/hooks/useSearchIndex";

/**
 * `useSearchIndex` coverage: the hook builds a MiniSearch index from the
 * (tree, metas, tagDefs) triple, applies diff-based incremental updates as
 * any of the three inputs change — the SAME index instance is kept, so hits
 * stay warm and no full rebuild runs per edit — and releases its cache on
 * unmount. The hook takes plain data (no chrome surface), so tests drive it
 * with hand-built flattened trees.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

let latest: SearchIndexHandle | null | undefined;
let renders: number;

interface ProbeProps {
  tree: FlattenedTree;
  metas: readonly BookmarkMeta[];
  tagDefs: readonly TagDef[];
}

function Probe({ tree, metas, tagDefs }: ProbeProps) {
  const handle = useSearchIndex(tree, metas, tagDefs);
  latest = handle;
  renders += 1;
  return (
    <output data-testid="probe">{handle === null ? "pending" : "ready"}</output>
  );
}

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

/**
 * One-level tree: root "0" → "1" Bookmarks bar → children. `flattenTree`
 * reads `parentId` off the input nodes verbatim (it never assigns it — real
 * `getTree()` nodes carry it), so fixtures must set it explicitly.
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

async function renderProbe(props: ProbeProps) {
  const view = render(<Probe {...props} />);
  await waitFor(() => expect(latest).not.toBeNull());
  return view;
}

function hitsFor(query: string): string[] {
  const handle = latest;
  expect(handle).not.toBeNull();
  return runQuery(handle!.index, query, handle!.ctx).hits.map(
    (hit) => hit.id,
  );
}

describe("useSearchIndex", () => {
  it("returns null while building, then an index over tree + metas + tagDefs", async () => {
    const tree = makeTree([
      {
        id: "b1",
        title: "Async Rust guide",
        url: "https://rust.example/async",
        dateAdded: Date.parse("2025-06-01T00:00:00"),
      },
      {
        id: "b2",
        title: "Cooking notes",
        url: "https://cook.example/",
        dateAdded: Date.parse("2025-06-02T00:00:00"),
      },
    ]);
    const metas = [
      makeMeta("b1", { tags: ["typescript"], notes: "event loop" }),
    ];
    const tagDefs = [makeTag("TypeScript")];
    renders = 0;

    await renderProbe({ tree, metas, tagDefs });

    // Free text over title.
    expect(hitsFor("async")).toEqual(["b1"]);
    // Indexed notes field.
    expect(hitsFor("loop")).toEqual(["b1"]);
    // Tag display name resolves through tagDefs.
    expect(hitsFor('tag:"typescript"')).toEqual(["b1"]);
    // treeOrder gives filter-only queries the library order.
    expect(hitsFor("is:untagged")).toEqual(["b2"]);
    expect(latest?.ctx.treeOrder).toEqual(["b1", "b2"]);
  });

  it("updates results on tree changes without a full rebuild", async () => {
    const tree = makeTree([
      { id: "b1", title: "alpha", url: "https://a.example/" },
      { id: "b2", title: "beta", url: "https://b.example/" },
    ]);
    renders = 0;
    const view = await renderProbe({ tree, metas: [], tagDefs: [] });
    const indexBefore = latest!.index;

    const treeAfter = makeTree([
      { id: "b1", title: "alpha renamed", url: "https://a.example/" },
      { id: "b3", title: "gamma", url: "https://g.example/" },
    ]);
    await act(async () => {
      view.rerender(
        <Probe tree={treeAfter} metas={[]} tagDefs={[]} />,
      );
    });
    await waitFor(() => expect(hitsFor("gamma")).toEqual(["b3"]));

    // Same index object — the diff path updated it in place.
    expect(latest!.index).toBe(indexBefore);
    expect(hitsFor("renamed")).toEqual(["b1"]);
    expect(hitsFor("beta")).toEqual([]); // b2 was discarded
    expect(hitsFor("alpha")).toEqual(["b1"]);
  });

  it("updates results on meta changes without a full rebuild", async () => {
    const tree = makeTree([
      { id: "b1", title: "plain", url: "https://p.example/" },
    ]);
    renders = 0;
    const view = await renderProbe({
      tree,
      metas: [],
      tagDefs: [makeTag("TypeScript")],
    });
    const indexBefore = latest!.index;
    expect(hitsFor("tag:typescript")).toEqual([]);

    await act(async () => {
      view.rerender(
        <Probe
          tree={tree}
          metas={[makeMeta("b1", { tags: ["typescript"] })]}
          tagDefs={[makeTag("TypeScript")]}
        />,
      );
    });

    await waitFor(() => expect(hitsFor("tag:typescript")).toEqual(["b1"]));
    expect(latest!.index).toBe(indexBefore);
  });

  it("re-indexes tag display names when tagDefs change", async () => {
    const tree = makeTree([
      { id: "b1", title: "plain", url: "https://p.example/", parentId: "1" },
    ]);
    renders = 0;
    const view = await renderProbe({
      tree,
      metas: [makeMeta("b1", { tags: ["typescript"] })],
      tagDefs: [makeTag("TypeScript")],
    });
    const indexBefore = latest!.index;
    // The display name is indexed, not just the key.
    expect(hitsFor("typescript")).toEqual(["b1"]);

    // A rename propagates through meta rows (see renameTag): the meta tag
    // key and the def change together — doc.tags flips to the new display
    // name and the old key stops matching both `tag:` and free text.
    await act(async () => {
      view.rerender(
        <Probe
          tree={tree}
          metas={[makeMeta("b1", { tags: ["ts"] })]}
          tagDefs={[makeTag("TS")] }
        />,
      );
    });

    await waitFor(() => expect(hitsFor("tag:ts")).toEqual(["b1"]));
    expect(hitsFor("tag:typescript")).toEqual([]);
    expect(hitsFor("typescript")).toEqual([]);
    expect(latest!.index).toBe(indexBefore);
  });

  it("drops discarded bookmarks and keeps ancestor folders searchable", async () => {
    const tree = makeTree([
      {
        id: "fld",
        title: "Deep",
        children: [
          { id: "b1", title: "leaf", url: "https://leaf.example/" },
        ],
      },
      { id: "b2", title: "other", url: "https://o.example/" },
    ]);
    renders = 0;
    const view = await renderProbe({ tree, metas: [], tagDefs: [] });
    expect(hitsFor("folder:deep")).toEqual(["b1"]);

    const treeAfter = makeTree([
      { id: "b2", title: "other", url: "https://o.example/" },
    ]);
    await act(async () => {
      view.rerender(<Probe tree={treeAfter} metas={[]} tagDefs={[]} />);
    });

    await waitFor(() => expect(hitsFor("folder:deep")).toEqual([]));
    expect(hitsFor("leaf")).toEqual([]);
    expect(hitsFor("other")).toEqual(["b2"]);
  });

  it("releases its cache on unmount and never updates after it", async () => {
    const tree = makeTree([
      { id: "b1", title: "alpha", url: "https://a.example/" },
    ]);
    renders = 0;
    const view = await renderProbe({ tree, metas: [], tagDefs: [] });
    expect(latest).not.toBeNull();

    view.unmount();

    // Post-unmount input churn must be a no-op, not a setState-on-unmounted.
    const rendersAtUnmount = renders;
    await act(async () => {});
    expect(renders).toBe(rendersAtUnmount);
  });
});
