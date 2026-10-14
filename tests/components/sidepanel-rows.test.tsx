import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useContext } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  BookmarkList,
  SelectionContext,
  useBookmarkSelection,
} from "../../src/entrypoints/sidepanel/BookmarkList";
import { FolderTree } from "../../src/entrypoints/sidepanel/FolderTree";
import type { BookmarkMeta } from "../../src/schemas/meta";
import { flattenTree } from "../../src/sync/tree";
import type { BookmarkItem } from "../../src/sync/tree";
import { restoreElementRects, stubElementRects } from "./virtual-rects";
const ISO = "2026-09-01T00:00:00.000Z";

function item(
  id: string,
  title: string,
  url: string,
  overrides: Partial<BookmarkItem> = {},
): BookmarkItem {
  return {
    id,
    title,
    url,
    path: [],
    isRoot: false,
    isManaged: false,
    depth: 1,
    kind: "bookmark",
    ...overrides,
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(stubElementRects);
afterEach(() => {
  cleanup();
  restoreElementRects();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

describe("list row", () => {
  it("shows the domain instead of the full URL and keeps the URL as a tooltip", () => {
    render(
      <BookmarkList
        items={[
          item("a", "Design system", "https://www.work.example/design/tokens?x=1"),
        ]}
      />,
    );
    const row = screen.getByRole("option");
    expect(row.textContent).toContain("work.example");
    expect(row.textContent).not.toContain("/design/tokens");
    expect(row.getAttribute("title")).toBe(
      "https://www.work.example/design/tokens?x=1",
    );
  });

  it("keeps row controls in the DOM, hidden until hover, focus or selection", () => {
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        renderItemActions={() => <button type="button">Actions</button>}
      />,
    );
    const row = screen.getByRole("option");
    const controls = row.querySelector("[data-row-controls]");
    expect(controls).not.toBeNull();
    expect(within(controls as HTMLElement).getByRole("button", { name: "Actions" }))
      .toBeTruthy();
    expect(controls?.className).toContain("opacity-0");
    expect(controls?.className).toContain("group-hover/row:opacity-100");
    expect(controls?.className).toContain("group-focus-within/row:opacity-100");
    expect(controls?.className).toContain("group-aria-selected/row:opacity-100");

    const handle = row.querySelector("[data-dnd-drag]");
    expect(handle).not.toBeNull();
    expect(handle?.className).toContain("opacity-0");
    expect(handle?.className).toContain("group-hover/row:opacity-100");
  });

  it("shows at most two tag chips and folds the rest into a +N chip with a tooltip", () => {
    const metaById = new Map<string, BookmarkMeta>([
      [
        "a",
        { id: "a", tags: ["one", "two", "three", "four"], updatedAt: ISO },
      ],
    ]);
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        metaById={metaById}
        tagNameByKey={new Map([
          ["one", "One"],
          ["two", "Two"],
          ["three", "Three"],
          ["four", "Four"],
        ])}
      />,
    );
    const row = screen.getByRole("option");
    expect(row.querySelectorAll("[data-tag]").length).toBe(2);
    expect(row.textContent).toContain("One");
    expect(row.textContent).toContain("Two");
    expect(row.textContent).not.toContain("Three");
    const more = row.querySelector("[data-tag-more]");
    expect(more?.textContent).toBe("+2");
    expect(more?.getAttribute("title")).toBe("Three, Four");
  });

  it("renders no +N chip when the tags fit", () => {
    const metaById = new Map<string, BookmarkMeta>([
      ["a", { id: "a", tags: ["one", "two"], updatedAt: ISO }],
    ]);
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        metaById={metaById}
      />,
    );
    expect(screen.getByRole("option").querySelector("[data-tag-more]")).toBeNull();
  });

  it("truncates tag chips in list rows with max-w-[80px] truncate (U-08a)", () => {
    const metaById = new Map<string, BookmarkMeta>();
    metaById.set("a", {
      id: "a",
      tags: ["super-long-tag-name"],
      updatedAt: ISO,
    });
    render(
      <BookmarkList
        items={[item("a", "Alpha", "https://a.example/")]}
        metaById={metaById}
      />,
    );
    const tagChip = screen.getByRole("option").querySelector("[data-tag]");
    expect(tagChip?.className).toContain("truncate");
    expect(tagChip?.className).toMatch(/max-w-\[(72|80)px\]/);
  });

  it("renders DragHandle inside grid cards and sets roving tabIndex on inner row controls (U-07, U-10c)", () => {
    render(
      <BookmarkList
        items={[
          item("a", "Alpha", "https://a.example/", { parentId: "1", index: 0 }),
          item("b", "Beta", "https://b.example/", { parentId: "1", index: 1 }),
        ]}
        renderItemActions={(it) => (
          <button type="button">Actions {it.title}</button>
        )}
      />,
    );
    const options = screen.getAllByRole("option");
    const rowA = options[0] as HTMLElement;
    const rowB = options[1] as HTMLElement;
    expect(
      within(rowA).getByRole("button", { name: "Actions Alpha" }).tabIndex,
    ).toBe(0);
    expect(
      within(rowB).getByRole("button", { name: "Actions Beta" }).tabIndex,
    ).toBe(-1);
    expect(
      (rowA.querySelector("[data-dnd-drag]") as HTMLElement).tabIndex,
    ).toBe(0);
    expect(
      (rowB.querySelector("[data-dnd-drag]") as HTMLElement).tabIndex,
    ).toBe(-1);

    fireEvent.click(screen.getByRole("button", { name: /Grid view/i }));
    const gridOptions = screen.getAllByRole("option");
    expect(
      gridOptions[0]?.querySelector("[data-dnd-drag]"),
    ).not.toBeNull();
    expect(
      (gridOptions[0]?.querySelector("[data-dnd-drag]") as HTMLElement).tabIndex,
    ).toBe(0);
    expect(
      (gridOptions[1]?.querySelector("[data-dnd-drag]") as HTMLElement).tabIndex,
    ).toBe(-1);
  });

  it("memoizes useBookmarkSelection return reference across unrelated parent renders (P-13a)", () => {
    const orderedIds = ["a", "b"];
    const seen: unknown[] = [];
    function Child() {
      const sel = useContext(SelectionContext);
      seen.push(sel);
      return null;
    }
    function Harness({ tick }: { tick: number }) {
      const sel = useBookmarkSelection(orderedIds);
      return (
        <SelectionContext.Provider value={sel}>
          <span data-tick={tick} />
          <Child />
        </SelectionContext.Provider>
      );
    }
    const { rerender } = render(<Harness tick={1} />);
    rerender(<Harness tick={2} />);
    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("sets roving tabIndex on FolderTree row controls and drag handles (U-10c)", () => {
    const tree = flattenTree([
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
              { id: "10", parentId: "1", index: 0, title: "Dev", children: [] },
              { id: "11", parentId: "1", index: 1, title: "Docs", children: [] },
            ],
          },
        ],
      },
    ]);
    render(
      <FolderTree
        tree={tree}
        selectedFolderId="10"
        renderFolderActions={(node) => (
          <button type="button">Folder actions {node.title}</button>
        )}
      />,
    );
    const devRow = screen.getByRole("treeitem", { name: "Dev" });
    const docsRow = screen.getByRole("treeitem", { name: "Docs" });
    expect(
      within(devRow).getByRole("button", { name: "Folder actions Dev" }).tabIndex,
    ).toBe(0);
    expect(
      within(docsRow).getByRole("button", { name: "Folder actions Docs" }).tabIndex,
    ).toBe(-1);
    expect(
      (devRow.querySelector("[data-dnd-drag]") as HTMLElement).tabIndex,
    ).toBe(0);
    expect(
      (docsRow.querySelector("[data-dnd-drag]") as HTMLElement).tabIndex,
    ).toBe(-1);
  });
});

describe("empty list", () => {
  it("renders the empty node outside the listbox", () => {
    render(<BookmarkList items={[]} empty={<p>Custom empty</p>} />);
    expect(screen.getByText("Custom empty")).toBeTruthy();
    const listbox = screen.getByRole("listbox", { name: "Bookmarks" });
    expect(within(listbox).queryByText("Custom empty")).toBeNull();
  });

  it("falls back to the default line when no empty node is given", () => {
    render(<BookmarkList items={[]} />);
    expect(screen.getByText("No bookmarks in this view.")).toBeTruthy();
  });
});
