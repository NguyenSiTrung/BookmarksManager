import type { Category } from "../schemas/bookmark";
import {
  BookmarkMeta,
  TagDef,
  tagNameKey,
  type CorruptMetaRow,
  type TagNameKey,
} from "../schemas/meta";
import { z } from "../schemas/z";
import { db } from "./database";

/**
 * Repository over the `bookmarkMeta` and `tags` tables. Every function is
 * async and total: expected "nothing there" cases return
 * `undefined`/`0`/`[]` rather than throwing. The only rejections are
 * `MetaRepoError`s for caller-visible rule violations (duplicate tag names,
 * payloads that would fail the storage schema) — everything else is a
 * return value.
 *
 * Design rules (locked by tests/unit/meta-repo.test.ts):
 *
 * - **Lazy rows.** A `bookmarkMeta` row exists only while it carries data:
 *   when a write leaves a row with no tags, no category, and no notes the
 *   row is DELETED instead of stored (track spec: "a bookmark with no tags,
 *   category, or notes has no row"). `notes === ""` counts as absent — an
 *   emptied textarea must not keep a row alive. The rule is enforced on
 *   every write path: `putMeta`, `patchMeta`, and the propagation inside
 *   `deleteTag` (a bookmark whose only metadata was the deleted tag loses
 *   its row entirely).
 * - **Validate on read.** Every read runs the row through its Zod schema.
 *   An invalid stored row is treated exactly like a missing one — returned
 *   as `undefined` / dropped from lists, with no logging: callers already
 *   handle absence, and a corrupt row carries no trustworthy data worth
 *   surfacing. The same rule is applied to the pre-merge read inside
 *   `patchMeta`, so a corrupt row is cleanly overwritten by the next write
 *   instead of poisoning merges.
 * - **Validate on write.** The complete row/def is `safeParse`d before it
 *   is stored; a violation rejects with `MetaRepoError` and nothing is
 *   written, so the "invalid ⇒ absent" read path is never triggered by
 *   this repository's own writes.
 * - **Fresh objects.** Every write stores a new object graph; caller
 *   objects (frozen ones included) are never mutated, and returned objects
 *   are decoupled from storage. Dexie writes a generated inbound key back
 *   onto the object passed to `add`/`put` — fresh copies keep that
 *   write-back away from callers.
 * - **Case-insensitive tags.** `tags[]` holds TagNameKeys (trim +
 *   lowercase), not display names. Write paths normalize entries through
 *   `tagNameKey`, drop empties, and dedupe in first-seen order. Tag-def
 *   uniqueness on `nameKey` is enforced inside the write transaction so a
 *   check-then-insert race cannot produce duplicates. Anywhere a `nameKey`
 *   parameter is accepted, a display name works too — inputs are
 *   normalized through `tagNameKey`, which is idempotent on keys.
 * - `updatedAt`/`createdAt` are stamped inside the repository
 *   (`new Date().toISOString()`); callers never supply timestamps.
 */

// ---------------------------------------------------------------------------
// Meta-changed notification (D14) — a same-origin BroadcastChannel so an
// index built in ANOTHER extension context (the worker's shared search
// index) invalidates on writes made here (a side-panel edit, an import).
// ---------------------------------------------------------------------------

/** BroadcastChannel name meta writes post a bump on. */
export const META_CHANGED_CHANNEL = "bookmarks-manager-meta-changed";

let metaChangedChannel: BroadcastChannel | null | undefined;

/**
 * Post one bump on {@link META_CHANGED_CHANNEL}. Total: a missing
 * BroadcastChannel (non-web runtimes) or a dead channel is swallowed —
 * the worst outcome is a stale read-model, never a failed write.
 */
export function emitMetaChanged(): void {
  if (metaChangedChannel === undefined) {
    try {
      metaChangedChannel = new BroadcastChannel(META_CHANGED_CHANNEL);
    } catch {
      metaChangedChannel = null;
    }
  }
  try {
    metaChangedChannel?.postMessage(0);
  } catch {
    // A channel that throws on post is as good as absent.
  }
}

export type MetaRepoErrorCode =
  /** A different tag already owns the case-insensitive nameKey. */
  | "tag_exists"
  /** The (new) tag definition violates the TagDef schema. */
  | "invalid_tag"
  /** The metadata fields violate the BookmarkMeta schema. */
  | "invalid_meta";

