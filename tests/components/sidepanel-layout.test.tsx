import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useMemo } from "react";
import { db } from "../../src/db/database";
import { createTag, putMeta } from "../../src/db/meta";
import type { BookmarkMeta } from "../../src/schemas/meta";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { BookmarkItem, FlattenedTree } from "../../src/sync/tree";
import { App } from "../../src/entrypoints/sidepanel/App";
import {
  BookmarkList,
  GRID_COLUMNS,
  GRID_ROW_HEIGHT,
  LIST_ROW_HEIGHT,
  useBookmarkSelection,
} from "../../src/entrypoints/sidepanel/BookmarkList";
import { FolderTree } from "../../src/entrypoints/sidepanel/FolderTree";
import {
  RECENT_VIEW_LIMIT,
  resolveView,
  viewTitle,
} from "../../src/entrypoints/sidepanel/views";

/**
 * Phase 4 Task 2 — side-panel layout.
 *
 * Layers under test:
 *  - `views.ts`        pure view resolution (all / folder / tag / category /
 *                      untagged / duplicates / recent), `viewTitle`.
 *  - `FolderTree`      ARIA tree: fixed roots only, roving tabindex, arrow /
 *                      Home / End navigation, expand/collapse, selection.
 *  - `BookmarkList`    list/grid toggle, row virtualization (10k items must
 *                      produce a bounded rendered count), multi-select model
 *                      (click / ctrl-click / shift-click / ctrl-A), activation.
 *  - `App`             thin wiring: live tree + live meta, view routing,
 *                      selection context.
 *
 * `chrome` is stubbed per-test; `chrome.runtime.getURL` only feeds Favicon,
 * `chrome.bookmarks` is the in-memory fake, and IndexedDB is fake-indexeddb.
 */

const ISO = "2026-09-26T10:00:00.000Z";

/** The hand-built tree both the pure tests and the App test rely on. */
const TREE_NODES: BookmarksTreeNode[] = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        parentId: "0",
        index: 0,
        title: "Bookmarks bar",
        children: [
          {
            id: "10",
            parentId: "1",
            index: 0,
            title: "Dev",
            children: [
              {
                id: "b1",
                parentId: "10",
                index: 0,
                title: "Alpha",
                url: "https://A.example/page?utm_source=x",
                dateAdded: 100,
              },
              {
                id: "f10",
                parentId: "10",
                index: 1,
                title: "Nested",
                children: [
                  {
                    id: "b2",
                    parentId: "f10",
                    index: 0,
                    title: "Beta",
                    url: "https://a.example/page",
                    dateAdded: 300,
                  },
                ],
              },
            ],
          },
          {
            id: "b3",
            parentId: "1",
            index: 1,
            title: "Gamma",
            url: "https://x.example/",
            dateAdded: 200,
          },
        ],
      },
      {
        id: "2",
        parentId: "0",
        index: 1,
        title: "Other bookmarks",
        children: [
          {
            id: "b4",
            parentId: "2",
            index: 0,
            title: "Delta",
            url: "https://x.example/",
            dateAdded: 400,
          },
        ],
      },
      {
        id: "3",
        parentId: "0",
        index: 2,
        title: "Mobile bookmarks",
        children: [],
      },
    ],
  },
];

const tree: FlattenedTree = flattenTree(TREE_NODES);

/** b1 tagged "dev"; b2 only a category (still untagged); b4 tagged "ops". */
const metas: BookmarkMeta[] = [
  { id: "b1", tags: ["dev"], updatedAt: ISO },
  { id: "b2", tags: [], category: "docs", updatedAt: ISO },
  { id: "b4", tags: ["ops"], category: "article", updatedAt: ISO },
];

function ids(items: readonly BookmarkItem[]): string[] {
  return items.map((item) => item.id);
}

function makeItems(count: number): BookmarkItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `bm-${i}`,
    title: `Item ${i}`,
    url: `https://e${i}.example/`,
    path: [],
    isRoot: false,
    isManaged: false,
    depth: 1,
    kind: "bookmark" as const,
    dateAdded: i,
  }));
}

