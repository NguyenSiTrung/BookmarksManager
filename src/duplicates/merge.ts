import {
  deleteMetaByIds,
  getMetaByIds,
  MetaRepoError,
  patchMeta,
} from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import type { Category } from "../schemas/bookmark";
import type { BookmarkMeta } from "../schemas/meta";
import { MERGE_NOTES_SEPARATOR, NOTES_MAX_LENGTH } from "../schemas/meta";
import type { UndoMeta, UndoNode, UndoOrigin } from "../schemas/undo";
import { get } from "../sync/chrome-bookmarks";
import { MutationError, removeTree } from "../sync/mutations";
import type { MutationErrorCode } from "../sync/mutations";
import { discardById } from "../undo/restore";
import { captureSubtree, pushSnapshot } from "../undo/snapshot";
import type { DuplicateCandidate, DuplicateGroup } from "./group";
import { normalizeUrl } from "./normalize";

/**
 * "Keep this one" merge for a duplicate group (spec §6): union the group's
 * tags onto the kept bookmark, join the members' notes with
 * {@link MERGE_NOTES_SEPARATOR}, keep the kept item's category (else the
 * first one found among the others), then delete the others.
 *
 * Design rules (locked by tests/unit/duplicates-merge.test.ts):
 *
 * - **Snapshot FIRST.** Before any mutation, every non-kept member is
 *   deep-captured via `captureSubtree` (full node + subtree meta) and the
 *   kept node's pre-merge meta row is appended to `meta` — its id is absent
 *   from `nodes`, which is exactly what makes `restore.ts` treat it as a
 *   SURVIVOR row written back under its own id. A member that vanished
 *   between grouping and merging is skipped (nothing to snapshot, nothing
 *   to remove). When the kept bookmark had no meta row at all, an EMPTY
 *   survivor row (`{id, tags: [], updatedAt}`) is pushed instead: on undo,
 *   `putMeta` resolves it to an empty field set and the lazy-row rule
 *   DELETES the merged row — a true pre-merge restore rather than leaving
 *   the unioned data behind.
 * - **Leaf losers only.** Duplicate groups are bookmark-only: a group
 *   member whose live node is a FOLDER (capture came back with no `url`)
 *   rejects `invalid` before the snapshot is even pushed — `removeTree` on
 *   a folder would delete its whole subtree (the kept node included, if the
 *   folder is its ancestor) while `deleteMetaByIds` missed every
 *   descendant's row.
 * - **Field order is kept-first.** Members are read in the order
 *   `[keepId, ...others in group order]`, so the union puts the kept
 *   bookmark's tags first and its note leads the joined notes; category is
 *   the kept item's when set, else the first found among the others in
 *   group order. Only rows belonging to the kept node or to members whose
 *   capture SUCCEEDED feed the union — a vanished member's stale row would
 *   otherwise leak its tags/notes onto the kept bookmark. Stored `tags`
 *   are nameKeys — merged output stays in nameKeys (patchMeta
 *   re-normalizes anyway).
 * - **Drifted members are dropped, not merged (D02).** A member whose live
 *   URL no longer matches the kept node's normalized key — it was edited
 *   between grouping and merging — is dropped: its node stays, its meta
 *   rows are neither snapshotted nor unioned (merging a different page's
 *   data onto the kept bookmark would be silent clobbering). Dropped ids
 *   are reported on {@link MergeSuccess.droppedIds}.
 * - **Notes join.** Non-empty `notes` values are joined verbatim with
 *   {@link MERGE_NOTES_SEPARATOR}; members with no row, no notes, or an
 *   empty-string note contribute no segment. The joined result is
 *   pre-validated against {@link NOTES_MAX_LENGTH} BEFORE the snapshot is
 *   pushed — an over-cap merge refuses `invalid_meta` with nothing mutated
 *   and nothing on the undo stack (D03).
 * - **The kept node must exist and be a leaf.** `patchMeta` lazily creates
 *   rows, so a stale `keepId` would grow an orphan meta row — the function
 *   reports `not_found` before touching anything instead; a folder keepId
 *   reports `invalid`.
 * - **Removals before the survivor write (D03).** Losers are removed first
 *   and their meta rows deleted; only then does `patchMeta` write the
 *   merged fields onto the kept node. A merge that fails before/during
 *   removals therefore leaves the kept row untouched — undo only restores
 *   removed losers — and a retry can never re-append already-merged notes
 *   onto an already-merged kept row.
 * - **A nothing-changed failure discards its snapshot (D03).** When no
 *   loser was removed, the pushed snapshot describes a merge that never
 *   happened; it is deleted by id so the undo stack stays honest and the
 *   retry starts clean.
 * - **No-op merges push nothing.** Every member vanished or drifted →
 *   success with `removedIds: []`, `snapshotId: undefined` — an empty
 *   snapshot could only clobber the kept row's meta on undo.
 * - **Mutations go through the guarded service.** `removeTree` enforces
 *   root/managed/not_found rules per loser; a rejection mid-list leaves a
 *   partial merge that the already-pushed snapshot still covers — undo
 *   restores whatever was removed plus the kept node's pre-merge meta.
 * - **Sidecar cleanup is explicit.** Meta rows for removed losers are
 *   deleted by this function rather than left to the `onRemoved` cascade
 *   listener: "delete the others" includes their extension metadata, and a
 *   caller must not depend on listener registration or its async timing.
 *   (The cascade delete is idempotent, so a registered listener is a
 *   harmless second pass.)
 * - **Total result union.** Never throws: input misuse reports `invalid`,
 *   a missing kept node `not_found`, `MutationError`s map to their own
 *   codes, `MetaRepoError`s to theirs, anything else to `api`.
 */

