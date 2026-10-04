import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ScopePane } from "../../src/entrypoints/sidepanel/ScopePane";
import type { ScopePaneProps } from "../../src/entrypoints/sidepanel/ScopePane";
import type { TagDef } from "../../src/schemas/meta";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";

const ISO = "2026-09-29T10:00:00.000Z";

const nodes: BookmarksTreeNode[] = [
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
              { id: "b1", parentId: "10", index: 0, title: "A", url: "https://a.example/" },
            ],
          },
        ],
      },
      { id: "2", parentId: "0", index: 1, title: "Other bookmarks", children: [] },
    ],
  },
];
const tree: FlattenedTree = flattenTree(nodes);
const devTag: TagDef = {
  name: "Ops",
  nameKey: "ops",
  createdAt: ISO,
  updatedAt: ISO,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPane(overrides: Partial<ScopePaneProps> = {}) {
  const onSelect = vi.fn();
  render(
    <ScopePane
      tree={tree}
      view={{ kind: "all" }}
      tagDefs={[devTag]}
      categories={[{ category: "docs", count: 2 }]}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return onSelect;
}

describe("ScopePane", () => {
  it("renders folders, tags and non-empty categories with counts", () => {
    renderPane();
    expect(screen.getByRole("treeitem", { name: "Dev" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ops" })).toBeTruthy();
    const docs = screen.getByRole("button", { name: /^Docs/ });
    expect(docs.textContent).toContain("2");
  });

  it("omits the Tags and Categories sections when empty", () => {
    renderPane({ tagDefs: [], categories: [] });
    expect(screen.queryByRole("heading", { name: "Tags" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Categories" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Folders" })).toBeTruthy();
  });

  it("shows a loading note until the tree has folders", () => {
    renderPane({ tree: flattenTree([]) });
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("routes selections to onSelect as views", () => {
    const onSelect = renderPane();
    fireEvent.click(screen.getByRole("treeitem", { name: "Dev" }));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "folder",
      folderId: "10",
    });
    fireEvent.click(screen.getByRole("button", { name: "Ops" }));
    expect(onSelect).toHaveBeenLastCalledWith({ kind: "tag", nameKey: "ops" });
    fireEvent.click(screen.getByRole("button", { name: /^Docs/ }));
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: "category",
      category: "docs",
    });
  });

  it("marks the current scope as pressed/selected", () => {
    renderPane({ view: { kind: "tag", nameKey: "ops" } });
    expect(
      screen.getByRole("button", { name: "Ops" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /^Docs/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("ScopePane section collapse", () => {
  const TAGS = [devTag];
  const CATEGORIES = [{ category: "docs" as const, count: 2 }];

  function pane(view: ScopePaneProps["view"]) {
    return (
      <ScopePane
        tree={tree}
        view={view}
        tagDefs={TAGS}
        categories={CATEGORIES}
        onSelect={vi.fn()}
      />
    );
  }

  function heading(name: string): HTMLElement {
    return screen.getByRole("button", { name });
  }

  it("collapses one section from its heading without touching the others", () => {
    render(pane({ kind: "all" }));
    expect(heading("Tags").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(heading("Tags"));
    expect(heading("Tags").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Ops" })).toBeNull();
    expect(screen.getByRole("treeitem", { name: "Dev" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Docs/ })).toBeTruthy();

    fireEvent.click(heading("Tags"));
    expect(screen.getByRole("button", { name: "Ops" })).toBeTruthy();
  });

  it("reopens the section of a selection that arrives from outside, once", () => {
    const { rerender } = render(pane({ kind: "all" }));
    fireEvent.click(heading("Tags"));
    expect(screen.queryByRole("button", { name: "Ops" })).toBeNull();

    rerender(pane({ kind: "tag", nameKey: "ops" }));
    expect(heading("Tags").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Ops" })).toBeTruthy();

    // Same selection re-rendered: the user's collapse sticks.
    fireEvent.click(heading("Tags"));
    rerender(pane({ kind: "tag", nameKey: "ops" }));
    expect(heading("Tags").getAttribute("aria-expanded")).toBe("false");
  });

  it("restores collapsed sections after a remount", async () => {
    const data: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: (key: string) => Promise.resolve({ [key]: data[key] }),
          set: (items: Record<string, unknown>) => {
            Object.assign(data, items);
            return Promise.resolve();
          },
        },
      },
    });
    const first = render(pane({ kind: "all" }));
    // Hydration (empty) finishes first and writes through.
    await waitFor(() => expect(Object.keys(data)).toHaveLength(2));

    fireEvent.click(heading("Categories"));
    await waitFor(() =>
      expect(Object.values(data)).toContainEqual({ categories: true }),
    );
    first.unmount();

    render(pane({ kind: "all" }));
    await waitFor(() =>
      expect(heading("Categories").getAttribute("aria-expanded")).toBe("false"),
    );
    expect(heading("Tags").getAttribute("aria-expanded")).toBe("true");
  });
});
