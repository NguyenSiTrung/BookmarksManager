import { db } from "../db/database";
import { deleteMetaByIds } from "../db/meta";
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
 * meta row whose Chrome bookmark id is not in the live tree is deleted.
 */

/** Depth-first id walk over a `getTree()`/`getSubTree()`-shaped node. */
function collectLiveIds(node: BookmarksTreeNode, into: Set<string>): void {
  into.add(node.id);
  for (const child of node.children ?? []) {
    collectLiveIds(child, into);
  }
}

/**
 * Delete every `bookmarkMeta` row whose id is absent from the live tree.
 *
 * Stored ids are read from the raw primary keys (`toCollection().primaryKeys()`)
 * rather than `listMeta()`: a schema-invalid row is "absent" to every read
 * path, and when its id is also dead the row is pure residue — reconcile
 * reaps it. An invalid row whose id is still live is kept (harmless: reads
 * ignore it and the next write overwrites it).
 *
 * Errors propagate to the caller; the worker swallows them at the call
 * site. Returns the number of rows deleted.
 */
export async function reconcileMetadata(): Promise<number> {
  const tree = await getTree();
  const liveIds = new Set<string>();
  for (const top of tree) {
    collectLiveIds(top, liveIds);
  }
  const storedIds = await db.bookmarkMeta.toCollection().primaryKeys();
  const orphanedIds = storedIds.filter((id) => !liveIds.has(id));
  return deleteMetaByIds(orphanedIds);
}
