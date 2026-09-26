import { getTree } from "./chrome-bookmarks";
import {
  getLastFolderId,
  resolveSaveFolder,
  setLastFolderId,
} from "./last-folder";
import { createBookmark } from "./mutations";
import { flattenTree } from "./tree";

/**
 * Right-click "Save page"/"Save link" menu items (spec §3, plan §5.1: "Quick
 * save from the popup, a keyboard shortcut, or the context menu").
 *
 * Registration (`registerContextMenus`) runs at every worker start from
 * `src/entrypoints/background.ts`, alongside `registerBookmarkListeners()` and
 * `reconcileMetadata()`. It is idempotent two ways: the `onClicked` listener
 * is keyed by the `chrome.contextMenus` instance in a `WeakMap` (so repeat
 * startup paths do not double-subscribe), and the two items are re-created
 * after a `removeAll()` on every registration. Context-menu items are owned by
 * the browser and survive worker eviction, so re-creating them by id would
 * raise a duplicate-id error; `removeAll`-then-create is the standard,
 * self-healing pattern — the menu is rebuilt exactly once per start regardless
 * of what survived.
 *
 * Menu items (exact `{id, title, contexts}` shapes are locked by
 * `tests/unit/context-menu.test.ts` and exported as {@link CONTEXT_MENU_ITEMS}):
 *
 *   { id: "save-page", title: "Save page to Bookmarks Manager", contexts: ["page"] }
 *   { id: "save-link", title: "Save link to Bookmarks Manager", contexts: ["link"] }
 *
 * Click behaviour: the item saves into the LAST-USED folder — the same Dexie
 * `metadata` preference (`prefs:lastFolderId`) the popup's folder picker uses,
 * resolved through `resolveSaveFolder` so a deleted stored folder falls back
 * to Other bookmarks ("2"). The write goes through the guarded mutation
 * service (`createBookmark`), which yields the real id and maps every failure
 * to a typed `MutationError`. After a successful write the resolved folder is
 * recorded via `setLastFolderId` — matching the popup, which remembers the
 * folder it saved into, so a stale pref is rewritten to the fallback that was
 * actually used.
 *
 * Badge strategy: on success the toolbar badge shows {@link BADGE_CONFIRM_TEXT}
 * ("✓") and a `setTimeout` clears it after {@link BADGE_CLEAR_DELAY_MS}. No
 * `alarms` permission is requested, so the timer lives only in the worker.
 * Trade-off: an MV3 worker evicted inside that window cannot fire the timeout
 * and would leave a stale "✓" on the toolbar. Mitigation: every worker start
 * clears the badge at registration time (the `void setBadgeText("")` below), so
 * the stale mark is wiped the next time the worker wakes for any reason; a
 * click also overwrites it before scheduling its own clear. A missing or
 * failing `chrome.action` surface degrades to a no-op — the badge is
 * decoration and never blocks the save.
 *
 * Incognito policy: **skip and log**. Chrome runs an extension in a single
 * process unless it declares `"incognito": "split"` (this one does not), and
 * `tab.incognito` is reported on the click's tab. Saving an incognito page
 * would write its URL into the user's durable, Chrome-synced bookmark tree —
 * a privacy leak from private browsing into persistent storage. So a click
 * whose tab reports `incognito: true` saves nothing, shows no badge, and logs
 * {@link INCOGNITO_SKIP_MESSAGE} (a generic reason — never the URL or title).
 * The handler is total: a click from any context never throws.
 *
 * `chrome` follows the house lazy-slice pattern (see
 * `src/sync/chrome-bookmarks.ts`): only `contextMenus` and `action` are
 * declared here and resolved at call time, so `vi.stubGlobal` composes in
 * tests and a missing surface throws synchronously where the callers catch it.
 * The slice lives in THIS module (not in `background.ts`) so the worker
 * entrypoint keeps its single `runtime.onMessage` declaration and the
 * context-menu API surface stays next to its only consumer. Zero network.
 */

// ---------------------------------------------------------------------------
// Chrome slices (lazy — resolved at call time)
// ---------------------------------------------------------------------------

/** Argument shape for `chrome.contextMenus.create` as this module uses it. */
export interface ContextMenuCreateProperties {
  id: string;
  title: string;
  contexts: string[];
}

