import {
  createTag,
  emitMetaChanged,
  getTag,
  retainCorruptMetaBatch,
} from "../db/meta";
import { db } from "../db/database";
import {
  ImportQueueRow,
  ImportState,
  ImportStateItem,
  MAX_PERSISTED_IMPORT_FAILURES,
  type ImportStateMeta,
  type ImportStateSkipped,
} from "../schemas/import-state";
import { BookmarkMeta, tagNameKey, type TagDef } from "../schemas/meta";
import {
  OTHER_BOOKMARKS_ID,
  get as getBookmarkNodes,
  type BookmarksTreeNode,
} from "../sync/chrome-bookmarks";
import {
  createBookmark,
  createFolder,
  newMutationVerifyCache,
} from "../sync/mutations";
import type { ImportItem, ImportMeta, ImportPlan } from "./import-plan";
import { isBlockedScheme } from "./netscape";
/**
 * Import writer — the write half of the local-file import flow. Consumes the
 * preview {@link ImportPlan} from `planImport` (or a raw {@link ImportItem}
 * forest when the caller skips planning) and materializes it under a NEW
 * `Imported <YYYY-MM-DD HH:mm>` folder inside Other bookmarks
 * (`OTHER_BOOKMARKS_ID`, "2").
 *
 * ## Resumability (I01)
 *
 * The forest is flattened preorder into a persisted `importQueues` row and a
 * mutable `importStates` cursor row — both written BEFORE the first node
 * (the queue's one write happens right after the import root is created, so
 * `importRootId` is always stored). Each item bumps `cursor` and persists
 * the created folder ids under `folderIds[queueIndex]`, so an interrupted
 * run — closed side panel, killed service worker — can be finished by
 * {@link resumeImport} without duplicating a single node. `importStates`
 * rows are deleted on completion and on clean cancel: a surviving `running`
 * row IS the "Resume import?" offer ({@link listInterruptedImports}).
 * The queue row stays immutable and is updated zero times — keeping it out
 * of the per-item put avoids the O(items²) rewrite trap.
 *
 * Cancellation is two-channel: an in-page {@link AbortSignal} and the
 * persisted `status` (flipped by {@link cancelImport} so a second context
 * can stop a running import). Both are checked before every item; a clean
 * cancel deletes the state and queue rows and returns `code: "cancelled"`.
 * Progress is reported through `options.onProgress` after each item.
 *
 * Every node write goes through the guarded mutation service
 * (`src/sync/mutations.ts`) — never the raw `chrome.bookmarks` surface — so
 * root/managed/index guards and the typed {@link MutationError} model apply.
 * Metadata is written per node via `putMeta` AFTER the node exists: a meta
 * rejection is recorded as a `meta` failure while the node still counts as
 * created (the mutations service deliberately does not roll back the chrome
 * write on a sidecar failure either).
 *
 * Tag definitions (JSON envelopes only) are restored BEFORE the items:
 * `getTag(nameKey)` first, `createTag(name, {color, description})` only on a
 * miss — a nameKey collision keeps the library's existing def, it is never
 * clobbered. `createdAt`/`updatedAt` are not carried; the repo stamps this
 * library's own timestamps.
 *
 * URL safety is re-checked HERE, not trusted from the plan: a raw
 * `ImportItem[]` input can carry an empty or blocked-scheme URL the planner
 * would have pruned, so {@link writeItems} refuses them (recorded as
 * failures — `createBookmark` is never reached) before touching Chrome.
 *
 * ## Partial-failure policy
 *
 * A per-item write failure never aborts the import: it is collected into
 * `summary.failures` and siblings keep writing. When a FOLDER create fails
 * its descendants cannot be placed — every one of them is recorded as a
 * failure with a "skipped: parent folder …" message so the summary's counts
 * still reconcile (`failures.length` covers everything not created). The
 * only TOTAL failure is the import root itself: when
 * `Imported <YYYY-MM-DD HH:mm>` cannot be created under Other bookmarks the
 * result is `{ ok: false, code: "import_root_failed" }` and nothing exists
 * to undo.
 *
 * ## Undo
 *
 * Undo is deliberately not a separate path: the summary carries
 * `importRootId`, and `removeTree(importRootId)` deletes the whole import —
 * meta rows for the subtree are cascade-deleted by the Phase-1 `onRemoved`
 * listener (`src/sync/listeners.ts`). Tag definitions are library data, not
 * part of the import subtree, so undo keeps them.
 */

/** What kind of write a {@link ImportFailure} entry describes. */
export type ImportFailureKind = "folder" | "bookmark" | "meta" | "tag";

/** One collected partial failure — the import continued past it. */
export interface ImportFailure {
  kind: ImportFailureKind;
  /** Node title or tag display name, for the summary UI. */
  title: string;
  /** The rejection message (MutationError/MetaRepoError text). */
  message: string;
}

