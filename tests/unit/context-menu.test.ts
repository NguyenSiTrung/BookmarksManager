import "fake-indexeddb/auto";
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
import { OTHER_BOOKMARKS_ID } from "../../src/sync/chrome-bookmarks";
import {
  BADGE_CLEAR_DELAY_MS,
  BADGE_CONFIRM_TEXT,
  BADGE_ERROR_TEXT,
  CONTEXT_MENU_ITEMS,
  INCOGNITO_SKIP_MESSAGE,
  SAVE_LINK_MENU_ID,
  SAVE_PAGE_MENU_ID,
  handleContextMenuClick,
  registerContextMenus,
} from "../../src/sync/context-menu";
import { LAST_FOLDER_KEY } from "../../src/sync/last-folder";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type {
  FakeBookmarksApi,
  FakeBookmarksOptions,
} from "../fakes/chrome-bookmarks";

/**
 * Phase 5 Task 3 — context-menu save.
 *
 * The production slice lives in `src/sync/context-menu.ts` and resolves
 * `chrome.contextMenus` / `chrome.action` lazily (house pattern), so tests
 * compose a `chrome` stub from the in-memory bookmarks fake, a context-menus
 * recorder, and a badge spy. `last-folder` storage is Dexie (`metadata`),
 * backed by fake-indexeddb.
 *
 * Covered: the exact create() shapes, removeAll-before-create ordering,
 * idempotent registration, click → save into the last-used folder, the
 * stale-pref fallback (and pref rewrite), the Save-link path, the badge
 * set→clear sequence, the incognito skip policy, and zero network.
 */

interface MenuItemProps {
  id?: string;
  title?: string;
  contexts?: string[];
}

type MenuListener = (info: unknown, tab?: unknown) => void;

