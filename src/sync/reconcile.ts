import { db } from "../db/database";
import { deleteMetaByIds } from "../db/meta";
import { deleteReviewableAbsentIds } from "../decisions/store";
import type { BookmarksTreeNode } from "./chrome-bookmarks";
import { getTree } from "./chrome-bookmarks";

/**
 * One-shot startup reconcile between the native bookmark tree and the
 * extension-owned `bookmarkMeta` table.
 *
 * The `onRemoved` listener cascade-deletes metadata while the worker is
 * alive, but an MV3 service worker is suspended most of the time: deletions
 * made in another window, by sync, or while the worker was asleep never
 * produced an event this worker observed. Reconcile closes that gap — any
 * meta row whose Chrome bookmark id is not in the live tree is deleted,
 * and every still-reviewable decision whose bookmark set contains a dead
 * real id dies with it (J14): a suggestion cannot outlive the bookmark it
 * proposes to change.
 */

/** Depth-first id walk over a `getTree()`/`getSubTree()`-shaped node. */
function collectLiveIds(node: BookmarksTreeNode, into: Set<string>): void {
  into.add(node.id);
  for (const child of node.children ?? []) {
    collectLiveIds(child, into);
  }
}

/**
 * Delete initially stored rows whose ids are absent from two native reads.
 *
 * Stored ids are read from the raw primary keys (`toCollection().primaryKeys()`)
 * rather than `listMeta()`: a schema-invalid row is "absent" to every read
 * path, and when its id is also dead the row is pure residue — reconcile
 * reaps it. An invalid row whose id is still live is kept (harmless: reads
 * ignore it and the next write overwrites it).
 *
 * Empty-tree guard: `getTree()` normally resolves to at least the root
 * node, so a tree containing NO ids at all while rows are stored can only
 * be a transiently failed or restricted-context read — deleting every row
 * then would wipe all metadata with no undo path. Deletions have no
 * snapshot (undo only covers tree mutations), so the guard refuses the
 * pass entirely: a real mass delete of bookmarks is indistinguishable from
 * a broken read only when the tree reports literally nothing, and that
 * case is left for the next worker start.
 *
 * Errors propagate to the caller; the worker swallows them at the call
 * site. Returns the total rows deleted (meta + reviewable decisions).
 */
export async function reconcileMetadata(): Promise<number> {
  const storedIds = await db.bookmarkMeta.toCollection().primaryKeys();
  // Decisions can outlive a meta-less bookmark too — their liveness check
  // cannot be gated on meta orphans.
  const hasDecisions = (await db.decisions.count()) > 0;
  if (storedIds.length === 0 && !hasDecisions) return 0;
  const tree = await getTree();
  const liveIds = new Set<string>();
  for (const top of tree) {
    collectLiveIds(top, liveIds);
  }
  if (liveIds.size === 0) {
    return 0;
  }
  const orphanedIds = storedIds.filter((id) => !liveIds.has(id));
  if (orphanedIds.length === 0 && !hasDecisions) return 0;

  // Chrome never reuses IDs. Rows created after the initial key snapshot
  // cannot be candidates; a second read protects live IDs missing from a
  // stale first response. An unavailable confirming read authorizes nothing.
  const confirmedIds = new Set<string>();
  try {
    for (const top of await getTree()) {
      collectLiveIds(top, confirmedIds);
    }
  } catch {
    return 0;
  }
  if (confirmedIds.size === 0) return 0;
  // Reviewable decisions die when ANY member id is dead — the tree read
  // that confirmed the meta orphans also confirms theirs (J14). Claimed
  // rows and popup ids are skipped by the sweep itself.
  const reapedDecisions = await deleteReviewableAbsentIds(confirmedIds);
  const reapedMeta = await deleteMetaByIds(
    orphanedIds.filter((id) => !confirmedIds.has(id)),
  );
  return reapedMeta + reapedDecisions;
}
