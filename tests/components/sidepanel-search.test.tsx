import "fake-indexeddb/auto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import { createTag, putMeta } from "../../src/db/meta";
import { App } from "../../src/entrypoints/sidepanel/App";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 2 Task 2 — side-panel search bar + `search` view.
 *
 * Layers under test:
 *  - `views.ts`    `{ kind: "search"; query }` resolves through `runQuery` to
 *                  live BookmarkItems over the whole library.
 *  - `SearchBar`   controlled input; Esc clears; parser warnings render
 *                  inline; the result count is a `role="status"` region.
 *  - `App.tsx`     `/` focuses the input unless focus is in a text field;
 *                  a non-empty query swaps the list to `search` and clearing
 *                  restores the previous view; search results keep row
 *                  actions, multi-select and the bulk bar; reorder drop
 *                  slots stay off (results are not in tree order).
 */

let fake: FakeBookmarksApi;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreElementRects();
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
            children: [{ id: "b2", title: "Beta", url: "https://b.example/" }],
          },
        ],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
    ],
    otherBookmarks: [
      { id: "b4", title: "Delta", url: "https://d.example/" },
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

/**
 * jsdom reports 0 for every element's offsetHeight/offsetWidth, which makes
 * @tanstack/react-virtual render nothing. The scroll container
 * (data-testid="bookmark-scroll") gets a fixed 600x400 rect so rows mount.
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

function option(name: string | RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

function treeitem(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

function searchbox(): HTMLElement {
  return screen.getByRole("searchbox", { name: "Search bookmarks" });
}

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
  // The search index builds in an effect after mount — wait for it so
  // typing yields results synchronously in each test.
  await waitFor(() =>
    expect(screen.queryByText("Indexing…")).toBeNull(),
  );
}

function typeQuery(text: string): void {
  fireEvent.change(searchbox(), { target: { value: text } });
}

describe("side-panel search", () => {
  it("filters the whole library as a query is typed", async () => {
    await renderApp();
    expect(screen.getAllByRole("option").length).toBe(4);

    typeQuery("alpha");

    await waitFor(() =>
      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(
        [expect.stringContaining("Alpha")],
      ),
    );
    // The header title flips to the search view title.
    expect(screen.getByRole("heading", { name: /Results for “alpha”/ })).toBeTruthy();
    // aria-live count announces the hit count.
    expect(screen.getByTestId("search-status").textContent).toBe("1 result");
  });

  it("restores the previous view when the query is cleared", async () => {
    await renderApp();

    // Navigate to the Dev folder (subtree shows Alpha + Beta only).
    fireEvent.click(treeitem(/Dev/));
    await waitFor(() =>
      expect(
        screen.getAllByRole("option").map((el) => el.textContent),
      ).toEqual([
        expect.stringContaining("Alpha"),
        expect.stringContaining("Beta"),
      ]),
    );

    // Search covers the WHOLE library — Delta lives under Other bookmarks.
    typeQuery("delta");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(
        [expect.stringContaining("Delta")],
      ),
    );

    // Clearing restores the folder view, not the default "all" view.
    typeQuery("");
    await waitFor(() =>
      expect(
        screen.getAllByRole("option").map((el) => el.textContent),
      ).toEqual([
        expect.stringContaining("Alpha"),
        expect.stringContaining("Beta"),
      ]),
    );
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
  });

  it("/ focuses the input and Esc clears the query", async () => {
    await renderApp();

    // Focus starts outside the input; "/" anywhere in the panel focuses it.
    expect(document.activeElement).not.toBe(searchbox());
    fireEvent.keyDown(document.body, { key: "/" });
    await waitFor(() => expect(document.activeElement).toBe(searchbox()));

    typeQuery("gamma");
    await waitFor(() =>
      expect(screen.getByTestId("search-status").textContent).toBe(
        "1 result",
      ),
    );

    fireEvent.keyDown(searchbox(), { key: "Escape" });
    await waitFor(() => expect((searchbox() as HTMLInputElement).value).toBe(""));
    expect(screen.getAllByRole("option").length).toBe(4);
  });

  it("does not steal / when focus is already in a text field", async () => {
    await renderApp();
    const input = searchbox();
    input.focus();
    expect(document.activeElement).toBe(input);

    // "/" typed inside a text field is literal text, not a refocus.
    fireEvent.keyDown(input, { key: "/" });
    fireEvent.change(input, { target: { value: "/" } });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("/"));
    expect(document.activeElement).toBe(input);
  });

  it("shows parser warnings inline under the input", async () => {
    await renderApp();

    // is:dead is recognized but unsupported yet.
    typeQuery("is:dead");
    await waitFor(() =>
      expect(screen.getByTestId("search-warnings").textContent).toContain(
        "Link checking isn't available yet",
      ),
    );

    // A malformed value for a known key warns instead of failing.
    typeQuery("category:bogus");
    await waitFor(() =>
      expect(screen.getByTestId("search-warnings").textContent).toContain(
        "Unknown category",
      ),
    );

    // Warnings clear with the query.
    typeQuery("tag:x");
    await waitFor(() =>
      expect(screen.queryByTestId("search-warnings")).toBeNull(),
    );
  });

  it("keeps selection and bulk actions working on results, with drop slots off", async () => {
    await renderApp();

    // Baseline: the "all" view is reorderable — rows carry reorder slots.
    // (`data-dnd-drop="folder:*"` lives on the sidebar tree and stays on —
    //  dropping a result onto a folder is a move, not a reorder.)
    expect(
      document.querySelectorAll('[data-dnd-drop^="slot:"]').length,
    ).toBeGreaterThan(0);

    typeQuery("example"); // every fixture URL sits on *.example — 4 hits
    await waitFor(() =>
      expect(screen.getAllByRole("option").length).toBe(4),
    );

    // Results are not tree-ordered: no row exposes a reorder drop slot.
    expect(
      document.querySelectorAll('[data-dnd-drop^="slot:"]').length,
    ).toBe(0);

    // Multi-select works on results (click + ctrl-click).
    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Gamma/), { ctrlKey: true });
    const bar = await screen.findByRole("toolbar", {
      name: "Selection actions",
    });
    // The bulk bar targets the selected results — delete them via Undo path.
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.getByTestId("undo-toast")).toBeTruthy(),
    );
    // The deleted rows leave the (still filtered) result list.
    await waitFor(() => {
      const texts = screen
        .getAllByRole("option")
        .map((el) => el.textContent ?? "");
      expect(texts.length).toBe(2);
      expect(texts).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Beta"),
          expect.stringContaining("Delta"),
        ]),
      );
    });
  });

  it("searches tags, notes, and folder filters from the bar", async () => {
    await createTag("TypeScript");
    await putMeta("b1", { tags: ["typescript"], notes: "event loop" });
    await renderApp();

    // Tag filter — display-name lookup through tagDefs.
    typeQuery("tag:typescript");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(
        [expect.stringContaining("Alpha")],
      ),
    );

    // Notes are indexed.
    typeQuery("loop");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(
        [expect.stringContaining("Alpha")],
      ),
    );

    // Folder subtree filter.
    typeQuery("folder:dev/nested");
    await waitFor(() =>
      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(
        [expect.stringContaining("Beta")],
      ),
    );
  });

  it("a change made elsewhere lands in results without a reload", async () => {
    await renderApp();
    // "quill" sits ≥2 edits from every indexed token — nothing fuzzy-hits.
    typeQuery("quill");
    await waitFor(() =>
      expect(screen.getByTestId("search-status").textContent).toBe(
        "0 results",
      ),
    );

    // An external create fires the tree listeners; the index diff-adds it.
    await act(async () => {
      await fake.create({
        parentId: "1",
        title: "Quill",
        url: "https://q.example/",
      });
    });

    await waitFor(() =>
      expect(screen.getAllByRole("option").map((el) => el.textContent)).toEqual(
        [expect.stringContaining("Quill")],
      ),
    );
  });
});
