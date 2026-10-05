import { db } from "../db/database";
import { refreshMetaIntegrity } from "../db/meta";
import {
  pruneTombstones,
  reattachTombstone,
  tombstoneMetaByIds,
} from "../db/tombstones";
import { deleteReviewableAbsentIds } from "../decisions/store";
import type { BookmarksTreeNode } from "./chrome-bookmarks";
import { getTree } from "./chrome-bookmarks";

/**
 * One-shot startup reconcile between the native bookmark tree and the
 * extension-owned `bookmarkMeta` table.
 *
 * The `onRemoved` listener cascade-TOMBSTONES metadata while the worker
 * is alive (D12), but an MV3 service worker is suspended most of the
 * time: deletions made in another window, by sync, or while the worker
 * was asleep never produced an event this worker observed. Reconcile
 * closes that gap — any meta row whose Chrome bookmark id is not in the
 * live tree is tombstoned when it carries a URL (re-attachable if the
 * same URL reappears) or deleted outright when it does not, and every
 * still-reviewable decision whose bookmark set contains a dead real id
 * dies with it (J14): a suggestion cannot outlive the bookmark it
 * proposes to change.
 *
 * It also closes the slept-worker create gap: a bookmark re-created
 * while the worker was suspended never fired `onCreated`, so reconcile
 * re-attaches any live tombstone whose URL a live, meta-less node now
 * carries (D12). Retention pruning and the D13 integrity surface
 * (invalid-row count + held corrupt copies under `metaIntegrity`) are
 * refreshed on every pass.
 */

/** Depth-first walk: ids into `ids`, first-seen leaf url → id into `urlToId`. */
function collectLive(
  node: BookmarksTreeNode,
  ids: Set<string>,
  urlToId: Map<string, string>,
): void {
  ids.add(node.id);
  if (node.url !== undefined && !urlToId.has(node.url)) {
    urlToId.set(node.url, node.id);
  }
  for (const child of node.children ?? []) {
    collectLive(child, ids, urlToId);
  }
}

/**
 * Reap confirmed-dead meta rows through the shared tombstone path (D12):
 * id-only candidates — the row's own `meta.url`, when it has one, keys
 * the tombstone. Schema-invalid rows are retained to `corruptMeta` first
 * (D13); url-less valid rows are deleted without a tombstone. Returns
 * rows reaped.
 */
async function reapOrphanedMeta(deadIds: readonly string[]): Promise<number> {
  if (deadIds.length === 0) return 0;
  const before = await db.bookmarkMeta.count();
  await tombstoneMetaByIds(
    deadIds.map((id) => ({ id })),
    { corruptReason: "reconcile" },
  );
  return before - (await db.bookmarkMeta.count());
}

/**
 * Delete or tombstone initially stored rows whose ids are absent from two
 * native reads.
 *
 * Stored ids are read from the raw primary keys (`toCollection().primaryKeys()`)
 * rather than `listMeta()`: a schema-invalid row is "absent" to every read
 * path, and when its id is also dead the row is residue — retained to
 * `corruptMeta` first (D13), never destroyed silently. An invalid row
 * whose id is still live is kept (harmless: reads ignore it and the next
 * write retains a copy before overwriting).
 *
 * Empty-tree guard: `getTree()` normally resolves to at least the root
 * node, so a tree containing NO ids at all while rows are stored can only
 * be a transiently failed or restricted-context read — deleting every row
 * then would wipe all metadata with no undo path. Deletions have no
 * snapshot (undo only covers tree mutations), so the guard refuses the
 * reap entirely: a real mass delete of bookmarks is indistinguishable
 * from a broken read only when the tree reports literally nothing, and
 * that case is left for the next worker start.
 *
 * Errors propagate to the caller; the worker swallows them at the call
 * site. Returns the total rows reaped (meta + reviewable decisions).
 */
export async function reconcileMetadata(): Promise<number> {
  // Retention housekeeping is unconditional — tombstones expire whether or
  // not there are orphans to reap (D12).
  await pruneTombstones();
  const storedIds = new Set(
    await db.bookmarkMeta.toCollection().primaryKeys(),
  );
  // Decisions can outlive a meta-less bookmark too — their liveness check
  // cannot be gated on meta orphans; tombstones can re-attach onto nodes
  // created while the worker slept.
  const hasDecisions = (await db.decisions.count()) > 0;
  const hasTombstones = (await db.metaTombstones.count()) > 0;
  if (storedIds.size === 0 && !hasDecisions && !hasTombstones) {
    await refreshMetaIntegrity();
    return 0;
  }
  const tree = await getTree();
  const liveIds = new Set<string>();
  for (const top of tree) {
    collectLive(top, liveIds, new Map());
  }
  if (liveIds.size === 0) {
    await refreshMetaIntegrity();
    return 0;
  }

  // Chrome never reuses IDs. Rows created after the initial key snapshot
  // cannot be candidates; a second read protects live IDs missing from a
  // stale first response. An unavailable confirming read authorizes nothing.
  const confirmedIds = new Set<string>();
  const urlToId = new Map<string, string>();
  try {
    for (const top of await getTree()) {
      collectLive(top, confirmedIds, urlToId);
    }
  } catch {
    await refreshMetaIntegrity();
    return 0;
  }
  if (confirmedIds.size === 0) {
    await refreshMetaIntegrity();
    return 0;
  }

  // D12 slept-create gap: a node re-created while the worker was suspended
  // never fired onCreated — offer each live URL to reattachTombstone, which
  // writes only onto meta-less ids and consumes the tombstone either way
  // (a live row for the same URL is fresher data; it wins and the
  // tombstone's job is done).
  for (const [url, id] of urlToId) {
    await reattachTombstone(id, url);
  }

  const orphanedIds = [...storedIds].filter((id) => !confirmedIds.has(id));
  // Reviewable decisions die when ANY member id is dead — the tree read
  // that confirmed the meta orphans also confirms theirs (J14). Claimed
  // rows and popup ids are skipped by the sweep itself.
  const reapedDecisions = hasDecisions
    ? await deleteReviewableAbsentIds(confirmedIds)
    : 0;
  const reapedMeta = await reapOrphanedMeta(orphanedIds);

  // D13: surface the post-reconcile invalid-row count + held corrupt
  // copies under the `metaIntegrity` metadata key.
  await refreshMetaIntegrity();
  return reapedMeta + reapedDecisions;
}
