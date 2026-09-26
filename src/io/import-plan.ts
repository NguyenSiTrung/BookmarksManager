import type { Category } from "../schemas/bookmark";
import type { ExportEnvelope, ExportTreeNode } from "../schemas/export";
import type { BookmarkMeta } from "../schemas/meta";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";
import { normalizeUrl } from "../duplicates/normalize";
import { BLOCKED_URL_SCHEMES } from "./netscape";
import type { CsvBookmarkRow } from "./csv";
import type { NetscapeNode } from "./netscape";

/**
 * Import planner — the pure half of the local-file import flow.
 *
 * The UI flow is: parse a file (`parseExport` / `parseNetscape` / `parseCsv`)
 * → adapt it into the normalized {@link ImportItem} forest with the `from*`
 * adapters below → feed the forest plus the library's existing normalized
 * URLs into {@link planImport} → show the returned counts in the preview →
 * on Confirm, hand `plan.items` (or the whole plan) to `writeImport` in
 * `src/io/import-write.ts`.
 *
 * This module is pure: no `chrome`, no DOM, no Dexie, no `fetch`.
 * `planImport` only inspects and filters — it writes nothing, so the preview
 * counts it returns are exactly what a later write will do.
 *
 * ## ImportItem — the normalized intermediate
 *
 * One recursive node type covering all three formats: folders keep `children`
 * (file order = sibling order), bookmarks keep `url`, and either kind may
 * carry {@link ImportMeta} — the meta fields the format can express (JSON
 * meta rows, CSV tag/category/notes columns, the Netscape `TAGS` attribute).
 * What the formats cannot express is absent here: `addDate`/`LAST_MODIFIED`
 * (Netscape) and `created` (CSV) are dropped because `chrome.bookmarks.create`
 * cannot set them, and the JSON envelope's node ids are dropped because they
 * are export-local meta join keys, never reusable Chrome ids.
 *
 * ## Duplicate semantics
 *
 * A bookmark is a duplicate when `normalizeUrl(url)` produces a key that is
 * already known — the seen set starts as a copy of `existingUrls` (the
 * library) and every KEPT bookmark's key is added to it, so a URL appearing
 * twice inside one file is also skipped on its second occurrence (importing
 * the twin would create the very duplicate the preview promised to avoid).
 * Bookmarks whose URL has no normalized form (`normalizeUrl` → `null`:
 * `ftp:`, `chrome:`, schemeless, unparseable) can never be duplicates and are
 * always kept. `options.importDuplicates` disables the whole check.
 *
 * ## What the planner drops
 *
 * - duplicates (into `duplicatesSkipped`), unless `importDuplicates` is set;
 * - bookmarks with a blocked URL scheme — `javascript:`/`data:`/`vbscript:`
 *   per {@link BLOCKED_URL_SCHEMES}, the same blocklist the Netscape parser
 *   applies — and bookmarks with an empty/whitespace URL. Both go into
 *   `invalid`, together with the caller-supplied count of rows the file
 *   parser already rejected (pass `stats.invalid + stats.skipped` for
 *   Netscape, `invalid.length` for CSV).
 *
 * Folders are NEVER dropped: even when every descendant is skipped the folder
 * is kept, because the spec preserves the file's folder structure inside the
 * import root.
 */

// ---------------------------------------------------------------------------
// Normalized intermediate shapes
// ---------------------------------------------------------------------------

/** Meta fields a format can carry; written via `putMeta` by the writer. */
export interface ImportMeta {
  /**
   * Tag names. Display names or nameKeys are both fine — the meta repo
   * normalizes through `tagNameKey` (trim + lowercase) on write.
   */
  tags?: readonly string[];
  category?: Category;
  notes?: string;
}

/** A bookmark row: `kind` discriminates it from {@link ImportFolder}. */
export interface ImportBookmark {
  kind: "bookmark";
  title: string;
  url: string;
  meta?: ImportMeta;
}

/** A folder; `children` preserves file order (= sibling order on write). */
export interface ImportFolder {
  kind: "folder";
  title: string;
  children: ImportItem[];
  meta?: ImportMeta;
}

/** One node of the normalized source forest. */
export type ImportItem = ImportBookmark | ImportFolder;

/** The items a plan returns for the writer — the pruned source forest. */
export type PlannedItem = ImportItem;

// ---------------------------------------------------------------------------
// planImport
// ---------------------------------------------------------------------------

