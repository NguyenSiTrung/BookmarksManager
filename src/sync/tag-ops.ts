import { db } from "../db/database";
import {
  createTag,
  deleteTag,
  getMeta,
  getMetaByTag,
  getTag,
  MetaRepoError,
  patchMeta,
  recolorTag as repoRecolorTag,
  renameTag as repoRenameTag,
} from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import type { Category } from "../schemas/bookmark";
import { tagNameKey } from "../schemas/meta";
import type { TagDef } from "../schemas/meta";
import { pushSnapshot } from "../undo/snapshot";

/**
 * Bulk tag and category operations over a bookmark selection, plus the
 * single-tag lifecycle ops the tag manager surfaces — thin orchestration
 * over the meta repository (`src/db/meta.ts`) and the undo stack
 * (`src/undo/snapshot.ts`). This module never touches the Chrome bookmarks
 * tree: `ids` are the Chrome node ids of the user's current selection and
 * meta rows are keyed by them directly (a row for a deleted node is cleaned
 * up by the onRemoved cascade, not here).
 *
 * Design rules (locked by tests/unit/tag-ops.test.ts):
 *
 * - **One result model.** Every operation is total and returns
 *   `{ok:true, …}` or `{ok:false, code, message}` — nothing throws.
 *   `MetaRepoError`s map to their own `code`; a missing tag reports
 *   `not_found`; anything else (a storage-level failure) reports `api`.
 * - **`affected` counts real changes.** Bulk ops report the number of
 *   bookmark ids whose stored meta actually changed — ids already carrying
 *   the tag (or already in/cleared of the category) are skipped, not
 *   rewritten, so a no-op selection reports 0 and never churns `updatedAt`.
 *   Duplicate ids in the input collapse to one. For `deleteTagWithUndo`,
 *   `affected` is the meta repo's count of rows that carried the tag — the
 *   number the spec wants shown to the user before confirming.
 * - **Bulk ops are transactional RMW.** Each bulk op reads every id's row
 *   and writes the merged result inside ONE `rw` transaction on
 *   `bookmarkMeta` — `patchMeta`'s own nested transaction joins the outer
 *   one (same scope), and Dexie/IndexedDB serializes `rw` transactions on
 *   the store. Two overlapping ops can therefore never interleave a stale
 *   read with a whole-array rewrite: the second op's read sees the first
 *   op's writes (no lost updates), and a mid-op failure rolls the whole
 *   selection back.
 * - **Resolve-or-create on add.** `bulkAddTag` takes a display name, not a
 *   nameKey: the side panel's "add tag" flow creates a definition for a new
 *   name and reuses an existing one otherwise (case-insensitively, via
 *   `tagNameKey`). The def is resolved/created up front even when the
 *   selection is empty — creating the tag IS the expected outcome.
 * - **Lazy rows.** Adds/sets create rows for bookmarks that had none;
 *   removes/clears let `patchMeta` delete rows left empty. Both are the
 *   repository's existing semantics — this module just counts them.
 * - **Blank tag references are caller bugs.** An empty-normalized tag input
 *   fails `invalid_tag` immediately; a non-blank input that resolves to no
 *   def fails `not_found` (or, for `bulkRemoveTag`, succeeds with 0 —
 *   removal doesn't need a def to exist).
 * - **Tag delete snapshots BEFORE deleting.** `deleteTagWithUndo` pushes a
 *   `tag_delete` snapshot carrying the `TagDef` plus every meta row holding
 *   the nameKey (`nodes: []` — no tree nodes are involved), then calls the
 *   repo's `deleteTag`. `undoLatest()` recreates the def and re-adds the
 *   key to each listed bookmark, unioned with interim edits. Only a real
 *   def is deletable this way: an orphaned nameKey with no def fails
 *   `not_found` (there is nothing to snapshot or restore — stripping
 *   orphans is the repo's `deleteTag` job).
 */

/** `code` values on a failed tag op: the repo's own codes plus two of ours. */
export type TagOpsErrorCode =
  | MetaRepoErrorCode
  /** The named tag definition does not exist. */
  | "not_found"
  /** Unexpected storage-level failure (Dexie, snapshot validation). */
  | "api";

export interface TagOpsFailure {
  ok: false;
  code: TagOpsErrorCode;
  message: string;
}

