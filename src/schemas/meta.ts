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
  updatedAt: z.iso.datetime(),
});
export type BookmarkMeta = z.infer<typeof BookmarkMeta>;
