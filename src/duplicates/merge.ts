import {
  deleteMetaByIds,
  getMetaByIds,
  MetaRepoError,
  patchMeta,
} from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import type { Category } from "../schemas/bookmark";
import type { BookmarkMeta } from "../schemas/meta";
import type { UndoMeta, UndoNode } from "../schemas/undo";
import { get } from "../sync/chrome-bookmarks";
import { MutationError, removeTree } from "../sync/mutations";
import type { MutationErrorCode } from "../sync/mutations";
import { captureSubtree, pushSnapshot } from "../undo/snapshot";
import type { DuplicateCandidate, DuplicateGroup } from "./group";

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
 * - **Field order is kept-first.** Members are read in the order
 *   `[keepId, ...others in group order]`, so the union puts the kept
 *   bookmark's tags first and its note leads the joined notes; category is
 *   the kept item's when set, else the first found among the others in
 *   group order. Stored `tags` are nameKeys — merged output stays in
 *   nameKeys (patchMeta re-normalizes anyway).
 * - **Notes join.** Non-empty `notes` values are joined verbatim with
 *   {@link MERGE_NOTES_SEPARATOR}; members with no row, no notes, or an
 *   empty-string note contribute no segment.
 * - **The kept node must exist.** `patchMeta` lazily creates rows, so a
 *   stale `keepId` would grow an orphan meta row — the function reports
 *   `not_found` before touching anything instead.
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
 * `"\n\n---\n\n"`, a blank-line-flanked Markdown horizontal rule. Readable
 * as a divider in plain text and renders as one wherever notes are shown
 * as Markdown.
 */
export const MERGE_NOTES_SEPARATOR = "\n\n---\n\n";

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
  mergedMeta: MergedMetaValues;
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
  const keptExists = await get(keepId)
    .then((nodes) => nodes[0] !== undefined)
    .catch(() => false);
  if (!keptExists) {
    return {
      ok: false,
      code: "not_found",
      message: `Kept bookmark "${keepId}" does not exist.`,
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
    for (const id of others) {
      const capture = await captureSubtree(id);
      if (capture === undefined) continue; // vanished — nothing to restore
      nodes.push(capture.node);
      meta.push(...capture.meta);
      captured.push(id);
    }
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
    await pushSnapshot({ kind: "merge", nodes, meta });

    // --- Apply: merged fields onto the kept node, then delete the losers. ---
    const merged = mergeMemberMeta(memberMeta);
    await patchMeta(keepId, {
      tags: merged.tags,
      category: merged.category ?? null,
      notes: merged.notes ?? null,
    });
    for (const id of captured) {
      await removeTree(id);
      removedIds.push(id);
    }
    await deleteMetaByIds(removedIds);
    return { ok: true, keptId: keepId, removedIds, mergedMeta: merged };
  } catch (cause) {
    // Whatever was already removed must not leave its meta rows behind.
    await deleteMetaByIds(removedIds).catch(() => {});
    return toMergeFailure(cause);
  }
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
