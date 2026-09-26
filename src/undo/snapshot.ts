import { db } from "../db/database";
import { getMetaByIds } from "../db/meta";
import type { TagDef } from "../schemas/meta";
import { UndoSnapshot } from "../schemas/undo";
import type { UndoKind, UndoMeta, UndoNode } from "../schemas/undo";
import { get, getSubTree } from "../sync/chrome-bookmarks";
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
 * - **Bounded stack.** The table is capped at {@link UNDO_STACK_LIMIT}
 *   rows; insertion keeps the newest by primary key (`++id` is the recency
 *   order) and drops the oldest. The cap runs inside the same transaction
 *   as the insert, so a concurrent push cannot overshoot it.
 * - `meta` rows keep their pre-mutation Chrome ids; the id remap at
 *   restore time is `restore.ts`'s job.
 */

/** Maximum number of snapshots kept in the `undo` table (LIFO stack depth). */
export const UNDO_STACK_LIMIT = 20;

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
 * `getMetaByIds`. Returns `undefined` when the node does not exist or is
 * the fixed root "0" (a parentless, unpositioned node can never be
 * restored).
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
 * resolve are skipped (a missing node has no position worth replaying).
 * Children are not captured — a moved node keeps its subtree attached, so
 * only its own placement matters. Meta rows are collected for the full
 * requested id list.
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
      found.index === undefined
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
 * Append a snapshot to the `undo` table and enforce the stack cap in one
 * transaction. `createdAt` is stamped when absent; the document is
 * schema-validated before the write and a fresh object is stored, so the
 * auto-incremented `id` Dexie writes back never reaches the caller's
 * object. Rows beyond {@link UNDO_STACK_LIMIT} are dropped oldest-first
 * (primary-key order = recency). Resolves to the new row id. Rejects with
 * a plain `Error` when the assembled document violates `UndoSnapshot` —
 * a caller-construction bug, not a runtime condition.
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
  return db.transaction("rw", db.undo, async () => {
    const id = await db.undo.add({ ...parsed.data });
    const keys = await db.undo.toCollection().primaryKeys();
    const excess = keys.length - UNDO_STACK_LIMIT;
    if (excess > 0) {
      await db.undo.bulkDelete(
        keys.slice(0, excess).map((key) => Number(key)),
      );
    }
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

/** The newest valid snapshot on the stack, or `undefined` when empty. */
export async function peekLatest(): Promise<UndoSnapshot | undefined> {
  return (await listSnapshots())[0];
}
