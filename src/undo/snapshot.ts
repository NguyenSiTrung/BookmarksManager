import { db } from "../db/database";
import type { DecisionRow } from "../decisions/store";
import { getMetaByIds } from "../db/meta";
import type { TagDef } from "../schemas/meta";
import { UndoSnapshot } from "../schemas/undo";
import type { UndoKind, UndoMeta, UndoNode, UndoOrigin } from "../schemas/undo";
import { get, getSubTree, isFixedRoot } from "../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";

/**
 * Capture and stack-management half of the undo system (`src/undo/restore.ts`
 * is the replay half). Mutating flows — delete, bulk move, merge, tag delete —
 * snapshot the affected nodes and their `bookmarkMeta` rows BEFORE touching
 * the tree, then `pushSnapshot` the result onto the Dexie `undo` table
 * (`++id,createdAt`). The `Undo` toast reads the stack through
 * {@link listSnapshots}/{@link peekLatest}; {@link undoLatest} in
 * `restore.ts` consumes it.
 *
 * Design rules (locked by tests/unit/undo.test.ts):
 *
 * - **Capture what replay needs.** `captureSubtree` records a node's
 *   `parentId`/`index` plus its full descendant tree (for delete/merge,
 *   where recreation needs every nested node); `captureNodes` records
 *   position-only nodes (for bulk_move, where the nodes survive and only
 *   their placement must be replayed). Both also collect the affected
 *   `bookmarkMeta` rows so metadata can be remapped onto the new Chrome
 *   ids a restore creates.
 * - **Total reads.** Captures return `undefined`/skip ids rather than
 *   throwing when a node is missing — callers snapshot right before a
 *   mutation, and a vanished node simply has nothing to restore.
 * - **Repository conventions.** `createdAt` is stamped inside
 *   `pushSnapshot` (callers may override it, e.g. for fixtures), writes go
 *   through `UndoSnapshot.safeParse` before they hit the table, and reads
 *   re-validate — a corrupt stored row is treated exactly like a missing
 *   one (invalid ⇒ absent), so a poisoned stack can never wedge the UI.
 * - **Fresh objects.** `pushSnapshot` stores a newly parsed object graph;
 *   Dexie writes the generated inbound key back onto the object passed to
 *   `add`, so the caller's input is never handed to the table.
 * - **Bounded stack, per origin (D05).** Rows are bucketed by `origin`
 *   (`user` UI flows vs `decision` applies — absent reads as `user`); each
 *   bucket is capped at {@link UNDO_STACK_LIMIT} rows AND
 *   {@link UNDO_NODE_BUDGET} captured nodes, so a burst of decision
 *   approvals can never evict the snapshot a user just pushed, and one
 *   giant capture cannot crowd out everything behind it. Eviction drops
 *   the bucket's OLDEST unprotected rows inside the same transaction as
 *   the insert; a row referenced by a live decision's `undoSnapshotId`
 *   (status not `rejected`/`reverted`) is never evicted, even past the
 *   cap — a revert must always find its snapshot.
 * - `meta` rows keep their pre-mutation Chrome ids; the id remap at
 *   restore time is `restore.ts`'s job.
 */

/** Maximum snapshots kept PER ORIGIN in the `undo` table (LIFO depth). */
export const UNDO_STACK_LIMIT = 20;

/**
 * Maximum total captured nodes PER ORIGIN. A single huge delete-all can
 * legitimately sit at 10k nodes, but twenty of them must not pile up —
 * eviction drops the origin's oldest unprotected rows until the bucket is
 * back under the bound.
 */
export const UNDO_NODE_BUDGET = 100_000;

/** `captureSubtree` result: the recursive node plus the subtree's meta rows. */
export interface SubtreeCapture {
  node: UndoNode;
  meta: UndoMeta[];
}

/** `captureNodes` result: position-only nodes plus their meta rows. */
export interface NodesCapture {
  nodes: UndoNode[];
  meta: UndoMeta[];
}

/**
 * `pushSnapshot` input: the snapshot document minus the database-owned
 * fields. `id` is always assigned by IndexedDB; `createdAt` is stamped
 * here unless the caller supplies one (fixtures, replayed envelopes).
 * `nodes`/`meta` accept readonly arrays so frozen or `as const` captures
 * can be pushed unwrapped.
 */
