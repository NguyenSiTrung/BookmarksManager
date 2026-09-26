import "fake-indexeddb/auto";
import {
  act,
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
import { db } from "../../src/db/database";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { BookmarkItem, FlattenedTree } from "../../src/sync/tree";
import { App } from "../../src/entrypoints/sidepanel/App";
import { BookmarkList } from "../../src/entrypoints/sidepanel/BookmarkList";
import { resolveDrop } from "../../src/entrypoints/sidepanel/dnd";
import type {
  DragPayload,
  DropTargetData,
} from "../../src/entrypoints/sidepanel/dnd";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Task 4 — drag and drop.
 *
 * Two layers:
 *  - `resolveDrop` (pure): the drop-target resolver — where a drop lands and,
 *    crucially, which drops are REJECTED (synthetic root "0", managed nodes,
 *    a folder's own subtree, a leaf bookmark used as a folder target).
 *  - `App` + the dnd-kit `KeyboardSensor` end-to-end: Space lifts, ArrowDown
 *    walks the drop targets, Space drops. Assertions run against the
 *    in-memory bookmarks fake (order/parents) and the Dexie `undo` table.
 *
 * jsdom has no layout, so `Element.prototype.getBoundingClientRect` is
 * stubbed to lay every `[data-dnd-drop]` element out in DOM order (40px
 * rows). That makes the keyboard coordinate getter's "next target below"
 * deterministic. `scrollIntoView` is stubbed because jsdom lacks it.
 */

// ---------------------------------------------------------------------------
// Pure resolveDrop fixtures
// ---------------------------------------------------------------------------

const PURE_NODES: BookmarksTreeNode[] = [
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
              { id: "b1", parentId: "10", index: 0, title: "Alpha", url: "https://a/" },
              {
                id: "f10",
                parentId: "10",
                index: 1,
                title: "Nested",
                children: [
                  {
                    id: "f12",
                    parentId: "f10",
                    index: 0,
                    title: "Deep",
                    children: [
                      { id: "b2", parentId: "f12", index: 0, title: "Beta", url: "https://b/" },
                    ],
                  },
                ],
              },
              { id: "f11", parentId: "10", index: 2, title: "Tools", children: [] },
            ],
          },
          {
            id: "m1",
            parentId: "1",
            index: 1,
            title: "Managed",
            unmodifiable: "managed",
            children: [],
          },
        ],
      },
      {
        id: "2",
        parentId: "0",
        index: 1,
        title: "Other bookmarks",
        children: [
          { id: "b4", parentId: "2", index: 0, title: "Delta", url: "https://d/" },
          { id: "b5", parentId: "2", index: 1, title: "Epsilon", url: "https://e/" },
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

const pureTree: FlattenedTree = flattenTree(PURE_NODES);

function payload(
  ids: readonly string[],
  kind: "bookmark" | "folder",
): DragPayload {
  return { ids, primaryId: ids[0] ?? "", kind, label: "x" };
}

const intoFolder = (folderId: string, parentId?: string, index?: number): DropTargetData => ({
  kind: "folder",
  folderId,
  ...(parentId === undefined ? {} : { parentId }),
  ...(index === undefined ? {} : { index }),
});

const intoSlot = (parentId?: string, index?: number): DropTargetData => ({
  kind: "slot",
  ...(parentId === undefined ? {} : { parentId }),
  ...(index === undefined ? {} : { index }),
});

describe("resolveDrop", () => {
  it("moves a bookmark INTO a folder", () => {
    expect(
      resolveDrop(pureTree, payload(["b1"], "bookmark"), intoFolder("f11", "10", 2)),
    ).toEqual({ ok: true, parentId: "f11", mode: "into" });
  });

  it("reorders a bookmark to a slot's index", () => {
    expect(
      resolveDrop(pureTree, payload(["b5"], "bookmark"), intoSlot("2", 0)),
    ).toEqual({ ok: true, parentId: "2", index: 0, mode: "reorder" });
  });

  it("reorders a folder among its siblings", () => {
    expect(
      resolveDrop(pureTree, payload(["f11"], "folder"), intoFolder("f10", "10", 1)),
    ).toEqual({ ok: true, parentId: "10", index: 1, mode: "reorder" });
  });

  it("moves a folder INTO a non-sibling folder", () => {
    expect(
      resolveDrop(pureTree, payload(["f11"], "folder"), intoFolder("f12", "f10", 0)),
    ).toEqual({ ok: true, parentId: "f12", mode: "into" });
  });

  it("rejects the synthetic root \"0\" as a target", () => {
    const result = resolveDrop(
      pureTree,
      payload(["b1"], "bookmark"),
      intoFolder("0"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/root/i);
  });

  it("rejects a fixed root \"1\"–\"3\" row as a target", () => {
    for (const rootId of ["1", "2", "3"]) {
      const result = resolveDrop(
        pureTree,
        payload(["b1"], "bookmark"),
        intoFolder(rootId),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/built-in/i);
    }
  });

  it("rejects a fixed root as a folder-into target too", () => {
    const result = resolveDrop(
      pureTree,
      payload(["f11"], "folder"),
      intoFolder("1"),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a managed folder as a target", () => {
    const result = resolveDrop(
      pureTree,
      payload(["b1"], "bookmark"),
      intoFolder("m1", "1", 1),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/managed/i);
  });

  it("rejects dropping a folder onto itself", () => {
    const result = resolveDrop(
      pureTree,
      payload(["f10"], "folder"),
      intoFolder("f10", "10", 1),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects dropping a folder into its own descendant", () => {
    const result = resolveDrop(
      pureTree,
      payload(["f10"], "folder"),
      intoFolder("f12", "f10", 0),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subtree/i);
  });

  it("rejects a leaf bookmark used as a folder target", () => {
    const result = resolveDrop(
      pureTree,
      payload(["b1"], "bookmark"),
      intoFolder("b1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/bookmark/i);
  });

  it("rejects a slot with no parent", () => {
    expect(
      resolveDrop(pureTree, payload(["b1"], "bookmark"), intoSlot(undefined, 0)).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: keyboard-sensor drags over the App shell
// ---------------------------------------------------------------------------

let fake: FakeBookmarksApi;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreElementRects();
  restoreDndRects();
});

beforeEach(async () => {
  await db.open();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  let tick = 0;
  fake = createFakeBookmarks({
    now: () => (tick += 100),
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [
          { id: "b1", title: "Alpha", url: "https://a.example/1" },
          {
            id: "f10",
            title: "Nested",
            children: [
              {
                id: "f12",
                title: "Deep",
                children: [{ id: "b2", title: "Beta", url: "https://b.example/" }],
              },
            ],
          },
          { id: "f11", title: "Tools", children: [] },
        ],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
      {
        id: "m1",
        title: "Managed",
        unmodifiable: "managed",
        children: [{ id: "mb1", title: "Hosted", url: "https://m.example/" }],
      },
    ],
    otherBookmarks: [
      { id: "b4", title: "Delta", url: "https://d.example/" },
      { id: "b5", title: "Epsilon", url: "https://e.example/" },
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
  stubDndRects();
});

/** Virtualizer needs a non-zero scroll rect; jsdom reports 0 for everything. */
const SCROLL_TESTID = "bookmark-scroll";
let savedRectDescriptors: [string, PropertyDescriptor | undefined][] = [];

function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  savedRectDescriptors = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID ? value : 0;
      },
    });
    return [prop, prior];
  });
}

function restoreElementRects(): void {
  for (const [prop, prior] of savedRectDescriptors) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  savedRectDescriptors = [];
}

/** DOM-order id list of every registered drop target. */
function dropOrder(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-dnd-drop]")].map(
    (el) => el.getAttribute("data-dnd-drop") ?? "",
  );
}

let savedGetBoundingClientRect:
  | typeof Element.prototype.getBoundingClientRect
  | undefined;
let savedScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;

/**
 * Lay every `[data-dnd-drop]` element out as a 40px row in DOM order so the
 * keyboard coordinate getter walks targets deterministically. Everything
 * else keeps jsdom's zero rect; `scrollIntoView` is a no-op.
 */
function stubDndRects(): void {
  savedGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (
    this: Element,
  ): DOMRect {
    const dropId = this.getAttribute?.("data-dnd-drop");
    if (dropId !== null && dropId !== undefined) {
      const index = dropOrder().indexOf(dropId);
      const y = index < 0 ? 0 : index * 40;
      return {
        x: 0,
        y,
        width: 240,
        height: 40,
        top: y,
        left: 0,
        right: 240,
        bottom: y + 40,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return savedGetBoundingClientRect?.call(this) as DOMRect;
  } as typeof Element.prototype.getBoundingClientRect;
  savedScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (): void {};
}

function restoreDndRects(): void {
  if (savedGetBoundingClientRect !== undefined) {
    Element.prototype.getBoundingClientRect = savedGetBoundingClientRect;
  }
  if (savedScrollIntoView !== undefined) {
    Element.prototype.scrollIntoView = savedScrollIntoView;
  }
  savedGetBoundingClientRect = undefined;
  savedScrollIntoView = undefined;
}

function option(name: string | RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

function treeitem(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

function handle(label: string): HTMLElement {
  return screen.getByRole("button", { name: `Drag ${label}` });
}

function toast(): HTMLElement {
  return screen.getByTestId("undo-toast");
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

/**
 * Lift `from` with Space, walk the drop targets with ArrowDown until the
 * `targetId` slot is reached, then drop with Space. Keys are dispatched on
 * the (still-focused) handle so they also bubble through the listbox / tree
 * handlers — exercising the "drag owns the keys" guard. The walk count comes
 * from the live DOM order, so it survives layout changes.
 */
async function keyboardDragTo(
  from: HTMLElement,
  targetId: string,
): Promise<void> {
  from.focus();
  fireEvent.keyDown(from, { code: "Space" });
  await flush();
  const order = dropOrder();
  const targetIndex = order.indexOf(targetId);
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  for (let i = 0; i <= targetIndex; i += 1) {
    fireEvent.keyDown(from, { code: "ArrowDown" });
  }
  fireEvent.keyDown(from, { code: "Space" });
  await flush();
}

describe("drag and drop (keyboard sensor)", () => {
  it("shows a drag overlay for the lifted row", async () => {
    await renderApp();
    const from = handle("Alpha");
    from.focus();
    fireEvent.keyDown(from, { code: "Space" });
    await flush();
    const overlay = screen.getByTestId("dnd-overlay");
    expect(overlay.textContent).toContain("Alpha");
    fireEvent.keyDown(from, { code: "Escape" });
    await flush();
  });

  it("keeps roving focus on the drag handle while dragging", async () => {
    await renderApp();
    const from = handle("Alpha");
    from.focus();
    fireEvent.keyDown(from, { code: "Space" });
    await flush();
    // ArrowDown during a drag moves the drag target, never the listbox's
    // roving focus (T2's key handler must stand down).
    fireEvent.keyDown(from, { code: "ArrowDown" });
    expect(document.activeElement).toBe(from);
    fireEvent.keyDown(from, { code: "Escape" });
    await flush();
  });

  it("moves a bookmark into another folder", async () => {
    await renderApp();
    // Expand "Dev" so its child folders are visible drop targets.
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowRight" });
    await waitFor(() => expect(treeitem("Tools")).toBeTruthy());
    await keyboardDragTo(handle("Alpha"), "folder:f11");

    await waitFor(async () => {
      expect((await fake.get("b1"))[0]?.parentId).toBe("f11");
    });
    await waitFor(() =>
      expect(toast().textContent).toContain("Moved 1 item"),
    );
    expect(await db.undo.count()).toBe(1);
  });

  it("reorders bookmarks within a folder", async () => {
    await renderApp();
    await keyboardDragTo(handle("Epsilon"), "slot:b4");

    await waitFor(async () => {
      const children = await fake.getChildren("2");
      expect(children.map((node) => node.id)).toEqual(["b5", "b4"]);
    });
    await waitFor(() => expect(toast().textContent).toContain("Reordered"));
  });

  it("reorders folders among their siblings", async () => {
    await renderApp();
    // Expand "Dev" so its child folders are visible drop targets.
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowRight" });
    await waitFor(() => expect(treeitem("Tools")).toBeTruthy());

    await keyboardDragTo(handle("Tools"), "folder:f10");

    await waitFor(async () => {
      const children = await fake.getChildren("10");
      expect(children.map((node) => node.id)).toEqual(["b1", "f11", "f10"]);
    });
  });

  it("drags the whole selection when a selected row is dragged", async () => {
    await renderApp();
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowRight" });
    await waitFor(() => expect(treeitem("Tools")).toBeTruthy());
    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Gamma/), { ctrlKey: true });

    await keyboardDragTo(handle("Alpha"), "folder:f11");

    await waitFor(async () => {
      expect((await fake.get("b1"))[0]?.parentId).toBe("f11");
    });
    expect((await fake.get("b3"))[0]?.parentId).toBe("f11");
    await waitFor(() => expect(toast().textContent).toContain("Moved 2 items"));

    // A successful drop clears the selection (same policy as delete/move).
    expect(
      screen.queryByRole("toolbar", { name: "Selection actions" }),
    ).toBeNull();

    // Undo restores both original parents.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(toast().textContent).toContain("Undone"));
    expect((await fake.get("b1"))[0]?.parentId).toBe("10");
    expect((await fake.get("b3"))[0]?.parentId).toBe("1");
  });

  it("rejects a drop onto a managed folder (invalid affordance, no move)", async () => {
    await renderApp();
    const from = handle("Alpha");
    from.focus();
    fireEvent.keyDown(from, { code: "Space" });
    await flush();

    const order = dropOrder();
    const targetIndex = order.indexOf("folder:m1");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i <= targetIndex; i += 1) {
      fireEvent.keyDown(from, { code: "ArrowDown" });
    }
    await flush();

    const zone = document.querySelector('[data-dnd-drop="folder:m1"]');
    expect(zone?.getAttribute("data-drop-invalid")).toBe("true");

    fireEvent.keyDown(from, { code: "Space" });
    await flush();

    expect((await fake.get("b1"))[0]?.parentId).toBe("10");
    expect(await db.undo.count()).toBe(0);
  });

  it("rejects a drop into the dragged folder's own descendant", async () => {
    await renderApp();
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowRight" });
    await waitFor(() => expect(treeitem("Nested")).toBeTruthy());
    fireEvent.keyDown(treeitem("Nested"), { key: "ArrowRight" });
    await waitFor(() => expect(treeitem("Deep")).toBeTruthy());

    await keyboardDragTo(handle("Nested"), "folder:f12");

    expect((await fake.get("f10"))[0]?.parentId).toBe("10");
    expect(await db.undo.count()).toBe(0);
  });

  it("leaves the tree untouched when a drag is cancelled", async () => {
    await renderApp();
    const from = handle("Alpha");
    from.focus();
    fireEvent.keyDown(from, { code: "Space" });
    await flush();
    fireEvent.keyDown(from, { code: "ArrowDown" });
    fireEvent.keyDown(from, { code: "Escape" });
    await flush();

    expect((await fake.get("b1"))[0]?.parentId).toBe("10");
    expect(await db.undo.count()).toBe(0);
    expect(screen.queryByTestId("dnd-overlay")).toBeNull();
  });

  it("rejects a drop onto a fixed-root row (invalid, nothing dispatched)", async () => {
    await renderApp();
    // "1" (Bookmarks bar) is a built-in root — never a user drop target.
    await keyboardDragTo(handle("Alpha"), "folder:1");

    expect((await fake.get("b1"))[0]?.parentId).toBe("10");
    expect(await db.undo.count()).toBe(0);
    // No toast for a rejected drop.
    expect(screen.queryByTestId("undo-toast")).toBeNull();
  });

  it("marks a fixed-root row's drop zone invalid while hovered", async () => {
    await renderApp();
    const from = handle("Alpha");
    from.focus();
    fireEvent.keyDown(from, { code: "Space" });
    await flush();

    const order = dropOrder();
    const targetIndex = order.indexOf("folder:2");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i <= targetIndex; i += 1) {
      fireEvent.keyDown(from, { code: "ArrowDown" });
    }
    await flush();

    const zone = document.querySelector('[data-dnd-drop="folder:2"]');
    expect(zone?.getAttribute("data-drop-invalid")).toBe("true");

    fireEvent.keyDown(from, { code: "Escape" });
    await flush();
  });

  it("does not toggle selection when the lifting Space bubbles to the listbox", async () => {
    await renderApp();
    const from = handle("Alpha");
    from.focus();
    // The Space that lifts the drag also bubbles to the listbox handler; it
    // is defaultPrevented by dnd-kit, so the row must NOT be selected.
    fireEvent.keyDown(from, { code: "Space" });
    await flush();

    expect(option(/Alpha/).getAttribute("aria-selected")).toBe("false");
    expect(
      screen.queryByRole("toolbar", { name: "Selection actions" }),
    ).toBeNull();

    fireEvent.keyDown(from, { code: "Escape" });
    await flush();
  });

  it("does not select a folder when the lifting Space bubbles to the tree", async () => {
    await renderApp();
    const from = handle("Dev");
    from.focus();
    fireEvent.keyDown(from, { code: "Space" });
    await flush();

    // The view stays on "All bookmarks" — the tree's Space handler stood down.
    expect(
      screen.getByRole("heading", { name: "All bookmarks" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Dev" })).toBeNull();

    fireEvent.keyDown(from, { code: "Escape" });
    await flush();
  });

  it("disables the drag handle on fixed-root folder rows", async () => {
    await renderApp();
    expect(
      handle("Bookmarks bar").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(handle("Other bookmarks").getAttribute("aria-disabled")).toBe(
      "true",
    );
    // A normal folder keeps an enabled handle.
    expect(handle("Dev").getAttribute("aria-disabled")).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// BookmarkList drop slots (reorderable gating) + roving-focus clamp
// ---------------------------------------------------------------------------

/** A minimal positioned bookmark row for direct BookmarkList renders. */
function bk(
  id: string,
  title: string,
  parentId: string,
  index: number,
): BookmarkItem {
  return {
    kind: "bookmark",
    id,
    title,
    url: `https://${id}.example/`,
    parentId,
    index,
    path: [],
    isRoot: false,
    isManaged: false,
    depth: 1,
  };
}

describe("BookmarkList drop slots", () => {
  it("exposes a reorder drop slot in a tree-ordered (reorderable) view", async () => {
    render(<BookmarkList items={[bk("x1", "X1", "10", 0)]} />);
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBe(1),
    );
    expect(
      screen.getByRole("option").getAttribute("data-dnd-drop"),
    ).toBe("slot:x1");
  });

  it("exposes no drop slot when the view is not tree-ordered", async () => {
    render(
      <BookmarkList items={[bk("x1", "X1", "10", 0)]} reorderable={false} />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBe(1),
    );
    expect(
      screen.getByRole("option").getAttribute("data-dnd-drop"),
    ).toBeNull();
  });
});

describe("BookmarkList roving focus", () => {
  it("keeps exactly one focusable row after the list shrinks", async () => {
    const { rerender } = render(
      <BookmarkList
        items={[
          bk("a", "A", "10", 0),
          bk("b", "B", "10", 1),
          bk("c", "C", "10", 2),
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBe(3),
    );
    // Walk the roving focus to the last row (index 2).
    fireEvent.keyDown(screen.getByRole("option", { name: /A/ }), {
      key: "ArrowDown",
    });
    fireEvent.keyDown(screen.getByRole("option", { name: /B/ }), {
      key: "ArrowDown",
    });

    rerender(<BookmarkList items={[bk("a", "A", "10", 0)]} />);
    await waitFor(() => {
      const options = screen.getAllByRole("option");
      expect(options.length).toBe(1);
      expect(
        options.filter((o) => o.getAttribute("tabindex") === "0").length,
      ).toBe(1);
    });
  });
});
