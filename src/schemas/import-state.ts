import { z } from "./z";
import { Category } from "./bookmark";
import { TagDef } from "./meta";

/**
 * Persisted state for a resumable import (I01). Two rows share one import id:
 *
 * - `importQueues` — written ONCE before the first node create: the source
 *   forest flattened preorder, the skipped-duplicate list, and the tag defs
 *   to restore. Immutable for the life of the import.
 * - `importStates` — the mutable cursor: next queue index, per-folder chrome
 *   ids, counters, and the (capped) failure list. Rewritten per item, so it
 *   stays small — the queue never rides along.
 *
 * `importRootId` lands in the state row BEFORE the first item write (the
 * "write-ahead" half of I01): an interrupted run — killed service worker,
 * closed panel — leaves a `running` row whose queue + cursor let
 * `resumeImport` finish without re-creating a single node. Rows are deleted
 * on completion and on clean cancel, so any surviving row is by definition
 * resumable work, and `listInterruptedImports` is a plain table read.
 */

/** Maximum items one import queue row may carry (20 MiB file → ~200k rows). */
export const MAX_IMPORT_QUEUE_ITEMS = 250_000;

/** Persisted failures are capped — the summary UI only renders the first N. */
export const MAX_PERSISTED_IMPORT_FAILURES = 200;

/**
 * Meta fields a queue entry may carry — mirrors `ImportMeta` (import-plan).
 * Bounds are STORAGE bounds, deliberately looser than `BookmarkMeta`'s
 * semantic ones: a value that violates the meta schema must still persist
 * here so `putMeta` can reject it at write time and record the `meta`
 * failure — clamping in this layer would silently launder bad input.
 */
export const ImportStateMeta = z.object({
  tags: z.array(z.string().max(256)).max(128).optional(),
  category: Category.optional(),
  notes: z.string().max(50_000).optional(),
  summary: z.string().max(5_000).optional(),
});
export type ImportStateMeta = z.infer<typeof ImportStateMeta>;

/**
 * One flattened queue entry. `parentIndex` is the queue index of the folder
 * this item files under, or -1 for the import root — preorder flattening
 * guarantees every parent sits at a lower index than its children, so a
 * resume only ever looks BACKWARD in the queue.
 */
export const ImportStateItem = z.object({
  parentIndex: z.number().int().min(-1),
  kind: z.enum(["folder", "bookmark"]),
  title: z.string().min(1).max(500),
  url: z.string().max(8192).optional(),
  meta: ImportStateMeta.optional(),
});
export type ImportStateItem = z.infer<typeof ImportStateItem>;

/** A skipped duplicate kept for the post-write merge (I04). */
export const ImportStateSkipped = z.object({
  url: z.string().max(8192),
  title: z.string().max(500),
  meta: ImportStateMeta.optional(),
  existingId: z.string().min(1).optional(),
});
export type ImportStateSkipped = z.infer<typeof ImportStateSkipped>;

/** The immutable import payload — one row, written ahead of the cursor. */
export const ImportQueueRow = z.object({
  id: z.string().min(1).max(64),
  items: z.array(ImportStateItem).max(MAX_IMPORT_QUEUE_ITEMS),
  skipped: z.array(ImportStateSkipped).max(100_000),
  tagDefs: z.array(TagDef).max(10_000),
});
export type ImportQueueRow = z.infer<typeof ImportQueueRow>;

/**
 * Resumability status. There is no "completed" value: finishing deletes the
 * row outright, so a read can never observe a terminal state. "cancelled"
 * survives only as a flag for a live driver to notice between items.
 */
export const ImportStateStatus = z.enum(["running", "cancelled"]);
export type ImportStateStatus = z.infer<typeof ImportStateStatus>;

/** One collected partial failure — mirrors `ImportFailure` (import-write). */
export const ImportStateFailure = z.object({
  kind: z.enum(["folder", "bookmark", "meta", "tag"]),
  title: z.string().max(500),
  message: z.string().max(2_000),
});
export type ImportStateFailure = z.infer<typeof ImportStateFailure>;

/** The mutable cursor row — rewritten once per written item. */
export const ImportState = z.object({
  id: z.string().min(1).max(64),
  status: ImportStateStatus,
  /** Chrome id of the `Imported <…>` root — also the undo entry point. */
  importRootId: z.string().min(1),
  /** Root title, for the resume prompt. */
  title: z.string().min(1).max(500),
  /** Next queue index to write — write-ahead ordering: item first, then ++. */
  cursor: z.number().int().min(0),
  total: z.number().int().min(0),
  /** queue index (as a string key) → created chrome folder id. */
  folderIds: z.record(z.string(), z.string().min(1)),
  foldersCreated: z.number().int().min(0),
  bookmarksCreated: z.number().int().min(0),
  tagsCreated: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  failures: z.array(ImportStateFailure).max(MAX_PERSISTED_IMPORT_FAILURES),
  /**
   * Single-flight token (I01): `resumeImport` claims the row inside a
   * transaction before driving — a second resume sees a fresh `claimedBy`
   * (updatedAt is refreshed per item, so a claim older than the TTL is a
   * dead driver's and may be taken over). The driver verifies the token on
   * each boundary read and stands down on mismatch.
   */
  claimedBy: z.string().max(64).optional(),
  /** Set once tag defs have been restored — resume does not re-run them. */
  tagDefsDone: z.boolean(),
  /** Set once skipped-duplicate metas have been merged — resume skips it. */
  skippedDone: z.boolean(),
  duplicatesSkipped: z.number().int().min(0),
  invalidSkipped: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ImportState = z.infer<typeof ImportState>;
