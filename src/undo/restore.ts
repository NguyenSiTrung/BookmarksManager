import { db } from "../db/database";
import {
  createTag,
  getMeta,
  getTag,
  MetaRepoError,
  patchMeta,
  putMeta,
} from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import type { UndoNode, UndoSnapshot } from "../schemas/undo";
import {
  get,
  getChildren,
  OTHER_BOOKMARKS_ID,
} from "../sync/chrome-bookmarks";
import {
  createBookmark,
  createFolder,
  moveNode,
  MutationError,
} from "../sync/mutations";
import type { MutationErrorCode } from "../sync/mutations";
import { peekLatest } from "./snapshot";

/**
 * Replay half of the undo system (`src/undo/snapshot.ts` is the capture and
 * stack half). {@link undoLatest} pops the newest valid snapshot off the
 * `undo` table and applies it through the guarded mutation service, so the
 * same rules Chrome enforces on user edits apply to restores: a target that
 * became managed in the meantime fails typed rather than slipping an
 * untyped API rejection through.
 *
 * Design rules (locked by tests/unit/undo.test.ts):
 *
 * - **Pop on success.** The `undo` row is deleted only AFTER the restore
 *   completes. A failed restore leaves the row in place — it reports
 *   `{ok:false}` and can be retried (a transient API failure heals on the
 *   next call) or inspected. Restores are not atomic across
 *   `chrome.bookmarks`: a mid-restore failure can leave a partial result,
 *   which the kept row and the next undo attempt converge on.
 * - **LIFO over valid rows.** Reads go through `peekLatest`, which applies
 *   the repository's invalid⇒absent rule — a corrupt row is invisible and
 *   never popped or replayed.
 * - **Id remap.** Recreated nodes get fresh Chrome ids; `idMap` (old id →
 *   new id) covers every recreated node including nested children, and
 *   `meta` rows keyed by a deleted id are rewritten onto the new id via
 *   `putMeta`. A `meta` row whose id is NOT among the snapshotted nodes
 *   belongs to a node that survived — that is how a `merge` snapshot
 *   carries the kept bookmark's pre-merge row — and it is written back
 *   under its own unchanged id (skipped when that node is now gone, so no
 *   orphan rows are manufactured).
 * - **Missing parents fall back.** When a recorded `parentId` no longer
 *   resolves, the node is restored into Other bookmarks ("2") instead and
 *   `fellBackToOther` reports it. A parent that exists but turned managed
 *   is NOT a fallback — the create/move guard rejects `managed`, typed.
 * - **Index clamping.** Recorded indexes are clamped to the destination's
 *   current child count (post-removal capacity for same-parent moves), so
 *   a parent that shrank since the snapshot restores at the end instead of
 *   failing `invalid`.
 * - **Per-kind semantics.**
 *   - `delete` / `merge`: recreate each top-level node at its original
 *     parent+index (children recursively, in captured order), then remap
 *     every meta row. Shared code path — a merge is a delete plus a
 *     surviving kept node's row in `meta`.
 *   - `bulk_move`: move each node back to its recorded parent+index in
 *     ascending index order (restoring low-to-high preserves the original
 *     sibling order). Nodes deleted since the move are skipped — nothing
 *     can move back — and `meta` is never rewritten: moving never changed
 *     it, so restoring stale rows would only clobber later edits.
 *   - `tag_delete`: recreate the `TagDef` through the meta repo (an
 *     already-recreated tag is kept, not collided) and re-add the nameKey
 *     to each listed bookmark's tags — unioned with whatever the row has
 *     now, never clobbering interim edits. Rows for bookmarks that no
 *     longer exist are skipped.
 * - The result is a total union, house pattern: `{ok:true, restoredIds,
 *   idMap, fellBackToOther}` or `{ok:false, code, message}`. Nothing
 *   throws; `MutationError`s map to their own code, `MetaRepoError`s to
 *   theirs, and anything else reports `api`.
 */