/** Recorder for `chrome.contextMenus` plus an emittable `onClicked` event. */
function createFakeContextMenus() {
  const created: MenuItemProps[] = [];
  const listeners = new Set<MenuListener>();
  const create = vi.fn(
    (props: MenuItemProps, callback?: () => void): string => {
      created.push(props);
      callback?.();
      return props.id ?? "";
    },
  );
  const removeAll = vi.fn((callback?: () => void): void => {
    created.length = 0;
    callback?.();
  });
  const addListener = vi.fn((listener: MenuListener): void => {
    listeners.add(listener);
  });
  const removeListener = vi.fn((listener: MenuListener): void => {
    listeners.delete(listener);
  });
  const hasListener = vi.fn(
    (listener: MenuListener): boolean => listeners.has(listener),
  );
  return {
    created,
    create,
    removeAll,
    onClicked: { addListener, removeListener, hasListener },
    emit(info: unknown, tab?: unknown): void {
      for (const listener of [...listeners]) listener(info, tab);
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

type FakeContextMenus = ReturnType<typeof createFakeContextMenus>;

let fake: FakeBookmarksApi;
let menus: FakeContextMenus;
let setBadgeText: ReturnType<typeof vi.fn>;

function installChrome(options: { seed?: FakeBookmarksOptions } = {}): void {
  fake = createFakeBookmarks(
    options.seed ?? {
      bookmarksBar: [{ id: "bar", title: "Bar", url: "https://bar.example/" }],
      otherBookmarks: [{ id: "fold", title: "Reading", children: [] }],
    },
  );
  menus = createFakeContextMenus();
  setBadgeText = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    contextMenus: menus,
    action: { setBadgeText },
    runtime: { sendMessage: vi.fn(async () => undefined) },
  });
}

const PAGE_CLICK = {
  menuItemId: SAVE_PAGE_MENU_ID,
  pageUrl: "https://page.example/article",
};
const PAGE_TAB = { title: "Article", url: PAGE_CLICK.pageUrl, incognito: false };

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.metadata.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerContextMenus", () => {
  it("creates both items with the exact id/title/contexts shapes", () => {
    installChrome();
    registerContextMenus();

    expect(menus.removeAll).toHaveBeenCalledTimes(1);
    expect(menus.created).toEqual([
      {
        id: "save-page",
        title: "Save page to Bookmarks Manager",
        contexts: ["page"],
      },
      {
        id: "save-link",
        title: "Save link to Bookmarks Manager",
        contexts: ["link"],
      },
    ]);
    expect(CONTEXT_MENU_ITEMS).toEqual(menus.created);
  });

  it("removes existing items before creating, so restarts never duplicate", () => {
    installChrome();
    registerContextMenus();

    const removeOrder = menus.removeAll.mock.invocationCallOrder[0] ?? 0;
    const firstCreateOrder = menus.create.mock.invocationCallOrder[0] ?? 0;
    expect(removeOrder).toBeLessThan(firstCreateOrder);
  });

  it("is idempotent for the same contextMenus instance", () => {
    installChrome();
    registerContextMenus();
    registerContextMenus();

    expect(menus.removeAll).toHaveBeenCalledTimes(1);
    expect(menus.create).toHaveBeenCalledTimes(2);
    expect(menus.listenerCount()).toBe(1);
  });

  it("re-registers on a fresh contextMenus instance", () => {
    installChrome();
    registerContextMenus();
    const firstMenus = menus;

    installChrome();
    registerContextMenus();

    expect(menus.removeAll).toHaveBeenCalledTimes(1);
    expect(firstMenus.removeAll).toHaveBeenCalledTimes(1);
  });

  it("clears a stale badge left by an evicted worker at registration", async () => {
    installChrome();
    registerContextMenus();

    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenCalledWith({ text: "" }),
    );
  });

  it("detaches the click listener on unsubscribe", () => {
    installChrome();
    const off = registerContextMenus();
    expect(menus.listenerCount()).toBe(1);
    off();
    expect(menus.listenerCount()).toBe(0);
  });

  it("is a no-op when chrome has no contextMenus surface", () => {
    vi.stubGlobal("chrome", { bookmarks: createFakeBookmarks() });
    expect(() => registerContextMenus()).not.toThrow();
    expect(registerContextMenus()()).toBeUndefined();
  });

  it("is a no-op when no chrome global exists at all", () => {
    expect(() => registerContextMenus()).not.toThrow();
    expect(registerContextMenus()()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Click → save
// ---------------------------------------------------------------------------

describe("context-menu click saves", () => {
  it("saves the page into the last-used folder with the tab title", async () => {
    await db.metadata.put({ key: LAST_FOLDER_KEY, value: "fold" });
    installChrome();

    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);

    const children = await fake.getChildren("fold");
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      title: "Article",
      url: PAGE_CLICK.pageUrl,
    });
  });

  it("defaults to Other bookmarks when no folder was remembered", async () => {
    installChrome();

    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);

    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.some((node) => node.url === PAGE_CLICK.pageUrl)).toBe(true);
    expect((await db.metadata.get(LAST_FOLDER_KEY))?.value).toBe(
      OTHER_BOOKMARKS_ID,
    );
  });

  it("rewrites a stale last-used folder to the fallback it saved into", async () => {
    await db.metadata.put({ key: LAST_FOLDER_KEY, value: "deleted-folder" });
    installChrome();

    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);

    expect(
      (await fake.getChildren(OTHER_BOOKMARKS_ID)).some(
        (node) => node.url === PAGE_CLICK.pageUrl,
      ),
    ).toBe(true);
    expect((await db.metadata.get(LAST_FOLDER_KEY))?.value).toBe(
      OTHER_BOOKMARKS_ID,
    );
  });

  it("saves a link using its URL and link text", async () => {
    await db.metadata.put({ key: LAST_FOLDER_KEY, value: "fold" });
    installChrome();

    await handleContextMenuClick(
      {
        menuItemId: SAVE_LINK_MENU_ID,
        pageUrl: "https://page.example/",
        linkUrl: "https://link.example/doc",
        linkText: "  The Doc  ",
      },
      { title: "Page", incognito: false },
    );

    const children = await fake.getChildren("fold");
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      title: "The Doc",
      url: "https://link.example/doc",
    });
  });

  it("falls back to the URL when no title is available", async () => {
    installChrome();

    await handleContextMenuClick(PAGE_CLICK, { incognito: false });

    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved[0]).toMatchObject({
      title: PAGE_CLICK.pageUrl,
      url: PAGE_CLICK.pageUrl,
    });
  });

  it("ignores clicks for unknown menu items and missing URLs", async () => {
    installChrome();

    await handleContextMenuClick({ menuItemId: "other" }, PAGE_TAB);
    await handleContextMenuClick({ menuItemId: SAVE_PAGE_MENU_ID }, PAGE_TAB);
    await handleContextMenuClick({
      menuItemId: SAVE_PAGE_MENU_ID,
      pageUrl: "  ",
    });

    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved).toEqual([]);
    expect(setBadgeText).not.toHaveBeenCalledWith({
      text: BADGE_CONFIRM_TEXT,
    });
  });

  it("flashes the error badge for a click with nothing to save", async () => {
    installChrome();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    registerContextMenus();
    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenCalledWith({ text: "" }),
    );

    // A page click with no URL and a whitespace-only link URL: both are
    // no-ops, and neither may be silent.
    await handleContextMenuClick({ menuItemId: SAVE_PAGE_MENU_ID }, PAGE_TAB);
    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenLastCalledWith({
        text: BADGE_ERROR_TEXT,
      }),
    );

    const calls = timeoutSpy.mock.calls as unknown as [
      () => void,
      number?,
    ][];
    await vi.waitFor(() =>
      expect(calls.some((call) => call[1] === BADGE_CLEAR_DELAY_MS)).toBe(true),
    );
    const index = calls.findIndex((call) => call[1] === BADGE_CLEAR_DELAY_MS);
    const timerId = timeoutSpy.mock.results[index]?.value as number;
    clearTimeout(timerId);
    calls[index]?.[0]?.();

    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenLastCalledWith({ text: "" }),
    );
    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved).toEqual([]);
  });

  it("refuses to store a blocked-scheme link URL and flashes the error badge", async () => {
    installChrome();

    for (const linkUrl of [
      "javascript:alert(1)",
      "data:text/html,<h1>hi</h1>",
      "VBSCRIPT:msgbox(1)",
      "java\tscript:alert(1)", // obfuscated spelling browsers still execute
    ]) {
      await handleContextMenuClick(
        {
          menuItemId: SAVE_LINK_MENU_ID,
          pageUrl: "https://page.example/",
          linkUrl,
          linkText: "Click me",
        },
        { title: "Page", incognito: false },
      );
    }

    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved).toEqual([]);
    expect(setBadgeText).toHaveBeenLastCalledWith({
      text: BADGE_ERROR_TEXT,
    });
  });

  it("still saves ordinary link URLs alongside the blocked checks", async () => {
    installChrome();

    await handleContextMenuClick(
      {
        menuItemId: SAVE_LINK_MENU_ID,
        pageUrl: "https://page.example/",
        linkUrl: "https://link.example/ok",
      },
      { title: "Page", incognito: false },
    );

    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ url: "https://link.example/ok" });
  });

  it("is wired through the registered onClicked listener", async () => {
    installChrome();
    registerContextMenus();

    menus.emit(PAGE_CLICK, PAGE_TAB);

    await vi.waitFor(async () => {
      const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
      expect(children.some((node) => node.url === PAGE_CLICK.pageUrl)).toBe(
        true,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Badge confirmation
// ---------------------------------------------------------------------------

describe("badge confirmation", () => {
  it("sets the confirmation badge then clears it after the delay", async () => {
    installChrome();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    registerContextMenus();
    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenCalledWith({ text: "" }),
    );

    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);
    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenLastCalledWith({
        text: BADGE_CONFIRM_TEXT,
      }),
    );

    const calls = timeoutSpy.mock.calls as unknown as [
      () => void,
      number?,
    ][];
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call[1] === BADGE_CLEAR_DELAY_MS),
      ).toBe(true),
    );
    const index = calls.findIndex((call) => call[1] === BADGE_CLEAR_DELAY_MS);
    const timerId = timeoutSpy.mock.results[index]?.value as number;
    clearTimeout(timerId);
    calls[index]?.[0]?.();

    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenLastCalledWith({ text: "" }),
    );
    const badgeTexts = setBadgeText.mock.calls.map(
      (call) => (call[0] as { text: string }).text,
    );
    expect(badgeTexts).toEqual(["", BADGE_CONFIRM_TEXT, ""]);
  });
});