/** Toggles on `planImport`. */
export interface ImportPlanOptions {
  /**
   * Re-include bookmarks whose normalized URL already exists. Default false
   * (duplicates are skipped). This is the preview's "Import duplicates
   * anyway" checkbox.
   */
  importDuplicates?: boolean;
}

/** Input to {@link planImport}. */
export interface PlanImportInput {
  /** The normalized source forest — output of a `from*` adapter. */
  items: readonly ImportItem[];
  /**
   * Normalized URLs already in the library (see {@link collectNormalizedUrls}
   * for building one from `chrome.bookmarks.getTree()`).
   */
  existingUrls: ReadonlySet<string>;
  /**
   * Rows the file parser already rejected — surfaced in the preview's invalid
   * count. Netscape: `stats.invalid + stats.skipped`; CSV: `invalid.length`;
   * JSON: omit (the envelope schema validates everything or nothing).
   */
  invalid?: number;
  options?: ImportPlanOptions;
}

/**
 * The preview: what a write of this plan would do. `folders`/`bookmarks`
 * count nodes that WILL be created inside the import root (the
 * `Imported <…>` root folder itself is not counted — it is not part of the
 * file's structure); `duplicatesSkipped` and `invalid` are the drop counts;
 * `items` is the pruned forest to hand to `writeImport`.
 */
export interface ImportPlan {
  folders: number;
  bookmarks: number;
  duplicatesSkipped: number;
  invalid: number;
  items: PlannedItem[];
}

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Mirror of the Netscape parser's scheme check: ASCII whitespace and control
 * characters are removed before reading the scheme, because that is how
 * browsers resolve an href — `java\tscript:` still executes. Kept in sync
 * with `isBlockedScheme` in `src/io/netscape.ts` (the function is private
 * there; the blocklist is shared via {@link BLOCKED_URL_SCHEMES}).
 */
function isBlockedImportUrl(url: string): boolean {
  // The control-char range is intentional — see isBlockedScheme in netscape.ts.
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\x00-\x20]/g, "");
  const scheme = SCHEME_PATTERN.exec(compact)?.[1];
  return scheme !== undefined && BLOCKED_URL_SCHEMES.has(scheme.toLowerCase());
}

/**
 * Filter one level of the forest into the plan. Folders are always kept and
 * recurse (with fresh objects — the caller's tree is never mutated);
 * bookmarks are kept unless blocked, empty, or a known duplicate.
 */
function planItems(
  items: readonly ImportItem[],
  seen: Set<string>,
  importDuplicates: boolean,
  plan: ImportPlan,
): ImportItem[] {
  const out: ImportItem[] = [];
  for (const item of items) {
    if (item.kind === "folder") {
      plan.folders += 1;
      out.push({
        ...item,
        children: planItems(item.children, seen, importDuplicates, plan),
      });
      continue;
    }
    if (item.url.trim() === "" || isBlockedImportUrl(item.url)) {
      plan.invalid += 1;
      continue;
    }
    const key = normalizeUrl(item.url);
    if (key !== null) {
      if (!importDuplicates && seen.has(key)) {
        plan.duplicatesSkipped += 1;
        continue;
      }
      seen.add(key);
    }
    plan.bookmarks += 1;
    out.push(item);
  }
  return out;
}

/**
 * Compute the import preview. Pure and total: nothing is written, nothing
 * throws. The returned {@link ImportPlan} is what the UI renders before
 * Confirm and what `writeImport` consumes afterwards.
 */
export function planImport(input: PlanImportInput): ImportPlan {
  const importDuplicates = input.options?.importDuplicates ?? false;
  // A copy: the caller's set is never mutated, and kept bookmarks join it so
  // in-file repeats count as duplicates too (see module header).
  const seen = new Set(input.existingUrls);
  const plan: ImportPlan = {
    folders: 0,
    bookmarks: 0,
    duplicatesSkipped: 0,
    invalid: input.invalid ?? 0,
    items: [],
  };
  plan.items = planItems(input.items, seen, importDuplicates, plan);
  return plan;
}

/**
 * Build the `existingUrls` set for {@link planImport} from a Chrome tree
 * (`getTree()` or `getSubTree()` output): every node's URL run through
 * `normalizeUrl`, non-normalizable URLs dropped.
 */
