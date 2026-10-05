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
import { getMeta, getTag } from "../../src/db/meta";
import { App as PopupApp } from "../../src/entrypoints/popup/App";
import {
  PENDING_EDIT_KEY,
  setPendingEditId,
} from "../../src/entrypoints/popup/chrome";
import { App as SidePanelApp } from "../../src/entrypoints/sidepanel/App";
import { handleSaveMessage } from "../../src/messages/save";
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
 *  - `SidePanelApp`  the additive half of the handoff: it reads
 *                    `chrome.storage.session` on the first tree load AND
 *                    subscribes to `chrome.storage.onChanged`, so a handoff
 *                    that arrives while the panel is already open still opens
 *                    `EditDialog`.
 *
 * `chrome.bookmarks` is the in-memory fake; IndexedDB is fake-indexeddb; the
 * `tabs`/`sidePanel`/`storage.session`/`storage.onChanged` surfaces are minimal
 * in-test stubs (the production slices resolve them lazily, see
 * `src/entrypoints/popup/chrome.ts`). The session stub emits `onChanged` for
 * every write/removal, mirroring Chrome. No network.
 */

const FIXED_NOW = 1_700_000_000_000;
const ACTIVE_TAB = {
  id: 11,
  windowId: 7,
  title: "Example Page",
  url: "https://example.com/page",
};
/** A URL the fake tree does NOT already contain. */
const FRESH_TAB = {
  id: 12,
  windowId: 7,
  title: "Fresh Page",
  url: "https://fresh.example/page",
};

