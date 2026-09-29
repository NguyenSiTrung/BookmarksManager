import { cleanup, render, screen, within } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { BookmarkList } from "../../src/entrypoints/sidepanel/BookmarkList";
import type { BookmarkMeta } from "../../src/schemas/meta";
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