export interface UndoSnapshotInput {
  kind: UndoKind;
  nodes: readonly UndoNode[];
  meta: readonly UndoMeta[];
  /** Required for `tag_delete` snapshots; absent otherwise. */
  tagDef?: TagDef;
  /** `restructure` snapshots: folders the apply created, parents-first. */
  createdFolderIds?: readonly string[];
  /**
   * Retention bucket (D05): `user` for UI-driven flows, `decision` for
   * decision/job applies. Defaults to `user`.
   */
  origin?: UndoOrigin;
  createdAt?: string;
}

/** Every id inside an UndoNode tree, depth-first. */
function collectNodeIds(node: UndoNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of node.children ?? []) {
    collectNodeIds(child, into);
  }
  return into;
}

/**
 * Convert a materialized tree node into an {@link UndoNode}. The child's
 * `parentId`/`index` are taken from the traversal position (the parent's
 * id and the child's slot in `children`) rather than the node's own fields
 * — Chrome populates both anyway, and deriving them keeps the snapshot
 * consistent even if a payload omits them.
 */
function toUndoNode(
  treeNode: BookmarksTreeNode,
  parentId: string,
  index: number,
): UndoNode {
  const node: UndoNode = {
    id: treeNode.id,
    parentId,
    index,
    title: treeNode.title,
  };
  if (treeNode.url !== undefined) node.url = treeNode.url;
  const children = treeNode.children ?? [];
  if (children.length > 0) {
    node.children = children.map((child, childIndex) =>
      toUndoNode(child, treeNode.id, childIndex),
    );
  }
  return node;
}

/**
 * Deep capture of the subtree rooted at `id` — call BEFORE deleting or
 * merging so the whole removed structure can be replayed. Resolves the
 * live tree via `getSubTree` and the subtree's meta rows via
 * `getMetaByIds`. Returns `undefined` when the node does not exist, is the
 * fixed root "0" (a parentless, unpositioned node can never be restored),
 * or is any other fixed root "1"–"3" — those carry `parentId`/`index` but
 * a snapshot of one could only ever fail `root` on replay, wedging the
 * stack head behind a permanently failing row.
 */
export async function captureSubtree(
  id: string,
): Promise<SubtreeCapture | undefined> {
  let root: BookmarksTreeNode | undefined;
  try {
    root = (await getSubTree(id))[0];
  } catch {
    root = undefined;
  }
  if (root === undefined) return undefined;
  if (isFixedRoot(root.id)) return undefined;
  if (root.parentId === undefined || root.index === undefined) {
    return undefined;
  }
  const node = toUndoNode(root, root.parentId, root.index);
  const meta = await getMetaByIds(collectNodeIds(node));
  return { node, meta };
}

/**
 * Shallow capture of each id's current `parentId`+`index` — call BEFORE a
 * bulk move so the move can be replayed in reverse. Nodes are emitted in
 * first-seen input order with duplicates collapsed; ids that no longer
 * resolve are skipped (a missing node has no position worth replaying), as
 * are fixed roots "0"–"3" (a root can never be moved, so a recorded
 * position for one could never be replayed either). Children are not
 * captured — a moved node keeps its subtree attached, so only its own
 * placement matters. Meta rows are collected for the full requested id
 * list.
 */
export async function captureNodes(
  ids: readonly string[],
): Promise<NodesCapture> {
  const nodes: UndoNode[] = [];
  for (const id of [...new Set(ids)]) {
    let found: BookmarksTreeNode | undefined;
    try {
      found = (await get(id))[0];
    } catch {
      found = undefined;
    }
    if (
      found === undefined ||
      found.parentId === undefined ||
      found.index === undefined ||
      isFixedRoot(found.id)
    ) {
      continue;
    }
    const node: UndoNode = {
      id: found.id,
      parentId: found.parentId,
      index: found.index,
      title: found.title,
    };
    if (found.url !== undefined) node.url = found.url;
    nodes.push(node);
  }
  const meta = await getMetaByIds(ids);
  return { nodes, meta };
}

