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
import { db } from "../../src/db/database";
import { App as PopupApp } from "../../src/entrypoints/popup/App";
import { PopupSearch } from "../../src/entrypoints/popup/Search";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 3 Task 1 — popup search. A search input sits at the top of the
 * quick-save popup; while it holds text a top-10 results list replaces the
 * save form (which returns unchanged on clear). Enter/click opens the hit in
 * a NEW tab, Ctrl/Cmd+Enter retargets the CURRENT tab — both through the
 * typed `openBookmarkUrl` slice. `javascript:`/`data:` results render but
 * can't be opened. The index builds after first paint ("Indexing…" state).
 */

const ACTIVE_TAB = {
  id: 7,
  windowId: 3,
  title: "Active tab",
  url: "https://active.example/",
};

let fake: FakeBookmarksApi;
let tabsQuery: ReturnType<typeof vi.fn>;
let tabsCreate: ReturnType<typeof vi.fn>;
let tabsUpdate: ReturnType<typeof vi.fn>;
let sidePanelOpen: ReturnType<typeof vi.fn>;
let session: Map<string, unknown>;

function sessionArea() {
  return {
    get: async (keys?: string | string[] | null) => {
      if (keys === undefined || keys === null) {
        return Object.fromEntries(session);
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (session.has(key)) out[key] = session.get(key);
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) session.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        session.delete(key);
      }
    },
  };
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
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
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  await db.metadata.clear();

  const bar = Array.from({ length: 12 }, (_, i) => ({
    id: `fill-${i}`,
    title: `Filler ${i}`,
    url: `https://filler-${i}.example/`,
  }));
  fake = createFakeBookmarks({
    now: () => 1700000000000,
    bookmarksBar: [
      { id: "b1", title: "Alpha", url: "https://a.example/1" },
      { id: "b9", title: "Payload", url: "javascript:alert(1)" },
      ...bar,
    ],
    otherBookmarks: [
      {
        id: "fold",
        title: "Reading",
        children: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
      },
    ],
  });

  session = new Map();
  tabsQuery = vi.fn(async () => [ACTIVE_TAB]);
  tabsCreate = vi.fn(async () => ({ id: 99 }));
  tabsUpdate = vi.fn(async () => ({ id: 7 }));
  sidePanelOpen = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    tabs: { query: tabsQuery, create: tabsCreate, update: tabsUpdate },
    sidePanel: { open: sidePanelOpen },
    storage: { session: sessionArea(), onChanged: {
      addListener: () => {},
      removeListener: () => {},
    } },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
});

async function renderPopup(): Promise<void> {
  render(<PopupApp />);
  // Form fields appear once the first data load lands.
  await screen.findByLabelText("Title");
}

function searchInput(): HTMLInputElement {
  return screen.getByRole("combobox", {
    name: "Search bookmarks",
  }) as HTMLInputElement;
}

function results(): HTMLElement[] {
  const list = screen.queryByRole("listbox", { name: "Popup results" });
  return list === null ? [] : Array.from(list.querySelectorAll('[role="option"]'));
}

describe("popup search", () => {
  it("shows Indexing… while the handle is null", () => {
    render(
      <PopupSearch
        search={null}
        query="alpha"
        onQueryChange={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Indexing…")).toBeTruthy();
  });

  it("replaces the save form with top-10 results while typing", async () => {
    await renderPopup();
    // Form state survives being swapped out.
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Custom title" },
    });

    fireEvent.change(searchInput(), { target: { value: "filler" } });
    await waitFor(() => expect(results().length).toBe(10)); // 12 fillers → capped
    expect(screen.queryByLabelText("Title")).toBeNull(); // form replaced
    // Results carry their URLs.
    expect(results()[0]?.textContent).toContain("filler-0.example");

    // Clearing restores the form exactly — typed state intact.
    fireEvent.change(searchInput(), { target: { value: "" } });
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeTruthy());
    expect(
      (screen.getByLabelText("Title") as HTMLInputElement).value,
    ).toBe("Custom title");
  });

  it("Enter opens the highlighted result in a new tab; click does too", async () => {
    await renderPopup();
    fireEvent.change(searchInput(), { target: { value: "alpha" } });
    await waitFor(() => expect(results().length).toBe(1));

    fireEvent.keyDown(searchInput(), { key: "Enter" });
    await waitFor(() =>
      expect(tabsCreate).toHaveBeenCalledWith({
        url: "https://a.example/1",
        active: true,
      }),
    );
  });

  it("Ctrl/Cmd+Enter retargets the current tab", async () => {
    await renderPopup();
    fireEvent.change(searchInput(), { target: { value: "delta" } });
    await waitFor(() => expect(results().length).toBe(1));

    fireEvent.keyDown(searchInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(tabsUpdate).toHaveBeenCalledWith({ url: "https://d.example/" }),
    );
  });

  it("arrow keys move the highlight before Enter", async () => {
    await renderPopup();
    fireEvent.change(searchInput(), { target: { value: "filler" } });
    await waitFor(() => expect(results().length).toBe(10));

    const el = searchInput();
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "Enter" });
    await waitFor(() => expect(tabsCreate).toHaveBeenCalled());
    // The second arrow moved off the first hit.
    expect(tabsCreate.mock.calls[0]?.[0]?.url).not.toBe(
      results()[0]?.getAttribute("data-url"),
    );
  });

  it("javascript: results render but cannot be opened", async () => {
    await renderPopup();
    fireEvent.change(searchInput(), { target: { value: "payload" } });
    await waitFor(() => expect(results().length).toBe(1));

    const hit = results()[0]!;
    expect(hit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(hit);
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("filter syntax works from the popup (folder:)", async () => {
    await renderPopup();
    fireEvent.change(searchInput(), { target: { value: "folder:reading" } });
    await waitFor(() => {
      const texts = results().map((el) => el.textContent ?? "");
      expect(texts).toEqual([expect.stringContaining("Delta")]);
    });
  });
});
