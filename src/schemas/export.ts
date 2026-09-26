import { z } from "./z";
import { BookmarkMeta, TagDef } from "./meta";

/**
 * One node in the serialized folder tree. `url` present ⇒ bookmark, absent ⇒
 * folder (mirroring Chrome's BookmarkTreeNode convention); `children` recurses.
 * Sibling position is the array order, so `index`/`parentId` are not carried.
 *
 * `id` is the Chrome node id at export time. It is portable only as a join
 * key — `meta` rows reference these ids, and the importer maps old ids to the
 * new Chrome ids it creates. Import must never reuse them as real node ids.
 */
export const ExportTreeNode = z.strictObject({
  id: z.string(),
  title: z.string(),
  url: z.string().min(1).optional(),
  get children() {
    return z.array(ExportTreeNode).optional();
  },
});
export type ExportTreeNode = z.infer<typeof ExportTreeNode>;

/**
 * The versioned JSON export file. Every level is a strict object so an
 * envelope smuggling secret-bearing fields (`keys`, `apiKey`,
 * `providerSettings`, `consents`, `sentLog`, `keyMaterials`, `decisions`, …)
 * fails validation outright instead of being written to or read from disk.
 */
export const ExportEnvelope = z.strictObject({
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  tree: z.array(ExportTreeNode),
  tags: z.array(TagDef),
  meta: z.array(BookmarkMeta),
});
export type ExportEnvelope = z.infer<typeof ExportEnvelope>;