describe("failure badge", () => {
  it("shows an error badge when the save fails, then clears it", async () => {
    installChrome();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    registerContextMenus();
    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenCalledWith({ text: "" }),
    );

    const createSpy = vi
      .spyOn(fake, "create")
      .mockRejectedValue(new Error("boom"));
    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);

    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenLastCalledWith({
        text: BADGE_ERROR_TEXT,
      }),
    );
    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved).toEqual([]);
    createSpy.mockRestore();

    const calls = timeoutSpy.mock.calls as unknown as [
      () => void,
      number?,
    ][];
    await vi.waitFor(() =>
      expect(
        calls.some((call) => call[1] === BADGE_CLEAR_DELAY_MS),
      ).toBe(true),
    );
    const index = calls.findIndex((call) => call[1] === BADGE_CLEAR_DELAY_MS);
    const timerId = timeoutSpy.mock.results[index]?.value as number;
    clearTimeout(timerId);
    calls[index]?.[0]?.();

    await vi.waitFor(() =>
      expect(setBadgeText).toHaveBeenLastCalledWith({ text: "" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Incognito policy
// ---------------------------------------------------------------------------

describe("incognito policy", () => {
  it("skips saving, logs a reason, and never leaks the URL", async () => {
    installChrome();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    await expect(
      handleContextMenuClick(
        { menuItemId: SAVE_PAGE_MENU_ID, pageUrl: "https://secret.example/x" },
        { title: "Secret", incognito: true },
      ),
    ).resolves.toBeUndefined();

    const saved = (await fake.getChildren(OTHER_BOOKMARKS_ID)).filter(
      (node) => node.url !== undefined,
    );
    expect(saved).toEqual([]);
    // Deliberately silent — not even the error badge: any badge would be
    // feedback about a private page (see the module doc's incognito policy).
    expect(setBadgeText).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(INCOGNITO_SKIP_MESSAGE);
    expect(infoSpy.mock.calls.flat().join(" ")).not.toContain(
      "secret.example",
    );
  });

  it("saves normally from a non-incognito tab", async () => {
    installChrome();

    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);

    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.some((node) => node.url === PAGE_CLICK.pageUrl)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------

describe("egress", () => {
  it("never touches the network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called from the context menu");
    });
    vi.stubGlobal("fetch", fetchSpy);
    installChrome();

    await handleContextMenuClick(PAGE_CLICK, PAGE_TAB);
    await handleContextMenuClick(
      {
        menuItemId: SAVE_LINK_MENU_ID,
        linkUrl: "https://link.example/",
        linkText: "Link",
      },
      PAGE_TAB,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
