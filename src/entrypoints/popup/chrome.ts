import { SaveMessageResult } from "../../messages/save";
import type { SaveMessage } from "../../messages/save";

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
 * panel reads and clears that key on mount, and also subscribes to
 * `chrome.storage.onChanged` through {@link onPendingEditId} so a panel that
 * is ALREADY open still sees the handoff (see the additive effects in
 * `src/entrypoints/sidepanel/App.tsx`). `storage.session` is in-memory and
 * cleared when the browser closes — exactly the lifetime a one-shot handoff
 * wants, and it never touches `chrome.storage.local` (reserved for encrypted
 * provider-key envelopes). When the surface is unavailable every helper
 * degrades to a no-op / `null` / inert unsubscribe.
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

/** One storage key's before/after values, as `storage.onChanged` reports it. */
export interface ChromeStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

/** The `changes` payload of `chrome.storage.onChanged` for one write. */
export type ChromeStorageChanges = Record<string, ChromeStorageChange>;

export interface ChromeStorageChangedEvent {
  addListener(
    callback: (changes: ChromeStorageChanges, areaName: string) => void,
  ): void;
  removeListener(
    callback: (changes: ChromeStorageChanges, areaName: string) => void,
  ): void;
}

declare const chrome: {
  runtime?: {
    openOptionsPage?: () => Promise<void> | void;
    sendMessage?(message: unknown): Promise<unknown>;
  } | null;
  tabs?: ChromeTabsApi;
  sidePanel?: ChromeSidePanelApi;
  storage?: {
    session?: ChromeSessionStorageArea;
    onChanged?: ChromeStorageChangedEvent;
  };
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
 * until its first `await`, and `open()` is called before that).
 *
 * Resolves `false` when the surface is missing or the call rejects — the
 * caller decides how to surface it (a one-line error under the form); the
 * promise is intentionally not awaited for the gesture window, which is why
 * the result arrives asynchronously.
 */
export async function openSidePanel(windowId?: number): Promise<boolean> {
  try {
    const api = chrome.sidePanel;
    if (api === undefined || typeof api.open !== "function") return false;
    await api.open(windowId === undefined ? {} : { windowId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send one `SAVE` intent to the worker and validate the reply. The whole
 * save (tag defs → create → meta → remember-folder) runs worker-side so a
 * popup destroyed after the send still completes it (U06). Throws when the
 * `runtime.sendMessage` surface is missing or the call rejects — the caller
 * renders `describeError`; a reply that does not match the protocol becomes
 * an `internal_error` result rather than a silent swallow.
 */
export async function sendSaveMessage(
  message: SaveMessage,
): Promise<SaveMessageResult> {
  let runtime;
  try {
    runtime = chrome.runtime;
  } catch {
    runtime = undefined;
  }
  if (runtime?.sendMessage === undefined) {
    return {
      ok: false,
      code: "unavailable",
      message: "The save could not reach the extension worker.",
    };
  }
  const reply: unknown = await runtime.sendMessage(message);
  const parsed = SaveMessageResult.safeParse(reply);
  if (!parsed.success) {
    return {
      ok: false,
      code: "internal_error",
      message: "The save did not return a usable answer.",
    };
  }
  return parsed.data;
}

/**
 * Open the extension's Options page in a tab. Total: a missing
 * `runtime.openOptionsPage` (or a throw) is a no-op.
 */
export function openOptionsPage(): void {
  try {
    const runtime = chrome.runtime;
    if (typeof runtime?.openOptionsPage === "function") {
      void runtime.openOptionsPage();
    }
  } catch {
    // No runtime surface — nothing to open.
  }
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

/**
 * Subscribe to `chrome.storage.session` writes of {@link PENDING_EDIT_KEY}.
 * The side panel is often ALREADY open when the popup hands a bookmark over,
 * so a mount/tree read alone misses the handoff — this is the live half.
 *
 * `callback` receives the new id; a removal (the key being cleared) is not a
 * handoff and is ignored, which also keeps a clear-then-read cycle from
 * re-entering. Returns an unsubscribe.
 *
 * Total: a missing `storage` / `storage.onChanged` surface (or one that
 * throws on `addListener`) degrades to an inert unsubscribe, leaving the
 * mount/tree read as the only path — exactly the previous behaviour.
 */
export function onPendingEditId(callback: (id: string) => void): () => void {
  let event: ChromeStorageChangedEvent | undefined;
  try {
    event = chrome.storage?.onChanged;
  } catch {
    event = undefined;
  }
  if (event === undefined) return () => {};

  const listener = (changes: ChromeStorageChanges, areaName: string): void => {
    if (areaName !== "session") return;
    const newValue = changes[PENDING_EDIT_KEY]?.newValue;
    if (typeof newValue !== "string" || newValue === "") return;
    callback(newValue);
  };

  try {
    event.addListener(listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      event.removeListener(listener);
    } catch {
      // The listener never attached (torn-down surface) — nothing to detach.
    }
  };
}
