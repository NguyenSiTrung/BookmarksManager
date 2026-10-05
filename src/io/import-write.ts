import { createTag, getMeta, getTag, patchMeta, putMeta } from "../db/meta";
import { db } from "../db/database";
import {
  ImportState,
  ImportStateItem,
  MAX_PERSISTED_IMPORT_FAILURES,
  type ImportQueueRow,
  type ImportStateMeta,
  type ImportStateSkipped,
} from "../schemas/import-state";
import { tagNameKey, type TagDef } from "../schemas/meta";
import {
  OTHER_BOOKMARKS_ID,
  get as getBookmarkNodes,
  type BookmarksTreeNode,
} from "../sync/chrome-bookmarks";
import { createBookmark, createFolder } from "../sync/mutations";
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

/**
 * Meta sidecar for one created node. Errors are recorded as `meta` failures —
 * the node itself already exists and still counts as created (no rollback,
 * matching the mutations service's own sidecar policy).
 */
async function writeMeta(
  item: { kind: "folder" | "bookmark"; title: string; url?: string; meta?: ImportMeta | ImportStateMeta },
  id: string,
  record: (failure: ImportFailure) => void,
): Promise<void> {
  const meta = item.meta;
  if (meta === undefined || !hasMeta(meta)) return;
  const tags = sanitizeImportTags(meta.tags).map((t) => t.key);
  try {
    await putMeta(id, {
      ...(meta.tags === undefined ? {} : { tags }),
      ...(meta.category === undefined ? {} : { category: meta.category }),
      ...(meta.notes === undefined ? {} : { notes: meta.notes }),
      ...(meta.summary === undefined ? {} : { summary: meta.summary }),
      // D12: record the node's URL so a later remove→recreate re-attaches
      // and undo's id+url check can tell a re-used id apart.
      ...(item.kind === "bookmark" ? { url: item.url } : {}),
    });
  } catch (cause) {
    record({
      kind: "meta",
      title: item.title,
      message: detail(cause),
    });
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

/** Zod-parse + put — a corrupt row must never be written silently. */
async function persistState(state: ImportState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await db.importStates.put(ImportState.parse(state));
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
  for (const skipped of skippedList) {
    if (skipped.existingId === undefined || skipped.meta === undefined) {
      continue;
    }
    try {
      // Liveness: a node deleted between plan and write must not gain a
      // dangling meta row (patchMeta lazily creates rows for missing ids).
      if ((await getBookmarkNodes(skipped.existingId)).length === 0) {
        continue;
      }
      const existing = await getMeta(skipped.existingId);
      const tags = sanitizeImportTags(skipped.meta.tags).map((t) => t.key);
      const mergedTags = [
        ...(existing?.tags ?? []),
        ...tags.filter((k) => !(existing?.tags ?? []).includes(k)),
      ];
      await patchMeta(skipped.existingId, {
        ...(mergedTags.length === 0 ? {} : { tags: mergedTags }),
        ...(existing?.category === undefined &&
        skipped.meta.category !== undefined
          ? { category: skipped.meta.category }
          : {}),
        ...((existing?.notes === undefined || existing.notes === "") &&
        skipped.meta.notes !== undefined
          ? { notes: skipped.meta.notes }
          : {}),
        // `summary` deliberately does NOT merge here: the spec's merge list
        // is tags/category/notes only, and a file's summary is often
        // machine-generated — attaching it to an existing library bookmark
        // would overwrite user-curated context with stale AI text. The
        // plan-time sibling merge keeps it because both sides are the
        // file's own data.
      });
    } catch (cause) {
      recordFailure(state, {
        kind: "meta",
        title: skipped.title,
        message: `merge into duplicate ${JSON.stringify(skipped.url)}: ${detail(cause)}`,
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
  const cancelled = async (): Promise<WriteImportResult> => {
    await db.importQueues.delete(state.id);
    await db.importStates.delete(state.id);
    return {
      ok: false,
      code: "cancelled",
      message: "Import cancelled; the items written so far were kept.",
      summary: summaryFromState(state),
    };
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
    await persistState(state);
  }

  options.onProgress?.({
    done: state.cursor,
    total: state.total,
    cursor: state.cursor,
  });
  while (state.cursor < queue.items.length) {
    if (options.signal?.aborted) return cancelled();
    const fresh = await db.importStates.get(state.id);
    if (fresh === undefined || fresh.status === "cancelled") {
      return cancelled();
    }
    if (
      fresh.claimedBy !== undefined &&
      fresh.claimedBy !== state.claimedBy
    ) {
      // Another driver claimed the row — stand down WITHOUT deleting; the
      // owner finishes the import.
      return {
        ok: false,
        code: "interrupted",
        message: "Another import driver took over this import.",
        summary: summaryFromState(state),
      };
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
          const folder = await createFolder({
            parentId,
            title: item.title,
          });
          state.foldersCreated += 1;
          state.folderIds[String(index)] = folder.id;
          await writeMeta(item, folder.id, record);
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
          const created = await createBookmark({ parentId, title: item.title, url });
          state.bookmarksCreated += 1;
          await writeMeta(item, created.id, record);
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
    await persistState(state);
    options.onProgress?.({
      done: state.cursor,
      total: state.total,
      cursor: state.cursor,
    });
  }

  if (!state.skippedDone) {
    await mergeSkippedDuplicates(queue.skipped, state);
    state.skippedDone = true;
    await persistState(state);
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

  const id = crypto.randomUUID();
  const queue: ImportQueueRow = {
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
  await db.importQueues.put(queue);
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
    tagDefsDone: false,
    skippedDone: false,
    duplicatesSkipped: plan?.duplicatesSkipped ?? 0,
    invalidSkipped: plan?.invalid ?? 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await db.importStates.put(ImportState.parse(state));
  try {
    return await driveImport(state, queue, options);
  } catch (cause) {
    // Unexpected driver failure (a chrome error that escaped a per-item
    // catch, a throwing onProgress callback): the rows stay persisted and
    // `resumeImport` can finish the run — report it as interrupted.
    return {
      ok: false,
      code: "interrupted",
      message: `Import interrupted: ${detail(cause)} — it can be resumed.`,
      summary: summaryFromState(state),
    };
  }
}

/**
 * Every persisted import row is by definition resumable (rows are deleted on
 * completion/cancel): list them for the "Resume import?" prompt.
 */
export async function listInterruptedImports(): Promise<ImportState[]> {
  const rows = await db.importStates.toArray();
  return rows.filter((row) => ImportState.safeParse(row).success);
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
  const parsedQueue = await db.importQueues.get(importId);
  if (parsedQueue === undefined) {
    return {
      ok: false,
      code: "state_lost",
      message:
        "The import's work queue is gone — delete the state row and re-import.",
    };
  }
  if (state.status === "cancelled") {
    await db.importQueues.delete(importId);
    await db.importStates.delete(importId);
    return { ok: false, code: "cancelled", message: "Import was cancelled." };
  }
  try {
    return await driveImport(state, parsedQueue, options);
  } catch (cause) {
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
