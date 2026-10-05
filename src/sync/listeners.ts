import { db } from "../db/database";
import {
  reattachTombstone,
  tombstoneMetaByIds,
  type TombstoneCandidate,
} from "../db/tombstones";
import { deleteReviewableByBookmarkIds } from "../decisions/store";
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
 *    snapshot — every leaf's URL included. The listener walks that snapshot
 *    and TOMBSTONES the `bookmarkMeta` rows for the node AND every
 *    descendant — keyed by each removed leaf's URL so a bookmark re-created
 *    with the same URL gets its metadata back inside the retention window
 *    (D12); the live rows themselves must not outlive the bookmark. It also
 *    deletes every still-reviewable decision (`pending`/`unsure`/`approved`)
 *    whose bookmark set intersects the removed ids (J14): a suggestion
 *    cannot outlive the bookmark it proposes to change. Decided rows are
 *    history and stay for undo and the audit trail.
 *  - **Tombstone re-attach.** `onCreated` checks the new node's URL against
 *    `metaTombstones`; a live tombstone within retention re-attaches its
 *    fields to the new id (D12).
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
 * Every removed node as a tombstone candidate — leaves carry their URL
 * (the re-attach key); folders contribute id-only candidates so their
 * (unexpected) meta rows still die with the bookmark.
 */
function collectTombstoneCandidates(
  node: BookmarksTreeNode,
  into: TombstoneCandidate[] = [],
): TombstoneCandidate[] {
  into.push({ id: node.id, url: node.url });
  for (const child of node.children ?? []) {
    collectTombstoneCandidates(child, into);
  }
  return into;
}

/**
 * Tombstone the meta rows and delete the reviewable decisions for a
 * removed subtree, then broadcast (D12). The broadcast waits on the
 * writes so a page that reacts by re-reading state never observes rows
 * for bookmarks that are already gone. The write block is wrapped: a
 * storage failure must not surface as an unhandled rejection in the
 * worker, and the broadcast still goes out — listeners missed this round
 * are repaired by the next startup reconcile.
 */
async function cascadeDelete(
  removedId: string,
  node: BookmarksTreeNode,
): Promise<void> {
  try {
    const ids = collectSubtreeIds(node);
    const candidates = collectTombstoneCandidates(node);
    // One transaction: URL-keyed tombstones land, the live meta rows die,
    // and the bookmark's pending decisions die with them (D12, J14).
    await db.transaction(
      "rw",
      db.bookmarkMeta,
      db.metaTombstones,
      db.corruptMeta,
      db.decisions,
      async () => {
        await tombstoneMetaByIds(candidates);
        await deleteReviewableByBookmarkIds(ids);
      },
    );
  } catch {
    // Cleanup failure: the row set converges at the next reconcileMetadata().
  }
  broadcastChanged("removed", removedId);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const handleCreated: OnCreatedListener = (id, node) => {
  // D12: a removed bookmark's URL reappearing re-attaches its tombstoned
  // metadata to the new id. Best-effort and detached — the broadcast is
  // the same whether or not a tombstone landed (the row set is visible
  // either way once the page re-reads).
  if (node.url !== undefined) {
    void reattachTombstone(id, node.url).catch(() => {
      // Re-attach is best-effort; a failure leaves the tombstone for the
      // next create or the retention prune.
    });
  }
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
 *
 * Total by contract: each `onX` helper re-resolves `chrome.bookmarks` at
 * call time, so a PARTIAL surface (present but missing an event) would
 * throw mid-subscription. The whole block is wrapped and any listeners
 * already attached are detached again — registration is all-or-nothing and
 * can never take down later startup code (the provider onMessage handler).
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
  const unsubscribers: (() => void)[] = [];
  try {
    // One statement per subscribe: a single push(f(), g(), …) call would
    // evaluate every argument BEFORE pushing any result, so a throw would
    // leak the listeners already attached. Sequential pushes guarantee each
    // subscription's unsubscribe lands in the array before the next
    // subscribe attempt runs.
    unsubscribers.push(onCreated(handleCreated));
    unsubscribers.push(onChanged(handleChanged));
    unsubscribers.push(onMoved(handleMoved));
    unsubscribers.push(onChildrenReordered(handleChildrenReordered));
    unsubscribers.push(onRemoved(handleRemoved));
  } catch {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    return () => {};
  }
  const unregister = (): void => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    registrations.delete(api);
  };
  registrations.set(api, unregister);
  return unregister;
}