/**
 * Append a snapshot to the `undo` table and enforce the retention bounds
 * in one transaction. `createdAt` is stamped when absent; the document is
 * schema-validated before the write and a fresh object is stored, so the
 * auto-incremented `id` Dexie writes back never reaches the caller's
 * object. Eviction is per-origin: the new row's bucket is trimmed to
 * {@link UNDO_STACK_LIMIT} rows and {@link UNDO_NODE_BUDGET} captured
 * nodes, oldest-first, skipping rows a live decision still references
 * (D05). Resolves to the new row id. Rejects with a plain `Error` when
 * the assembled document violates `UndoSnapshot` — a caller-construction
 * bug, not a runtime condition.
 */
export async function pushSnapshot(
  input: UndoSnapshotInput,
): Promise<number> {
  const parsed = UndoSnapshot.safeParse({
    ...input,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `undo snapshot failed schema validation: ${issue?.message ?? "invalid document"}`,
    );
  }
  // The transaction covers `decisions` too: the protected-id read must see
  // the same snapshot of the world as the eviction that follows it.
  return db.transaction("rw", db.undo, db.decisions, async () => {
    const id = await db.undo.add({ ...parsed.data });

    // Snapshot ids a live decision can still revert through — never
    // evicted, whatever the cap says (D05). `undoSnapshotId` exists only on
    // applied/auto_applied rows (the DecisionRow sidecar, not the base
    // Decision schema); rejected/reverted decisions no longer need theirs.
    const protectedIds = new Set<number>();
    await db.decisions
      .filter((row) => {
        const sidecar = row as DecisionRow;
        return (
          sidecar.undoSnapshotId !== undefined &&
          sidecar.status !== "rejected" &&
          sidecar.status !== "reverted"
        );
      })
      .each((row) => {
        protectedIds.add((row as DecisionRow).undoSnapshotId as number);
      });

    const origin: UndoOrigin = parsed.data.origin ?? "user";
    const bucket = (await db.undo.toArray()).filter(
      (row) => (row.origin as UndoOrigin | undefined ?? "user") === origin,
    ); // toArray() is primary-key order: oldest first
    const excess = bucket.length - UNDO_STACK_LIMIT;
    let nodeTotal = 0;
    for (const row of bucket) {
      nodeTotal += (row.nodes as unknown[] | undefined)?.length ?? 0;
    }
    const evict: number[] = [];
    for (const row of bucket) {
      if (evict.length >= excess && nodeTotal <= UNDO_NODE_BUDGET) break;
      const rowId = row.id as number | undefined;
      if (rowId === undefined || rowId === id) continue; // never the new row
      if (protectedIds.has(rowId)) continue;
      evict.push(rowId);
      nodeTotal -= (row.nodes as unknown[] | undefined)?.length ?? 0;
    }
    if (evict.length > 0) await db.undo.bulkDelete(evict);
    return id;
  });
}

/**
 * All valid snapshots, newest-first (descending row id = most recent).
 * Stored rows are re-validated; corrupt rows are dropped from the result
 * exactly like missing ones (invalid ⇒ absent) so a poisoned row never
 * breaks listing or blocks a restore behind it.
 */
export async function listSnapshots(): Promise<UndoSnapshot[]> {
  const rows = await db.undo.toArray(); // primary-key order: oldest first
  const snapshots: UndoSnapshot[] = [];
  for (const row of rows) {
    const parsed = UndoSnapshot.safeParse(row);
    if (parsed.success) snapshots.push(parsed.data);
  }
  snapshots.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  return snapshots;
}

/**
 * The newest VALID snapshot on the stack (D06): a reverse cursor reads one
 * row at a time, newest-first, skipping corrupt rows exactly like
 * `listSnapshots` — instead of loading and validating the whole stack.
 */
export async function peekLatest(): Promise<UndoSnapshot | undefined> {
  let row = await db.undo.toCollection().reverse().first();
  while (row !== undefined) {
    const parsed = UndoSnapshot.safeParse(row);
    if (parsed.success) return parsed.data;
    const id = row.id as number;
    // Step back one row: the corrupt head does not poison the rest.
    row = await db.undo.where(":id").below(id).reverse().first();
  }
  return undefined;
}