/** Option lookup by visible name (title + url text both count). */
function option(name: string | RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

function treeitem(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreElementRects();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

/** Favicon needs only chrome.runtime.getURL; stubs the whole surface. */
function stubFaviconRuntime(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
  });
}

/**
 * jsdom reports 0 for every element's offsetHeight/offsetWidth, which makes
 * @tanstack/react-virtual see an empty viewport and render nothing. Give the
 * scroll container (data-testid="bookmark-scroll") a fixed 600x400 rect so
 * virtualization tests observe a realistic bounded window. Everything else
 * keeps 0. Restored in the shared afterEach.
 */
const SCROLL_TESTID = "bookmark-scroll";
let savedRectDescriptors: [string, PropertyDescriptor | undefined][] = [];

function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  savedRectDescriptors = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      prop,
    );
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID
          ? value
          : 0;
      },
    });
    return [prop, prior];
  });
}

function restoreElementRects(): void {
  for (const [prop, prior] of savedRectDescriptors) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  savedRectDescriptors = [];
}

// ---------------------------------------------------------------------------
// views.ts — pure view resolution
// ---------------------------------------------------------------------------

describe("resolveView", () => {
  it("all returns every bookmark in tree order", () => {
    expect(ids(resolveView({ kind: "all" }, tree, metas))).toEqual([
      "b1",
      "b2",
      "b3",
      "b4",
    ]);
  });

  it("folder returns SUBTREE bookmarks of the folder", () => {
    expect(
      ids(resolveView({ kind: "folder", folderId: "1" }, tree, metas)),
    ).toEqual(["b1", "b2", "b3"]);
    expect(
      ids(resolveView({ kind: "folder", folderId: "10" }, tree, metas)),
    ).toEqual(["b1", "b2"]);
    expect(
      ids(resolveView({ kind: "folder", folderId: "3" }, tree, metas)),
    ).toEqual([]);
    expect(
      ids(resolveView({ kind: "folder", folderId: "missing" }, tree, metas)),
    ).toEqual([]);
  });

  it("tag joins through meta rows on nameKey", () => {
    expect(
      ids(resolveView({ kind: "tag", nameKey: "dev" }, tree, metas)),
    ).toEqual(["b1"]);
    expect(
      ids(resolveView({ kind: "tag", nameKey: "nope" }, tree, metas)),
    ).toEqual([]);
  });

  it("category joins through meta rows", () => {
    expect(
      ids(
        resolveView({ kind: "category", category: "docs" }, tree, metas),
      ),
    ).toEqual(["b2"]);
    expect(
      ids(
        resolveView({ kind: "category", category: "video" }, tree, metas),
      ),
    ).toEqual([]);
  });

  it("untagged is bookmarks with no meta row or an empty tag list", () => {
    expect(ids(resolveView({ kind: "untagged" }, tree, metas))).toEqual([
      "b2",
      "b3",
    ]);
  });

  it("duplicates contains ids from exact and normalized groups", () => {
    // b3/b4 share a raw URL (exact); b1/b2 share a normalized key
    // (tracking param + host case). Exact groups are emitted first.
    expect(ids(resolveView({ kind: "duplicates" }, tree, metas))).toEqual([
      "b3",
      "b4",
      "b1",
      "b2",
    ]);
  });

  it("recent sorts by dateAdded descending and caps the list", () => {
    expect(ids(resolveView({ kind: "recent" }, tree, metas))).toEqual([
      "b4",
      "b2",
      "b3",
      "b1",
    ]);

    const bigTree = flattenTree([
      {
        id: "0",
        title: "",
        children: [
          {
            id: "1",
            parentId: "0",
            index: 0,
            title: "Bar",
            children: makeItems(RECENT_VIEW_LIMIT + 100).map((item, i) => ({
              ...item,
              parentId: "1",
              index: i,
            })),
          },
        ],
      },
    ]);
    const recent = resolveView({ kind: "recent" }, bigTree, []);
    expect(recent.length).toBe(RECENT_VIEW_LIMIT);
    expect(recent[0]?.id).toBe(`bm-${RECENT_VIEW_LIMIT + 99}`);
  });
});