/**
 * Segment placed between the non-empty notes of merged members —
 * `"\n\n---\n\n"`, a blank-line-flanked Markdown horizontal rule — the
 * constant itself lives in `src/schemas/meta.ts` (the undo restore's
 * survivor-merge needs it too, and importing it from here would create a
 * `restore → merge → restore` cycle). Re-exported for existing importers.
 */
export { MERGE_NOTES_SEPARATOR } from "../schemas/meta";

/** `code` values on a failed merge: the guards plus every typed write error. */
export type MergeFailureCode =
  | MutationErrorCode // "root" | "managed" | "not_found" | "invalid" | "api"
  | MetaRepoErrorCode; // "tag_exists" | "invalid_tag" | "invalid_meta"

/** The resolved field set written onto the kept bookmark (summary UI copy). */
export interface MergedMetaValues {
  /** Unioned tag nameKeys — kept member's first, then others in group order. */
  tags: string[];
  /** Kept member's category when set, else the first found among the others. */
  category?: Category;
  /** Non-empty notes joined with {@link MERGE_NOTES_SEPARATOR}, kept first. */
  notes?: string;
}

export interface MergeSuccess {
  ok: true;
  keptId: string;
  /** Non-kept members actually removed (vanished members are skipped). */
  removedIds: string[];
  /**
   * Members dropped because their live URL no longer matches the kept
   * node's key — edited since grouping (D02). They keep their nodes and
   * their meta; they are simply not part of this merge anymore.
   */
  droppedIds: string[];
  mergedMeta: MergedMetaValues;
  /**
   * The `merge` snapshot pushed for undo (D04) — `undefined` when the
   * merge was a no-op (every member vanished or drifted; nothing to
   * restore). Callers record THIS id; never `peekLatest()` — a concurrent
   * push could move the stack head in between.
   */
  snapshotId?: number;
}

export interface MergeFailure {
  ok: false;
  code: MergeFailureCode;
  message: string;
}

export type MergeResult = MergeSuccess | MergeFailure;

/**
 * Merge `group` into its member `keepId`: snapshot, write the merged field
 * set onto the kept bookmark, then delete the other members (nodes and
 * meta rows). Returns the union described in the module header — never
 * throws.
 */
