import { useMemo, useState } from "react";
import { exportCsv, joinFolderPath } from "../../io/csv";
import type { CsvBookmarkRow } from "../../io/csv";
import { buildExport, serializeExport } from "../../io/export-json";
import { exportNetscape } from "../../io/netscape";
import type { ExportableNode } from "../../io/netscape";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../sync/chrome-bookmarks";
import type {
  BookmarkItem,
  FlattenedTree,
  FolderNode,
} from "../../sync/tree";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";

/**
 * Export dialog — the UI half of spec §5 "Export the whole library or one
 * folder as Netscape HTML, JSON, or CSV".
 *
 * Format and scope are plain radios. On Export the file is built entirely
 * in-process (`buildExport`/`serializeExport`, `exportNetscape`, `exportCsv`)
 * and downloaded with a Blob + `URL.createObjectURL` + `<a download>` click —
 * no `downloads` permission and no network anywhere in the path.
 *
 * The props mirror what App already holds: the live `FlattenedTree` from
 * `useBookmarkTree`, `listMeta()` rows (joined onto nodes by Chrome id), and
 * `listTags()` rows (meta rows store tag nameKeys; the file formats carry
 * display names, so the defs provide the mapping). `currentFolderId` /
 * `currentFolderTitle` enable the "Current folder" scope — the folder itself
 * becomes the export's single top-level node (matching `buildExport`'s
 * `folderId` semantics, so its title survives a re-import).
 */

// ---------------------------------------------------------------------------
// FlattenedTree → forest adaptation (shared with ImportDialog)
// ---------------------------------------------------------------------------

/**
 * Rebuild a `BookmarksTreeNode` forest from the flattened read model — the
 * inverse of `flattenTree` for the fields the IO layer consumes (`id`,
 * `title`, `url`, `index`, `parentId`, `dateAdded`, `children`). `childIds`
 * are already in Chrome `index` order so sibling order round-trips;
 * `dateGroupModified` is not part of the flattened model and is dropped.
 */
export function unflattenTree(tree: FlattenedTree): BookmarksTreeNode[] {
  const toNode = (id: string): BookmarksTreeNode | undefined => {
    const folder = tree.folders.get(id);
    if (folder !== undefined) {
      return {
        id: folder.id,
        ...(folder.parentId === undefined
          ? {}
          : { parentId: folder.parentId }),
        ...(folder.index === undefined ? {} : { index: folder.index }),
        title: folder.title,
        ...(folder.dateAdded === undefined
          ? {}
          : { dateAdded: folder.dateAdded }),
        children: folder.childIds
          .map(toNode)
          .filter((node): node is BookmarksTreeNode => node !== undefined),
      };
    }
    const bookmark = tree.bookmarks.get(id);
    if (bookmark === undefined) return undefined;
    return {
      id: bookmark.id,
      ...(bookmark.parentId === undefined
        ? {}
        : { parentId: bookmark.parentId }),
      ...(bookmark.index === undefined ? {} : { index: bookmark.index }),
      title: bookmark.title,
      url: bookmark.url,
      ...(bookmark.dateAdded === undefined
        ? {}
        : { dateAdded: bookmark.dateAdded }),
    };
  };
  return topLevelIds(tree)
    .map(toNode)
    .filter((node): node is BookmarksTreeNode => node !== undefined);
}

/** Top-level entry ids (parentless nodes) in `index` order. */
function topLevelIds(tree: FlattenedTree): string[] {
  return [...tree.folders.values(), ...tree.bookmarks.values()]
    .filter((entry) => entry.parentId === undefined)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((entry) => entry.id);
}

/**
 * The ids a whole-library export sits on top of: children of the synthetic
 * root "0" (it has no title and cannot be recreated on import — the same
 * unwrap rule `buildExport` applies). Falls back to the forest's top level
 * when the model does not contain "0" (e.g. a subtree slice).
 */
function exportRootIds(tree: FlattenedTree): string[] {
  const root = tree.folders.get(ROOT_NODE_ID);
  if (root !== undefined) return root.childIds;
  return topLevelIds(tree);
}

// ---------------------------------------------------------------------------
// File building
// ---------------------------------------------------------------------------

