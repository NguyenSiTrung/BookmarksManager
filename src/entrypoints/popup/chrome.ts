/**
 * Narrow, lazily-resolved `chrome` slices for the quick-save popup plus the
 * popup → side-panel "edit this bookmark" handoff.
 *
 * The house pattern (see `src/sync/chrome-bookmarks.ts` and
 * `src/security/keys.ts`): `@types/chrome` declares the `chrome` namespace but
 * no usable global binding, and WXT's `browser` export captures
 * `globalThis.chrome` at module load — too early for `vi.stubGlobal`. So this
 * module declares only the slice it needs and resolves it at call time; a
 * missing surface throws *synchronously* (a `ReferenceError`), which the
 * helpers here catch so callers always get a total result.
 *
 * Handoff key: {@link PENDING_EDIT_KEY} (`"bookmarksManager:pendingEditId"`).
 * The popup writes the existing bookmark's Chrome id to
 * `chrome.storage.session` and then calls `chrome.sidePanel.open()`; the side
 * panel reads and clears that key on mount (see the additive effect in
 * `src/entrypoints/sidepanel/App.tsx`). `storage.session` is in-memory and
 * cleared when the browser closes — exactly the lifetime a one-shot handoff
 * wants, and it never touches `chrome.storage.local` (reserved for encrypted
 * provider-key envelopes). When the surface is unavailable every helper
 * degrades to a no-op / `null`.
 */

/** The active tab as the popup needs it (`activeTab` grants title/url). */
export interface ChromeTab {
  id?: number;
  windowId?: number;
  title?: string;
  url?: string;
}

export interface ChromeTabsApi {
  query(queryInfo: {
    active?: boolean;
    currentWindow?: boolean;
    lastFocusedWindow?: boolean;
  }): Promise<ChromeTab[]>;
}

export interface ChromeSidePanelApi {
  open(options: { windowId?: number; tabId?: number }): Promise<void>;
}

export interface ChromeSessionStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

declare const chrome: {
  tabs?: ChromeTabsApi;
  sidePanel?: ChromeSidePanelApi;
  storage?: { session?: ChromeSessionStorageArea };
};

/** `chrome.storage.session` key carrying the id the side panel should edit. */
export const PENDING_EDIT_KEY = "bookmarksManager:pendingEditId";

/**
 * The active tab of the current window, or `null` when the `tabs` surface is
 * missing or the query fails. Never rejects.
 */
export async function queryActiveTab(): Promise<ChromeTab | null> {
  try {
    const tabs = await chrome.tabs?.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Open the side panel for `windowId` (the popup's own window). `chrome`'s
 * `sidePanel.open()` must run inside a user gesture, so callers invoke this
 * SYNCHRONOUSLY from a click handler: the inner `chrome.sidePanel.open(...)`
 * call is dispatched on the same tick (an async function runs synchronously
 * until its first `await`, and `open()` is called before that), and the
 * returned promise is intentionally not awaited. Failures are swallowed —
 * the panel simply does not open on browsers without `sidePanel`.
 */
export function openSidePanel(windowId?: number): void {
  void (async () => {
    try {
      await chrome.sidePanel?.open(
        windowId === undefined ? {} : { windowId },
      );
    } catch {
      // No user gesture / API unavailable — nothing to recover here.
    }
  })();
}

/** The session storage area, or `null` when it is unavailable. */
function sessionArea(): ChromeSessionStorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

/** Stash the bookmark id the side panel should open for editing. */
export async function setPendingEditId(id: string): Promise<void> {
  const area = sessionArea();
  if (area === null) return;
  try {
    await area.set({ [PENDING_EDIT_KEY]: id });
  } catch {
    // Session storage unavailable — the handoff degrades to a no-op.
  }
}

/** Read the pending edit id, or `null` when none is stashed. */
export async function readPendingEditId(): Promise<string | null> {
  const area = sessionArea();
  if (area === null) return null;
  try {
    const values = await area.get(PENDING_EDIT_KEY);
    const value = values[PENDING_EDIT_KEY];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Clear the pending edit id after the side panel consumes it. */
export async function clearPendingEditId(): Promise<void> {
  const area = sessionArea();
  if (area === null) return;
  try {
    await area.remove(PENDING_EDIT_KEY);
  } catch {
    // Best-effort — a stale id only re-opens the same editor.
  }
}