/** `bulkAddTag` success: the resolved def plus how many rows changed. */
export interface BulkAddTagSuccess {
  ok: true;
  /** The tag definition the ids were tagged with (resolved or created). */
  tag: TagDef;
  /** True when this call created the definition (a new tag name). */
  created: boolean;
  /** Selection ids whose stored tags changed (already-tagged ids excluded). */
  affected: number;
}

/** Shared success shape for ops that only report a change count. */
export interface AffectedSuccess {
  ok: true;
  /** Selection ids whose stored meta changed (see module header). */
  affected: number;
}

/** `renameTag` success: the post-rename def plus the propagated row count. */
export interface RenameTagSuccess {
  ok: true;
  /** The def as stored after the rename. */
  renamed: TagDef;
  /** Meta rows rewritten to the new nameKey (repo `bookmarkCount`). */
  affectedBookmarks: number;
}

/** `recolorTag` success: the def as stored after the color change. */
export interface RecolorTagSuccess {
  ok: true;
  tag: TagDef;
}

/** `deleteTagWithUndo` success: the affected count plus the snapshot row id. */
export interface DeleteTagSuccess {
  ok: true;
  /** Meta rows that carried the tag (the count shown to the user). */
  affected: number;
  /** Row id of the pushed `tag_delete` snapshot — feed the Undo toast. */
  snapshotId: number;
}

export type BulkAddTagResult = BulkAddTagSuccess | TagOpsFailure;
export type BulkRemoveTagResult = AffectedSuccess | TagOpsFailure;
export type BulkSetCategoryResult = AffectedSuccess | TagOpsFailure;
export type RenameTagOpResult = RenameTagSuccess | TagOpsFailure;
export type RecolorTagResult = RecolorTagSuccess | TagOpsFailure;
export type DeleteTagResult = DeleteTagSuccess | TagOpsFailure;

/** Shared `not_found` arm — `key` is the normalized nameKey. */
function tagNotFound(key: string): TagOpsFailure {
  return {
    ok: false,
    code: "not_found",
    message: `No tag exists for "${key}".`,
  };
}

/** Blank-input guard shared by every op that takes a tag reference. */
function invalidTagName(): TagOpsFailure {
  return {
    ok: false,
    code: "invalid_tag",
    message: "Tag name must not be blank.",
  };
}

/** Map a thrown cause onto the result model — nothing escapes as a throw. */
function toFailure(cause: unknown): TagOpsFailure {
  if (cause instanceof MetaRepoError) {
    return { ok: false, code: cause.code, message: cause.message };
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, code: "api", message };
}

/**
 * Add a tag to every selected bookmark. `tagName` is a DISPLAY name: its
 * nameKey is looked up and the def created when missing (the "add tag" UI
 * doubles as tag creation), so a fresh name reports `created: true`. The
 * key is appended to each row's tags; ids already carrying it are skipped.
 * `affected` counts the ids whose stored tags changed.
 */
