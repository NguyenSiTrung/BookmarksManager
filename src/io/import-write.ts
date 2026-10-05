import { createTag, getMeta, getTag, patchMeta, putMeta } from "../db/meta";
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
}

/** Why a writeImport call failed outright (the import root could not be created). */
export type WriteImportErrorCode = "import_root_failed";

/** Total result union — `writeImport` never throws. */
export type WriteImportResult =
  | { ok: true; summary: ImportSummary }
  | { ok: false; code: WriteImportErrorCode; message: string };

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
function hasMeta(meta: ImportMeta): boolean {
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
  item: ImportItem,
  id: string,
  summary: ImportSummary,
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
    summary.failures.push({
      kind: "meta",
      title: item.title,
      message: detail(cause),
    });
  }
}

/**
 * Record every descendant of an uncreated folder as a failure so the summary
 * reconciles: each gets the shared "skipped" cause under its own kind/title.
 */
function recordSubtreeFailures(
  items: readonly ImportItem[],
  cause: string,
  summary: ImportSummary,
): void {
  for (const item of items) {
    summary.failures.push({ kind: item.kind, title: item.title, message: cause });
    if (item.kind === "folder") {
      recordSubtreeFailures(item.children, cause, summary);
    }
  }
}

/**
 * Write one level of the forest under `parentId`, siblings in array order
 * (each create appends, so file order becomes index order). Sequential
 * awaits keep ordering deterministic and failures attributable.
 */
async function writeItems(
  items: readonly ImportItem[],
  parentId: string,
  summary: ImportSummary,
): Promise<void> {
  for (const item of items) {
    if (item.kind === "folder") {
      let folder: BookmarksTreeNode;
      try {
        folder = await createFolder({ parentId, title: item.title });
        summary.foldersCreated += 1;
      } catch (cause) {
        const message = detail(cause);
        summary.failures.push({ kind: "folder", title: item.title, message });
        recordSubtreeFailures(
          item.children,
          `skipped: parent folder "${item.title}" failed to create`,
          summary,
        );
        continue;
      }
      await writeMeta(item, folder.id, summary);
      await writeItems(item.children, folder.id, summary);
    } else {
      // Re-validate the URL at the write boundary — a raw ImportItem[] input
      // bypasses planImport's pruning and must never reach createBookmark
      // with an empty or scriptable URL. Same shared blocklist the Netscape
      // parser and the planner apply.
      if (item.url.trim() === "") {
        summary.failures.push({
          kind: "bookmark",
          title: item.title,
          message: "Refused: the URL is empty.",
        });
        continue;
      }
      if (isBlockedScheme(item.url)) {
        summary.failures.push({
          kind: "bookmark",
          title: item.title,
          message: `Refused: ${JSON.stringify(item.url)} uses a blocked URL scheme.`,
        });
        continue;
      }
      try {
        const created = await createBookmark({
          parentId,
          title: item.title,
          url: item.url,
        });
        summary.bookmarksCreated += 1;
        await writeMeta(item, created.id, summary);
      } catch (cause) {
        summary.failures.push({
          kind: "bookmark",
          title: item.title,
          message: detail(cause),
        });
      }
    }
  }
}

/**
 * Restore JSON tag definitions: reuse an existing def on a nameKey collision
 * (the library's colors/description win — the file never clobbers them),
 * create the def otherwise. Per-def failures are collected, never fatal.
 */
async function restoreTagDefs(
  defs: readonly TagDef[],
  summary: ImportSummary,
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
      summary.tagsCreated += 1;
    } catch (cause) {
      summary.failures.push({
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
  plan: ImportPlan | undefined,
  items: readonly ImportItem[],
  summary: ImportSummary,
): Promise<void> {
  const wanted = new Map<string, string>(); // key -> display name
  const collect = (meta: { tags?: readonly string[] } | undefined): void => {
    for (const { name, key } of sanitizeImportTags(meta?.tags)) {
      if (!wanted.has(key)) wanted.set(key, name);
    }
  };
  const walk = (list: readonly ImportItem[]): void => {
    for (const item of list) {
      collect(item.meta);
      if (item.kind === "folder") walk(item.children);
    }
  };
  walk(items);
  for (const skipped of plan?.skipped ?? []) collect(skipped.meta);
  for (const [key, name] of wanted) {
    try {
      if ((await getTag(key)) !== undefined) continue;
      await createTag(name);
      summary.tagsCreated += 1;
    } catch (cause) {
      summary.failures.push({ kind: "tag", title: name, message: detail(cause) });
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
  plan: ImportPlan,
  summary: ImportSummary,
): Promise<void> {
  for (const skipped of plan.skipped) {
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
      summary.failures.push({
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
 * Write a planned import. `source` is either a {@link ImportPlan} from
 * `planImport` (its preview counts carry into the summary) or a raw
 * `ImportItem[]` forest (written verbatim — no duplicate skipping; planning
 * is the caller's job).
 *
 * Total by contract — the result union is the house pattern. The single
 * fatal step is creating the import root under Other bookmarks; everything
 * after it is collected per item into `summary.failures`.
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

  const summary: ImportSummary = {
    importRootId: root.id,
    foldersCreated: 0,
    bookmarksCreated: 0,
    duplicatesSkipped: plan?.duplicatesSkipped ?? 0,
    invalidSkipped: plan?.invalid ?? 0,
    tagsCreated: 0,
    failures: [],
  };

  await restoreTagDefs(options.tagDefs ?? [], summary);
  await ensureImportTagDefs(plan, items, summary);
  await writeItems(items, root.id, summary);
  if (plan !== undefined) {
    await mergeSkippedDuplicates(plan, summary);
  }
  return { ok: true, summary };
}
