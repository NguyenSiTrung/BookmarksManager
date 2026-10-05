import { z } from "./z";
import { Category } from "./bookmark";

/**
 * Case-insensitive tag uniqueness key. The transform is exactly
 * `name.trim().toLowerCase()` (Unicode-aware, locale-independent lowercase;
 * interior whitespace is preserved). Two tags whose names differ only by case
 * or surrounding whitespace share a nameKey and are therefore the same tag.
 */
export function tagNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The wire/storage shape of a nameKey: a non-empty string that is already in
 * its own trim+lowercase form (i.e. `k === tagNameKey(k)`), bounded by the
 * same 64-char limit as `TagDef.name`. Since the transform can only shrink a
 * string, every value that is the key of some valid name satisfies this.
 */
export const TagNameKey = z
  .string()
  .min(1)
  .max(64)
  .refine((k) => k === k.trim().toLowerCase(), {
    message: "nameKey must be the trim+lowercase form (see tagNameKey)",
  });
export type TagNameKey = z.infer<typeof TagNameKey>;

/**
 * A user-defined tag. `nameKey` is the case-insensitive uniqueness key and
 * must equal `tagNameKey(name)` — it is derived data, never free text, so a
 * stored key can always be reproduced from the name.
 */
export const TagDef = z
  .strictObject({
    name: z.string().min(1).max(64),
    nameKey: TagNameKey,
    color: z.string().optional(),
    description: z.string().max(300).optional(), // shown to Jev as the option's meaning
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((tag, ctx) => {
    // A whitespace-only name derives "" — no valid nameKey can match, so this
    // also rejects blank names that would otherwise pass the 1–64 length check.
    if (tag.nameKey !== tagNameKey(tag.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["nameKey"],
        message: "nameKey must equal tagNameKey(name): name.trim().toLowerCase()",
      });
    }
  });
export type TagDef = z.infer<typeof TagDef>;

/**
 * Extension-owned metadata for one Chrome bookmark node, keyed by the Chrome
 * node `id`. Rows are lazy: a bookmark with no tags/category/notes has no row.
 * `tags` holds tag nameKeys (not display names) so renames propagate without
 * rewriting every row.
 */
/** Hard cap on a bookmark's `notes` field — callers that compose notes
 * (e.g. merge joins) must pre-validate against this before writing. */
export const NOTES_MAX_LENGTH = 10_000;

/**
 * Segment placed between the non-empty notes of merged members —
 * `"\n\n---\n\n"`, a blank-line-flanked Markdown horizontal rule. Readable
 * as a divider in plain text and renders as one wherever notes are shown
 * as Markdown. Lives here (not in `duplicates/merge.ts`) so the undo
 * restore's survivor-merge can split joined notes without importing the
 * merge module — `merge.ts` already imports `restore.ts`, which would make
 * a `restore → merge` import a runtime cycle.
 */
export const MERGE_NOTES_SEPARATOR = "\n\n---\n\n";

export const BookmarkMeta = z.strictObject({
  id: z.string(), // Chrome bookmark node id — the Dexie `bookmarkMeta` primary key
  tags: z.array(TagNameKey).default([]),
  category: Category.optional(),
  notes: z.string().max(NOTES_MAX_LENGTH).optional(),
  /**
   * A Jev-verified page summary (spec FR10.8). Optional and absent on
   * pre-Phase-4 rows — backward compatible. Written only by the verified
   * summarize path; ≤2,000 chars matching `SUMMARY_VERIFY_LIMITS.summary`.
   */
  summary: z.string().min(1).max(2_000).optional(),
  /**
   * The node's URL when the row was last written (D12). Keys tombstone
   * re-attachment — a bookmark removed and later re-created with the same
   * URL gets its metadata back — and lets undo's existence check reject a
   * live id that now points at a different URL. Never a caller-facing
   * metadata field: a row holding ONLY a url is still empty (lazy-row
   * rule). Optional — pre-D12 rows lack it and keep id-only checks.
   */
  url: z.string().min(1).optional(),
  /**
   * Storage schema epoch (D13): `1` on new writes, absent on pre-D13
   * rows (still read). A row carrying a higher version — or failing the
   * schema in any other way — counts as invalid: invisible to reads,
   * counted and surfaced, and never overwritten without a retained copy.
   */
  schemaVersion: z.literal(1).optional(),
  updatedAt: z.iso.datetime(),
});
export type BookmarkMeta = z.infer<typeof BookmarkMeta>;

/**
 * Re-attachable record of a removed bookmark's metadata (D12), keyed by
 * the removed node's URL. When `chrome.bookmarks.onCreated` reports a node
 * with the same URL inside the retention window, its fields are written
 * onto the new id and the tombstone is consumed. `deadId` is provenance
 * only — Chrome ids are never re-attached to.
 */
export const MetaTombstone = z.strictObject({
  /** The removed bookmark's URL — primary key AND re-attach key. */
  url: z.string().min(1),
  tags: z.array(TagNameKey).default([]),
  category: Category.optional(),
  notes: z.string().max(NOTES_MAX_LENGTH).optional(),
  summary: z.string().min(1).max(2_000).optional(),
  /** The bookmarkMeta id the fields came from (provenance only). */
  deadId: z.string(),
  removedAt: z.iso.datetime(),
});
export type MetaTombstone = z.infer<typeof MetaTombstone>;

/**
 * Forensic copy of a `bookmarkMeta` row that failed schema validation
 * (D13): kept verbatim so an overwrite/delete never silently destroys
 * whatever the row actually held. Bounded — the table is pruned to the
 * newest entries when it grows past the cap.
 */
export const CorruptMetaRow = z.strictObject({
  id: z.number().int().positive().optional(), // ++id assigned by IndexedDB
  /** The `bookmarkMeta` primary key of the unreadable row. */
  bookmarkId: z.string(),
  /** The raw stored value, kept verbatim. */
  raw: z.unknown(),
  /** Which path found the row unreadable. */
  reason: z.enum(["overwrite", "delete", "reconcile"]),
  retainedAt: z.iso.datetime(),
});
export type CorruptMetaRow = z.infer<typeof CorruptMetaRow>;