type ExportFormat = "json" | "netscape" | "csv";
type ExportScope = "all" | "folder";

interface UiError {
  code: string;
  message: string;
}

type BuiltFile =
  | {
      ok: true;
      text: string;
      ext: "json" | "html" | "csv";
      mime: string;
      /** Non-fatal export notes (e.g. over-deep subtrees flattened). */
      warnings?: string[];
    }
  | { ok: false; code: string; message: string };

/** meta.tags hold nameKeys — file formats carry display names. */
function tagDisplayNames(
  meta: BookmarkMeta | undefined,
  tagNameByKey: ReadonlyMap<string, string>,
): string[] {
  if (meta === undefined) return [];
  return meta.tags.map((key) => tagNameByKey.get(key) ?? key);
}

/** One node → `ExportableNode` (Netscape), recursing through folders. */
function toExportableNode(
  id: string,
  tree: FlattenedTree,
  metaById: ReadonlyMap<string, BookmarkMeta>,
  tagNameByKey: ReadonlyMap<string, string>,
): ExportableNode | undefined {
  const folder = tree.folders.get(id);
  if (folder !== undefined) {
    const node: ExportableNode = {
      title: folder.title,
      children: folder.childIds
        .map((childId) =>
          toExportableNode(childId, tree, metaById, tagNameByKey),
        )
        .filter((node): node is ExportableNode => node !== undefined),
    };
    if (folder.dateAdded !== undefined) node.dateAdded = folder.dateAdded;
    return node;
  }
  const bookmark = tree.bookmarks.get(id);
  if (bookmark === undefined) return undefined;
  const node: ExportableNode = { title: bookmark.title, url: bookmark.url };
  if (bookmark.dateAdded !== undefined) node.dateAdded = bookmark.dateAdded;
  const tags = tagDisplayNames(metaById.get(id), tagNameByKey);
  if (tags.length > 0) node.tags = tags;
  return node;
}

/** The `ExportableNode` forest for the chosen scope. */
function netscapeNodes(
  tree: FlattenedTree,
  metaById: ReadonlyMap<string, BookmarkMeta>,
  tagNameByKey: ReadonlyMap<string, string>,
  scopeFolderId: string | undefined,
): ExportableNode[] {
  if (scopeFolderId !== undefined) {
    const node = toExportableNode(
      scopeFolderId,
      tree,
      metaById,
      tagNameByKey,
    );
    return node === undefined ? [] : [node];
  }
  return exportRootIds(tree)
    .map((id) => toExportableNode(id, tree, metaById, tagNameByKey))
    .filter((node): node is ExportableNode => node !== undefined);
}

/**
 * CSV rows in depth-first order. `folder_path` is the `/`-joined ancestor
 * titles *within the export*: whole-library rows are rooted at the fixed
 * roots ("Bookmarks bar/…"), a folder-scoped export roots at that folder's
 * own title (matching the JSON contract, which keeps the folder itself as
 * the top-level node). `created` is `dateAdded` as ISO.
 */
function collectCsvRows(
  tree: FlattenedTree,
  metaById: ReadonlyMap<string, BookmarkMeta>,
  tagNameByKey: ReadonlyMap<string, string>,
  scopeFolderId: string | undefined,
  includeNotes: boolean,
): CsvBookmarkRow[] {
  const rows: CsvBookmarkRow[] = [];
  const push = (bookmark: BookmarkItem, ancestors: string[]): void => {
    const meta = metaById.get(bookmark.id);
    const row: CsvBookmarkRow = {
      title: bookmark.title,
      url: bookmark.url,
      folderPath: joinFolderPath(ancestors),
      tags: tagDisplayNames(meta, tagNameByKey),
    };
    if (meta?.category !== undefined) row.category = meta.category;
    if (includeNotes && meta?.notes !== undefined) row.notes = meta.notes;
    if (
      bookmark.dateAdded !== undefined &&
      Number.isFinite(bookmark.dateAdded)
    ) {
      row.created = new Date(bookmark.dateAdded).toISOString();
    }
    rows.push(row);
  };
  const walkFolder = (folder: FolderNode, ancestors: string[]): void => {
    for (const childId of folder.childIds) {
      const childFolder = tree.folders.get(childId);
      if (childFolder !== undefined) {
        walkFolder(childFolder, [...ancestors, childFolder.title]);
        continue;
      }
      const bookmark = tree.bookmarks.get(childId);
      if (bookmark !== undefined) push(bookmark, ancestors);
    }
  };
  if (scopeFolderId !== undefined) {
    const scope = tree.folders.get(scopeFolderId);
    if (scope === undefined) return rows;
    walkFolder(scope, [scope.title]);
    return rows;
  }
  for (const id of exportRootIds(tree)) {
    const folder = tree.folders.get(id);
    if (folder !== undefined) {
      walkFolder(folder, [folder.title]);
      continue;
    }
    const bookmark = tree.bookmarks.get(id);
    if (bookmark !== undefined) push(bookmark, []);
  }
  return rows;
}