export async function mergeGroup<T extends DuplicateCandidate>(
  group: DuplicateGroup<T>,
  keepId: string,
  /** D05: retention bucket for the pushed snapshot. Defaults to `user`. */
  origin: UndoOrigin = "user",
): Promise<MergeResult> {
  if (group.items.length < 2) {
    return {
      ok: false,
      code: "invalid",
      message: "A merge group needs at least two members.",
    };
  }
  if (!group.items.some((item) => item.id === keepId)) {
    return {
      ok: false,
      code: "invalid",
      message: `keepId "${keepId}" is not a member of this group.`,
    };
  }
  const others = [
    ...new Set(
      group.items.filter((item) => item.id !== keepId).map((item) => item.id),
    ),
  ];

  // patchMeta lazily creates a row — refuse before it can grow an orphan.
  // The live kept node is also the drift anchor: every member must still
  // resolve to the same normalized key it was grouped under (D02).
  const keptNode = await get(keepId)
    .then((nodes) => nodes[0])
    .catch(() => undefined);
  if (keptNode === undefined) {
    return {
      ok: false,
      code: "not_found",
      message: `Kept bookmark "${keepId}" does not exist.`,
    };
  }
  if (keptNode.url === undefined) {
    return {
      ok: false,
      code: "invalid",
      message:
        `Kept member "${keepId}" is a folder — ` +
        `merge only accepts leaf bookmarks.`,
    };
  }

  const removedIds: string[] = [];
  try {
    // Kept-first member order drives every merged field below.
    const memberMeta = await getMetaByIds([keepId, ...others]);

    // --- Snapshot: losers' full nodes + all touched meta rows. ---
    const nodes: UndoNode[] = [];
    const meta: UndoMeta[] = [];
    const captured: string[] = [];
    const droppedIds: string[] = [];
    for (const id of others) {
      const capture = await captureSubtree(id);
      if (capture === undefined) continue; // vanished — nothing to restore
      if (capture.node.url === undefined) {
        // A folder loser would make removeTree delete its whole subtree —
        // the kept node included when the folder is its ancestor — while
        // deleteMetaByIds missed the descendants' rows. Groups are
        // bookmark-only; reject before anything is pushed or mutated.
        return {
          ok: false,
          code: "invalid",
          message:
            `Group member "${id}" is a folder, not a bookmark — ` +
            `merge only accepts leaf bookmarks.`,
        };
      }
      if (!urlsStillMatch(capture.node.url, keptNode.url)) {
        // Edited since grouping — the page that was grouped no longer
        // exists under this id. Drop it whole: keep its node, keep its
        // meta rows out of the snapshot AND the union (a different page's
        // data must not be restored onto it by undo, nor folded onto the
        // kept bookmark).
        droppedIds.push(id);
        continue;
      }
      nodes.push(capture.node);
      meta.push(...capture.meta);
      captured.push(id);
    }
    const capturedIds = new Set(captured);
    const keptMeta = memberMeta.find((row) => row.id === keepId);
    // Survivor row for the kept node: its pre-merge meta, or an EMPTY row so
    // undo deletes the merged row when there was nothing before (see header).
    meta.push(
      keptMeta ?? {
        id: keepId,
        tags: [],
        updatedAt: new Date().toISOString(),
      },
    );

    // --- Merged field set: union of the kept row + captured members only —
    // a vanished member's stale row must not leak onto the kept one.
    const merged = mergeMemberMeta(
      memberMeta.filter(
        (row) => row.id === keepId || capturedIds.has(row.id),
      ),
    );

    if (captured.length === 0) {
      // Every member vanished or drifted — nothing to remove, nothing to
      // union. A snapshot would only clobber the kept row's meta on undo,
      // so this merge pushes none (no-op success).
      return {
        ok: true,
        keptId: keepId,
        removedIds,
        droppedIds,
        mergedMeta: merged,
      };
    }

    // D03: refuse over-cap notes BEFORE the snapshot is pushed — the merge
    // must fail with nothing mutated and nothing left on the undo stack.
    if (merged.notes !== undefined && merged.notes.length > NOTES_MAX_LENGTH) {
      return {
        ok: false,
        code: "invalid_meta",
        message:
          `Merged notes are ${merged.notes.length} characters — ` +
          `the ${NOTES_MAX_LENGTH}-character cap would be exceeded.`,
      };
    }

    const snapshotId = await pushSnapshot({
      kind: "merge",
      nodes,
      meta,
      origin,
    });

    try {
      // --- Apply: remove the losers first; the survivor write is LAST
      // (D03). A failure before or during removals leaves kept meta
      // untouched, and a retried merge can never double-append already-
      // merged notes onto the kept row.
      for (const id of captured) {
        await removeTree(id);
        removedIds.push(id);
      }
      await deleteMetaByIds(removedIds);
      await patchMeta(keepId, {
        tags: merged.tags,
        category: merged.category ?? null,
        notes: merged.notes ?? null,
      });
      return {
        ok: true,
        keptId: keepId,
        removedIds,
        droppedIds,
        mergedMeta: merged,
        snapshotId,
      };
    } catch (cause) {
      // Whatever was already removed must not leave its meta rows behind.
      await deleteMetaByIds(removedIds).catch(() => {});
      if (removedIds.length === 0) {
        // Nothing changed — the snapshot describes a merge that never
        // happened. Discard it BY ID (never the head) so the stack stays
        // honest and the retry starts clean (D03).
        await discardById(snapshotId).catch(() => {});
      }
      return toMergeFailure(cause);
    }
  } catch (cause) {
    return toMergeFailure(cause);
  }
}

/**
 * Whether a member's live URL still identifies the page the group was
 * formed around: both sides compared under the same normalized key the
 * grouping used, raw equality when either URL has no normalized form
 * (non-http(s), unparseable). Anything else means the member was edited
 * into a different page since grouping — it is dropped, not merged (D02).
 */
function urlsStillMatch(memberUrl: string, keptUrl: string): boolean {
  const memberKey = normalizeUrl(memberUrl);
  const keptKey = normalizeUrl(keptUrl);
  if (memberKey !== null && keptKey !== null) {
    return memberKey === keptKey;
  }
  return memberUrl === keptUrl;
}

/**
 * Resolve the merged field set from member meta rows in member order
 * (`keepId` first, then the others in group order — {@link getMetaByIds}
 * preserves input order). One pass yields kept-first tag union and note
 * join, and first-found category.
 */
function mergeMemberMeta(rows: readonly BookmarkMeta[]): MergedMetaValues {
  const seen = new Set<string>();
  const tags: string[] = [];
  const notes: string[] = [];
  let category: Category | undefined;
  for (const row of rows) {
    for (const tag of row.tags) {
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
    if (row.notes !== undefined && row.notes !== "") {
      notes.push(row.notes);
    }
    if (category === undefined && row.category !== undefined) {
      category = row.category;
    }
  }
  const merged: MergedMetaValues = { tags };
  if (category !== undefined) merged.category = category;
  if (notes.length > 0) merged.notes = notes.join(MERGE_NOTES_SEPARATOR);
  return merged;
}

function toMergeFailure(cause: unknown): MergeFailure {
  if (cause instanceof MutationError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  if (cause instanceof MetaRepoError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, code: "api", message };
}