/**
 * The post-import summary — shown to the user and the undo entry point.
 * `foldersCreated`/`bookmarksCreated` count nodes the WRITER created inside
 * the import root (the root itself is reported separately via
 * `importRootId`); `duplicatesSkipped`/`invalidSkipped` echo the plan's
 * preview counts (0 when a raw items array was written); `tagsCreated`
 * counts tag definitions actually created (nameKey collisions reuse the
 * library def and are not counted).
 */
export interface ImportSummary {
  /** Chrome id of the `Imported <…>` root — hand to `removeTree` for undo. */
  importRootId: string;
  foldersCreated: number;
  bookmarksCreated: number;
  duplicatesSkipped: number;
  invalidSkipped: number;
  tagsCreated: number;
  failures: ImportFailure[];
}

/** Options for {@link writeImport}. */
export interface WriteImportOptions {
  /**
   * Clock override for the `Imported <YYYY-MM-DD HH:mm>` title — the local
   * wall time by default. Tests inject a fixed value for determinism.
   */
  now?: Date;
  /**
   * Tag definitions to restore (JSON envelopes only — pass
   * `envelope.tags`). Existing nameKeys are reused, not overwritten.
   */
  tagDefs?: readonly TagDef[];
  /** In-page cancellation — polled before every item write. */
  signal?: AbortSignal;
  /** Called after each item (and once at start) with the live position. */
  onProgress?: (progress: ImportProgress) => void;
}

/** Progress callback payload: `done` items written/skipped of `total`. */
export interface ImportProgress {
  done: number;
  total: number;
  /** Queue index just processed — informational for the UI. */
  cursor: number;
}

/** Why a writeImport/resumeImport call failed outright. */
export type WriteImportErrorCode =
  | "import_root_failed"
  | "cancelled"
  | "interrupted"
  | "already_running"
  | "state_lost";

/** Total result union — `writeImport` never throws. */
export type WriteImportResult =
  | { ok: true; summary: ImportSummary }
  | {
      ok: false;
      code: WriteImportErrorCode;
      message: string;
      /** Partial counts for a cancelled run — what got written stays. */
      summary?: ImportSummary;
    };