/** The `tab` handed to `onClicked` — only the fields the policy needs. */
export interface ContextMenuTab {
  title?: string;
  url?: string;
  incognito?: boolean;
}

/** `info` payload of `chrome.contextMenus.onClicked`. */
export interface ContextMenuClickData {
  menuItemId: string | number;
  /** Present for page/selection contexts; absent for link-only clicks. */
  pageUrl?: string;
  /** Present for link contexts. */
  linkUrl?: string;
  /** The link's anchor text, when Chrome can determine it. */
  linkText?: string;
}

export type ContextMenuClickListener = (
  info: ContextMenuClickData,
  tab?: ContextMenuTab,
) => void;

/** Minimal shape of the `chrome.contextMenus` surface this module needs. */
export interface ChromeContextMenusApi {
  create(
    properties: ContextMenuCreateProperties,
    callback?: () => void,
  ): string | number;
  removeAll(callback?: () => void): void;
  onClicked: {
    addListener(callback: ContextMenuClickListener): void;
    removeListener(callback: ContextMenuClickListener): void;
  };
}

/** Minimal shape of the `chrome.action` surface this module needs. */
export interface ChromeActionApi {
  setBadgeText(details: { text: string; tabId?: number }): Promise<void> | void;
}

declare const chrome: {
  contextMenus?: ChromeContextMenusApi;
  action?: ChromeActionApi;
};

// ---------------------------------------------------------------------------
// Menu definitions
// ---------------------------------------------------------------------------

/** Menu id of the page-context item. */
export const SAVE_PAGE_MENU_ID = "save-page";
/** Menu id of the link-context item. */
export const SAVE_LINK_MENU_ID = "save-link";
/** Title of the page-context item (spec §3). */
export const SAVE_PAGE_MENU_TITLE = "Save page to Bookmarks Manager";
/** Title of the link-context item (spec §3). */
export const SAVE_LINK_MENU_TITLE = "Save link to Bookmarks Manager";

/**
 * The two menu items, in registration order. Exported so tests and the store
 * listing assert the exact `{id, title, contexts}` contract in one place.
 */
export const CONTEXT_MENU_ITEMS: readonly ContextMenuCreateProperties[] = [
  { id: SAVE_PAGE_MENU_ID, title: SAVE_PAGE_MENU_TITLE, contexts: ["page"] },
  { id: SAVE_LINK_MENU_ID, title: SAVE_LINK_MENU_TITLE, contexts: ["link"] },
];

/** Badge text shown after a successful save. */
export const BADGE_CONFIRM_TEXT = "✓";

/** How long the confirmation badge stays up before clearing (milliseconds). */
export const BADGE_CLEAR_DELAY_MS = 1500;

/** Logged when a click is skipped because its tab is incognito. */
export const INCOGNITO_SKIP_MESSAGE =
  "Bookmarks Manager: skipped saving from an incognito window.";

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/**
 * Set the toolbar badge text. Total: a missing `chrome.action` surface throws
 * synchronously (`ReferenceError`) and a failing `setBadgeText` rejects — both
 * are swallowed, because the badge must never block or fail the save.
 */
async function setBadgeText(text: string): Promise<void> {
  try {
    await chrome.action?.setBadgeText({ text });
  } catch {
    // No action surface (partial stubs) or the call failed — decoration only.
  }
}

/**
 * Show the confirmation badge and schedule its clear. The clear is a
 * `setTimeout` (no `alarms` permission); an evicted worker may miss it, which
 * is repaired by the registration-time clear on the next worker start.
 */
