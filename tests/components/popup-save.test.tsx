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
import { getMeta, getTag } from "../../src/db/meta";
import { App as PopupApp } from "../../src/entrypoints/popup/App";
import { PENDING_EDIT_KEY } from "../../src/entrypoints/popup/chrome";
import { App as SidePanelApp } from "../../src/entrypoints/sidepanel/App";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 5 Task 1 — popup quick save.
 *
 * Layers under test:
 *  - `PopupApp`      prefilled title/URL from the ACTIVE TAB (`chrome.tabs.query`
 *                    behind the `activeTab` permission), folder picker defaulted
 *                    to the last-used folder (Dexie `metadata` row
 *                    `prefs:lastFolderId`), tag chips (defs created on demand
 *                    through tag-ops), `CategorySelect`, notes → `createBookmark`
 *                    + `patchMeta`; a normalized-URL duplicate notice
 *                    ("Already saved in <folder>") with an "Edit that bookmark"
 *                    handoff; and an "Open manager" action that opens the side
 *                    panel (`chrome.sidePanel.open`).
 *  - `SidePanelApp`  the additive half of the handoff: on mount/first tree load
 *                    it reads `chrome.storage.session` and opens `EditDialog`
 *                    for the stashed id.
 *
 * `chrome.bookmarks` is the in-memory fake; IndexedDB is fake-indexeddb; the
 * `tabs`/`sidePanel`/`storage.session` surfaces are minimal in-test stubs (the
 * production slices resolve them lazily, see `src/entrypoints/popup/chrome.ts`).
 * No network.
 */

const FIXED_NOW = 1_700_000_000_000;
const ACTIVE_TAB = {
  id: 11,
  windowId: 7,
  title: "Example Page",
  url: "https://example.com/page",
};

let fake: FakeBookmarksApi;
/** In-memory `chrome.storage.session` backing store. */
let session: Map<string, unknown>;
let tabsQuery: ReturnType<typeof vi.fn>;
let sidePanelOpen: ReturnType<typeof vi.fn>;

function sessionArea(): {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
} {
  return {
    get: async (keys) => {
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
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) session.set(key, value);
    },
    remove: async (keys) => {
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

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  await db.metadata.clear();

  fake = createFakeBookmarks({
    now: () => FIXED_NOW,
    bookmarksBar: [{ id: "bar1", title: "Bar One", url: "https://bar.example/" }],
    otherBookmarks: [
      { id: "fold", title: "Reading", children: [] },
      {
        id: "dup",
        title: "Existing",
        // Normalizes to the same key as ACTIVE_TAB.url (`utm_source` dropped).
        url: "https://example.com/page?utm_source=newsletter",
      },
    ],
  });

  session = new Map();
  tabsQuery = vi.fn(async () => [ACTIVE_TAB]);
  sidePanelOpen = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    tabs: { query: tabsQuery },
    sidePanel: { open: sidePanelOpen },
    storage: { session: sessionArea() },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
  stubElementRects();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreElementRects();
});