/** Rejection for caller-visible repository rule violations. */
export class MetaRepoError extends Error {
  readonly code: MetaRepoErrorCode;

  constructor(
    code: MetaRepoErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MetaRepoError";
    this.code = code;
  }
}

/**
 * Caller-writable fields of a bookmark's meta row. `putMeta` reads this as
 * the complete field set (absent or `null` ⇒ no value); `patchMeta` reads
 * it as a merge patch (absent ⇒ untouched, `null` ⇒ cleared). `tags`, when
 * present, always replaces the whole list; entries are normalized through
 * `tagNameKey` (trim + lowercase), deduped, and empties dropped — pass `[]`
 * to clear. A `""` or `null` `notes` is stored as no-notes.
 */
export interface MetaPatch {
  tags?: readonly string[];
  category?: Category | null;
  notes?: string | null;
  /**
   * A Jev-verified page summary (spec FR10). `null` clears; absent leaves
   * unchanged on merge paths. Written only by the verified summarize flow.
   */
  summary?: string | null;
  /**
   * The node's URL at write time (D12): enables URL-keyed tombstone
   * re-attachment and undo's id+url existence check. Callers that know
   * the node pass it; absent keeps the stored value on merge paths. Not
   * a lazy-row field — a url alone never keeps a row alive.
   */
  url?: string | null;
}

export interface TagCreateOptions {
  color?: string;
  description?: string;
}

/**
 * Display-field patch for `updateTag`. Absent ⇒ untouched, `null` ⇒
 * cleared. `name` is deliberately not patchable here — renames go through
 * `renameTag`, which propagates the new nameKey to every meta row.
 */
export interface TagPatch {
  color?: string | null;
  description?: string | null;
}

export interface RenameTagResult {
  /** The def as stored after the rename. */
  tag: TagDef;
  /** Meta rows that carry the tag (all rewritten when the key changed). */
  bookmarkCount: number;
}

type MetaFields = Pick<
  BookmarkMeta,
  "tags" | "category" | "notes" | "summary" | "url"
>;

function nowIso(): string {
  return new Date().toISOString();
}

/** First Zod issue message, or a generic fallback for empty issue lists. */
function firstIssue(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "schema validation failed";
}

/**
 * Normalize caller-supplied tag entries to the storage form: each entry is
 * trimmed + lowercased via `tagNameKey`, empties dropped, duplicates
 * removed keeping first-seen order.
 */
