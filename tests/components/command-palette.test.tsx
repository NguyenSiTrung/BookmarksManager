import "fake-indexeddb/auto";
import {
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
import { App } from "../../src/entrypoints/sidepanel/App";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 2 Task 4 — command palette: Ctrl/Cmd+K opens a Radix Dialog with an
 * ARIA combobox over flat results; sections for bookmarks (search hits),
 * views, folders, tags, categories; arrows navigate, Enter runs, Esc closes
 * and restores the pre-open focus.
 */

let fake: FakeBookmarksApi;
let chromeStub: { tabs: { create: ReturnType<typeof vi.fn> } };

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
        children: [{ id: "b1", title: "Alpha", url: "https://a.example/1" }],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
    ],
    otherBookmarks: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
  });
  chromeStub = {
    tabs: { create: vi.fn().mockResolvedValue({ id: 1 }) },
  };
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    tabs: chromeStub.tabs,
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
  });
  stubElementRects();
});

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
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  savedRectDescriptors = [];
}

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() =>
    expect(
      within(screen.getByRole("listbox", { name: "Bookmarks" }))
        .queryAllByRole("option").length,
    ).toBeGreaterThan(0),
  );
}

function pressPaletteShortcut(key = "k", meta = false): void {
  fireEvent.keyDown(document.body, {
    key,
    [meta ? "metaKey" : "ctrlKey"]: true,
  });
}

function paletteInput(): HTMLElement {
  return screen.getByRole("combobox", { name: "Command palette" });
}

function paletteList(): HTMLElement {
  return screen.getByRole("listbox", { name: "Palette results" });
}

describe("command palette", () => {
  it("Ctrl+K and Cmd+K open the dialog with the input focused", async () => {
    await renderApp();
    expect(screen.queryByRole("dialog")).toBeNull();

    pressPaletteShortcut("k", false);
    await screen.findByRole("dialog");
    expect(paletteInput()).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(paletteInput()),
    );

    fireEvent.keyDown(paletteInput(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // MetaKey (macOS Cmd) opens it too.
    pressPaletteShortcut("k", true);
    await screen.findByRole("dialog");
  });

  it("lists jump sections when the query is empty", async () => {
    await renderApp();
    pressPaletteShortcut();
    await screen.findByRole("dialog");

    const list = paletteList();
    for (const label of [
      "All bookmarks",
      "Recently saved",
      "Untagged",
      "Duplicates",
      "Dev",
      "Other bookmarks",
    ]) {
      expect(
        within(list).getByRole("option", { name: new RegExp(label) }),
      ).toBeTruthy();
    }
    // No Bookmarks section until a query is typed.
    expect(
      within(list).queryByRole("option", { name: /Alpha/ }),
    ).toBeNull();
  });

  it("arrows move the highlight and Enter jumps to a view", async () => {
    await renderApp();
    pressPaletteShortcut();
    await screen.findByRole("dialog");

    const el = paletteInput();
    const list = paletteList();
    const options = within(list).getAllByRole("option");
    // First option is pre-highlighted (index 0) — Enter works immediately.
    expect(options[0]?.textContent).toContain("All bookmarks");
    expect(el.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(el.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");

    // Two more downs → "Duplicates" (index 3), Enter → the view switches.
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("heading", { name: "Duplicates" }),
    ).toBeTruthy();
  });

  it("typing narrows to bookmark results; Enter opens the bookmark", async () => {
    await renderApp();
    pressPaletteShortcut();
    await screen.findByRole("dialog");
    const tabsCreate = (
      chromeStub.tabs.create as ReturnType<typeof vi.fn>
    );
    fireEvent.change(paletteInput(), { target: { value: "delta" } });
    await waitFor(() => {
      const hit = within(paletteList()).queryByRole("option", {
        name: /Delta/,
      });
      expect(hit).toBeTruthy();
    });

    // Result 0 is pre-highlighted — Enter opens it in a foreground tab via
    // the typed tabs slice.
    fireEvent.keyDown(paletteInput(), { key: "Enter" });
    await waitFor(() =>
      expect(tabsCreate).toHaveBeenCalledWith({
        url: "https://d.example/",
        active: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Esc closes and restores the element that had focus", async () => {
    await renderApp();
    const searchbox = screen.getByRole("combobox", {
      name: "Search bookmarks",
    });
    (searchbox as HTMLElement).focus();
    expect(document.activeElement).toBe(searchbox);

    pressPaletteShortcut();
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(document.activeElement).toBe(paletteInput()),
    );

    fireEvent.keyDown(paletteInput(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(searchbox),
    );
  });

  it("a jump while a search is active clears the search and switches", async () => {
    await renderApp();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search bookmarks" }),
      { target: { value: "alpha" } },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Results for/ }),
      ).toBeTruthy(),
    );

    pressPaletteShortcut();
    await screen.findByRole("dialog");
    // Index 0 is pre-highlighted — Enter jumps straight to "All bookmarks".
    fireEvent.keyDown(paletteInput(), { key: "Enter" });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "All bookmarks" }),
      ).toBeTruthy(),
    );
    expect(
      (screen.getByRole("combobox", {
        name: "Search bookmarks",
      }) as HTMLInputElement).value,
    ).toBe("");
  });
});