afterAll(() => {
  db.close();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

/** Wait for the popup's initial load (active tab + tree + pref) to settle. */
async function renderPopup(): Promise<void> {
  render(<PopupApp />);
  await waitFor(() =>
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      ACTIVE_TAB.title,
    ),
  );
}

function titleInput(): HTMLInputElement {
  return screen.getByLabelText("Title") as HTMLInputElement;
}

function urlInput(): HTMLInputElement {
  return screen.getByLabelText("URL") as HTMLInputElement;
}

function folderSelect(): HTMLSelectElement {
  return screen.getByLabelText("Folder") as HTMLSelectElement;
}

// ---------------------------------------------------------------------------
// Prefill + folder default
// ---------------------------------------------------------------------------

describe("PopupApp — prefill and folder default", () => {
  it("prefills the title and URL from the active tab", async () => {
    await renderPopup();
    expect(titleInput().value).toBe("Example Page");
    expect(urlInput().value).toBe("https://example.com/page");
    expect(tabsQuery).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
  });

  it("defaults the folder picker to Other bookmarks with no stored pref", async () => {
    await renderPopup();
    expect(folderSelect().value).toBe("2");
  });

  it("defaults the folder picker to the last used folder", async () => {
    await db.metadata.put({ key: "prefs:lastFolderId", value: "fold" });
    await renderPopup();
    expect(folderSelect().value).toBe("fold");
  });

  it("falls back to Other bookmarks when the stored folder is gone", async () => {
    await db.metadata.put({ key: "prefs:lastFolderId", value: "missing" });
    await renderPopup();
    expect(folderSelect().value).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

describe("PopupApp — save", () => {
  it("creates the bookmark with tags, category and notes and remembers the folder", async () => {
    await renderPopup();

    fireEvent.change(folderSelect(), { target: { value: "fold" } });
    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "Urgent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(screen.getByText("Urgent")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "docs" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "read later" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByTestId("save-confirmation");
    const children = await fake.getChildren("fold");
    const created = children.find((node) => node.url === ACTIVE_TAB.url);
    expect(created).toBeDefined();
    if (created === undefined) return;
    expect(created.title).toBe("Example Page");

    expect(await getMeta(created.id)).toMatchObject({
      tags: ["urgent"],
      category: "docs",
      notes: "read later",
    });
    // The tag definition was created on demand through tag-ops.
    expect(await getTag("urgent")).toBeDefined();
    // The chosen folder becomes the last-used default.
    expect((await db.metadata.get("prefs:lastFolderId"))?.value).toBe("fold");
  });

  it("saves into Other bookmarks without any metadata", async () => {
    await renderPopup();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByTestId("save-confirmation");
    const children = await fake.getChildren("2");
    expect(children.some((node) => node.url === ACTIVE_TAB.url)).toBe(true);
    const created = children.find((node) => node.url === ACTIVE_TAB.url);
    expect(await getMeta(created?.id ?? "")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Duplicate notice + handoff
// ---------------------------------------------------------------------------

describe("PopupApp — duplicate notice and handoff", () => {
  it('shows "Already saved in <folder>" when the normalized URL exists', async () => {
    await renderPopup();
    const notice = await screen.findByTestId("duplicate-notice");
    expect(notice.textContent).toContain("Already saved in Other bookmarks");
  });

  it("hands the existing bookmark to the side panel for editing", async () => {
    await renderPopup();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit that bookmark" }),
    );

    await waitFor(() =>
      expect(session.get(PENDING_EDIT_KEY)).toBe("dup"),
    );
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 });
  });

  it("does not show the duplicate notice for a novel URL", async () => {
    tabsQuery.mockResolvedValue([
      { id: 12, windowId: 7, title: "New", url: "https://brand-new.example/x" },
    ]);
    render(<PopupApp />);
    await waitFor(() =>
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
        "New",
      ),
    );
    expect(screen.queryByTestId("duplicate-notice")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Open manager
// ---------------------------------------------------------------------------

describe("PopupApp — open manager", () => {
  it("opens the side panel for the active tab's window", async () => {
    await renderPopup();
    fireEvent.click(screen.getByRole("button", { name: "Open manager" }));
    await waitFor(() =>
      expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Render budget
// ---------------------------------------------------------------------------

describe("PopupApp — render budget", () => {
  it("becomes interactive well under the 150 ms popup budget", async () => {
    // Measurement: wall-clock from just before a render to the moment the form
    // is interactive — the title prefilled from the active tab, i.e. the
    // `tabs.query` + `getTree` + last-folder reads have settled and React has
    // committed the filled form. `waitFor` polls at 1 ms so the number tracks
    // the component's own work rather than the poll granularity.
    //
    // One unmounted warm-up render runs first: the FIRST render in a vitest
    // process pays a one-time module/JIT cost (observed ~150 ms cold vs. a few
    // ms warm) that has nothing to do with the popup's work and would make the
    // assertion environment-dependent. Excluding it keeps the budget honest
    // and non-flaky; the steady-state value observed here is 20–30 ms, so the
    // 150 ms budget keeps >4x headroom.
    const warmup = render(<PopupApp />);
    await waitFor(
      () =>
        expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
          ACTIVE_TAB.title,
        ),
      { interval: 1 },
    );
    warmup.unmount();

    const start = performance.now();
    render(<PopupApp />);
    await waitFor(
      () =>
        expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
          ACTIVE_TAB.title,
        ),
      { interval: 1 },
    );
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(150);
  });
});

// ---------------------------------------------------------------------------
// Side-panel handoff consumption
// ---------------------------------------------------------------------------

/**
 * jsdom reports 0 for every element's offsetHeight/offsetWidth, which makes
 * @tanstack/react-virtual render nothing. The scroll container
 * (data-testid="bookmark-scroll") gets a fixed rect so rows mount.
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

describe("SidePanelApp — pending edit handoff", () => {
  it("opens EditDialog for the id left in chrome.storage.session", async () => {
    session.set(PENDING_EDIT_KEY, "bar1");
    render(<SidePanelApp />);

    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value)
      .toBe("Bar One");
    // Consumed once — the key is cleared so a later mount does not re-open it.
    await waitFor(() => expect(session.has(PENDING_EDIT_KEY)).toBe(false));
  });
});
