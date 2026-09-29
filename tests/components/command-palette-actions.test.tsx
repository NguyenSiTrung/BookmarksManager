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
 * Phase 2 Task 5 — palette commands and per-result actions.
 * Commands (Import/Export/Tag manager/New folder/Undo/Options) dispatch to
 * the same flows the toolbar buttons drive; bookmark results carry Open
 * (Enter → foreground tab), Open in new tab (Ctrl/Cmd+Enter → background),
 * Reveal in folder, Edit, and Copy URL via an actions menu. `javascript:`/
 * `data:` results keep Reveal/Edit/Copy but lose the opens.
 */

let fake: FakeBookmarksApi;
let tabsCreate: ReturnType<typeof vi.fn>;
let tabsUpdate: ReturnType<typeof vi.fn>;
let openOptionsPage: ReturnType<typeof vi.fn>;
let clipboardWrite: ReturnType<typeof vi.fn>;

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
          { id: "b9", title: "Payload", url: "javascript:alert(1)" },
        ],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
    ],
    otherBookmarks: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
  });
  tabsCreate = vi.fn().mockResolvedValue({ id: 42 });
  tabsUpdate = vi.fn().mockResolvedValue({ id: 42 });
  openOptionsPage = vi.fn();
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    tabs: { create: tabsCreate, update: tabsUpdate },
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      openOptionsPage,
    },
  });
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
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

async function openPalette(): Promise<HTMLElement> {
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  await screen.findByRole("dialog");
  return screen.getByRole("combobox", { name: "Command palette" });
}

function paletteList(): HTMLElement {
  return screen.getByRole("listbox", { name: "Palette results" });
}

/** Radix dropdown triggers open on pointerdown; jsdom needs both events. */
function openActions(optionEl: HTMLElement, name: RegExp): void {
  const btn = within(optionEl).getByRole("button", {
    name: new RegExp(`Actions for ${name.source}`),
  });
  fireEvent.pointerDown(btn, { button: 0, ctrlKey: false });
  fireEvent.click(btn);
}

/** Navigate the flat item list to the option whose text matches. */
async function highlight(
  el: HTMLElement,
  name: RegExp,
): Promise<HTMLElement> {
  for (let i = 0; i < 30; i++) {
    const activeId = el.getAttribute("aria-activedescendant");
    const activeEl = activeId === null ? null : document.getElementById(activeId);
    if (activeEl !== null && name.test(activeEl.textContent ?? "")) {
      return activeEl;
    }
    fireEvent.keyDown(el, { key: "ArrowDown" });
  }
  throw new Error(`no palette option matching ${String(name)}`);
}

describe("palette commands", () => {
  it("lists all commands and narrows them by query", async () => {
    await renderApp();
    const el = await openPalette();
    const list = paletteList();
    for (const label of [
      "Import",
      "Export",
      "Manage tags",
      "New folder",
      "Undo last action",
      "Open options",
    ]) {
      expect(
        within(list).getByRole("option", { name: new RegExp(label) }),
      ).toBeTruthy();
    }

    fireEvent.change(el, { target: { value: "import" } });
    await waitFor(() => {
      const names = within(paletteList())
        .getAllByRole("option")
        .map((o) => o.textContent ?? "");
      expect(names).toEqual([expect.stringContaining("Import")]);
    });
  });

  it("dispatches Import, Tag manager, and New folder to their dialogs", async () => {
    await renderApp();
    let el = await openPalette();

    // Import
    await highlight(el, /Import/);
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Import bookmarks" }),
      ).toBeTruthy(),
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Import bookmarks" }),
      ).toBeNull(),
    );

    // Tag manager
    el = await openPalette();
    await highlight(el, /Manage tags/);
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Manage tags" }),
      ).toBeTruthy(),
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Manage tags" }),
      ).toBeNull(),
    );

    // New folder → the folder dialog opens against a parent.
    el = await openPalette();
    await highlight(el, /New folder/);
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /New folder inside/ }),
      ).toBeTruthy(),
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
  });

  it("opens the Options page from the header Settings button", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it("runs Export and Options without a dialog trace left open", async () => {
    await renderApp();
    const el = await openPalette();

    await highlight(el, /Open options/);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(openOptionsPage).toHaveBeenCalled();

    const el2 = await openPalette();
    await highlight(el2, /Export/);
    fireEvent.keyDown(el2, { key: "Enter" });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Export/ }),
      ).toBeTruthy(),
    );
  });

  it("runs Undo through the toast controller", async () => {
    await renderApp();
    // Seed an undoable action: delete a row from the result list.
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Bookmarks" })).getByRole(
        "option",
        { name: /Gamma/ },
      ),
    );
    fireEvent.click(
      within(
        await screen.findByRole("toolbar", { name: "Selection actions" }),
      ).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("undo-toast")).toBeTruthy(),
    );

    const el = await openPalette();
    await highlight(el, /Undo last action/);
    fireEvent.keyDown(el, { key: "Enter" });
    // Gamma is restored to the library.
    await waitFor(() =>
      expect(
        within(screen.getByRole("listbox", { name: "Bookmarks" }))
          .queryByRole("option", { name: /Gamma/ }),
      ).toBeTruthy(),
    );
  });
});