/** `YYYY-MM-DD HH:mm` in local wall time — the spec's folder stamp. */
export function importRootTitle(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Imported ${date} ${time}`;
}

/** Error message text for the summary/failure records. */
function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** True when the meta object carries at least one writable field. */
function hasMeta(meta: ImportMeta | ImportStateMeta): boolean {
  return (
    (meta.tags !== undefined && meta.tags.length > 0) ||
    meta.category !== undefined ||
    (meta.notes !== undefined && meta.notes !== "") ||
    meta.summary !== undefined
  );
}

/**
 * Per-tag sanitation (I03): a file can carry names that violate TagNameKey
 * — over the 64-char bound or all-whitespace. Each tag is handled
 * INDIVIDUALLY: whitespace names drop out (key would be `""`), over-long
 * names are truncated to 64 chars, and the surviving set is deduped. A bad
 * tag can never fail the whole meta row this way. Returns `[name, key]`
 * pairs — `name` feeds `createTag` for defs, `key` is what meta rows store.
 */
function sanitizeImportTags(
  tags: readonly string[] | undefined,
): { name: string; key: string }[] {
  if (tags === undefined) return [];
  const out: { name: string; key: string }[] = [];
  const seenKeys = new Set<string>();
  for (const raw of tags) {
    const name = raw.trim().slice(0, 64);
    const key = tagNameKey(name).slice(0, 64);
    if (key === "" || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({ name, key });
  }
  return out;
}

/** Number of items written between cursor/metadata checkpoints in `driveImport`. */
const IMPORT_CHECKPOINT_BATCH = 25;

interface PendingMetaWrite {
  id: string;
  item: {
    kind: "folder" | "bookmark";
    title: string;
    url?: string;
    meta?: ImportMeta | ImportStateMeta;
  };
}


/**
 * Flush buffered metadata sidecars in a single IndexedDB transaction with one
 * `emitMetaChanged()` broadcast. Errors are recorded per item as `meta`
 * failures — created Chrome nodes stay in place (matching `putMeta` policy).
 */
async function flushPendingMeta(
  pending: PendingMetaWrite[],
  record: (failure: ImportFailure) => void,
): Promise<void> {
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  const candidates: {
    title: string;
    row: BookmarkMeta;
  }[] = [];
  const updatedAt = new Date().toISOString();
  for (const { id, item } of batch) {
    const meta = item.meta;
    if (meta === undefined || !hasMeta(meta)) continue;
    const tags = sanitizeImportTags(meta.tags).map((t) => t.key);
    const notes = meta.notes === "" ? undefined : meta.notes;
    const summary = meta.summary === "" ? undefined : meta.summary;
    const url =
      item.kind === "bookmark" && item.url !== "" ? item.url : undefined;
    const parsed = BookmarkMeta.safeParse({
      id,
      tags,
      ...(meta.category === undefined ? {} : { category: meta.category }),
      ...(notes === undefined ? {} : { notes }),
      ...(summary === undefined ? {} : { summary }),
      ...(url === undefined ? {} : { url }),
      schemaVersion: 1,
      updatedAt,
    });
    if (!parsed.success) {
      record({
        kind: "meta",
        title: item.title,
        message:
          parsed.error.issues[0]?.message ?? "schema validation failed",
      });
      continue;
    }
    if (
      parsed.data.tags.length === 0 &&
      parsed.data.category === undefined &&
      (parsed.data.notes === undefined || parsed.data.notes === "") &&
      (parsed.data.summary === undefined || parsed.data.summary === "")
    ) {
      continue;
    }
    candidates.push({
      title: item.title,
      row: { ...parsed.data, tags: [...parsed.data.tags] },
    });
  }
  if (candidates.length === 0) return;
  try {
    const ids = candidates.map((c) => c.row.id);
    await db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () => {
      const existingRaw = await db.bookmarkMeta.bulkGet(ids);
      const corruptRows: { id: string; raw: unknown }[] = [];
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const raw = existingRaw[i];
        if (
          id !== undefined &&
          raw !== undefined &&
          !BookmarkMeta.safeParse(raw).success
        ) {
          corruptRows.push({ id, raw });
        }
      }
      if (corruptRows.length > 0) {
        await retainCorruptMetaBatch(corruptRows, "overwrite");
      }
      await db.bookmarkMeta.bulkPut(candidates.map((c) => c.row));
    });
    emitMetaChanged();
  } catch (cause) {
    const msg = detail(cause);
    for (const c of candidates) {
      record({
        kind: "meta",
        title: c.title,
        message: msg,
      });
    }
  }
}

/**
 * Flatten the source forest preorder into queue entries. Every folder gets
 * its own entry whose index is what children's `parentIndex` points at;
 * -1 marks the import root. Preorder means a parent ALWAYS precedes its
 * descendants — on resume, anything a child needs sits below the cursor.
 * Fields are clamped to the persisted schema's bounds (titles are what
 * Chrome receives verbatim; "Untitled" fills an empty one).
 */
function flattenForQueue(items: readonly ImportItem[]): ImportStateItem[] {
  const queue: ImportStateItem[] = [];
  const pushMeta = (
    meta: ImportMeta | undefined,
  ): ImportStateMeta | undefined => {
    if (meta === undefined) return undefined;
    const out: ImportStateMeta = {};
    if (meta.tags !== undefined) {
      out.tags = meta.tags.slice(0, 128).map((t) => t.slice(0, 256));
    }
    if (meta.category !== undefined) out.category = meta.category;
    if (meta.notes !== undefined) out.notes = meta.notes.slice(0, 50_000);
    if (meta.summary !== undefined) out.summary = meta.summary.slice(0, 5_000);
    return out;
  };
  const walk = (list: readonly ImportItem[], parentIndex: number): void => {
    for (const item of list) {
      const index = queue.length;
      const title = item.title.trim() === "" ? "Untitled" : item.title.slice(0, 500);
      queue.push({
        parentIndex,
        kind: item.kind,
        title,
        ...(item.kind === "bookmark" ? { url: item.url.slice(0, 8192) } : {}),
        ...(pushMeta(item.meta) !== undefined
          ? { meta: pushMeta(item.meta) }
          : {}),
      });
      if (item.kind === "folder") walk(item.children, index);
    }
  };
  walk(items, -1);
  return queue;
}

/** Persisted-failure ring: keep the first N, always count the rest. */
function recordFailure(
  state: ImportState,
  failure: ImportFailure,
): void {
  state.failureCount += 1;
  if (state.failures.length < MAX_PERSISTED_IMPORT_FAILURES) {
    state.failures.push(failure);
  }
}

/** Live counters → the user-facing summary shape. */
function summaryFromState(state: ImportState): ImportSummary {
  return {
    importRootId: state.importRootId,
    foldersCreated: state.foldersCreated,
    bookmarksCreated: state.bookmarksCreated,
    duplicatesSkipped: state.duplicatesSkipped,
    invalidSkipped: state.invalidSkipped,
    tagsCreated: state.tagsCreated,
    failures: state.failures.map((f) => ({ ...f })),
  };
}

/**
 * Transactional conditional state update (B-03): never resurrects a deleted or
 * cancelled row and never overwrites a row claimed by a different driver.
 */
async function persistState(
  state: ImportState,
): Promise<"ok" | "cancelled" | "superseded"> {
  return db.transaction("rw", db.importStates, async () => {
    const current = await db.importStates.get(state.id);
    if (current === undefined || current.status === "cancelled") {
      return "cancelled";
    }
    if (
      current.claimedBy !== undefined &&
      state.claimedBy !== undefined &&
      current.claimedBy !== state.claimedBy
    ) {
      return "superseded";
    }
    state.updatedAt = new Date().toISOString();
    await db.importStates.put(ImportState.parse(state));
    return "ok";
  });
}

/**
 * Restore JSON tag definitions: reuse an existing def on a nameKey collision
 * (the library's colors/description win — the file never clobbers them),
 * create the def otherwise. Per-def failures are collected, never fatal.
 */
async function restoreTagDefs(
  defs: readonly TagDef[],
  state: ImportState,
): Promise<void> {
  for (const def of defs) {
    try {
      if ((await getTag(def.nameKey)) !== undefined) {
        continue;
      }
      await createTag(def.name, {
        ...(def.color === undefined ? {} : { color: def.color }),
        ...(def.description === undefined
          ? {}
          : { description: def.description }),
      });
      state.tagsCreated += 1;
    } catch (cause) {
      recordFailure(state, {
        kind: "tag",
        title: def.name,
        message: detail(cause),
      });
    }
  }
}

/**
 * I03: every tag name a CSV/Netscape plan references gets a `TagDef` —
 * without one the imported tags sit on rows but are invisible in
 * `listTags()` and cannot be renamed. Reuses an existing def on a nameKey
 * collision (same policy as {@link restoreTagDefs}); JSON envelopes keep
 * their own `tagDefs` path, this covers any tag an item or skipped
 * duplicate mentions that no def exists for yet.
 */
async function ensureImportTagDefs(
  queue: readonly ImportStateItem[],
  skipped: readonly ImportStateSkipped[],
  state: ImportState,
): Promise<void> {
  const wanted = new Map<string, string>(); // key -> display name
  const collect = (meta: ImportStateMeta | undefined): void => {
    for (const { name, key } of sanitizeImportTags(meta?.tags)) {
      if (!wanted.has(key)) wanted.set(key, name);
    }
  };
  for (const item of queue) collect(item.meta);
  for (const dup of skipped) collect(dup.meta);
  for (const [key, name] of wanted) {
    try {
      if ((await getTag(key)) !== undefined) continue;
      await createTag(name);
      state.tagsCreated += 1;
    } catch (cause) {
      recordFailure(state, { kind: "tag", title: name, message: detail(cause) });
    }
  }
}

/**
 * I04: merge a skipped duplicate's meta into the existing library bookmark.
 * Same policy as {@link mergeImportMeta}: tags union, `category`/`notes` only
 * fill empty fields — nothing the user already curated is overwritten.
 * In-file repeats carry no `existingId` (already merged at plan time).
 */
async function mergeSkippedDuplicates(
  skippedList: readonly ImportStateSkipped[],
  state: ImportState,
): Promise<void> {
  const candidates: ImportStateSkipped[] = [];
  for (const skipped of skippedList) {
    if (skipped.existingId === undefined || skipped.meta === undefined) {
      continue;
    }
    try {
      // Liveness: a node deleted between plan and write must not gain a
      // dangling meta row.
      if ((await getBookmarkNodes(skipped.existingId)).length === 0) {
        continue;
      }
      candidates.push(skipped);
    } catch (cause) {
      recordFailure(state, {
        kind: "meta",
        title: skipped.title,
        message: `merge into duplicate ${JSON.stringify(skipped.url)}: ${detail(cause)}`,
      });
    }
  }
  if (candidates.length === 0) return;

  const uniqueIds = [
    ...new Set(
      candidates
        .map((s) => s.existingId)
        .filter((id): id is string => id !== undefined),
    ),
  ];
  try {
    let wroteAny = false;
    await db.transaction("rw", db.bookmarkMeta, db.corruptMeta, async () => {
      const rawRows = await db.bookmarkMeta.bulkGet(uniqueIds);
      const byId = new Map<string, BookmarkMeta | undefined>();
      const corruptRows: { id: string; raw: unknown }[] = [];
      for (let i = 0; i < uniqueIds.length; i += 1) {
        const id = uniqueIds[i];
        if (id === undefined) continue;
        const raw = rawRows[i];
        if (raw === undefined) {
          byId.set(id, undefined);
          continue;
        }
        const parsed = BookmarkMeta.safeParse(raw);
        if (parsed.success) {
          byId.set(id, parsed.data);
        } else {
          corruptRows.push({ id, raw });
          byId.set(id, undefined);
        }
      }
      const updatedAt = new Date().toISOString();
      const toPut = new Map<string, BookmarkMeta>();
      for (const skipped of candidates) {
        const id = skipped.existingId;
        const meta = skipped.meta;
        if (id === undefined || meta === undefined) continue;
        const existing = byId.get(id);
        const tags = sanitizeImportTags(meta.tags).map((t) => t.key);
        const mergedTags = [
          ...(existing?.tags ?? []),
          ...tags.filter((k) => !(existing?.tags ?? []).includes(k)),
        ];
        const category =
          existing?.category === undefined && meta.category !== undefined
            ? meta.category
            : existing?.category;
        const rawNotes =
          (existing?.notes === undefined || existing.notes === "") &&
          meta.notes !== undefined
            ? meta.notes
            : existing?.notes;
        const notes = rawNotes === "" ? undefined : rawNotes;
        const summary =
          existing?.summary === "" ? undefined : existing?.summary;
        const url = existing?.url === "" ? undefined : existing?.url;
        const next = BookmarkMeta.safeParse({
          id,
          tags: mergedTags,
          ...(category === undefined ? {} : { category }),
          ...(notes === undefined ? {} : { notes }),
          ...(summary === undefined ? {} : { summary }),
          ...(url === undefined ? {} : { url }),
          schemaVersion: 1,
          updatedAt,
        });
        if (!next.success) {
          recordFailure(state, {
            kind: "meta",
            title: skipped.title,
            message: `merge into duplicate ${JSON.stringify(skipped.url)}: ${
              next.error.issues[0]?.message ?? "schema validation failed"
            }`,
          });
          continue;
        }
        if (
          next.data.tags.length === 0 &&
          next.data.category === undefined &&
          (next.data.notes === undefined || next.data.notes === "") &&
          (next.data.summary === undefined || next.data.summary === "")
        ) {
          continue;
        }
        const fresh: BookmarkMeta = {
          ...next.data,
          tags: [...next.data.tags],
        };
        byId.set(id, fresh);
        toPut.set(id, fresh);
      }
      if (corruptRows.length > 0) {
        await retainCorruptMetaBatch(corruptRows, "overwrite");
      }
      if (toPut.size > 0) {
        await db.bookmarkMeta.bulkPut([...toPut.values()]);
        wroteAny = true;
      }
    });
    if (wroteAny) emitMetaChanged();
  } catch (cause) {
    const msg = detail(cause);
    for (const skipped of candidates) {
      recordFailure(state, {
        kind: "meta",
        title: skipped.title,
        message: `merge into duplicate ${JSON.stringify(skipped.url)}: ${msg}`,
      });
    }
  }
}

/** Type guard: a plan carries `items`; a raw forest IS the array. */
function isImportPlan(
  source: ImportPlan | readonly ImportItem[],
): source is ImportPlan {
  return !Array.isArray(source);
}

/**
 * Milliseconds a driver's claim may go un-refreshed before another resume
 * may take over — the per-item persist refreshes `updatedAt`, so a live
 * driver's claim never expires.
 */
const CLAIM_TTL_MS = 60_000;

/**
 * The shared driver: walk the persisted queue from `state.cursor`, writing
 * one node per item. All failures funnel through {@link recordFailure} —
 * `state.failures` is the single capped store, `failureCount` keeps the
 * true total past the cap, and `ImportSummary` is a pure projection via
 * {@link summaryFromState}, so fresh and resumed drives behave identically.
 *
 * Cancellation is polled per item (AbortSignal + the persisted status);
 * a clean cancel deletes both rows and returns `code: "cancelled"` with
 * the partial summary. A claim mismatch (another driver took the row via
 * {@link resumeImport}) stands this driver down WITHOUT deleting rows —
 * the new owner finishes them. Completion deletes both rows and returns
 * the final summary.
 */
async function driveImport(
  state: ImportState,
  queue: ImportQueueRow,
  options: WriteImportOptions,
): Promise<WriteImportResult> {
  const record = (failure: ImportFailure): void =>
    recordFailure(state, failure);
  const pendingMeta: PendingMetaWrite[] = [];
  const verifyCache = newMutationVerifyCache();
  const cancelled = async (): Promise<WriteImportResult> => {
    await flushPendingMeta(pendingMeta, record);
    await db.importQueues.delete(state.id);
    await db.importStates.delete(state.id);
    return {
      ok: false,
      code: "cancelled",
      message: "Import cancelled; the items written so far were kept.",
      summary: summaryFromState(state),
    };
  };
  const superseded = async (): Promise<WriteImportResult> => {
    await flushPendingMeta(pendingMeta, record);
    return {
      ok: false,
      code: "interrupted",
      message: "Another import driver took over this import.",
      summary: summaryFromState(state),
    };
  };
  const checkPersistedStatus = async (): Promise<
    "ok" | "cancelled" | "superseded"
  > => {
    const fresh = await db.importStates.get(state.id);
    if (fresh === undefined || fresh.status === "cancelled") {
      return "cancelled";
    }
    if (
      fresh.claimedBy !== undefined &&
      fresh.claimedBy !== state.claimedBy
    ) {
      return "superseded";
    }
    return "ok";
  };
  /** queue indexes of folders whose create failed → the failing title. */
  const failedParents = new Map<number, string>();
  // On resume: folders left of the cursor with no recorded id failed before
  // the interruption — their descendants still fail with the same cause.
  for (let i = 0; i < state.cursor; i += 1) {
    const item = queue.items[i];
    if (item?.kind === "folder" && state.folderIds[String(i)] === undefined) {
      failedParents.set(i, item.title);
    }
  }

  if (!state.tagDefsDone) {
    await restoreTagDefs(queue.tagDefs, state);
    await ensureImportTagDefs(queue.items, queue.skipped, state);
    state.tagDefsDone = true;
    const tagPersist = await persistState(state);
    if (tagPersist === "cancelled") return cancelled();
    if (tagPersist === "superseded") return superseded();
  }

  options.onProgress?.({
    done: state.cursor,
    total: state.total,
    cursor: state.cursor,
  });
  let itemsSinceCheckpoint = 0;
  try {
    while (state.cursor < queue.items.length) {
      if (options.signal?.aborted) return await cancelled();
      if (itemsSinceCheckpoint === 0) {
        const status = await checkPersistedStatus();
        if (status === "cancelled") return await cancelled();
        if (status === "superseded") return await superseded();
      }
      const index = state.cursor;
      const item = queue.items[index];
      if (item === undefined) break;
      const failedParentTitle =
        item.parentIndex >= 0 ? failedParents.get(item.parentIndex) : undefined;
    if (failedParentTitle !== undefined) {
      // Same "skipped: parent folder" cascade the recursive writer used —
      // the recorded title is the topmost failed ancestor's.
      recordFailure(state, {
        kind: item.kind,
        title: item.title,
        message: `skipped: parent folder "${failedParentTitle}" failed to create`,
      });
      if (item.kind === "folder") failedParents.set(index, failedParentTitle);
    } else if (item.kind === "folder") {
      const parentId =
        item.parentIndex === -1
          ? state.importRootId
          : state.folderIds[String(item.parentIndex)];
      if (parentId === undefined) {
        // Persisted state without its parent's id is corrupt — fail the
        // subtree rather than guess a parent.
        recordFailure(state, {
          kind: "folder",
          title: item.title,
          message: "skipped: parent folder id missing from import state",
        });
        failedParents.set(index, item.title);
      } else {
        try {
          const folder = await createFolder(
            {
              parentId,
              title: item.title,
            },
            verifyCache,
          );
          state.foldersCreated += 1;
          state.folderIds[String(index)] = folder.id;
          if (item.meta !== undefined && hasMeta(item.meta)) {
            pendingMeta.push({ id: folder.id, item });
          }
        } catch (cause) {
          recordFailure(state, {
            kind: "folder",
            title: item.title,
            message: detail(cause),
          });
          failedParents.set(index, item.title);
        }
      }
    } else {
      const url = item.url ?? "";
      const parentId =
        item.parentIndex === -1
          ? state.importRootId
          : state.folderIds[String(item.parentIndex)];
      if (parentId === undefined) {
        recordFailure(state, {
          kind: "bookmark",
          title: item.title,
          message: "skipped: parent folder id missing from import state",
        });
      } else if (url.trim() === "") {
        recordFailure(state, {
          kind: "bookmark",
          title: item.title,
          message: "Refused: the URL is empty.",
        });
      } else if (isBlockedScheme(url)) {
        recordFailure(state, {
          kind: "bookmark",
          title: item.title,
          message: `Refused: ${JSON.stringify(url)} uses a blocked URL scheme.`,
        });
      } else {
        try {
          const created = await createBookmark(
            { parentId, title: item.title, url },
            verifyCache,
          );
          state.bookmarksCreated += 1;
          if (item.meta !== undefined && hasMeta(item.meta)) {
            pendingMeta.push({ id: created.id, item });
          }
        } catch (cause) {
          recordFailure(state, {
            kind: "bookmark",
            title: item.title,
            message: detail(cause),
          });
        }
      }
    }
      state.cursor += 1;
      itemsSinceCheckpoint += 1;
      if (
        itemsSinceCheckpoint >= IMPORT_CHECKPOINT_BATCH ||
        state.cursor >= queue.items.length
      ) {
        const status = await checkPersistedStatus();
        if (status === "cancelled") return await cancelled();
        if (status === "superseded") return await superseded();
        await flushPendingMeta(pendingMeta, record);
        const persisted = await persistState(state);
        if (persisted === "cancelled") return await cancelled();
        if (persisted === "superseded") return await superseded();
        itemsSinceCheckpoint = 0;
      }
      options.onProgress?.({
        done: state.cursor,
        total: state.total,
        cursor: state.cursor,
      });
    }
  } catch (cause) {
    await flushPendingMeta(pendingMeta, record);
    await persistState(state).catch(() => undefined);
    throw cause;
  }

  if (!state.skippedDone) {
    await mergeSkippedDuplicates(queue.skipped, state);
    state.skippedDone = true;
    const skippedPersist = await persistState(state);
    if (skippedPersist === "cancelled") return cancelled();
    if (skippedPersist === "superseded") return superseded();
  }

  const final = summaryFromState(state);
  await db.importQueues.delete(state.id);
  await db.importStates.delete(state.id);
  return { ok: true, summary: final };
}

/**
 * Write a planned import. `source` is either a {@link ImportPlan} from
 * `planImport` (its preview counts carry into the summary) or a raw
 * `ImportItem[]` forest (written verbatim — no duplicate skipping; planning
 * is the caller's job).
 *
 * Total by contract — the result union is the house pattern. The single
 * fatal step is creating the import root under Other bookmarks; everything
 * after it is collected per item into `summary.failures`. The persisted
 * state row lands before the first item write, so any interruption is
 * resumable via {@link resumeImport}.
 */
export async function writeImport(
  source: ImportPlan | readonly ImportItem[],
  options: WriteImportOptions = {},
): Promise<WriteImportResult> {
  const items: readonly ImportItem[] = isImportPlan(source)
    ? source.items
    : source;
  const plan = isImportPlan(source) ? source : undefined;

  const id = crypto.randomUUID();
  const rawQueue: ImportQueueRow = {
    id,
    items: flattenForQueue(items),
    skipped: (plan?.skipped ?? []).map((dup) => ({
      url: dup.url.slice(0, 8192),
      title: dup.title.slice(0, 500),
      ...(dup.meta !== undefined
        ? {
            meta: {
              ...(dup.meta.tags !== undefined
                ? { tags: dup.meta.tags.map((t) => t.slice(0, 256)) }
                : {}),
              ...(dup.meta.category !== undefined
                ? { category: dup.meta.category }
                : {}),
              ...(dup.meta.notes !== undefined
                ? { notes: dup.meta.notes.slice(0, 50_000) }
                : {}),
              ...(dup.meta.summary !== undefined
                ? { summary: dup.meta.summary.slice(0, 5_000) }
                : {}),
            },
          }
        : {}),
      ...(dup.existingId !== undefined ? { existingId: dup.existingId } : {}),
    })),
    tagDefs: [...(options.tagDefs ?? [])],
  };
  // Validate the flattened queue BEFORE creating the Chrome root folder so a
  // schema violation on items/skipped cannot leave an empty "Imported ..."
  // folder behind (B-16b).
  const parsedQueue = ImportQueueRow.safeParse({
    ...rawQueue,
    tagDefs: [],
  });
  if (!parsedQueue.success) {
    return {
      ok: false,
      code: "import_root_failed",
      message: `Invalid import queue: ${
        parsedQueue.error.issues[0]?.message ?? "schema validation failed"
      }`,
    };
  }
  const queue: ImportQueueRow = {
    ...parsedQueue.data,
    tagDefs: rawQueue.tagDefs,
  };

  let root: BookmarksTreeNode;
  try {
    root = await createFolder({
      parentId: OTHER_BOOKMARKS_ID,
      title: importRootTitle(options.now ?? new Date()),
    });
  } catch (cause) {
    return {
      ok: false,
      code: "import_root_failed",
      message: `Could not create the import folder under Other bookmarks: ${detail(cause)}`,
    };
  }

  const nowIso = new Date().toISOString();
  const state: ImportState = {
    id,
    status: "running",
    importRootId: root.id,
    title: root.title ?? "Imported",
    cursor: 0,
    total: queue.items.length,
    folderIds: {},
    foldersCreated: 0,
    bookmarksCreated: 0,
    tagsCreated: 0,
    failureCount: 0,
    failures: [],
    claimedBy: crypto.randomUUID(),
    tagDefsDone: false,
    skippedDone: false,
    duplicatesSkipped: plan?.duplicatesSkipped ?? 0,
    invalidSkipped: plan?.invalid ?? 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  try {
    await db.importQueues.put(queue);
    await db.importStates.put(ImportState.parse(state));
    return await driveImport(state, queue, options);
  } catch (cause) {
    // Release the initial driver's claim on an unexpected crash so
    // listInterruptedImports() surfaces the row immediately and
    // resumeImport() can take over without waiting for CLAIM_TTL_MS.
    try {
      const current = await db.importStates.get(id);
      if (
        current !== undefined &&
        current.status === "running" &&
        current.claimedBy === state.claimedBy
      ) {
        delete state.claimedBy;
        await db.importStates.put(
          ImportState.parse({
            ...state,
            updatedAt: new Date().toISOString(),
          }),
        );
      }
    } catch {
      // Best-effort unclaim; TTL fallback still recovers after CLAIM_TTL_MS.
    }
    return {
      ok: false,
      code: "interrupted",
      message: `Import interrupted: ${detail(cause)} — it can be resumed.`,
      summary: summaryFromState(state),
    };
  }
}

/**
 * Every persisted import row without an active claim or cancellation is
 * resumable (rows are deleted on completion/cancel): list them for the
 * "Resume import?" prompt.
 */
export async function listInterruptedImports(): Promise<ImportState[]> {
  const rows = await db.importStates.toArray();
  const now = Date.now();
  const out: ImportState[] = [];
  for (const raw of rows) {
    const parsed = ImportState.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    if (row.status === "cancelled") continue;
    if (
      row.claimedBy !== undefined &&
      now - Date.parse(row.updatedAt) < CLAIM_TTL_MS
    ) {
      continue;
    }
    out.push(row);
  }
  return out;
}
/**
 * Finish an interrupted import from its persisted cursor. The queue row is
 * what makes resume possible — a state row without it reports `state_lost`
 * instead of guessing.
 */
export async function resumeImport(
  importId: string,
  options: WriteImportOptions = {},
): Promise<WriteImportResult> {
  const token = crypto.randomUUID();
  // Single-flight claim (I01): read + mark inside ONE transaction so two
  // racing resumes cannot both drive the cursor — the loser reports
  // `already_running`. A claim whose updatedAt is older than the TTL is a
  // dead driver's and is taken over.
  const claimed = await db.transaction(
    "rw",
    db.importStates,
    async () => {
      const raw = await db.importStates.get(importId);
      const parsed = ImportState.safeParse(raw);
      if (!parsed.success) return { outcome: "lost" as const };
      const row = parsed.data;
      if (
        row.claimedBy !== undefined &&
        Date.now() - Date.parse(row.updatedAt) < CLAIM_TTL_MS
      ) {
        return { outcome: "busy" as const };
      }
      const next: ImportState = {
        ...row,
        claimedBy: token,
        updatedAt: new Date().toISOString(),
      };
      await db.importStates.put(next);
      return { outcome: "claimed" as const, state: next };
    },
  );
  if (claimed.outcome === "lost") {
    return {
      ok: false,
      code: "state_lost",
      message: `No resumable import state for ${JSON.stringify(importId)}.`,
    };
  }
  if (claimed.outcome === "busy") {
    return {
      ok: false,
      code: "already_running",
      message: "This import is already being resumed elsewhere.",
    };
  }
  const state = claimed.state;
  const rawQueue = await db.importQueues.get(importId);
  if (rawQueue === undefined) {
    return {
      ok: false,
      code: "state_lost",
      message:
        "The import's work queue is gone — delete the state row and re-import.",
    };
  }
  const parsedQueue = ImportQueueRow.safeParse(rawQueue);
  if (!parsedQueue.success) {
    return {
      ok: false,
      code: "state_lost",
      message:
        "The import's work queue is corrupt — delete the state row and re-import.",
    };
  }
  const queue = parsedQueue.data;
  if (state.status === "cancelled") {
    await db.importQueues.delete(importId);
    await db.importStates.delete(importId);
    return { ok: false, code: "cancelled", message: "Import was cancelled." };
  }
  try {
    return await driveImport(state, queue, options);
  } catch (cause) {
    try {
      const current = await db.importStates.get(importId);
      if (
        current !== undefined &&
        current.status === "running" &&
        current.claimedBy === state.claimedBy
      ) {
        delete state.claimedBy;
        await db.importStates.put(
          ImportState.parse({
            ...state,
            updatedAt: new Date().toISOString(),
          }),
        );
      }
    } catch {
      // Best-effort unclaim.
    }
    return {
      ok: false,
      code: "interrupted",
      message: `Import interrupted: ${detail(cause)} — it can be resumed.`,
      summary: summaryFromState(state),
    };
  }
}

/**
 * Delete a resumable import outright — the dialog's Discard path for a row
 * the user declines to resume. Unlike {@link cancelImport} (which only
 * flags the row for a live driver), discard removes state + queue now.
 */
export async function discardImportState(importId: string): Promise<void> {
  await db.importQueues.delete(importId);
  await db.importStates.delete(importId);
}

/**
 * Flip a running import's persisted status to cancelled — the live driver
 * notices at the next item boundary and stops cleanly. Safe on an already-
 * gone row (a completed import deletes its own state).
 */
export async function cancelImport(importId: string): Promise<void> {
  const row = await db.importStates.get(importId);
  const parsed = ImportState.safeParse(row);
  if (!parsed.success) return;
  await db.importStates.put({ ...parsed.data, status: "cancelled" });
}