function buildFile(
  format: ExportFormat,
  tree: FlattenedTree,
  meta: readonly BookmarkMeta[],
  tagDefs: readonly TagDef[],
  metaById: ReadonlyMap<string, BookmarkMeta>,
  tagNameByKey: ReadonlyMap<string, string>,
  scopeFolderId: string | undefined,
  includeNotes: boolean,
): BuiltFile {
  switch (format) {
    case "json": {
      // I07: notes stay out when unchecked — strip them off the meta rows
      // before the envelope is built so nothing private leaks into the file.
      const metaForExport = includeNotes
        ? meta
        : meta.map((row) => ({ ...row, notes: undefined }));
      const built = buildExport({
        tree: unflattenTree(tree),
        meta: metaForExport,
        tags: tagDefs,
        ...(scopeFolderId === undefined ? {} : { folderId: scopeFolderId }),
      });
      if (!built.ok) {
        return { ok: false, code: built.code, message: built.message };
      }
      const serialized = serializeExport(built.data);
      if (!serialized.ok) {
        return {
          ok: false,
          code: serialized.code,
          message: serialized.message,
        };
      }
      return {
        ok: true,
        text: serialized.data,
        ext: "json",
        mime: "application/json",
        ...(built.warnings === undefined ? {} : { warnings: built.warnings }),
      };
    }
    case "netscape": {
      const nodes = netscapeNodes(
        tree,
        metaById,
        tagNameByKey,
        scopeFolderId,
      );
      return {
        ok: true,
        text: exportNetscape(nodes),
        ext: "html",
        mime: "text/html",
      };
    }
    case "csv": {
      const rows = collectCsvRows(
        tree,
        metaById,
        tagNameByKey,
        scopeFolderId,
        includeNotes,
      );
      return {
        ok: true,
        text: exportCsv(rows),
        ext: "csv",
        mime: "text/csv",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Download (Blob + anchor — no `downloads` permission, no network)
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in local wall time — the filename date stamp. */
function fileStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Grace period before the object URL is revoked (I07): revoking in the
 * same task as `anchor.click()` races the browser's own download handoff —
 * on some engines the fetch of the blob URL hasn't started yet and the
 * download silently fails. The blob is small; a delayed revoke costs
 * nothing and cannot break a started download.
 */
const REVOKE_URL_DELAY_MS = 30_000;

function downloadTextFile(text: string, fileName: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  // Firefox requires the anchor to be attached for a programmatic click.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_URL_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live flattened tree (App's `useBookmarkTree` model). */
  tree: FlattenedTree;
  /** `listMeta()` rows — joined onto nodes by Chrome id. */
  meta: readonly BookmarkMeta[];
  /** `listTags()` rows — nameKey → display name for CSV/Netscape tags. */
  tagDefs: readonly TagDef[];
  /** Enables the "Current folder" scope when it resolves to a folder. */
  currentFolderId?: string;
  /** Scope label override; falls back to the tree's own title. */
  currentFolderTitle?: string;
}

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "json", label: "JSON (.json)" },
  { value: "netscape", label: "Netscape HTML (.html)" },
  { value: "csv", label: "CSV (.csv)" },
];

const primaryButtonClass =
  "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 " +
  "text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden " +
  "disabled:pointer-events-none disabled:opacity-50";

export function ExportDialog({
  open,
  onOpenChange,
  tree,
  meta,
  tagDefs,
  currentFolderId,
  currentFolderTitle,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("json");
  const [scope, setScope] = useState<ExportScope>("all");
  const [error, setError] = useState<UiError | null>(null);
  const [exportedFile, setExportedFile] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // I07: notes ride along in JSON backups by default (full-fidelity export)
  // but stay out of CSV/Netscape unless the user asks — those formats are
  // for interop, and notes are extension-private data.
  const [includeNotes, setIncludeNotes] = useState(true);

  const metaById = useMemo(
    () => new Map(meta.map((row) => [row.id, row])),
    [meta],
  );
  const tagNameByKey = useMemo(
    () => new Map(tagDefs.map((def) => [def.nameKey, def.name])),
    [tagDefs],
  );

  const scopeFolder =
    currentFolderId === undefined
      ? undefined
      : tree.folders.get(currentFolderId);
  const folderScopeAvailable = scopeFolder !== undefined;
  const folderTitle = currentFolderTitle ?? scopeFolder?.title;

  const reset = (): void => {
    setFormat("json");
    setScope("all");
    setError(null);
    setExportedFile(null);
    setWarnings([]);
    setIncludeNotes(true);
  };
  const handleOpenChange = (next: boolean): void => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleExport = (): void => {
    setError(null);
    setExportedFile(null);
    setWarnings([]);
    const scopeFolderId = scope === "folder" ? currentFolderId : undefined;
    if (scope === "folder" && !folderScopeAvailable) {
      setError({
        code: "scope_not_found",
        message: "The selected folder is no longer in the bookmark tree.",
      });
      return;
    }
    const built = buildFile(
      format,
      tree,
      meta,
      tagDefs,
      metaById,
      tagNameByKey,
      scopeFolderId,
      includeNotes,
    );
    if (!built.ok) {
      setError({ code: built.code, message: built.message });
      return;
    }
    const fileName = `bookmarks-${fileStamp(new Date())}.${built.ext}`;
    try {
      downloadTextFile(built.text, fileName, built.mime);
    } catch (cause) {
      setError({
        code: "download_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    setExportedFile(fileName);
    setWarnings(built.warnings ?? []);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export bookmarks</DialogTitle>
          <DialogDescription>
            Builds a local file and downloads it — nothing leaves this
            device.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Format</legend>
          {FORMATS.map(({ value, label }) => (
            <label
              key={value}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="export-format"
                value={value}
                checked={format === value}
                onChange={() => {
                  setFormat(value);
                  // I07: JSON defaults notes ON (backup fidelity); the
                  // interop formats default OFF.
                  setIncludeNotes(value === "json");
                }}
                className="size-4 accent-primary"
              />
              {label}
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Scope</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="export-scope"
              value="all"
              checked={scope === "all"}
              onChange={() => setScope("all")}
              className="size-4 accent-primary"
            />
            Whole library
          </label>
          <label
            className="flex items-center gap-2 text-sm has-disabled:opacity-50"
          >
            <input
              type="radio"
              name="export-scope"
              value="folder"
              disabled={!folderScopeAvailable}
              checked={scope === "folder"}
              onChange={() => setScope("folder")}
              className="size-4 accent-primary"
            />
            {folderTitle === undefined
              ? "Current folder"
              : `Current folder — ${folderTitle}`}
          </label>
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="include-notes"
            checked={includeNotes}
            disabled={format === "netscape"}
            onChange={(event) => setIncludeNotes(event.target.checked)}
            className="size-4 accent-primary disabled:opacity-50"
          />
          <span>
            Include notes
            {format === "netscape" && (
              <span className="text-muted-foreground">
                {" "}
                — Netscape HTML has no notes field
              </span>
            )}
          </span>
        </label>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error.code}: {error.message}
          </p>
        )}
        {exportedFile !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            Exported {exportedFile}
          </p>
        )}
        {warnings.map((warning) => (
          <p
            key={warning}
            role="status"
            className="text-sm text-amber-600 dark:text-amber-400"
          >
            {warning}
          </p>
        ))}

        <DialogFooter showCloseButton>
          <button
            type="button"
            onClick={handleExport}
            className={primaryButtonClass}
          >
            Export
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