describe("palette bookmark actions", () => {
  it("Enter opens the foreground tab; Ctrl/Cmd+Enter opens background", async () => {
    await renderApp();
    let el = await openPalette();
    fireEvent.change(el, { target: { value: "gamma" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Gamma/ }),
      ).toBeTruthy(),
    );

    await highlight(el, /Gamma/);
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() =>
      expect(tabsCreate).toHaveBeenCalledWith({
        url: "https://g.example/",
        active: true,
      }),
    );

    el = await openPalette();
    fireEvent.change(el, { target: { value: "delta" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Delta/ }),
      ).toBeTruthy(),
    );
    await highlight(el, /Delta/);
    fireEvent.keyDown(el, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(tabsCreate).toHaveBeenCalledWith({
        url: "https://d.example/",
        active: false,
      }),
    );
  });

  it("actions menu reveals a result in its folder", async () => {
    await renderApp();
    const el = await openPalette();
    fireEvent.change(el, { target: { value: "alpha" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Alpha/ }),
      ).toBeTruthy(),
    );

    const hit = await highlight(el, /Alpha/);
    openActions(hit, /Alpha/);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Reveal in folder" }),
    );

    // Dialog closes, view switches to Dev, and the row is selected.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Dev" }),
      ).toBeTruthy(),
    );
    await waitFor(() => {
      const row = within(
        screen.getByRole("listbox", { name: "Bookmarks" }),
      ).getByRole("option", { name: /Alpha/ });
      expect(row.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("Edit opens the bookmark editor", async () => {
    await renderApp();
    const el = await openPalette();
    fireEvent.change(el, { target: { value: "alpha" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Alpha/ }),
      ).toBeTruthy(),
    );

    const hit = await highlight(el, /Alpha/);
    openActions(hit, /Alpha/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit…" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Edit bookmark" }),
      ).toBeTruthy(),
    );
  });

  it("Copy URL writes to the clipboard and toasts; failure toasts an error", async () => {
    await renderApp();
    const el = await openPalette();
    fireEvent.change(el, { target: { value: "alpha" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Alpha/ }),
      ).toBeTruthy(),
    );

    let hit = await highlight(el, /Alpha/);
    openActions(hit, /Alpha/);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy URL" }),
    );
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith("https://a.example/1"),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("undo-toast").textContent,
      ).toContain("Copied"),
    );

    // Rejecting clipboard → error toast.
    clipboardWrite.mockRejectedValueOnce(new Error("denied"));
    const el2 = await openPalette();
    fireEvent.change(el2, { target: { value: "alpha" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Alpha/ }),
      ).toBeTruthy(),
    );
    hit = await highlight(el2, /Alpha/);
    openActions(hit, /Alpha/);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy URL" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("undo-toast").textContent,
      ).toContain("denied"),
    );
  });

  it("offers no open actions for a javascript: URL and Enter is a no-op", async () => {
    await renderApp();
    const el = await openPalette();
    fireEvent.change(el, { target: { value: "payload" } });
    await waitFor(() =>
      expect(
        within(paletteList()).getByRole("option", { name: /Payload/ }),
      ).toBeTruthy(),
    );

    const hit = await highlight(el, /Payload/);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(tabsCreate).not.toHaveBeenCalled();

    openActions(hit, /Payload/);
    expect(screen.queryByRole("menuitem", { name: /^Open/ })).toBeNull();
    // Reveal/Edit/Copy still offered.
    expect(
      screen.getByRole("menuitem", { name: "Reveal in folder" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Copy URL" }),
    ).toBeTruthy();
  });
});
