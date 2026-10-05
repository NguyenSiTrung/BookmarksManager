import { z } from "./z";
import { BookmarkMeta, TagDef } from "./meta";

/** Operations that write an undo snapshot before mutating the tree/tags. */
export const UndoKind = z.enum([
  "delete",
  "bulk_move",
  "merge",
  "tag_delete",
  "restructure",
]);
export type UndoKind = z.infer<typeof UndoKind>;

/**
 * Who pushed the snapshot (D05). `user` rows come from UI-driven flows
 * (delete, move, merge, tag-delete via the panels); `decision` rows come
 * from decision/job applies. Retention caps and the node budget are
 * enforced PER ORIGIN so a burst of decision approvals can never evict a
 * snapshot the user just pushed. Absent = `user` (pre-D05 rows).
 */
export const UndoOrigin = z.enum(["user", "decision"]);
export type UndoOrigin = z.infer<typeof UndoOrigin>;

/**
 * One Chrome bookmark node captured before removal/move, sufficient to
 * re-create the subtree at its original position (`parentId` + `index`).
 * `url` is absent on folders. `children` recurses — a removed folder carries
 * its whole subtree so cascade restores need no extra rows.
 */
export const UndoNode = z.strictObject({
  id: z.string(), // Chrome node id at snapshot time (pre-delete)
  parentId: z.string(),
  index: z.number().int().min(0),
  title: z.string(), // Chrome permits empty titles
  url: z.string().min(1).optional(),
  get children() {
    return z.array(UndoNode).optional();
  },
  /**
   * `bulk_move`/`restructure` only: the parent the move sent this node to
   * (recorded at capture time by the pusher — {@link parentId} is the
   * ORIGINAL, pre-move parent). On undo a node whose current parent is
   * not this target was moved AGAIN since the snapshot and is skipped
   * rather than yanked back (D09). Absent on older rows and on
   * delete/merge/tag_delete nodes — those restores keep their existing
   * semantics.
   */
  movedToParentId: z.string().optional(),
});
export type UndoNode = z.infer<typeof UndoNode>;

/**
 * The BookmarkMeta rows belonging to snapshotted nodes, kept alongside them so
 * metadata can be remapped onto the new Chrome IDs on restore. Same shape as
 * the `bookmarkMeta` table row.
 */
export const UndoMeta = BookmarkMeta;
export type UndoMeta = z.infer<typeof UndoMeta>;

/**
 * Snapshot written to the Dexie `undo` table (`++id,createdAt`) before a
 * delete, bulk move, merge, or tag-delete. `id` is auto-incremented on write,
 * so it is absent in the input document and present once persisted.
 * `tagDef` carries the deleted tag's definition for `tag_delete` restores;
 * for other kinds it stays absent (the tag rows live in `meta` already).
 * `idMap` is restore progress persisted by `src/undo/restore.ts`: old
 * snapshot id → new Chrome id for every node recreated so far, written back
 * after each successful create so a failed restore resumes instead of
 * replaying (fresh Chrome ids make a naive retry duplicate everything).
 */
export const UndoSnapshot = z
  .strictObject({
    id: z.number().int().positive().optional(), // assigned by IndexedDB
    createdAt: z.iso.datetime(),
    kind: UndoKind,
    nodes: z.array(UndoNode),
    meta: z.array(UndoMeta),
    tagDef: TagDef.optional(),
    idMap: z.record(z.string(), z.string()).optional(),
    /**
     * `restructure` snapshots only: Chrome ids of the folders the apply
     * created (parents-first order). On undo each is removed iff it is
     * still a folder and empty — a folder the user has since filed into is
     * kept.
     */
    createdFolderIds: z.array(z.string().min(1)).optional(),
    /** D05 retention bucket; absent rows read as `user`. */
    origin: UndoOrigin.optional(),
  })
  .superRefine((snapshot, ctx) => {
    if (snapshot.kind === "tag_delete" && snapshot.tagDef === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["tagDef"],
        message: "tagDef is required for tag_delete snapshots",
      });
    }
  });
export type UndoSnapshot = z.infer<typeof UndoSnapshot>;