/** `code` values on a failed undo: the empty stack plus every typed guard. */
export type UndoFailureCode =
  | "empty"
  | MutationErrorCode
  | MetaRepoErrorCode;

/** A completed restore: which ids were written and whether fallback fired. */
export interface UndoSuccess {
  ok: true;
  /**
   * Ids the restore wrote or moved — NEW Chrome ids for recreated nodes
   * (delete/merge), the moved nodes' own ids for bulk_move, and the
   * affected bookmark ids for tag_delete.
   */
  restoredIds: string[];
  /** Old snapshot id → new Chrome id for every recreated node. */
  idMap: Record<string, string>;
  /** True when at least one node restored into Other bookmarks because its
   * recorded parent was gone. */
  fellBackToOther: boolean;
}

export interface UndoFailure {
  ok: false;
  code: UndoFailureCode;
  message: string;
}

export type UndoResult = UndoSuccess | UndoFailure;

interface RestoreContext {
  restoredIds: string[];
  idMap: Record<string, string>;
  fellBackToOther: boolean;
}

/** Total existence probe — `get` rejects on unknown ids. */
async function nodeExists(id: string): Promise<boolean> {
  try {
    return (await get(id))[0] !== undefined;
  } catch {
    return false;
  }
}

/**
 * The recorded parent, or `OTHER_BOOKMARKS_ID` (flagging the fallback)
 * when that folder is gone.
 */
async function resolveParent(
  parentId: string,
  ctx: RestoreContext,
): Promise<string> {
  if (await nodeExists(parentId)) return parentId;
  ctx.fellBackToOther = true;
  return OTHER_BOOKMARKS_ID;
}

/**
 * Recreate `node` under `parentId` at `index`, then its children in
 * captured order (each clamped to the fresh folder's growth). Records the
 * old→new id pair for every created node.
 */
async function recreateSubtree(
  node: UndoNode,
  parentId: string,
  index: number,
  ctx: RestoreContext,
): Promise<void> {
  const created =
    node.url !== undefined
      ? await createBookmark({
          parentId,
          title: node.title,
          url: node.url,
          index,
        })
      : await createFolder({ parentId, title: node.title, index });
  ctx.idMap[node.id] = created.id;
  ctx.restoredIds.push(created.id);
  let createdCount = 0;
  for (const child of node.children ?? []) {
    // A restored folder starts empty, so the child lands at its recorded
    // index or at the end of what we have recreated so far.
    await recreateSubtree(
      child,
      created.id,
      Math.min(child.index, createdCount),
      ctx,
    );
    createdCount += 1;
  }
}

/**
 * `delete`/`merge` structure pass: recreate every top-level node in
 * ascending index order (independent parents cannot disturb each other;
 * same-parent siblings land low→high so the original order survives
 * clamping).
 */
async function recreateNodes(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  const ordered = [...snapshot.nodes].sort((a, b) => a.index - b.index);
  for (const node of ordered) {
    const parentId = await resolveParent(node.parentId, ctx);
    const siblings = await getChildren(parentId);
    await recreateSubtree(node, parentId, Math.min(node.index, siblings.length), ctx);
  }
}

/**
 * `delete`/`merge` metadata pass. `idMap` covers snapshotted (recreated)
 * ids; any other meta row belongs to a surviving node — for a merge that is
 * exactly the kept bookmark's pre-merge row — and is written back under
 * its own id when that node still exists.
 */
async function restoreMetaRows(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  for (const meta of snapshot.meta) {
    const remapped = ctx.idMap[meta.id];
    if (remapped !== undefined) {
      await putMeta(remapped, {
        tags: meta.tags,
        category: meta.category ?? null,
        notes: meta.notes ?? null,
      });
      continue;
    }
    if (!(await nodeExists(meta.id))) continue; // never manufacture orphans
    await putMeta(meta.id, {
      tags: meta.tags,
      category: meta.category ?? null,
      notes: meta.notes ?? null,
    });
    ctx.restoredIds.push(meta.id);
  }
}