describe("viewTitle", () => {
  it("names every view kind", () => {
    expect(viewTitle({ kind: "all" }, tree)).toBe("All bookmarks");
    expect(viewTitle({ kind: "folder", folderId: "10" }, tree)).toBe("Dev");
    expect(viewTitle({ kind: "untagged" }, tree)).toBe("Untagged");
    expect(viewTitle({ kind: "duplicates" }, tree)).toBe("Duplicates");
    expect(viewTitle({ kind: "recent" }, tree)).toBe("Recently saved");
    expect(viewTitle({ kind: "category", category: "docs" }, tree)).toBe(
      "Docs",
    );
    expect(
      viewTitle({ kind: "tag", nameKey: "dev" }, tree, [
        {
          name: "Dev",
          nameKey: "dev",
          createdAt: ISO,
          updatedAt: ISO,
        },
      ]),
    ).toBe("#Dev");
    expect(viewTitle({ kind: "tag", nameKey: "dev" }, tree)).toBe("#dev");
    expect(viewTitle({ kind: "folder", folderId: "missing" }, tree)).toBe(
      "Folder",
    );
  });
});

// ---------------------------------------------------------------------------
// FolderTree — ARIA tree
// ---------------------------------------------------------------------------

describe("FolderTree", () => {
  it("renders the fixed roots and never the synthetic root", () => {
    render(<FolderTree tree={tree} />);
    const items = screen.getAllByRole("treeitem");
    expect(items.map((el) => el.dataset.nodeId)).toEqual([
      "1",
      "10",
      "2",
      "3",
    ]);
    expect(treeitem("Bookmarks bar")).toBeTruthy();
    expect(treeitem("Dev")).toBeTruthy();
    expect(treeitem("Other bookmarks")).toBeTruthy();
    expect(treeitem("Mobile bookmarks")).toBeTruthy();
  });

  it("sets aria-expanded only on folders with folder children", () => {
    render(<FolderTree tree={tree} />);
    // Fixed roots default to expanded; non-root folders to collapsed.
    expect(treeitem("Bookmarks bar").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("false");
    // Leaf folders (no folder children) carry no aria-expanded.
    expect(treeitem("Other bookmarks").getAttribute("aria-expanded")).toBeNull();
    expect(treeitem("Mobile bookmarks").getAttribute("aria-expanded")).toBeNull();
  });

  it("annotates level/setsize/posinset", () => {
    render(<FolderTree tree={tree} />);
    expect(treeitem("Bookmarks bar").getAttribute("aria-level")).toBe("1");
    expect(treeitem("Dev").getAttribute("aria-level")).toBe("2");
    expect(treeitem("Dev").getAttribute("aria-posinset")).toBe("1");
    expect(treeitem("Dev").getAttribute("aria-setsize")).toBe("1");
    expect(treeitem("Mobile bookmarks").getAttribute("aria-posinset")).toBe(
      "3",
    );
  });

  it("roving tabindex: arrows, Home and End move DOM focus", () => {
    render(<FolderTree tree={tree} />);
    const bar = treeitem("Bookmarks bar");
    expect(bar.tabIndex).toBe(0);
    expect(treeitem("Dev").tabIndex).toBe(-1);

    bar.focus();
    fireEvent.keyDown(bar, { key: "ArrowDown" });
    expect(document.activeElement).toBe(treeitem("Dev"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(treeitem("Other bookmarks"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(treeitem("Mobile bookmarks"));

    // At the end — stays put.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(treeitem("Mobile bookmarks"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(treeitem("Other bookmarks"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(treeitem("Mobile bookmarks"));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(treeitem("Bookmarks bar"));
  });

  it("expands/collapses with ArrowRight/ArrowLeft", () => {
    render(<FolderTree tree={tree} />);
    const dev = treeitem("Dev");
    dev.focus();

    // Right on a closed node expands it without moving focus.
    fireEvent.keyDown(dev, { key: "ArrowRight" });
    expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("true");
    const nested = treeitem("Nested");
    expect(nested.getAttribute("aria-level")).toBe("3");
    expect(document.activeElement).toBe(treeitem("Dev"));

    // Right on an open node moves to the first child.
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(nested);

    // Right on an end node does nothing.
    fireEvent.keyDown(nested, { key: "ArrowRight" });
    expect(document.activeElement).toBe(nested);

    // Left on a child end node moves to its parent.
    fireEvent.keyDown(nested, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(treeitem("Dev"));

    // Left on an open node closes it.
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowLeft" });
    expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "Nested" })).toBeNull();

    // Left on a closed child moves to its parent.
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(treeitem("Bookmarks bar"));
  });

  it("selects via Enter, Space, and click", () => {
    const onSelectFolder = vi.fn();
    render(<FolderTree tree={tree} onSelectFolder={onSelectFolder} />);

    fireEvent.keyDown(treeitem("Dev"), { key: "Enter" });
    expect(onSelectFolder).toHaveBeenLastCalledWith("10");

    fireEvent.keyDown(treeitem("Dev"), { key: " " });
    expect(onSelectFolder).toHaveBeenLastCalledWith("10");

    fireEvent.click(treeitem("Mobile bookmarks"));
    expect(onSelectFolder).toHaveBeenLastCalledWith("3");
    expect(document.activeElement).toBe(treeitem("Mobile bookmarks"));
    expect(onSelectFolder).toHaveBeenCalledTimes(3);
  });

  it("reflects selectedFolderId in aria-selected", () => {
    render(<FolderTree tree={tree} selectedFolderId="10" />);
    expect(treeitem("Dev").getAttribute("aria-selected")).toBe("true");
    expect(treeitem("Bookmarks bar").getAttribute("aria-selected")).toBe(
      "false",
    );
  });
});

// ---------------------------------------------------------------------------
// BookmarkList — layout toggle, virtualization, selection
// ---------------------------------------------------------------------------

function ListHarness({ items }: { items: BookmarkItem[] }) {
  const orderedIds = useMemo(() => items.map((item) => item.id), [items]);
  const selection = useBookmarkSelection(orderedIds);
  return (
    <>
      <output data-testid="selection">
        {[...selection.selectedIds].join(",")}
      </output>
      <BookmarkList items={items} selection={selection} />
    </>
  );
}

function selected(): string {
  return screen.getByTestId("selection").textContent ?? "";
}

describe("BookmarkList", () => {
  beforeEach(() => {
    stubFaviconRuntime();
    stubElementRects();
  });

  it("renders rows as listbox options and toggles to grid", () => {
    const items = makeItems(4);
    render(<ListHarness items={items} />);

    const listbox = screen.getByRole("listbox");
    expect(listbox.dataset.layout).toBe("list");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    expect(option(/Item 0/)).toBeTruthy();

    const listButton = screen.getByRole("button", { name: "List view" });
    const gridButton = screen.getByRole("button", { name: "Grid view" });
    expect(listButton.getAttribute("aria-pressed")).toBe("true");
    expect(gridButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(gridButton);
    expect(gridButton.getAttribute("aria-pressed")).toBe("true");
    expect(listButton.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("listbox").dataset.layout).toBe("grid");
    expect(option(/Item 0/)).toBeTruthy();
  });

  it("virtualizes: 10k items produce a bounded rendered count", () => {
    const items = makeItems(10_000);
    render(<ListHarness items={items} />);

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThan(100);

    // The sizer reserves the full virtual height even though only a window
    // of rows is mounted.
    const listbox = screen.getByRole("listbox");
    expect(listbox.style.height).toBe(`${10_000 * LIST_ROW_HEIGHT}px`);
  });

  it("virtualizes in grid layout too", () => {
    const items = makeItems(10_000);
    render(<ListHarness items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThan(100);
    const listbox = screen.getByRole("listbox");
    expect(listbox.style.height).toBe(
      `${Math.ceil(10_000 / GRID_COLUMNS) * GRID_ROW_HEIGHT}px`,
    );
  });

  it("click selects, ctrl-click toggles, shift-click ranges, ctrl-A selects all", () => {
    const items = makeItems(6);
    render(<ListHarness items={items} />);

    fireEvent.click(option(/Item 0/));
    expect(selected()).toBe("bm-0");
    expect(option(/Item 0/).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(option(/Item 2/), { ctrlKey: true });
    expect(selected()).toBe("bm-0,bm-2");

    // Toggling off still moves the anchor to the clicked item.
    fireEvent.click(option(/Item 2/), { metaKey: true });
    expect(selected()).toBe("bm-0");

    // Shift-click extends a range from the anchor (bm-2) downwards…
    fireEvent.click(option(/Item 4/), { shiftKey: true });
    expect(selected()).toBe("bm-2,bm-3,bm-4");

    // …and upwards, from the same anchor.
    fireEvent.click(option(/Item 0/), { shiftKey: true });
    expect(selected()).toBe("bm-0,bm-1,bm-2");

    fireEvent.keyDown(screen.getByRole("listbox"), {
      key: "a",
      ctrlKey: true,
    });
    expect(selected()).toBe("bm-0,bm-1,bm-2,bm-3,bm-4,bm-5");

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(selected()).toBe("");
  });

  it("shift+ctrl-click adds the range to the current selection", () => {
    const items = makeItems(6);
    render(<ListHarness items={items} />);

    fireEvent.click(option(/Item 0/));
    fireEvent.click(option(/Item 4/), { ctrlKey: true });
    fireEvent.click(option(/Item 2/), { shiftKey: true, ctrlKey: true });
    // Anchor is bm-4: range 2..4 unioned with existing {0,4}.
    expect(selected()).toBe("bm-0,bm-4,bm-2,bm-3");
  });

  it("arrow keys move focus through rows; Enter activates", () => {
    const onActivateItem = vi.fn();
    const items = makeItems(5);
    render(
      <BookmarkList items={items} onActivateItem={onActivateItem} />,
    );

    const listbox = screen.getByRole("listbox");
    listbox.focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(document.activeElement).toBe(option(/Item 0/));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(option(/Item 1/));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(onActivateItem).toHaveBeenCalledWith(items[1]);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(option(/Item 0/));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(listbox);
  });

  it("renders tag and category chips from meta rows", () => {
    const items = makeItems(2);
    const metaById = new Map<string, BookmarkMeta>([
      ["bm-0", { id: "bm-0", tags: ["dev"], category: "docs", updatedAt: ISO }],
    ]);
    render(
      <BookmarkList
        items={items}
        metaById={metaById}
        tagNameByKey={new Map([["dev", "Dev"]])}
      />,
    );
    const first = option(/Item 0/);
    expect(first.textContent).toContain("Dev");
    expect(first.textContent).toContain("docs");
  });
});

// ---------------------------------------------------------------------------
// App — wiring on the live tree + live meta tables
// ---------------------------------------------------------------------------

describe("App", () => {
  let fake: FakeBookmarksApi;

  beforeAll(async () => {
    await db.open();
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(async () => {
    await db.bookmarkMeta.clear();
    await db.tags.clear();
    // Increasing clock: Recent view order is deterministic.
    let tick = 0;
    fake = createFakeBookmarks({
      now: () => (tick += 100),
      bookmarksBar: [
        {
          id: "10",
          title: "Dev",
          children: [
            {
              id: "b1",
              title: "Alpha",
              url: "https://A.example/page?utm_source=x",
            },
            {
              id: "f10",
              title: "Nested",
              children: [
                {
                  id: "b2",
                  title: "Beta",
                  url: "https://a.example/page",
                },
              ],
            },
          ],
        },
        { id: "b3", title: "Gamma", url: "https://x.example/" },
      ],
      otherBookmarks: [
        { id: "b4", title: "Delta", url: "https://x.example/" },
      ],
    });
    vi.stubGlobal("chrome", {
      bookmarks: fake,
      runtime: {
        getURL: (path: string) =>
          `chrome-extension://test-extension-id/${path}`,
      },
    });
    stubElementRects();
  });

  function optionTexts(): string[] {
    return screen
      .getAllByRole("option")
      .map((el) => el.textContent ?? "");
  }

  it("renders the two-pane shell with views, tree, and list", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getAllByRole("treeitem").length).toBe(4),
    );

    expect(
      screen.getByRole("heading", { name: "Bookmarks Manager" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Review suggestions" }),
    ).toBeTruthy();

    // Default "all" view lists every bookmark.
    await waitFor(() => expect(optionTexts().length).toBe(4));

    // Folder view: clicking the tree shows the folder's subtree.
    fireEvent.click(treeitem("Dev"));
    await waitFor(() => {
      const texts = optionTexts().join("|");
      expect(texts).toContain("Alpha");
      expect(texts).toContain("Beta");
      expect(texts).not.toContain("Gamma");
    });
    expect(treeitem("Dev").getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Dev" }),
    ).toBeTruthy();
  });

  it("switches views and joins meta rows live", async () => {
    await putMeta("b1", { tags: ["dev"] });
    await putMeta("b2", { category: "docs" });
    await putMeta("b4", { tags: ["ops"], category: "article" });
    await createTag("Dev");

    render(<App />);
    await waitFor(() => expect(optionTexts().length).toBe(4));

    // Untagged = no row or empty tags: b2 (category only) + b3 (no row).
    fireEvent.click(screen.getByRole("button", { name: "Untagged" }));
    await waitFor(() => {
      const texts = optionTexts().join("|");
      expect(texts).toContain("Beta");
      expect(texts).toContain("Gamma");
      expect(texts).not.toContain("Alpha");
      expect(texts).not.toContain("Delta");
    });

    // Tag view via the tag nav.
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    await waitFor(() => {
      const texts = optionTexts().join("|");
      expect(texts).toContain("Alpha");
      expect(texts).not.toContain("Beta");
    });

    // Category view.
    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    await waitFor(() => {
      const texts = optionTexts().join("|");
      expect(texts).toContain("Beta");
      expect(texts).not.toContain("Alpha");
    });

    // Duplicates: exact pair (x.example) then normalized pair (a.example).
    fireEvent.click(screen.getByRole("button", { name: "Duplicates" }));
    await waitFor(() => expect(optionTexts().length).toBe(4));

    // Recently saved: dateAdded desc → Delta, Gamma, Beta, Alpha.
    fireEvent.click(
      screen.getByRole("button", { name: "Recently saved" }),
    );
    await waitFor(() => {
      const texts = optionTexts().join("|");
      expect(texts.indexOf("Delta")).toBeLessThan(texts.indexOf("Gamma"));
      expect(texts.indexOf("Gamma")).toBeLessThan(texts.indexOf("Beta"));
      expect(texts.indexOf("Beta")).toBeLessThan(texts.indexOf("Alpha"));
    });
  });

  it("multi-selects options inside the app shell", async () => {
    render(<App />);
    await waitFor(() => expect(optionTexts().length).toBe(4));

    fireEvent.click(option(/Alpha/));
    expect(option(/Alpha/).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(screen.getByRole("listbox"), {
      key: "a",
      metaKey: true,
    });
    for (const el of screen.getAllByRole("option")) {
      expect(el.getAttribute("aria-selected")).toBe("true");
    }
  });
});