function normalizeTagKeys(tags: readonly string[]): TagNameKey[] {
  const seen = new Set<string>();
  const keys: TagNameKey[] = [];
  for (const tag of tags) {
    const key = tagNameKey(tag);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** The lazy-row rule: a row with no tags/category/notes/summary must not
 * exist. `url` is bookkeeping, not metadata — a url-only row still dies. */
function isEmptyMeta(fields: MetaFields): boolean {
  return (
    fields.tags.length === 0 &&
    fields.category === undefined &&
    (fields.notes === undefined || fields.notes === "") &&
    (fields.summary === undefined || fields.summary === "")
  );
}

/** Schema-checked read; invalid rows are treated as absent. */
function parseMeta(raw: unknown): BookmarkMeta | undefined {
  const parsed = BookmarkMeta.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function parseTagDef(raw: unknown): TagDef | undefined {
  const parsed = TagDef.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Keep a forensic copy of a schema-invalid stored row before it is
 * overwritten or deleted (D13): the raw value lands in `corruptMeta`
 * verbatim, bounded to the newest {@link CORRUPT_META_CAP} rows. Returns
 * true when a copy was retained — a VALID or missing row is a no-op.
 */
export async function retainCorruptMeta(
  id: string,
  reason: CorruptMetaRow["reason"],
): Promise<boolean> {
  const raw = await db.bookmarkMeta.get(id);
  if (raw === undefined || parseMeta(raw) !== undefined) return false;
  await db.corruptMeta.add({
    bookmarkId: id,
    raw,
    reason,
    retainedAt: nowIso(),
  });
  // Bounded: drop the oldest beyond the cap (retainedAt indexes order).
  const excess = (await db.corruptMeta.count()) - CORRUPT_META_CAP;
  if (excess > 0) {
    const stale = await db.corruptMeta
      .orderBy("retainedAt")
      .limit(excess)
      .primaryKeys();
    await db.corruptMeta.bulkDelete(stale);
  }
  return true;
}

/** How many forensic copies `corruptMeta` keeps. */
export const CORRUPT_META_CAP = 50;

/**
 * Commit a fully-resolved field set for `id`: validate, apply the lazy-row
 * rule, and store a fresh object. Returns the stored meta, or `undefined`
 * when the lazy rule deleted the row (or kept a missing row absent).
 * An unreadable row already stored under `id` is retained to
 * `corruptMeta` BEFORE the overwrite/delete touches it (D13).
 */
async function commitMeta(
  id: string,
  fields: MetaFields,
): Promise<BookmarkMeta | undefined> {
  // An emptied textarea is "no notes", not a one-character-shy payload.
  const notes = fields.notes === "" ? undefined : fields.notes;
  const summary = fields.summary === "" ? undefined : fields.summary;
  const url = fields.url === "" ? undefined : fields.url;
  const parsed = BookmarkMeta.safeParse({
    id,
    tags: fields.tags,
    ...(fields.category === undefined ? {} : { category: fields.category }),
    ...(notes === undefined ? {} : { notes }),
    ...(summary === undefined ? {} : { summary }),
    ...(url === undefined ? {} : { url }),
    schemaVersion: 1,
    updatedAt: nowIso(),
  });
  if (!parsed.success) {
    throw new MetaRepoError("invalid_meta", firstIssue(parsed.error));
  }
  await retainCorruptMeta(id, "overwrite");
  if (isEmptyMeta(parsed.data)) {
    await db.bookmarkMeta.delete(id);
    emitMetaChanged();
    return undefined;
  }
  // Fresh copy for the write — the parsed object goes back to the caller
  // and must stay decoupled from whatever Dexie does with the stored one.
  await db.bookmarkMeta.put({ ...parsed.data, tags: [...parsed.data.tags] });
  emitMetaChanged();
  return parsed.data;
}

/**
 * The valid meta rows carrying `nameKey`, resolved through the `*tags`
 * multiEntry index; schema-invalid rows are skipped (invalid ⇒ absent).
 */
async function rowsWithTag(nameKey: TagNameKey): Promise<BookmarkMeta[]> {
  const rows = await db.bookmarkMeta.where("tags").equals(nameKey).toArray();
  const metas: BookmarkMeta[] = [];
  for (const row of rows) {
    const meta = parseMeta(row);
    if (meta !== undefined) metas.push(meta);
  }
  return metas;
}

/**
 * Shared tag-propagation pass for `renameTag`/`deleteTag`: collect the meta
 * rows carrying `nameKey` via the `*tags` multiEntry index, rewrite each
 * valid row's tag list through `rewrite`, and persist the result — rows
 * left empty by the rewrite are deleted (lazy-row rule). Returns how many
 * valid rows carried the key. Must run inside a `rw` transaction covering
 * `db.bookmarkMeta`.
 */
async function rewriteTagRows(
  nameKey: TagNameKey,
  rewrite: (tags: readonly TagNameKey[]) => TagNameKey[],
): Promise<number> {
  const metas = await rowsWithTag(nameKey);
  const puts: BookmarkMeta[] = [];
  const deletes: string[] = [];
  const updatedAt = nowIso();
  for (const meta of metas) {
    const tags = rewrite(meta.tags);
    if (
      isEmptyMeta({
        tags,
        category: meta.category,
        notes: meta.notes,
        summary: meta.summary,
      })
    ) {
      deletes.push(meta.id);
    } else {
      puts.push({ ...meta, tags, updatedAt });
    }
  }
  if (puts.length > 0) await db.bookmarkMeta.bulkPut(puts);
  if (deletes.length > 0) await db.bookmarkMeta.bulkDelete(deletes);
  if (metas.length > 0) emitMetaChanged();
  return metas.length;
}

// ---------------------------------------------------------------------------
// bookmarkMeta rows
// ---------------------------------------------------------------------------

/**
 * Read one meta row by Chrome bookmark id. `undefined` when the row is
 * missing OR fails schema validation (invalid ⇒ absent; see module header).
 */
export async function getMeta(id: string): Promise<BookmarkMeta | undefined> {
  return parseMeta(await db.bookmarkMeta.get(id));
}

/**
 * Bulk read for merges/export. Results keep input order with missing and
 * invalid ids dropped; duplicate input ids collapse to one result.
 */
export async function getMetaByIds(
  ids: readonly string[],
): Promise<BookmarkMeta[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const rows = await db.bookmarkMeta.bulkGet(uniqueIds);
  const metas: BookmarkMeta[] = [];
  for (const row of rows) {
    const meta = parseMeta(row);
    if (meta !== undefined) metas.push(meta);
  }
  return metas;
}

/** Every valid meta row, in primary-key (id) order. For whole-library export. */
export async function listMeta(): Promise<BookmarkMeta[]> {
  const rows = await db.bookmarkMeta.toArray();
  const metas: BookmarkMeta[] = [];
  for (const row of rows) {
    const meta = parseMeta(row);
    if (meta !== undefined) metas.push(meta);
  }
  return metas;
}

/**
 * Meta rows carrying a tag, resolved through the `*tags` multiEntry index.
 * `tag` may be a nameKey or a display name (normalized via `tagNameKey`).
 */
export async function getMetaByTag(tag: string): Promise<BookmarkMeta[]> {
  const key = tagNameKey(tag);
  if (key === "") return [];
  return rowsWithTag(key);
}

/** Meta rows in a category, resolved through the `category` index. */
export async function getMetaByCategory(
  category: Category,
): Promise<BookmarkMeta[]> {
  const rows = await db.bookmarkMeta
    .where("category")
    .equals(category)
    .toArray();
  const metas: BookmarkMeta[] = [];
  for (const row of rows) {
    const meta = parseMeta(row);
    if (meta !== undefined) metas.push(meta);
  }
  return metas;
}

/**
 * Upsert with REPLACE semantics: `fields` becomes the row's complete field
 * set (absent/`null` ⇒ no value). `updatedAt` is stamped inside. Returns
 * the stored meta, or `undefined` when the lazy-row rule deleted the row.
 * Rejects `invalid_meta` if the result violates the BookmarkMeta schema.
 */
export async function putMeta(
  id: string,
  fields: MetaPatch,
): Promise<BookmarkMeta | undefined> {
  // The transaction must cover `corruptMeta`: commitMeta retains an
  // unreadable prior row inside the same write scope (D13).
  return db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () =>
    commitMeta(id, {
      tags: normalizeTagKeys(fields.tags ?? []),
      category: fields.category ?? undefined,
      notes: fields.notes ?? undefined,
      summary: fields.summary ?? undefined,
      url: fields.url ?? undefined,
    }),
  );
}

/**
 * Upsert with MERGE semantics: absent keys keep their stored values,
 * `null` clears `category`/`notes`, `tags` replaces the list wholesale.
 * Patching a missing id lazily creates the row. `updatedAt` is stamped
 * inside. Returns the resulting meta, or `undefined` when the lazy-row
 * rule deleted the row / kept a missing row absent.
 */
export async function patchMeta(
  id: string,
  patch: MetaPatch,
): Promise<BookmarkMeta | undefined> {
  return db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () => {
    // Invalid stored rows are absent — the patch merges onto an empty
    // base; the unreadable row is retained before the overwrite (D13).
    const existing = parseMeta(await db.bookmarkMeta.get(id));
    return commitMeta(id, {
      tags:
        patch.tags === undefined
          ? [...(existing?.tags ?? [])]
          : normalizeTagKeys(patch.tags),
      category:
        patch.category === undefined
          ? existing?.category
          : (patch.category ?? undefined),
      notes:
        patch.notes === undefined
          ? existing?.notes
          : (patch.notes ?? undefined),
      summary:
        patch.summary === undefined
          ? existing?.summary
          : (patch.summary ?? undefined),
      url:
        patch.url === undefined
          ? existing?.url
          : (patch.url ?? undefined),
    });
  });
}

/**
 * Persist a Jev-verified page summary for a bookmark (spec FR10.6). The
 * summary is the ONLY field this writes — callers reach it from the
 * verified summarize path, never as free text (Jev must answer
 * "supported" first). `patchMeta` merge keeps the row's other fields;
 * passing `null` clears. Returns the stored meta, or `undefined` when
 * clearing emptied the row (lazy-row rule).
 */
export async function setBookmarkSummary(
  id: string,
  summary: string | null,
): Promise<BookmarkMeta | undefined> {
  return patchMeta(id, { summary });
}

/**
 * Bulk delete by Chrome bookmark id — the raw primitive. Callers that
 * must preserve removed metadata go through `tombstoneMetaByIds` (D12),
 * which retains a URL-keyed copy (or a forensic copy for unparseable
 * rows, D13) before the row leaves; merge-compensation callers rely on
 * the merge undo snapshot holding the same rows. Returns the number of
 * rows actually deleted.
 */
export async function deleteMetaByIds(
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db.bookmarkMeta
    .where("id")
    .anyOf([...new Set(ids)])
    .delete();
  if (deleted > 0) emitMetaChanged();
  return deleted;
}

// ---------------------------------------------------------------------------
// Integrity surface (D13) — invalid rows are counted and surfaced
// ---------------------------------------------------------------------------

/**
 * Count of `bookmarkMeta` rows that fail schema validation. Reads drop
 * these silently (invalid ⇒ absent); this scan is how the count is
 * surfaced — `reconcileMetadata` refreshes it and
 * {@link getMetaIntegrity} reads it.
 */
export async function countInvalidMetaRows(): Promise<number> {
  const rows = await db.bookmarkMeta.toArray();
  let invalid = 0;
  for (const row of rows) {
    if (parseMeta(row) === undefined) invalid += 1;
  }
  return invalid;
}

/** `metadata` key under which the integrity snapshot is surfaced. */
const META_INTEGRITY_KEY = "metaIntegrity";

export interface MetaIntegrity {
  /** Schema-invalid `bookmarkMeta` rows at the last reconcile scan. */
  invalidRows: number;
  /** Forensic copies currently held in `corruptMeta`. */
  corruptRows: number;
  checkedAt: string;
}

/**
 * Refresh the surfaced integrity snapshot: counts invalid bookmarkMeta
 * rows + held corrupt copies and writes them under the `metaIntegrity`
 * metadata key (validated loosely on read — a corrupt entry reads as
 * absent). Called by `reconcileMetadata`; safe to call anywhere.
 */
export async function refreshMetaIntegrity(): Promise<MetaIntegrity> {
  const integrity: MetaIntegrity = {
    invalidRows: await countInvalidMetaRows(),
    corruptRows: await db.corruptMeta.count(),
    checkedAt: nowIso(),
  };
  await db.metadata.put({ key: META_INTEGRITY_KEY, value: integrity });
  return integrity;
}

/** Last surfaced integrity snapshot, or `undefined` before the first scan. */
export async function getMetaIntegrity(): Promise<MetaIntegrity | undefined> {
  const row = await db.metadata.get(META_INTEGRITY_KEY);
  const parsed = z
    .strictObject({
      invalidRows: z.number().int().min(0),
      corruptRows: z.number().int().min(0),
      checkedAt: z.iso.datetime(),
    })
    .safeParse(row?.value);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Tag definitions
// ---------------------------------------------------------------------------

/**
 * Read one tag definition. `tag` may be a nameKey or a display name.
 * `undefined` when missing or schema-invalid.
 */
export async function getTag(tag: string): Promise<TagDef | undefined> {
  const key = tagNameKey(tag);
  if (key === "") return undefined;
  return parseTagDef(await db.tags.get(key));
}

/** All tag definitions sorted by nameKey; invalid stored defs dropped. */
export async function listTags(): Promise<TagDef[]> {
  const rows = await db.tags.toArray();
  const tags: TagDef[] = [];
  for (const row of rows) {
    const def = parseTagDef(row);
    if (def !== undefined) tags.push(def);
  }
  // Deterministic code-unit order on the uniqueness key.
  tags.sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0));
  return tags;
}

/**
 * Create a tag definition. The display name is trimmed for storage and the
 * nameKey is derived (`tagNameKey`), never taken from the caller. Rejects
 * `tag_exists` on a case-insensitive name collision and `invalid_tag` when
 * the resulting def violates the TagDef schema (blank name, >64 chars,
 * description >300).
 */
export async function createTag(
  name: string,
  options: TagCreateOptions = {},
): Promise<TagDef> {
  const displayName = name.trim();
  const now = nowIso();
  const parsed = TagDef.safeParse({
    name: displayName,
    nameKey: tagNameKey(displayName),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    createdAt: now,
    updatedAt: now,
  });
  if (!parsed.success) {
    throw new MetaRepoError("invalid_tag", firstIssue(parsed.error));
  }
  const def = parsed.data;
  return db.transaction("rw", db.tags, async () => {
    // Uniqueness is checked inside the write transaction: a concurrent
    // create of a differently-cased twin cannot slip between the check and
    // the insert.
    const collision = await db.tags.get(def.nameKey);
    if (collision !== undefined) {
      throw new MetaRepoError(
        "tag_exists",
        `A tag already exists for key "${def.nameKey}"`,
      );
    }
    await db.tags.add({ ...def });
    return def;
  });
}

/**
 * Merge a display-field patch into a tag definition (`null` clears;
 * `name` is not patchable here — use `renameTag`). Returns the updated
 * def, or `undefined` for a missing tag. Rejects `invalid_tag` when the
 * result violates the TagDef schema; nothing is written in that case.
 */
export async function updateTag(
  tag: string,
  patch: TagPatch,
): Promise<TagDef | undefined> {
  const key = tagNameKey(tag);
  if (key === "") return undefined;
  return db.transaction("rw", db.tags, async () => {
    const existing = parseTagDef(await db.tags.get(key));
    if (existing === undefined) return undefined;
    const color =
      patch.color === undefined ? existing.color : (patch.color ?? undefined);
    const description =
      patch.description === undefined
        ? existing.description
        : (patch.description ?? undefined);
    const merged = TagDef.safeParse({
      name: existing.name,
      nameKey: existing.nameKey,
      ...(color === undefined ? {} : { color }),
      ...(description === undefined ? {} : { description }),
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
    if (!merged.success) {
      throw new MetaRepoError("invalid_tag", firstIssue(merged.error));
    }
    await db.tags.put({ ...merged.data });
    return merged.data;
  });
}

/** Set (`string`) or clear (`null`) a tag's color. `updateTag` shorthand. */
export async function recolorTag(
  tag: string,
  color: string | null,
): Promise<TagDef | undefined> {
  return updateTag(tag, { color });
}

/**
 * Rename a tag and propagate the change to every meta row carrying the old
 * nameKey (via the `*tags` index). The nameKey is derived from the trimmed
 * new name; `createdAt` is preserved and `updatedAt` stamped. Case-only
 * renames (`"foo"` → `"Foo"`) keep the nameKey and skip row rewriting.
 * Returns `undefined` for a missing tag. Rejects `tag_exists` when the new
 * name collides with a DIFFERENT tag (the whole transaction rolls back —
 * defs and rows untouched) and `invalid_tag` when the new name violates
 * the schema.
 */
export async function renameTag(
  tag: string,
  newName: string,
): Promise<RenameTagResult | undefined> {
  const key = tagNameKey(tag);
  if (key === "") return undefined;
  const displayName = newName.trim();
  const newKey = tagNameKey(displayName);
  return db.transaction("rw", db.tags, db.bookmarkMeta, async () => {
    const existing = parseTagDef(await db.tags.get(key));
    if (existing === undefined) return undefined;
    if (newKey !== key) {
      const collision = await db.tags.get(newKey);
      if (collision !== undefined) {
        throw new MetaRepoError(
          "tag_exists",
          `A tag already exists for key "${newKey}"`,
        );
      }
    }
    const renamed = TagDef.safeParse({
      ...existing,
      name: displayName,
      nameKey: newKey,
      updatedAt: nowIso(),
    });
    if (!renamed.success) {
      throw new MetaRepoError("invalid_tag", firstIssue(renamed.error));
    }
    const def = renamed.data;
    if (newKey !== key) {
      // The primary key itself moves: delete the old row, store the new one.
      await db.tags.delete(key);
    }
    await db.tags.put({ ...def });
    // Rows carry nameKeys, so a case-only rename needs no rewrite.
    const bookmarkCount =
      newKey === key
        ? (await rowsWithTag(key)).length
        : await rewriteTagRows(key, (tags) =>
            [...new Set(tags.map((t) => (t === key ? newKey : t)))],
          );
    return { tag: def, bookmarkCount };
  });
}

/**
 * Delete a tag definition and strip its nameKey from every meta row
 * (via `*tags`). Rows left empty by the strip are deleted outright —
 * the lazy-row rule applies to propagation too. Returns the number of
 * bookmark meta rows that carried the tag (the "affected" count the spec
 * wants surfaced in the UI); missing defs and orphaned keys are handled
 * the same way — the strip happens regardless.
 */
export async function deleteTag(tag: string): Promise<number> {
  const key = tagNameKey(tag);
  if (key === "") return 0;
  return db.transaction("rw", db.tags, db.bookmarkMeta, async () => {
    const affected = await rewriteTagRows(key, (tags) =>
      tags.filter((t) => t !== key),
    );
    await db.tags.delete(key);
    return affected;
  });
}
