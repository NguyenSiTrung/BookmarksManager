import { db } from "../db/database";
import {
  getMeta,
  getTag,
  MetaRepoError,
  patchMeta,
  putMeta,
} from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import { UndoSnapshot } from "../schemas/undo";
import type { UndoMeta, UndoNode } from "../schemas/undo";
import type { BookmarkMeta } from "../schemas/meta";
import type { Category } from "../schemas/bookmark";
import { MERGE_NOTES_SEPARATOR } from "../schemas/meta";
import {
  get,
  getChildren,
  isFolder,
  OTHER_BOOKMARKS_ID,
} from "../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";
import {
  createBookmark,
  createFolder,
  moveNode,
  removeNode,
  MutationError,
  newMutationVerifyCache,
} from "../sync/mutations";
import type { MutationErrorCode, MutationVerifyCache } from "../sync/mutations";
import { UndoLockError, withUndoLock } from "./lock";
import type { UndoLockHold } from "./lock";
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
 *   next call), explicitly dropped via {@link discardLatest} (head) or
 *   {@link discardById} (a specific row), or inspected. Restores are not
 *   atomic across `chrome.bookmarks`: a mid-restore failure can leave a
 *   partial result, which the kept row and the next undo attempt converge
 *   on.
 * - **Serialized.** `undoLatest`/`discardLatest`/`discardById`/`undoExpected`
 *   calls queue on a module-level promise chain, so peek→replay→pop can never
 *   interleave with a second call in THIS context — two concurrent undos
 *   cannot both replay the same row. That local queue is ordering only, never
 *   a substitute for the lock below.
 * - **Locked across contexts.** The promise chain says nothing about the
 *   other extension contexts (options page, service worker), which load their
 *   own copy of these modules over the same database. Every stack operation —
 *   replay and discard alike — runs inside `withUndoLock`
 *   (`src/undo/lock.ts`), i.e. inside ONE origin-scoped exclusive Web Lock
 *   shared by every context, so the read and the pop are atomic against
 *   them: a second context either waits its turn and finds the row gone
 *   (`empty`) or is refused, never replays it a second time. A runtime
 *   without Web Locks, or a rejected/aborted request, refuses typed
 *   (`conflict`) with zero mutations instead of replaying unprotected.
 * - **Targeted replay is atomic too.** {@link undoExpected} checks that the
 *   expected row is still the stack head and replays that exact row inside a
 *   single lock hold, so decision compensation/revert can never pop a
 *   snapshot another context pushed in the meantime; a head that moved
 *   reports `conflict`. The pop always deletes the row that was READ
 *   (`snapshot.id`), never a freshly peeked head.
 * - **Idempotent, resumable replay.** Two mechanisms make a re-run safe:
 *   (a) a top-level snapshot node whose ORIGINAL id still resolves is
 *   skipped outright — Chrome never reuses ids, so a live original means
 *   the node was never deleted (a merge that failed after `pushSnapshot`
 *   but before removals, or a loser whose `removeTree` rejected);
 *   (b) every successful recreate is written back to the row's `idMap`
 *   (old id → new Chrome id) via {@link persistProgress}, so a retry after
 *   a partial restore resumes from the persisted remap instead of
 *   duplicating already-recreated subtrees — fresh Chrome ids make a
 *   naive replay duplicate everything. A persisted mapping whose new node
 *   has itself been deleted is treated as dead and recreated fresh.
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
 *   current child count (post-removal capacity for same-parent moves, the
 *   live child count of a resumed folder), so a parent that shrank since
 *   the snapshot restores at the end instead of failing `invalid`.
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
 *   - `tag_delete`: recreate the `TagDef` verbatim (original `createdAt`
 *     included; an already-recreated tag is kept, not collided) and re-add
 *     ONLY the deleted nameKey to each listed bookmark's tags, inserted at
 *     its recorded position — tags the user removed since the delete must
 *     not be resurrected from the stale snapshot row. Rows already
 *     carrying the key are left untouched (and do not count as restored);
 *     rows for bookmarks that no longer exist are skipped.
 * - The result is a total union, house pattern: `{ok:true, restoredIds,
 *   idMap, fellBackToOther}` or `{ok:false, code, message}`. Nothing
 *   throws — the whole operation (lock acquisition, stack read, replay, pop)
 *   runs inside the failure boundary; `MutationError`s map to their own code,
 *   `MetaRepoError`s to theirs, an unusable lock and a moved head to
 *   `conflict`, and anything else reports `api`.
 */