/**
 * `bulk_move`: move each recorded node back to its original parent+index,
 * ascending by index so earlier siblings are reinserted first and later
 * ones land after them. `meta` is deliberately untouched — a move never
 * altered it.
 */
async function restoreMoves(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  const ordered = [...snapshot.nodes].sort((a, b) => a.index - b.index);
  for (const node of ordered) {
    const current = await get(node.id)
      .then((found) => found[0])
      .catch(() => undefined);
    // Deleted since the move — nothing to move back; not a failure.
    if (current === undefined) continue;
    const parentId = await resolveParent(node.parentId, ctx);
    const siblings = await getChildren(parentId);
    // Post-removal indexing: moving within the same parent frees one slot.
    const capacity =
      siblings.length - (current.parentId === parentId ? 1 : 0);
    const index = Math.min(node.index, Math.max(capacity, 0));
    if (current.parentId === parentId && current.index === index) {
      ctx.restoredIds.push(node.id);
      continue; // already back in place
    }
    await moveNode(node.id, { parentId, index });
    ctx.restoredIds.push(node.id);
  }
}

/**
 * `tag_delete`: restore the definition (unless an identical-keyed tag was
 * recreated since — the live def wins) and re-add the nameKey to each
 * listed bookmark's tags, unioned ahead of its current tags so the
 * original ordering is preserved without dropping interim additions.
 * Bookmarks that no longer exist are skipped.
 */
async function restoreTagDelete(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  const tagDef = snapshot.tagDef;
  if (tagDef === undefined) {
    throw new MutationError(
      "invalid",
      "tag_delete snapshot is missing its tagDef.",
    );
  }
  if ((await getTag(tagDef.nameKey)) === undefined) {
    const options: { color?: string; description?: string } = {};
    if (tagDef.color !== undefined) options.color = tagDef.color;
    if (tagDef.description !== undefined) {
      options.description = tagDef.description;
    }
    await createTag(tagDef.name, options);
  }
  for (const meta of snapshot.meta) {
    if (!(await nodeExists(meta.id))) continue;
    const current = await getMeta(meta.id);
    const tags = mergeTags(meta.tags, current?.tags ?? []);
    await patchMeta(meta.id, { tags });
    ctx.restoredIds.push(meta.id);
  }
}

/** `first` followed by the not-already-present entries of `rest`. */
function mergeTags(
  first: readonly string[],
  rest: readonly string[],
): string[] {
  const seen = new Set(first);
  return [...first, ...rest.filter((tag) => !seen.has(tag))];
}

function toFailure(cause: unknown): UndoFailure {
  if (cause instanceof MutationError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  if (cause instanceof MetaRepoError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, code: "api", message };
}

/**
 * Pop the newest valid snapshot and replay it. The `undo` row is deleted
 * only after the restore succeeds (pop-on-success); a failure keeps the
 * row so it can be retried. Returns the union described in the module
 * header — never throws.
 */
export async function undoLatest(): Promise<UndoResult> {
  const snapshot = await peekLatest();
  if (snapshot === undefined) {
    return { ok: false, code: "empty", message: "Nothing to undo." };
  }
  const ctx: RestoreContext = {
    restoredIds: [],
    idMap: {},
    fellBackToOther: false,
  };
  try {
    switch (snapshot.kind) {
      case "delete":
      case "merge":
        // A merge snapshot is a delete restore plus the kept node's
        // pre-merge row riding in `meta` (its id is absent from `nodes`,
        // which is what tells it apart from the losers' rows).
        await recreateNodes(snapshot, ctx);
        await restoreMetaRows(snapshot, ctx);
        break;
      case "bulk_move":
        await restoreMoves(snapshot, ctx);
        break;
      case "tag_delete":
        await restoreTagDelete(snapshot, ctx);
        break;
    }
  } catch (cause) {
    return toFailure(cause);
  }
  if (snapshot.id !== undefined) {
    await db.undo.delete(snapshot.id);
  }
  return {
    ok: true,
    restoredIds: ctx.restoredIds,
    idMap: ctx.idMap,
    fellBackToOther: ctx.fellBackToOther,
  };
}
