import { db } from "../db/database";
import {
  createTag,
  deleteTag,
  emitMetaChanged,
  getMetaByTag,
  getTag,
  MetaRepoError,
  recolorTag as repoRecolorTag,
  renameTag as repoRenameTag,
  retainCorruptMetaBatch,
} from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import type { Category } from "../schemas/bookmark";
import { BookmarkMeta, tagNameKey } from "../schemas/meta";
import type { TagDef, TagNameKey } from "../schemas/meta";
import { pushSnapshot } from "../undo/snapshot";
import { get as getBookmarks } from "./chrome-bookmarks";
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
function isEmptyRow(fields: {
  tags: readonly TagNameKey[];
  category?: Category;
  notes?: string;
  summary?: string;
}): boolean {
  return (
    fields.tags.length === 0 &&
    fields.category === undefined &&
    (fields.notes === undefined || fields.notes === "") &&
    (fields.summary === undefined || fields.summary === "")
  );
}
/**
 * Best-effort lookup of bookmark URLs for `ids` outside the IDB transaction so
 * newly created or url-less `bookmarkMeta` rows receive `url` (B-10) without
 * holding an IndexedDB lock across Chrome IPC.
 */
async function resolveBookmarkUrls(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (ids.length === 0) return urls;
  try {
    const nodes = await getBookmarks(ids.length === 1 ? ids[0]! : [...ids]);
    for (const node of nodes) {
      if (node.url !== undefined && node.url !== "") {
        urls.set(node.id, node.url);
      }
    }
    return urls;
  } catch {
    // If any id in the batch is missing from the tree, fall back per-id.
  }
  await Promise.all(
    ids.map(async (id) => {
      try {
        const nodes = await getBookmarks(id);
        const url = nodes[0]?.url;
        if (url !== undefined && url !== "") {
          urls.set(id, url);
        }
      } catch {
        // Missing or unavailable bookmark surface — leave url unset.
      }
    }),
  );
  return urls;
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
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return { ok: true, tag, created, affected: 0 };
    }
    const urlsById = await resolveBookmarkUrls(uniqueIds);
    let affected = 0;
    await db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () => {
      const rawRows = await db.bookmarkMeta.bulkGet(uniqueIds);
      const corruptRows: { id: string; raw: unknown }[] = [];
      const puts: BookmarkMeta[] = [];
      const updatedAt = new Date().toISOString();
      for (let i = 0; i < uniqueIds.length; i += 1) {
        const id = uniqueIds[i];
        if (id === undefined) continue;
        const raw = rawRows[i];
        let current: BookmarkMeta | undefined;
        if (raw !== undefined) {
          const parsedExisting = BookmarkMeta.safeParse(raw);
          if (parsedExisting.success) {
            current = parsedExisting.data;
          } else {
            corruptRows.push({ id, raw });
          }
        }
        if (current !== undefined && current.tags.includes(key)) continue;
        const url = current?.url ?? urlsById.get(id);
        const next = BookmarkMeta.safeParse({
          id,
          tags: [...(current?.tags ?? []), key],
          ...(current?.category === undefined
            ? {}
            : { category: current.category }),
          ...(current?.notes === undefined ? {} : { notes: current.notes }),
          ...(current?.summary === undefined
            ? {}
            : { summary: current.summary }),
          ...(url === undefined ? {} : { url }),
          schemaVersion: 1,
          updatedAt,
        });
        if (!next.success) {
          throw new MetaRepoError(
            "invalid_meta",
            next.error.issues[0]?.message ?? "schema validation failed",
          );
        }
        puts.push({ ...next.data, tags: [...next.data.tags] });
        affected += 1;
      }
      if (corruptRows.length > 0) {
        await retainCorruptMetaBatch(corruptRows, "overwrite");
      }
      if (puts.length > 0) {
        await db.bookmarkMeta.bulkPut(puts);
      }
    });
    if (affected > 0) emitMetaChanged();
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
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return { ok: true, affected: 0 };
    let affected = 0;
    await db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () => {
      const rawRows = await db.bookmarkMeta.bulkGet(uniqueIds);
      const puts: BookmarkMeta[] = [];
      const deletes: string[] = [];
      const updatedAt = new Date().toISOString();
      for (let i = 0; i < uniqueIds.length; i += 1) {
        const id = uniqueIds[i];
        if (id === undefined) continue;
        const raw = rawRows[i];
        if (raw === undefined) continue;
        const parsedExisting = BookmarkMeta.safeParse(raw);
        if (!parsedExisting.success) continue;
        const current = parsedExisting.data;
        if (!current.tags.includes(key)) continue;
        const nextTags = current.tags.filter((t) => t !== key);
        if (
          isEmptyRow({
            tags: nextTags,
            category: current.category,
            notes: current.notes,
            summary: current.summary,
          })
        ) {
          deletes.push(id);
        } else {
          puts.push({
            ...current,
            tags: nextTags,
            schemaVersion: 1,
            updatedAt,
          });
        }
        affected += 1;
      }
      if (puts.length > 0) await db.bookmarkMeta.bulkPut(puts);
      if (deletes.length > 0) await db.bookmarkMeta.bulkDelete(deletes);
    });
    if (affected > 0) emitMetaChanged();
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
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return { ok: true, affected: 0 };
    const urlsById =
      category === null ? new Map<string, string>() : await resolveBookmarkUrls(uniqueIds);
    let affected = 0;
    await db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () => {
      const rawRows = await db.bookmarkMeta.bulkGet(uniqueIds);
      const corruptRows: { id: string; raw: unknown }[] = [];
      const puts: BookmarkMeta[] = [];
      const deletes: string[] = [];
      const updatedAt = new Date().toISOString();
      for (let i = 0; i < uniqueIds.length; i += 1) {
        const id = uniqueIds[i];
        if (id === undefined) continue;
        const raw = rawRows[i];
        let current: BookmarkMeta | undefined;
        if (raw !== undefined) {
          const parsedExisting = BookmarkMeta.safeParse(raw);
          if (parsedExisting.success) {
            current = parsedExisting.data;
          } else if (category !== null) {
            corruptRows.push({ id, raw });
          }
        }
        if (category === null) {
          if (current?.category === undefined) continue;
          if (
            isEmptyRow({
              tags: current.tags,
              notes: current.notes,
              summary: current.summary,
            })
          ) {
            deletes.push(id);
          } else {
            const next: BookmarkMeta = {
              id,
              tags: [...current.tags],
              ...(current.notes === undefined ? {} : { notes: current.notes }),
              ...(current.summary === undefined
                ? {}
                : { summary: current.summary }),
              ...(current.url === undefined ? {} : { url: current.url }),
              schemaVersion: 1,
              updatedAt,
            };
            puts.push(next);
          }
          affected += 1;
          continue;
        }
        if (current?.category === category) continue;
        const url = current?.url ?? urlsById.get(id);
        const next = BookmarkMeta.safeParse({
          id,
          tags: [...(current?.tags ?? [])],
          category,
          ...(current?.notes === undefined ? {} : { notes: current.notes }),
          ...(current?.summary === undefined
            ? {}
            : { summary: current.summary }),
          ...(url === undefined ? {} : { url }),
          schemaVersion: 1,
          updatedAt,
        });
        if (!next.success) {
          throw new MetaRepoError(
            "invalid_meta",
            next.error.issues[0]?.message ?? "schema validation failed",
          );
        }
        puts.push({ ...next.data, tags: [...next.data.tags] });
        affected += 1;
      }
      if (corruptRows.length > 0) {
        await retainCorruptMetaBatch(corruptRows, "overwrite");
      }
      if (puts.length > 0) await db.bookmarkMeta.bulkPut(puts);
      if (deletes.length > 0) await db.bookmarkMeta.bulkDelete(deletes);
    });
    if (affected > 0) emitMetaChanged();
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
    // D10: capture + push + delete run in ONE Dexie transaction, so a
    // deleteTag failure rolls the snapshot back with it — there is no
    // window where the stack claims an undo for a delete that never
    // happened. (Nested transactions reuse this one: pushSnapshot's
    // undo+decisions tables and deleteTag's tags+bookmarkMeta tables are
    // all covered here.)
    const result = await db.transaction(
      "rw",
      db.tags,
      db.bookmarkMeta,
      db.corruptMeta,
      db.undo,
      db.decisions,
      async () => {
        const tagDef = await getTag(key);
        if (tagDef === undefined) return undefined;
        // Capture BEFORE the mutation: every row carrying the key, plus the
        // def.
        const meta = await getMetaByTag(key);
        const snapshotId = await pushSnapshot({
          kind: "tag_delete",
          nodes: [],
          meta,
          tagDef,
        });
        const affected = await deleteTag(key);
        return { affected, snapshotId };
      },
    );
    if (result === undefined) return tagNotFound(key);
    return { ok: true, affected: result.affected, snapshotId: result.snapshotId };
  } catch (cause) {
    return toFailure(cause);
  }
}