export function collectNormalizedUrls(
  nodes: readonly BookmarksTreeNode[],
): Set<string> {
  const urls = new Set<string>();
  const walk = (list: readonly BookmarksTreeNode[]): void => {
    for (const node of list) {
      if (node.url !== undefined) {
        const key = normalizeUrl(node.url);
        if (key !== null) urls.add(key);
      }
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return urls;
}

// ---------------------------------------------------------------------------
// Format adapters → ImportItem[]
// ---------------------------------------------------------------------------

/** `undefined` for an absent or all-empty meta row. */
function toImportMeta(meta: BookmarkMeta | undefined): ImportMeta | undefined {
  if (meta === undefined) return undefined;
  const out: ImportMeta = {};
  if (meta.tags.length > 0) out.tags = meta.tags;
  if (meta.category !== undefined) out.category = meta.category;
  if (meta.notes !== undefined) out.notes = meta.notes;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Adapt a parsed JSON envelope. `meta[]` rows are joined onto nodes by the
 * envelope's export-local `id`; the ids themselves are dropped (they are join
 * keys, not reusable Chrome ids — see `src/schemas/export.ts`). Tag
 * definitions are NOT carried: they are not nodes — pass `envelope.tags` to
 * `writeImport`'s `tagDefs` option instead.
 */
export function fromEnvelope(envelope: ExportEnvelope): ImportItem[] {
  const metaById = new Map<string, BookmarkMeta>(
    envelope.meta.map((row) => [row.id, row]),
  );
  const convert = (nodes: readonly ExportTreeNode[]): ImportItem[] =>
    nodes.map((node) => {
      const meta = toImportMeta(metaById.get(node.id));
      if (node.url !== undefined) {
        const bookmark: ImportBookmark = {
          kind: "bookmark",
          title: node.title,
          url: node.url,
        };
        if (meta !== undefined) bookmark.meta = meta;
        return bookmark;
      }
      const folder: ImportFolder = {
        kind: "folder",
        title: node.title,
        children: convert(node.children ?? []),
      };
      if (meta !== undefined) folder.meta = meta;
      return folder;
    });
  return convert(envelope.tree);
}

/**
 * Adapt a parsed Netscape tree (`parseNetscape`'s `tree`). `TAGS` lands in
 * `meta.tags`; `addDate`/`lastModified` are dropped (Chrome sets its own
 * `dateAdded`; the create API cannot take one). Pass the parser's
 * `stats.invalid + stats.skipped` through `PlanImportInput.invalid`.
 */
export function fromNetscape(nodes: readonly NetscapeNode[]): ImportItem[] {
  return nodes.map((node) => {
    if (node.kind === "folder") {
      return {
        kind: "folder",
        title: node.title,
        children: fromNetscape(node.children),
      };
    }
    const bookmark: ImportBookmark = {
      kind: "bookmark",
      title: node.title,
      url: node.url,
    };
    if (node.tags.length > 0) bookmark.meta = { tags: node.tags };
    return bookmark;
  });
}

/** `undefined` when the row carries no meta fields. `created` is dropped. */
function csvMeta(row: CsvBookmarkRow): ImportMeta | undefined {
  const meta: ImportMeta = {};
  if (row.tags.length > 0) meta.tags = row.tags;
  if (row.category !== undefined) meta.category = row.category;
  if (row.notes !== undefined) meta.notes = row.notes;
  return Object.keys(meta).length === 0 ? undefined : meta;
}

/**
 * Adapt CSV rows into a forest: `folderPath` (`/`-joined ancestors) becomes
 * nested folders. Segments are trimmed and empty segments dropped; rows
 * sharing an identical normalized path share the folder — the map key is the
 * joined path, so `W/D` and `W / D` merge while `W/D` and `w/d` stay apart
 * (folder titles are case-sensitive data). `created` is dropped — Chrome
 * owns `dateAdded`. Pass `parseCsv`'s `invalid.length` through
 * `PlanImportInput.invalid`.
 */
export function fromCsvRows(rows: readonly CsvBookmarkRow[]): ImportItem[] {
  const root: ImportItem[] = [];
  const folders = new Map<string, ImportFolder>();
  for (const row of rows) {
    let siblings = root;
    let pathKey = "";
    for (const segment of row.folderPath
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part !== "")) {
      pathKey = pathKey === "" ? segment : `${pathKey}/${segment}`;
      let folder = folders.get(pathKey);
      if (folder === undefined) {
        folder = { kind: "folder", title: segment, children: [] };
        folders.set(pathKey, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    const bookmark: ImportBookmark = {
      kind: "bookmark",
      title: row.title,
      url: row.url,
    };
    const meta = csvMeta(row);
    if (meta !== undefined) bookmark.meta = meta;
    siblings.push(bookmark);
  }
  return root;
}