/** `code` values on a failed undo: the empty stack, the lock/head refusal,
 * and every typed guard. */
export type UndoFailureCode =
  | "empty"
  /**
   * The undo could not run as asked: the extension-wide undo lock is
   * unavailable (no Web Locks, rejected or aborted request), or the row a
   * targeted replay was asked for is no longer the stack head. Refused with
   * zero mutations rather than risking a double replay or popping an
   * unrelated snapshot.
   */
  | "conflict"
  | MutationErrorCode
  | MetaRepoErrorCode;

/** A completed restore: which ids were written and whether fallback fired. */
export interface UndoSuccess {
  ok: true;
  /**
   * Ids the restore wrote or moved — NEW Chrome ids for nodes recreated by
   * THIS call (delete/merge), the moved nodes' own ids for bulk_move, and
   * the affected bookmark ids for tag_delete. Nodes recreated by an
   * earlier failed attempt (persisted in the row's `idMap`) are skipped,
   * not re-reported.
   */
  restoredIds: string[];
  /** Old snapshot id → new Chrome id for every recreated node — including
   * mappings persisted by earlier attempts of the same snapshot. */
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

/** A discarded snapshot's row id — `discardLatest`'s success shape. */
export interface DiscardSuccess {
  ok: true;
  /** Row id of the snapshot dropped without replaying it. */
  discardedId: number;
}

export type DiscardResult = DiscardSuccess | UndoFailure;

interface RestoreContext {
  kind: UndoSnapshot["kind"];
  restoredIds: string[];
  idMap: Record<string, string>;
  fellBackToOther: boolean;
  /** Row id of the snapshot being replayed — progress writes go here. */
  snapshotId?: number;
  /**
   * Per-replay verification cache (D08): every `requireNode`/`writableParent`
   * guard and index check in `src/sync/mutations.ts` resolves through it,
   * so a 5k-node subtree costs one `get`/`getChildren` per DISTINCT
   * ancestor/folder instead of one per node (and one ancestor re-walk per
   * ancestor). Fresh per replay — never shared.
   */
  verify: MutationVerifyCache;
  /** New `idMap` entries not yet flushed to the row by {@link persistProgress}. */
  unpersisted: number;
}

// ---------------------------------------------------------------------------
// Serialization — peek→replay→pop must never interleave between calls
// ---------------------------------------------------------------------------

/**
 * The tail of the stack-operation queue. Each `undoLatest`/`undoExpected`/
 * `discardLatest`/`discardById` call appends its work via {@link serialize};
 * the tail is normalized back to a resolved promise after every task so a
 * (buggy) throwing task can never wedge the queue.
 *
 * This is SAME-CONTEXT ORDERING ONLY. Cross-context exclusion is
 * {@link withUndoLock}'s job; the queue is deliberately not a stand-in for a
 * missing lock (nothing here falls back to running unprotected).
 */
let tail: Promise<void> = Promise.resolve();

/** Run `task` after every previously queued stack operation settles. */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = tail.then(task);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Restructure must prove a node is missing before recreating it or treating
 * its remap as dead. Match the mutation service's missing-ID classification;
 * an unrelated native failure keeps the snapshot rather than making a clone.
 */
async function getRestructureNode(
  id: string,
): Promise<BookmarksTreeNode | undefined> {
  try {
    return (await get(id))[0];
  } catch (cause) {
    if (cause instanceof Error && /can't find bookmark/i.test(cause.message)) {
      return undefined;
    }
    throw new MutationError("api", `chrome.bookmarks get for undo node "${id}" failed.`, {
      cause,
    });
  }
}

/**
 * Legacy probes are total; restructure probes reject ambiguous failures.
 * `expectedUrl` (D12): when the caller knows the URL the id should point
 * at — a snapshot node's recorded url, or a meta row's — a live id whose
 * current URL differs does NOT count as existing (a re-used/repointed id
 * is a different bookmark; its row must not attach there).
 */
async function nodeExists(
  id: string,
  ctx?: RestoreContext,
  expectedUrl?: string,
): Promise<boolean> {
  const node =
    ctx?.kind === "restructure"
      ? await getRestructureNode(id)
      : await get(id)
          .then((found) => found[0])
          .catch(() => undefined);
  if (node === undefined) return false;
  return expectedUrl === undefined || node.url === expectedUrl;
}

/**
 * The recorded parent, or `OTHER_BOOKMARKS_ID` (flagging the fallback)
 * when that folder is gone.
 */
async function resolveParent(
  parentId: string,
  ctx: RestoreContext,
): Promise<string> {
  if (await nodeExists(parentId, ctx)) return parentId;
  ctx.fellBackToOther = true;
  return OTHER_BOOKMARKS_ID;
}

/**
 * Flush the in-flight `idMap` to the snapshot row unconditionally.
 */
async function flushProgress(ctx: RestoreContext): Promise<void> {
  if (ctx.snapshotId === undefined || ctx.unpersisted === 0) return;
  // modify() rather than update(): UpdateSpec's mapped type hits TS2615 on
  // UndoNode's recursive `children`.
  await db.undo
    .where("id")
    .equals(ctx.snapshotId)
    .modify((row) => {
      row.idMap = { ...ctx.idMap };
    });
  ctx.unpersisted = 0;
}

/**
 * Write the in-flight `idMap` back to the snapshot row — the resume anchor
 * that lets a failed restore continue where it stopped instead of
 * duplicating already-recreated nodes on retry.
 *
 * Batched (D08): each `modify` rewrites the WHOLE map, so per-node writes
 * are O(n²) bytes on a big subtree. Progress is therefore flushed every
 * {@link IDMAP_PERSIST_BATCH} new mappings — bounding a hard-kill loss to
 * under a batch — and ALWAYS on a thrown failure (see
 * {@link replaySnapshot}'s catch), so a retried typed failure resumes
 * with no duplicates at all.
 */
async function persistProgress(ctx: RestoreContext): Promise<void> {
  if (ctx.snapshotId === undefined) return;
  ctx.unpersisted += 1;
  if (ctx.unpersisted < IDMAP_PERSIST_BATCH) return;
  await flushProgress(ctx);
}

/** How many new `idMap` entries a restore batches between row writes. */
const IDMAP_PERSIST_BATCH = 50;

/**
 * Live child count of `parentId` — seeded by ONE `getChildren` per folder
 * (D08) and afterwards kept exact by the mutation cache as this module's
 * own creates/moves land. Clamping indexes against this local count is
 * what makes a 5k-node subtree restore read each folder once instead of
 * once per node.
 */
async function childCount(
  parentId: string,
  ctx: RestoreContext,
): Promise<number> {
  const known = ctx.verify.childCounts.get(parentId);
  if (known !== undefined) return known;
  const count = (await getChildren(parentId)).length;
  ctx.verify.childCounts.set(parentId, count);
  return count;
}

/**
 * Recreate `node` under `parentId` at `index`, then its children in
 * captured order (each clamped to the folder's LIVE child count, so a
 * resumed folder that already holds children from an earlier attempt slots
 * the rest correctly). A node already present in `ctx.idMap` — recreated
 * by an earlier attempt — is not created again; its mapped id simply
 * becomes the parent for the child pass. Records/persists the old→new id
 * pair for every created node.
 */
async function recreateSubtree(
  node: UndoNode,
  parentId: string,
  index: number,
  ctx: RestoreContext,
): Promise<void> {
  let createdId = ctx.idMap[node.id];
  if (
    createdId !== undefined &&
    !(await nodeExists(createdId, ctx, node.url))
  ) {
    // An earlier attempt's recreation has itself been removed since —
    // the persisted mapping is dead; recreate the node fresh.
    delete ctx.idMap[node.id];
    createdId = undefined;
  }
  if (createdId === undefined) {
    const created =
      node.url !== undefined
        ? await createBookmark(
            {
              parentId,
              title: node.title,
              url: node.url,
              index,
            },
            ctx.verify,
          )
        : await createFolder(
            { parentId, title: node.title, index },
            ctx.verify,
          );
    createdId = created.id;
    ctx.idMap[node.id] = createdId;
    ctx.restoredIds.push(createdId);
    // A folder we just created is empty by construction — seed its child
    // count instead of paying a `getChildren` read for it (D08).
    if (node.url === undefined) ctx.verify.childCounts.set(createdId, 0);
    await persistProgress(ctx);
  }
  for (const child of node.children ?? []) {
    const count = await childCount(createdId, ctx);
    await recreateSubtree(
      child,
      createdId,
      Math.min(child.index, count),
      ctx,
    );
  }
}

/**
 * `delete`/`merge` structure pass: recreate every top-level node in
 * ascending index order (independent parents cannot disturb each other;
 * same-parent siblings land low→high so the original order survives
 * clamping). A node whose ORIGINAL id still resolves was never deleted —
 * Chrome never reuses ids — so replaying it would duplicate a live
 * bookmark (merge applied after pushSnapshot failures, losers whose
 * removeTree rejected): skip it.
 */
async function recreateNodes(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  const ordered = [...snapshot.nodes].sort((a, b) => a.index - b.index);
  for (const node of ordered) {
    // never deleted — do not clone; a repointed id is a different
    // bookmark and takes the recreate path (D12 url check)
    if (await nodeExists(node.id, undefined, node.url)) continue;
    const parentId = await resolveParent(node.parentId, ctx);
    const count = await childCount(parentId, ctx);
    await recreateSubtree(node, parentId, Math.min(node.index, count), ctx);
  }
}

/**
 * A merge survivor's undo row (D09): `recorded` is the kept bookmark's
 * PRE-merge row; the live row holds the merge's own writes PLUS whatever
 * the user edited afterwards. Writing the recorded row back wholesale
 * would silently clobber those edits — so the result is
 * `recorded ∪ (current − merged)`, where `merged` is the merge's own
 * survivor write recomputed from the recorded member rows exactly as
 * `mergeMemberMeta` built it (kept-first tag union, verbatim note join,
 * first-found category). A current tag/segment the merge did not write is
 * a post-merge edit and survives; one the merge wrote reverts with it.
 * Category follows the same rule: the recorded value when set, else the
 * current one only if it differs from the borrowed `merged` value (a user
 * change, not the merge's). Summary is never written by the merge, so the
 * recorded value wins when present and the current survives otherwise.
 * Known limit: a union cannot express "user deleted one of the merged
 * fields" — a field absent from `current` simply reverts with the merge.
 */
function mergeSurvivorMeta(
  recorded: UndoMeta,
  members: readonly UndoMeta[],
  current: BookmarkMeta | undefined,
): {
  tags: string[];
  category: Category | null;
  notes: string | null;
  summary: string | null;
  url: string | null;
} {
  // The merge's own survivor write — kept row first, then the rest in
  // recorded order (capture order == the group order mergeMemberMeta saw).
  const mergedTags = new Set<string>();
  const mergedSegments = new Set<string>();
  let mergedCategory: Category | undefined;
  const rows = [
    recorded,
    ...members.filter((member) => member.id !== recorded.id),
  ];
  for (const row of rows) {
    for (const tag of row.tags) mergedTags.add(tag);
    for (const segment of (row.notes ?? "")
      .split(MERGE_NOTES_SEPARATOR)
      .filter((segment) => segment.length > 0)) {
      mergedSegments.add(segment);
    }
    if (mergedCategory === undefined && row.category !== undefined) {
      mergedCategory = row.category;
    }
  }

  const recordedSegments = (recorded.notes ?? "")
    .split(MERGE_NOTES_SEPARATOR)
    .filter((segment) => segment.length > 0);
  const tagEdits = (current?.tags ?? []).filter(
    (tag) => !mergedTags.has(tag),
  );
  const noteEdits = (current?.notes ?? "")
    .split(MERGE_NOTES_SEPARATOR)
    .filter((segment) => segment.length > 0)
    .filter(
      (segment) =>
        !mergedSegments.has(segment) && !recordedSegments.includes(segment),
    );

  const segments = [...recordedSegments, ...noteEdits];
  return {
    tags: [...new Set([...recorded.tags, ...tagEdits])],
    category:
      recorded.category ??
      (current?.category !== undefined && current.category !== mergedCategory
        ? current.category
        : null),
    notes: segments.length > 0 ? segments.join(MERGE_NOTES_SEPARATOR) : null,
    summary: recorded.summary ?? current?.summary ?? null,
    url: current?.url ?? recorded.url ?? null,
  };
}

/**
 * `delete`/`merge` metadata pass. `idMap` covers snapshotted (recreated)
 * ids; any other meta row belongs to a surviving node — for a merge that is
 * exactly the kept bookmark's pre-merge row. A surviving row of a `merge`
 * snapshot is MERGED with the live row (D09 — post-merge edits survive);
 * every other survivor row is written back wholesale.
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
        summary: meta.summary ?? null,
        url: meta.url ?? null,
      });
      continue;
    }
    // never manufacture orphans; the url check (D12) keeps a meta row
    // from attaching to a re-used id pointing at a different bookmark
    if (!(await nodeExists(meta.id, undefined, meta.url))) continue;
    if (snapshot.kind === "merge") {
      const current = await getMeta(meta.id);
      await putMeta(meta.id, mergeSurvivorMeta(meta, snapshot.meta, current));
    } else {
      await putMeta(meta.id, {
        tags: meta.tags,
        category: meta.category ?? null,
        notes: meta.notes ?? null,
        summary: meta.summary ?? null,
        url: meta.url ?? null,
      });
    }
    ctx.restoredIds.push(meta.id);
  }
}

/**
 * `bulk_move`/`restructure`: move each recorded node back to its original parent+index,
 * ascending by index so earlier siblings are reinserted first and later
 * ones land after them. `meta` is deliberately untouched — a move never
 * altered it. Only restructure recreates missing captured nodes, using
 * the same durable idMap as delete/merge restores.
 */
async function restoreMoves(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  const ordered = [...snapshot.nodes].sort((a, b) => a.index - b.index);
  for (const node of ordered) {
    const found =
      snapshot.kind === "restructure"
        ? await getRestructureNode(node.id)
        : await get(node.id)
            .then((nodes) => nodes[0])
            .catch(() => undefined);
    // A live id pointing at a different URL is not this node (D12).
    const current =
      found !== undefined &&
      (node.url === undefined || found.url === node.url)
        ? found
        : undefined;
    if (current === undefined) {
      // A plain move skips deleted nodes; restructure must recover them.
      if (snapshot.kind !== "restructure") continue;
      const parentId = await resolveParent(node.parentId, ctx);
      const count = await childCount(parentId, ctx);
      await recreateSubtree(node, parentId, Math.min(node.index, count), ctx);
      continue;
    }
    if (
      node.movedToParentId !== undefined &&
      current.parentId !== node.movedToParentId
    ) {
      // The node no longer sits where this move left it — the user (or
      // another flow) moved it AGAIN since. Undoing the recorded move would
      // clobber that newer placement; skip it (D09).
      continue;
    }
    const parentId = await resolveParent(node.parentId, ctx);
    // Post-removal indexing: moving within the same parent frees one slot.
    const capacity =
      (await childCount(parentId, ctx)) -
      (current.parentId === parentId ? 1 : 0);
    const index = Math.min(node.index, Math.max(capacity, 0));
    if (current.parentId === parentId && current.index === index) {
      ctx.restoredIds.push(node.id);
      continue; // already back in place
    }
    await moveNode(node.id, { parentId, index }, ctx.verify);
    ctx.restoredIds.push(node.id);
  }
}

/**
 * `restructure`: replay the recorded moves back to their original parents,
 * recreating missing captured nodes and restoring only their metadata.
 * Surviving nodes keep their later metadata edits. Remove each created folder iff
 * it still exists, is a folder, and is empty (a folder the user has since
 * filed into is kept). Removed-first ordering is bottom-up so a parent is
 * only removed after its created children.
 */
async function restoreRestructure(
  snapshot: UndoSnapshot,
  ctx: RestoreContext,
): Promise<void> {
  await restoreMoves(snapshot, ctx);
  for (const meta of snapshot.meta) {
    const remapped = ctx.idMap[meta.id];
    if (remapped === undefined) continue;
    await putMeta(remapped, {
      tags: meta.tags,
      category: meta.category ?? null,
      notes: meta.notes ?? null,
      summary: meta.summary ?? null,
    });
  }
  for (const id of [...(snapshot.createdFolderIds ?? [])].reverse()) {
    const current = await getRestructureNode(id);
    if (current === undefined) {
      ctx.restoredIds.push(id); // already gone — nothing to remove
      continue;
    }
    if (!isFolder(current)) continue;
    // A failed read retains the snapshot for retry, never means "empty".
    const children = await getChildren(id);
    if (children.length > 0) continue; // user filed into it since — keep
    // Chrome's non-recursive remove protects even a racing child insertion.
    await removeNode(id);
    // `removeNode` is not cache-aware (guard must read live children): the
    // removal shrinks the folder's parent — drop the seeded count so the
    // next writer re-reads it instead of clamping against a stale high
    // water mark.
    if (current.parentId !== undefined) {
      ctx.verify.childCounts.delete(current.parentId);
    }
    ctx.restoredIds.push(id);
  }
}

/**
 * `tag_delete`: restore the definition verbatim — original `createdAt`
 * included — unless an identical-keyed tag was recreated since (the live
 * def wins, no collision). Then re-add ONLY the deleted nameKey to each
 * listed bookmark's tags, inserted at the position it held in the
 * pre-delete row so the original ordering is approximated without
 * resurrecting tags the user removed since. Rows already carrying the key
 * and bookmarks that no longer exist are skipped (and do not count toward
 * `restoredIds`).
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
    // Verbatim restore of the snapshotted def (schema-validated on write
    // and on read) — `createTag` would stamp a fresh createdAt. The
    // recheck inside the transaction keeps a concurrently recreated def
    // winning instead of being overwritten.
    await db.transaction("rw", db.tags, async () => {
      if ((await getTag(tagDef.nameKey)) === undefined) {
        await db.tags.put({ ...tagDef });
      }
    });
  }
  for (const meta of snapshot.meta) {
    if (!(await nodeExists(meta.id, undefined, meta.url))) continue;
    const current = await getMeta(meta.id);
    if (current !== undefined && current.tags.includes(tagDef.nameKey)) {
      continue; // already re-added — nothing changes
    }
    const tags = [...(current?.tags ?? [])];
    const recorded = meta.tags.indexOf(tagDef.nameKey);
    // Insert where the key sat in the pre-delete list, clamped to the
    // current list; not found (defensive) → append.
    const at = recorded < 0 ? tags.length : Math.min(recorded, tags.length);
    tags.splice(at, 0, tagDef.nameKey);
    await patchMeta(meta.id, {
      tags,
      ...(meta.url === undefined ? {} : { url: meta.url }),
    });
    ctx.restoredIds.push(meta.id);
  }
}

function toFailure(cause: unknown): UndoFailure {
  if (cause instanceof UndoLockError) {
    // No lock, no replay: refused typed with zero mutations (see lock.ts).
    return { ok: false, code: "conflict", message: cause.message };
  }
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
 * row — including its persisted `idMap` progress — so a retry resumes
 * instead of replaying. The whole operation runs inside one hold of the
 * extension-wide undo lock, queued behind earlier calls in this context, and
 * returns the union described in the module header — never throws.
 */
export function undoLatest(hold?: UndoLockHold): Promise<UndoResult> {
  return serialize(() =>
    withUndoLock(runUndoLatest, hold).catch(toFailure),
  );
}

async function runUndoLatest(): Promise<UndoResult> {
  try {
    const snapshot = await peekLatest();
    if (snapshot === undefined) {
      return { ok: false, code: "empty", message: "Nothing to undo." };
    }
    return await replaySnapshot(snapshot);
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Replay ONE already-read snapshot row and pop it (pop-on-success). Throws on
 * any failure — the entry points below own the failure boundary — and always
 * pops the row that was READ (`snapshot.id`), never a freshly peeked head:
 * that is what makes a targeted replay safe against a snapshot another
 * context pushes mid-flight.
 */
async function replaySnapshot(snapshot: UndoSnapshot): Promise<UndoResult> {
  const ctx: RestoreContext = {
    kind: snapshot.kind,
    restoredIds: [],
    // Progress persisted by an earlier failed attempt resumes the
    // replay where it stopped.
    idMap: { ...(snapshot.idMap ?? {}) },
    fellBackToOther: false,
    snapshotId: snapshot.id,
    // Fresh per replay: cached verifications must never leak into the
    // next operation (D08).
    verify: newMutationVerifyCache(),
    unpersisted: 0,
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
      case "restructure":
        await restoreRestructure(snapshot, ctx);
        break;
      case "tag_delete":
        await restoreTagDelete(snapshot, ctx);
        break;
    }
    if (snapshot.id !== undefined) {
      await db.undo.delete(snapshot.id);
    }
  } catch (cause) {
    // Progress writes are batched (D08) — flush the tail now so a retried
    // typed failure (replay OR the pop itself) resumes with ZERO
    // duplicates. A flush failure must not mask the real one.
    await flushProgress(ctx).catch(() => undefined);
    throw cause;
  }
  return {
    ok: true,
    restoredIds: ctx.restoredIds,
    idMap: ctx.idMap,
    fellBackToOther: ctx.fellBackToOther,
  };
}

/**
 * Replay the SPECIFIC snapshot row `snapshotId` — but only if it is still the
 * stack head, checked and replayed inside ONE hold of the extension-wide undo
 * lock. This is the atomic replacement for a `peekLatest()` +
 * `undoLatest()` pair: with two separate calls another context can push or
 * pop a snapshot in between, and the replay would then pop whatever the stack
 * happens to hold instead of the row that was verified (B13).
 *
 * Behaviour matches {@link undoLatest} in every other respect (same replay
 * kinds, same pop-on-success, same persisted `idMap` resume, same failure
 * codes); a head that is not `snapshotId` — including a stack that became
 * empty — reports `conflict` and mutates nothing. Never throws.
 */
export function undoExpected(
  snapshotId: number,
  hold?: UndoLockHold,
): Promise<UndoResult> {
  return serialize(() =>
    withUndoLock(() => runUndoExpected(snapshotId), hold).catch(toFailure),
  );
}

/**
 * Replay the SPECIFIC snapshot row `snapshotId` wherever it sits on the
 * stack (D07) — the toast/palette counterpart of {@link undoExpected} for
 * flows that recorded WHICH action they announced: deleting in panel A
 * then moving in panel B leaves A's delete below B's move, and A's Undo
 * must still revert exactly the delete it advertised, not whatever the
 * head happens to be. Same serialization + lock + pop-on-success as every
 * other replay; a missing/corrupt row reports `empty`. Never throws.
 */
export function restoreById(
  snapshotId: number,
  hold?: UndoLockHold,
): Promise<UndoResult> {
  return serialize(() =>
    withUndoLock(() => runRestoreById(snapshotId), hold).catch(toFailure),
  );
}

async function runRestoreById(snapshotId: number): Promise<UndoResult> {
  try {
    const row = await db.undo.get(snapshotId);
    const parsed = row === undefined ? undefined : UndoSnapshot.safeParse(row);
    if (row === undefined || parsed === undefined || !parsed.success) {
      // Already consumed/popped — or corrupt, which the repository's
      // invalid⇒absent rule reads the same way.
      return {
        ok: false,
        code: "empty",
        message: "That change was already undone.",
      };
    }
    return await replaySnapshot(parsed.data);
  } catch (cause) {
    return toFailure(cause);
  }
}

async function runUndoExpected(snapshotId: number): Promise<UndoResult> {
  try {
    const head = await peekLatest();
    if (head?.id !== snapshotId) {
      return {
        ok: false,
        code: "conflict",
        message:
          `Snapshot ${snapshotId} is not the top of the undo stack; ` +
          `replay refused.`,
      };
    }
    return await replaySnapshot(head);
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Drop the newest valid snapshot WITHOUT replaying it — the explicit
 * escape hatch for a head that can never restore (e.g. its recorded parent
 * has since become managed, or the snapshot predates this build's
 * fixed-root capture guard), which pop-on-success would otherwise wedge
 * atop the stack forever. Runs inside the extension-wide undo lock, like
 * every other stack mutation: a discard must not slip past another
 * context's replay, or it could drop the row that replay is about to pop.
 * The row below the discarded head becomes the next undo target. Never
 * throws.
 */
export function discardLatest(hold?: UndoLockHold): Promise<DiscardResult> {
  return serialize(() =>
    withUndoLock(async (): Promise<DiscardResult> => {
      try {
        const snapshot = await peekLatest();
        if (snapshot === undefined || snapshot.id === undefined) {
          return { ok: false, code: "empty", message: "Nothing to discard." };
        }
        await db.undo.delete(snapshot.id);
        return { ok: true, discardedId: snapshot.id };
      } catch (cause) {
        return toFailure(cause);
      }
    }, hold).catch(toFailure),
  );
}

/**
 * Drop the SPECIFIC snapshot row `id` WITHOUT replaying it — the targeted
 * counterpart of {@link discardLatest} for flows that push a snapshot and
 * only later learn the mutation was a no-op. Discarding by the row id
 * `pushSnapshot` returned keeps one flow's cleanup from dropping an
 * UNRELATED snapshot a concurrent flow pushed on top: `pushSnapshot` is not
 * part of the serialized stack queue, so a flow's `discardLatest()` can
 * otherwise pop another flow's head. Serialized with `undoLatest`/
 * `discardLatest` and taken under the same extension-wide undo lock; a
 * missing row reports `empty` and never throws.
 */
export function discardById(
  id: number,
  hold?: UndoLockHold,
): Promise<DiscardResult> {
  return serialize(() =>
    withUndoLock(async (): Promise<DiscardResult> => {
      try {
        const row = await db.undo.get(id);
        if (row === undefined) {
          return { ok: false, code: "empty", message: "Nothing to discard." };
        }
        await db.undo.delete(id);
        return { ok: true, discardedId: id };
      } catch (cause) {
        return toFailure(cause);
      }
    }, hold).catch(toFailure),
  );
}
