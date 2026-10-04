import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FolderTree } from "../../src/entrypoints/sidepanel/FolderTree";
import { FOLDER_EXPANSION_KEY } from "../../src/entrypoints/sidepanel/folder-expansion";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";

/**
 * Folder-tree expansion: reveal-on-select and `chrome.storage.session`
 * persistence. Layout: bar(1) > Dev(10) > Nested(f10) > Deep(f11); Other(2).
 */

function folder(
  id: string,
  parentId: string,
  title: string,
  children: BookmarksTreeNode[] = [],
): BookmarksTreeNode {
  return { id, parentId, index: 0, title, children };
}

const NODES: BookmarksTreeNode[] = [
  {
    id: "0",
    title: "",
    children: [
      folder("1", "0", "Bookmarks bar", [
        folder("10", "1", "Dev", [
          folder("f10", "10", "Nested", [folder("f11", "f10", "Deep")]),
        ]),
      ]),
      folder("2", "0", "Other bookmarks"),
    ],
  },
];

const tree = flattenTree(NODES);

function treeitem(name: string): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

function queryTreeitem(name: string): HTMLElement | null {
  return screen.queryByRole("treeitem", { name });
}

/** In-memory `chrome.storage.session`; `data` is inspectable by the test. */
function stubSessionStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const set = vi.fn((items: Record<string, unknown>) => {
    Object.assign(data, items);
    return Promise.resolve();
  });
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: (key: string) => Promise.resolve({ [key]: data[key] }),
        set,
      },
    },
  });
  return { data, set };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FolderTree reveal on selection", () => {
  it("expands every collapsed ancestor of a selection that arrives from outside", () => {
    const { rerender } = render(<FolderTree tree={tree} />);
    expect(queryTreeitem("Deep")).toBeNull();

    rerender(<FolderTree tree={tree} selectedFolderId="f11" />);

    expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("true");
    expect(treeitem("Nested").getAttribute("aria-expanded")).toBe("true");
    expect(treeitem("Deep").getAttribute("aria-selected")).toBe("true");
    // The selected row is the roving-tabindex target.
    expect(treeitem("Deep").tabIndex).toBe(0);
  });

  it("does not re-expand an ancestor the user collapsed afterwards", () => {
    const { rerender } = render(
      <FolderTree tree={tree} selectedFolderId="f11" />,
    );
    expect(treeitem("Deep")).toBeTruthy();

    fireEvent.keyDown(treeitem("Nested"), { key: "ArrowLeft" });
    expect(queryTreeitem("Deep")).toBeNull();

    // Same selection, new tree identity (a live bookmark update).
    rerender(
      <FolderTree tree={flattenTree(NODES)} selectedFolderId="f11" />,
    );
    expect(queryTreeitem("Deep")).toBeNull();
    expect(treeitem("Nested").getAttribute("aria-expanded")).toBe("false");
  });

  it("re-reveals when the selection changes back to a hidden folder", () => {
    const { rerender } = render(
      <FolderTree tree={tree} selectedFolderId="f11" />,
    );
    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowLeft" });
    expect(queryTreeitem("Deep")).toBeNull();

    rerender(<FolderTree tree={tree} selectedFolderId="2" />);
    rerender(<FolderTree tree={tree} selectedFolderId="f11" />);
    expect(treeitem("Deep").getAttribute("aria-selected")).toBe("true");
  });

  it("reveals once the selected folder shows up in a later tree", () => {
    const { rerender } = render(
      <FolderTree tree={flattenTree([])} selectedFolderId="f11" />,
    );
    rerender(<FolderTree tree={tree} selectedFolderId="f11" />);
    expect(treeitem("Deep").getAttribute("aria-selected")).toBe("true");
  });
});

describe("FolderTree expansion persistence", () => {
  it("restores expansion after the panel is closed and reopened", async () => {
    const { data } = stubSessionStorage();
    const first = render(<FolderTree tree={tree} />);
    // Hydration (empty) must finish before the first toggle is persisted.
    await waitFor(() => expect(data[FOLDER_EXPANSION_KEY]).toBeDefined());

    fireEvent.keyDown(treeitem("Dev"), { key: "ArrowRight" });
    await waitFor(() =>
      expect(data[FOLDER_EXPANSION_KEY]).toMatchObject({ "10": true }),
    );
    first.unmount();

    render(<FolderTree tree={tree} />);
    await waitFor(() =>
      expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("true"),
    );
    expect(treeitem("Nested")).toBeTruthy();
  });

  it("keeps a user toggle made while the stored state was still loading", async () => {
    stubSessionStorage({
      [FOLDER_EXPANSION_KEY]: { "10": true, "1": true },
    });
    render(<FolderTree tree={tree} />);
    // Synchronously, before the async read resolves: collapse the root.
    fireEvent.keyDown(treeitem("Bookmarks bar"), { key: "ArrowLeft" });

    await waitFor(() => expect(queryTreeitem("Dev")).toBeNull());
    expect(treeitem("Bookmarks bar").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("prunes ids that are no longer in the tree and ignores corrupt data", async () => {
    const { data, set } = stubSessionStorage({
      [FOLDER_EXPANSION_KEY]: { "10": true, gone: true },
    });
    render(<FolderTree tree={tree} />);
    await waitFor(() =>
      expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("true"),
    );
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(data[FOLDER_EXPANSION_KEY]).toEqual({ "10": true });

    cleanup();
    stubSessionStorage({ [FOLDER_EXPANSION_KEY]: { "10": "yes" } });
    render(<FolderTree tree={tree} />);
    // Corrupt value: the whole entry is dropped, defaults apply.
    await waitFor(() =>
      expect(treeitem("Dev").getAttribute("aria-expanded")).toBe("false"),
    );
  });
});