export async function bulkAddTag(
  ids: readonly string[],
  tagName: string,
): Promise<BulkAddTagResult> {
  const key = tagNameKey(tagName);
  if (key === "") return invalidTagName();
  try {
    let tag = await getTag(key);
    let created = false;
    if (tag === undefined) {
      try {
        tag = await createTag(tagName);
        created = true;
      } catch (cause) {
        // A concurrent create of the same nameKey won the race — its def is
        // the same tag, so reuse it rather than surfacing tag_exists.
        if (cause instanceof MetaRepoError && cause.code === "tag_exists") {
          tag = await getTag(key);
        }
        if (tag === undefined) throw cause;
      }
    }
    let affected = 0;
    // Read-modify-write inside one transaction: each getMeta reads the
    // row's CURRENT committed+in-transaction state, so a concurrent op
    // can't slip a stale whole-array rewrite between our read and write.
    await db.transaction("rw", db.bookmarkMeta, async () => {
      for (const id of new Set(ids)) {
        const current = await getMeta(id);
        if (current !== undefined && current.tags.includes(key)) continue;
        await patchMeta(id, { tags: [...(current?.tags ?? []), key] });
        affected += 1;
      }
    });
    return { ok: true, tag, created, affected };
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Remove a tag from every selected bookmark carrying it. `tag` may be a
 * nameKey or a display name (normalized via `tagNameKey`). Only rows that
 * actually carry the key are patched — rows left empty by the removal are
 * deleted by the lazy-row rule and still count toward `affected`. Removing
 * a tag that nothing carries succeeds with `affected: 0`; no def is needed.
 */
export async function bulkRemoveTag(
  ids: readonly string[],
  tag: string,
): Promise<BulkRemoveTagResult> {
  const key = tagNameKey(tag);
  if (key === "") return invalidTagName();
  try {
    let affected = 0;
    // Same transactional RMW as bulkAddTag — the read and the rewrite are
    // atomic per selection, so concurrent ops on shared ids can't lose
    // each other's changes.
    await db.transaction("rw", db.bookmarkMeta, async () => {
      for (const id of new Set(ids)) {
        const current = await getMeta(id);
        if (current === undefined || !current.tags.includes(key)) continue;
        await patchMeta(id, {
          tags: current.tags.filter((t) => t !== key),
        });
        affected += 1;
      }
    });
    return { ok: true, affected };
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Set (`Category`) or clear (`null`) the category on every selected
 * bookmark — at most one per bookmark, so this is a replace. Ids with no
 * meta row get one lazily on set; `affected` counts only ids whose stored
 * category actually changed (already-set ids skipped on set, rows with no
 * category skipped on clear).
 */
export async function bulkSetCategory(
  ids: readonly string[],
  category: Category | null,
): Promise<BulkSetCategoryResult> {
  try {
    let affected = 0;
    // Transactional RMW as in bulkAddTag — each row is read and patched
    // atomically, so an overlapping category/tag write can't be clobbered
    // by a rewrite based on a stale read.
    await db.transaction("rw", db.bookmarkMeta, async () => {
      for (const id of new Set(ids)) {
        const current = await getMeta(id);
        if (category === null) {
          if (current?.category === undefined) continue; // nothing to clear
        } else if (current?.category === category) {
          continue; // already in the target state
        }
        await patchMeta(id, { category });
        affected += 1;
      }
    });
    return { ok: true, affected };
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Rename a tag — delegates to the repo, which propagates the new nameKey to
 * every meta row (and merges it into rows that already carried it).
 * `affectedBookmarks` is the repo's rewrite count. `not_found` when no def
 * exists; `tag_exists`/`invalid_tag` pass through from the repo.
 */
export async function renameTag(
  tag: string,
  newName: string,
): Promise<RenameTagOpResult> {
  const key = tagNameKey(tag);
  if (key === "") return invalidTagName();
  try {
    const result = await repoRenameTag(key, newName);
    if (result === undefined) return tagNotFound(key);
    return {
      ok: true,
      renamed: result.tag,
      affectedBookmarks: result.bookmarkCount,
    };
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Set (`string`) or clear (`null`) a tag's color — delegates to the repo.
 * `not_found` when no def exists.
 */
export async function recolorTag(
  tag: string,
  color: string | null,
): Promise<RecolorTagResult> {
  const key = tagNameKey(tag);
  if (key === "") return invalidTagName();
  try {
    const updated = await repoRecolorTag(key, color);
    if (updated === undefined) return tagNotFound(key);
    return { ok: true, tag: updated };
  } catch (cause) {
    return toFailure(cause);
  }
}

/**
 * Delete a tag definition and strip its nameKey from every meta row —
 * undoably. The snapshot (kind `tag_delete`, `nodes: []`, every meta row
 * carrying the key, plus the `TagDef` itself) is pushed BEFORE the repo's
 * `deleteTag` runs, so `undoLatest()` can recreate the def and re-add the
 * key, unioned with any interim edits. `affected` is the number of bookmark
 * rows that carried the tag — the count the UI shows before confirming.
 * Fails `not_found` when no def exists (an orphaned nameKey alone is not a
 * deletable tag — there's nothing to restore).
 */
export async function deleteTagWithUndo(
  tag: string,
): Promise<DeleteTagResult> {
  const key = tagNameKey(tag);
  if (key === "") return invalidTagName();
  try {
    const tagDef = await getTag(key);
    if (tagDef === undefined) return tagNotFound(key);
    // Capture BEFORE the mutation: every row carrying the key, plus the def.
    const meta = await getMetaByTag(key);
    const snapshotId = await pushSnapshot({
      kind: "tag_delete",
      nodes: [],
      meta,
      tagDef,
    });
    const affected = await deleteTag(key);
    return { ok: true, affected, snapshotId };
  } catch (cause) {
    return toFailure(cause);
  }
}