let fake: FakeBookmarksApi;
/** In-memory `chrome.storage.session` backing store. */
let session: Map<string, unknown>;
/** Listeners registered on the stubbed `chrome.storage.onChanged`. */
let storageListeners: ((
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void)[];
let tabsQuery: ReturnType<typeof vi.fn>;
let sidePanelOpen: ReturnType<typeof vi.fn>;
let openOptionsPage: ReturnType<typeof vi.fn>;
/**
 * The popup's `SAVE` send is routed to the REAL `handleSaveMessage` — the
 * same Dexie/bookmarks surfaces the worker would use — with a trusted
 * extension sender url (matches the `chrome.runtime.getURL` stub's prefix).
 */
let sendMessage: ReturnType<typeof vi.fn>;

/** Emit one `chrome.storage.onChanged` event, as Chrome does after a write. */
function emitStorageChange(
  key: string,
  oldValue: unknown,
  newValue: unknown,
): void {
  for (const listener of [...storageListeners]) {
    listener({ [key]: { oldValue, newValue } }, "session");
  }
}

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
      for (const [key, value] of Object.entries(items)) {
        const oldValue = session.get(key);
        session.set(key, value);
        emitStorageChange(key, oldValue, value);
      }
    },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const oldValue = session.get(key);
        session.delete(key);
        emitStorageChange(key, oldValue, undefined);
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
  storageListeners = [];
  tabsQuery = vi.fn(async () => [ACTIVE_TAB]);
  sidePanelOpen = vi.fn(async () => undefined);
  openOptionsPage = vi.fn();
  sendMessage = vi.fn(async (message: unknown) =>
    handleSaveMessage(message, {
      url: "chrome-extension://test/popup.html",
    }),
  );
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    tabs: { query: tabsQuery },
    sidePanel: { open: sidePanelOpen },
    storage: {
      session: sessionArea(),
      onChanged: {
        addListener: (
          callback: (
            changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
            areaName: string,
          ) => void,
        ) => {
          storageListeners.push(callback);
        },
        removeListener: (
          callback: (
            changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
            areaName: string,
          ) => void,
        ) => {
          const index = storageListeners.indexOf(callback);
          if (index >= 0) storageListeners.splice(index, 1);
        },
      },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      openOptionsPage,
      sendMessage,
    },
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

  it("refuses a blocked-scheme URL and writes nothing", async () => {
    await renderPopup();
    fireEvent.change(urlInput(), {
      target: { value: "  javascript:alert(1)  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "This URL scheme cannot be saved as a bookmark.",
    );
    const all = await fake.getTree();
    expect(JSON.stringify(all)).not.toContain("javascript:alert(1)");
    expect(screen.queryByTestId("save-confirmation")).toBeNull();
  });

  it("keeps Save disabled for a blank URL", async () => {
    await renderPopup();
    fireEvent.change(urlInput(), { target: { value: "   " } });
    const save = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Task 1: the disabled state must read as disabled — dimmed,
    // desaturated, not-allowed cursor — not a normal-looking button.
    expect(save.className).toContain("disabled:cursor-not-allowed");
    expect(save.className).toContain("disabled:saturate-50");
    expect(save.className).not.toContain("pointer-events-none");
  });

  it("unwinds the created bookmark when the meta write fails", async () => {
    await renderPopupForFreshTab();
    // Stage a chip so commitMeta takes the put path (non-empty row), then
    // sabotage that write: the save must leave no half-saved bookmark.
    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "Urgent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    const putSpy = vi
      .spyOn(db.bookmarkMeta, "put")
      .mockRejectedValue(new Error("storage gone"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    // The worker redacts a code-less throw — the alert carries the safe
    // protocol message, not the raw error string.
    expect(alert.textContent).toContain("nothing was written");
    const children = await fake.getChildren("2");
    expect(
      children.filter((node) => node.url === FRESH_TAB.url),
    ).toHaveLength(0);
    expect(await getMeta("1000")).toBeUndefined();
    // The resolved tag def stays — it is not tree state and costs nothing.
    expect(await getTag("urgent")).toBeDefined();
    putSpy.mockRestore();
  });
});

describe("PopupApp — worker-side save (U06)", () => {
  it("completes the save even when the popup is destroyed right after send", async () => {
    await renderPopupForFreshTab();
    // Stage a tag so the meta write is observable (an all-empty patch is
    // legitimately absent under the lazy-row rule).
    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "Urgent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    // Slow the create so the bookmark+meta writes are observably in flight
    // when the popup unmounts — the whole sequence now lives worker-side.
    const origCreate = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation(async (node) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return origCreate(node);
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    // The popup context is destroyed (popup closed) mid-flight.
    cleanup();

    await waitFor(async () => {
      const children = await fake.getChildren("2");
      const created = children.find((node) => node.url === FRESH_TAB.url);
      expect(created).toBeDefined();
      if (created === undefined) return;
      // Meta landed too — no half-saved bookmark behind a dead context.
      await expect(getMeta(created.id)).resolves.toMatchObject({
        tags: ["urgent"],
        url: FRESH_TAB.url,
      });
    });
    expect((await db.metadata.get("prefs:lastFolderId"))?.value).toBe("2");
  });

  it("surfaces a worker failure reply as the form error", async () => {
    await renderPopupForFreshTab();
    sendMessage.mockResolvedValueOnce({
      ok: false,
      code: "blocked_scheme",
      message: "worker refused the scheme",
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("worker refused the scheme");
    expect(screen.queryByTestId("save-confirmation")).toBeNull();
  });

  it("surfaces a rejected sendMessage and a malformed reply", async () => {
    await renderPopupForFreshTab();
    sendMessage.mockRejectedValueOnce(new Error("channel gone"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "channel gone",
    );

    sendMessage.mockResolvedValueOnce({ ok: "maybe" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "did not return a usable answer",
      ),
    );
  });

  it("surfaces an openSidePanel failure on Open manager", async () => {
    await renderPopup();
    sidePanelOpen.mockRejectedValueOnce(new Error("no gesture"));
    fireEvent.click(screen.getByRole("button", { name: "Open manager" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not open the manager panel");
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
// Duplicate discipline (review fix P5-FIX #5)
// ---------------------------------------------------------------------------

/** Render the popup against a URL the fake tree does not contain yet. */
async function renderPopupForFreshTab(): Promise<void> {
  tabsQuery.mockResolvedValue([FRESH_TAB]);
  render(<PopupApp />);
  await waitFor(() =>
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      FRESH_TAB.title,
    ),
  );
}

describe("PopupApp — duplicate discipline", () => {
  it("ignores a second submit while the first save is in flight", async () => {
    await renderPopupForFreshTab();
    const form = screen
      .getByRole("button", { name: "Save" })
      .closest("form");
    if (form === null) throw new Error("the Save button is not in a form");

    // Two submits dispatched in the same task: a `busy`-state check alone
    // would let both through and create two bookmarks.
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByTestId("save-confirmation");
    const children = await fake.getChildren("2");
    expect(children.filter((node) => node.url === FRESH_TAB.url)).toHaveLength(
      1,
    );
  });

  it("recognises the just-saved bookmark as a duplicate", async () => {
    await renderPopupForFreshTab();
    expect(screen.queryByTestId("duplicate-notice")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("save-confirmation");

    // The tree snapshot was refreshed, so the popup recognises what it just
    // wrote: the success state replaces the duplicate warning (which would
    // read as an error right after a save) and offers "Edit that bookmark".
    expect(screen.queryByTestId("duplicate-notice")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit that bookmark" }),
    );
    await waitFor(() => expect(session.get(PENDING_EDIT_KEY)).toBeDefined());
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 });
  });

  it("locks the form and drops Save once the bookmark is saved", async () => {
    await renderPopupForFreshTab();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("save-confirmation");

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(titleInput().disabled).toBe(true);
  });

  it("saves with Ctrl+Enter from anywhere in the form", async () => {
    await renderPopupForFreshTab();
    fireEvent.keyDown(titleInput(), { key: "Enter", ctrlKey: true });
    await screen.findByTestId("save-confirmation");
    const children = await fake.getChildren("2");
    expect(children.filter((node) => node.url === FRESH_TAB.url)).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Open manager
// ---------------------------------------------------------------------------

describe("PopupApp — URL placement", () => {
  it("keeps the URL inside Details when the tab has a URL", async () => {
    await renderPopup();
    expect(urlInput().closest("#popup-details")).not.toBeNull();
  });

  it("puts the URL in the page card when the tab has none, and gates Save on it", async () => {
    tabsQuery.mockResolvedValue([{ id: 13, windowId: 7 }]);
    render(<PopupApp />);
    await screen.findByLabelText("Title");

    // Not tucked away in the collapsed panel — it is the field to fill.
    expect(urlInput().closest("#popup-details")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(urlInput(), {
      target: { value: "https://typed.example/page" },
    });
    // Typing must not move the input (it would lose focus mid-keystroke).
    expect(urlInput().closest("#popup-details")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("PopupApp — open manager", () => {
  it("opens the side panel for the active tab's window", async () => {
    await renderPopup();
    fireEvent.click(screen.getByRole("button", { name: "Open manager" }));
    await waitFor(() =>
      expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 }),
    );
  });

  it("opens the Options page from the Settings button", async () => {
    await renderPopup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
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

  it("opens EditDialog when the id arrives while the panel is already open", async () => {
    render(<SidePanelApp />);
    await screen.findByRole("treeitem", { name: "Other bookmarks" });
    // Nothing pending, no dialog, and the tree will not change again.
    expect(screen.queryByRole("dialog")).toBeNull();

    // Exactly what the popup's "Edit that bookmark" does. `act` wraps the
    // storage write because the stub emits `onChanged` synchronously.
    await act(async () => {
      await setPendingEditId("bar1");
    });

    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value)
      .toBe("Bar One");
    await waitFor(() => expect(session.has(PENDING_EDIT_KEY)).toBe(false));
  });

  it("clears a stale pending id whose bookmark no longer exists", async () => {
    session.set(PENDING_EDIT_KEY, "deleted-bookmark");
    render(<SidePanelApp />);

    await screen.findByRole("treeitem", { name: "Other bookmarks" });
    // Read → cleared unconditionally, even though nothing resolves for it.
    await waitFor(() => expect(session.has(PENDING_EDIT_KEY)).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
