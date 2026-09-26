import { deleteMetaByIds } from "../db/meta";
import { z } from "../schemas/z";
import type {
  BookmarksTreeNode,
  ChromeBookmarksApi,
  OnChangedListener,
  OnChildrenReorderedListener,
  OnCreatedListener,
  OnMovedListener,
  OnRemovedListener,
} from "./chrome-bookmarks";
import {
  getBookmarksApi,
  onChanged,
  onChildrenReordered,
  onCreated,
  onMoved,
  onRemoved,
} from "./chrome-bookmarks";

/**
 * Worker-side wiring between `chrome.bookmarks` events and the extension's
 * own state. Registered once at worker startup (see
 * `src/entrypoints/background.ts`).
 *
 * Two jobs:
 *
 *  - **Cascade delete.** Chrome fires `onRemoved` once per removed subtree
 *    and hands the removed node back with its full descendant `children`
 *    snapshot. The listener walks that snapshot and deletes the
 *    `bookmarkMeta` rows for the node AND every descendant — extension
 *    metadata must not outlive the bookmark it describes.
 *  - **Change broadcast.** Every one of the five bookmark events also
 *    broadcasts a typed {@link BookmarksChangedMessage} over
 *    `chrome.runtime.sendMessage` so open extension pages (the side panel,
 *    an options tab) can invalidate their read models. Fire-and-forget: the
 *    promise rejects when no page is listening, which is the common case.
 *
 * Totality rules:
 *  - Event callbacks never throw into Chrome's synchronous dispatch: the
 *    cascade runs detached (`void`), a `deleteMetaByIds` rejection is
 *    swallowed (a failed cleanup is retried by the startup reconcile), and
 *    `broadcastChanged` absorbs both synchronous and asynchronous
 *    `sendMessage` failures. Nothing sensitive is logged — event payloads
 *    carry user bookmark data.
 *  - No network: this module never fetches. `chrome.runtime.sendMessage` is
 *    in-process extension messaging, not egress.
 *
 * `chrome` follows the house lazy-slice pattern (see
 * `src/sync/chrome-bookmarks.ts`): only `runtime.sendMessage` is declared
 * here and it is resolved at call time, so `vi.stubGlobal` composes in
 * tests.
 */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

// ---------------------------------------------------------------------------
// Broadcast payload
// ---------------------------------------------------------------------------

/** `type` discriminator of the tree-change broadcast message. */
export const BOOKMARKS_CHANGED_TYPE = "bookmarks-changed";

/** The bookmark event that triggered the broadcast. */
export const BookmarksChangedEvent = z.enum([
  "created",
  "changed",
  "moved",
  "reordered",
  "removed",
]);
export type BookmarksChangedEvent = z.infer<typeof BookmarksChangedEvent>;

/**
 * The message fanned out to extension pages after any bookmark event. `id`
 * is the id Chrome handed the event listener: the affected node for
 * created/changed/moved/removed, the reordered folder for reordered.
 * Receivers should treat it as a hint and re-read the tree rather than
 * patch local state.
 */
export const BookmarksChangedMessage = z.strictObject({
  type: z.literal(BOOKMARKS_CHANGED_TYPE),
  event: BookmarksChangedEvent,
  id: z.string(),
});
export type BookmarksChangedMessage = z.infer<typeof BookmarksChangedMessage>;

// ---------------------------------------------------------------------------
// Broadcast + cascade internals
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget `runtime.sendMessage`. Total by contract: a missing
 * `runtime` surface (partial stubs, odd contexts) throws synchronously and
 * is caught, and a broadcast with no listening page rejects the promise and
 * is swallowed. `id` is always present — every bookmark event carries one.
 */
function broadcastChanged(event: BookmarksChangedEvent, id: string): void {
  const payload: BookmarksChangedMessage = {
    type: BOOKMARKS_CHANGED_TYPE,
    event,
    id,
  };
  try {
    void chrome.runtime.sendMessage(payload).catch(() => {
      // No extension page is listening — the broadcast is best-effort.
    });
  } catch {
    // `chrome.runtime` itself is unavailable; drop the broadcast.
  }
}

/** The removed node's id plus every descendant id (depth-first). */
function collectSubtreeIds(node: BookmarksTreeNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of node.children ?? []) {
    collectSubtreeIds(child, into);
  }
  return into;
}

/**
 * Delete the meta rows for a removed subtree, then broadcast. The broadcast
 * waits on the delete so a page that reacts by re-reading metadata never
 * observes rows for bookmarks that are already gone. The delete is wrapped:
 * a storage failure must not surface as an unhandled rejection in the
 * worker, and the broadcast still goes out — listeners missed this round
 * are repaired by the next startup reconcile.
 */
async function cascadeDelete(
  removedId: string,
  node: BookmarksTreeNode,
): Promise<void> {
  try {
    await deleteMetaByIds(collectSubtreeIds(node));
  } catch {
    // Cleanup failure: the row set converges at the next reconcileMetadata().
  }
  broadcastChanged("removed", removedId);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const handleCreated: OnCreatedListener = (id) => {
  broadcastChanged("created", id);
};

const handleChanged: OnChangedListener = (id) => {
  broadcastChanged("changed", id);
};

const handleMoved: OnMovedListener = (id) => {
  broadcastChanged("moved", id);
};

const handleChildrenReordered: OnChildrenReorderedListener = (id) => {
  broadcastChanged("reordered", id);
};

const handleRemoved: OnRemovedListener = (id, removeInfo) => {
  void cascadeDelete(id, removeInfo.node);
};

/**
 * One active registration per `chrome.bookmarks` instance. Keyed by the API
 * object (a stable singleton in the worker) so repeat calls — defensive
 * startup paths — do not double-subscribe, while a fresh instance in tests
 * still gets its own registration. Entries are weakly held and die with the
 * fake/API they were registered on.
 */
const registrations = new WeakMap<ChromeBookmarksApi, () => void>();

/**
 * Subscribe all five bookmark events. Idempotent per API instance: a second
 * call on the same `chrome.bookmarks` returns the existing unsubscribe
 * function without adding listeners. Returns a no-op when
 * `chrome.bookmarks` is unavailable (the worker keeps serving messages even
 * if the bookmarks surface is absent in some context).
 */
export function registerBookmarkListeners(): () => void {
  let api: ChromeBookmarksApi | undefined | null;
  try {
    api = getBookmarksApi();
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
  const unsubscribers = [
    onCreated(handleCreated),
    onChanged(handleChanged),
    onMoved(handleMoved),
    onChildrenReordered(handleChildrenReordered),
    onRemoved(handleRemoved),
  ];
  const unregister = (): void => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    registrations.delete(api);
  };
  registrations.set(api, unregister);
  return unregister;
}
