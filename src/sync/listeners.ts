import { db } from "../db/database";
import {
  reattachTombstone,
  tombstoneMetaByIds,
  type TombstoneCandidate,
} from "../db/tombstones";
import { deleteReviewableByBookmarkIds } from "../decisions/store";
import { invalidateSearchIndex } from "../search/omnibox";
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
 *  - **Index invalidation.** Every one of the five bookmark events bumps
 *    the shared search index's generation (D14) so the worker-lifetime
 *    cache the omnibox queries against rebuilds on its next read. The
 *    event object is never inspected — any tree change is a reason to
 *    rebuild.
 *
 * Totality rules:
 *  - Event callbacks never throw into Chrome's synchronous dispatch: the
 *    cascade runs detached (`void`), a meta/tombstone write rejection is
 *    swallowed (a failed cleanup is retried by the startup reconcile).
 *    Nothing sensitive is logged — event payloads carry user bookmark
 *    data.
 *  - No network: this module never fetches.
 *
 * `chrome.bookmarks` follows the house lazy-slice pattern (see
 * `src/sync/chrome-bookmarks.ts`): the surface is resolved at call time,
 * so `vi.stubGlobal` composes in tests.
 */

// ---------------------------------------------------------------------------
// Cascade internals
// ---------------------------------------------------------------------------

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
 * removed subtree, then invalidate the search index (D12, D14). The
 * invalidation waits on the writes so a rebuild triggered by it never
 * observes rows for bookmarks that are already gone. The write block is
 * wrapped: a storage failure must not surface as an unhandled rejection
 * in the worker — rows missed this round are repaired by the next
 * startup reconcile.
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
  invalidateSearchIndex();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const handleCreated: OnCreatedListener = (id, node) => {
  // D12: a removed bookmark's URL reappearing re-attaches its tombstoned
  // metadata to the new id. Best-effort and detached — the index
  // invalidates the same whether or not a tombstone landed (its emit
  // covers the re-attach write anyway).
  if (node.url !== undefined) {
    void reattachTombstone(id, node.url).catch(() => {
      // Re-attach is best-effort; a failure leaves the tombstone for the
      // next create or the retention prune.
    });
  }
  invalidateSearchIndex();
};

const handleChanged: OnChangedListener = () => {
  invalidateSearchIndex();
};

const handleMoved: OnMovedListener = () => {
  invalidateSearchIndex();
};

const handleChildrenReordered: OnChildrenReorderedListener = () => {
  invalidateSearchIndex();
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