function confirmSaveBadge(): void {
  void setBadgeText(BADGE_CONFIRM_TEXT).then(() => {
    setTimeout(() => {
      void setBadgeText("");
    }, BADGE_CLEAR_DELAY_MS);
  });
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Resolve the folder a menu save should target: the stored last-used folder
 * when it still names a folder in the live tree, else Other bookmarks ("2").
 * Total — a tree read failure degrades to the default (the subsequent
 * `createBookmark` reports the real problem).
 */
async function resolveSaveFolderId(): Promise<string> {
  let folderIds: ReadonlySet<string> = new Set();
  let lastFolderId: string | null = null;
  try {
    const [tree, stored] = await Promise.all([getTree(), getLastFolderId()]);
    folderIds = new Set(flattenTree(tree).folders.keys());
    lastFolderId = stored;
  } catch {
    // No readable tree — fall back to Other bookmarks; createBookmark decides
    // whether the save can proceed.
  }
  return resolveSaveFolder(folderIds, lastFolderId);
}

/**
 * Handle one context-menu click. Total by contract — it never throws into
 * Chrome's synchronous dispatch; every failure path returns without a badge.
 *
 * Page clicks save `info.pageUrl` titled by the tab's title; link clicks save
 * `info.linkUrl` titled by `info.linkText`. An empty title falls back to the
 * URL, matching the popup. Incognito tabs are skipped (see the module doc).
 * The chosen folder is remembered as the last-used default after the write.
 */
export async function handleContextMenuClick(
  info: ContextMenuClickData,
  tab?: ContextMenuTab,
): Promise<void> {
  try {
    const menuItemId = String(info.menuItemId);
    const isPage = menuItemId === SAVE_PAGE_MENU_ID;
    const isLink = menuItemId === SAVE_LINK_MENU_ID;
    if (!isPage && !isLink) return;

    if (tab?.incognito === true) {
      console.info(INCOGNITO_SKIP_MESSAGE);
      return;
    }

    const url = (isPage ? info.pageUrl : info.linkUrl)?.trim() ?? "";
    if (url === "") return;

    const rawTitle = isPage ? tab?.title : info.linkText;
    const title = rawTitle?.trim() ?? "";

    const folderId = await resolveSaveFolderId();
    await createBookmark({
      parentId: folderId,
      title: title === "" ? url : title,
      url,
    });
    // Match the popup: the folder a save actually landed in becomes the
    // last-used default (rewriting a stale pref to the fallback).
    await setLastFolderId(folderId);
    confirmSaveBadge();
  } catch {
    // Guards rejected (managed/root/unknown folder) or the tree is
    // unavailable — the click is best-effort and must not throw.
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * One active registration per `chrome.contextMenus` instance. Keyed by the API
 * object (a stable singleton in the worker) so repeat startup calls do not
 * double-subscribe, while a fresh instance in tests gets its own registration.
 * Entries are weakly held and die with the fake/API they were registered on.
 */
const registrations = new WeakMap<ChromeContextMenusApi, () => void>();

/**
 * Create the two menu items and subscribe the click handler. Returns an
 * unsubscribe that detaches the listener; a second call on the same
 * `chrome.contextMenus` instance returns the existing unsubscribe without
 * rebuilding. A no-op when `chrome.contextMenus` is unavailable, so the worker
 * still starts on a partial surface.
 *
 * Total by contract: a synchronous failure while attaching (partial surface)
 * detaches anything already attached and returns an inert unsubscribe, so a
 * throw can never take down the provider `onMessage` registration that follows.
 */
export function registerContextMenus(): () => void {
  let api: ChromeContextMenusApi | undefined;
  try {
    api = chrome.contextMenus;
  } catch {
    api = undefined;
  }
  if (api === undefined || api === null) {
    return () => {};
  }
  const existing = registrations.get(api);
  if (existing !== undefined) {
    return existing;
  }

  const listener: ContextMenuClickListener = (info, tab) => {
    void handleContextMenuClick(info, tab);
  };

  try {
    api.onClicked.addListener(listener);
    // Rebuild the items on every registration: menu items outlive the worker,
    // so removeAll-then-create keeps the menu exactly in sync with this build
    // (and avoids duplicate-id errors on restart).
    api.removeAll(() => {
      for (const item of CONTEXT_MENU_ITEMS) {
        try {
          api.create({ ...item });
        } catch {
          // A torn-down surface mid-rebuild — keep the remaining items.
        }
      }
    });
    // Clear any confirmation badge left by a worker evicted mid-timeout.
    void setBadgeText("");
  } catch {
    try {
      api.onClicked.removeListener(listener);
    } catch {
      // The listener never attached — nothing to detach.
    }
    return () => {};
  }

  const unregister = (): void => {
    try {
      api.onClicked.removeListener(listener);
    } catch {
      // Already torn down — nothing to detach.
    }
    registrations.delete(api);
  };
  registrations.set(api, unregister);
  return unregister;
}
