import { useMemo, useState } from "react";
import { parseCsv } from "../../io/csv";
import { parseExport } from "../../io/export-json";
import {
  collectNormalizedUrls,
  fromCsvRows,
  fromEnvelope,
  fromNetscape,
  planImport,
} from "../../io/import-plan";
import type { ImportItem } from "../../io/import-plan";
import { writeImport } from "../../io/import-write";
import type { ImportSummary } from "../../io/import-write";
import {
  isBlockedScheme,
  MAX_FILE_BYTES,
  parseNetscape,
} from "../../io/netscape";
import type { TagDef } from "../../schemas/meta";
import type { FlattenedTree } from "../../sync/tree";
import { Checkbox } from "../../ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import { DropZone } from "../../ui/components/drop-zone";
import { deleteNodesWithUndo } from "./BulkBar";
import { unflattenTree } from "./ExportDialog";
import { useToast } from "./UndoToast";

/**
 * Import dialog — spec §5 "Import from Netscape HTML, JSON, or CSV".
 *
 * State machine: `pick` → `preview` → `importing` → `summary`.
 *
 *  - `pick`: a themed drop zone (`DropZone`) routes ONE picked-or-dropped
 *    file through `handleFile`; the real `<input type="file">` is sr-only
 *    inside the zone. An extension outside .json/.html/.htm/.csv/.txt (or
 *    none) fails fast with a friendly message; >20 MiB is rejected
 *    up-front (`file.size`), then again by the parsers (`too_large`
 *    surfaces their typed code). Stray drops that miss the zone are
 *    cancelled on the dialog root so the browser cannot navigate to the
 *    file.
 *  - `preview`: `planImport` counts (folders / bookmarks / duplicates to
 *    skip / invalid), an "Import duplicates anyway" checkbox that re-plans,
 *    and an invalid-item detail list (first ~20). Nothing is written.
 *  - `importing`: `writeImport` runs — always into a NEW
 *    `Imported <YYYY-MM-DD HH:mm>` folder under Other bookmarks.
 *  - `summary`: created/skipped/failed counts, per-item failure list, and a
 *    "Delete import folder" button that routes through the shared
 *    `deleteNodesWithUndo` helper — the folder + contents are snapshotted
 *    BEFORE removal, typed failures surface inline, and the toast offers
 *    Undo.
 *
 * Everything runs locally: `file.text()` + pure parsers, no `fetch`.
 */

type ImportFormat = "json" | "netscape" | "csv";
type Stage = "pick" | "preview" | "importing" | "summary";

interface UiError {
  code: string;
  message: string;
}

/** A successfully parsed file, ready for planning. */
interface ParsedSource {
  format: ImportFormat;
  fileName: string;
  /** Normalized forest for `planImport` / `writeImport`. */
  items: ImportItem[];
  /** Rows the parser rejected → `PlanImportInput.invalid`. */
  parserInvalid?: number;
  /** Human-readable lines for the preview's invalid list. */
  invalidDetails: string[];
  /** JSON envelopes only — handed to `writeImport`'s `tagDefs`. */
  tagDefs?: readonly TagDef[];
}

const MAX_INVALID_DETAILS = 20;
const MAX_FAILURE_DETAILS = 10;

// ---------------------------------------------------------------------------
// Format detection and parsing
// ---------------------------------------------------------------------------

/**
 * Format by extension first, content sniff second (a renamed file still
 * parses): leading `{`/`[` → JSON, leading `<` → Netscape HTML, anything
 * else → CSV.
 */
function detectFormat(fileName: string, text: string): ImportFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "netscape";
  if (ext === "csv") return "csv";
  const head = text.replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (head.startsWith("<")) return "netscape";
  return "csv";
}

/** Extensions the pick stage accepts up front; anything else fails fast. */
const BOOKMARKS_EXTENSIONS = new Set(["json", "html", "htm", "csv", "txt"]);

/**
 * True when a file may hold bookmarks: an allowed extension, or none at
 * all (content sniffing handles extension-less and renamed files). A
 * dropped `.pdf`/`.png` stops here with the friendly message instead of
 * reaching the CSV parser's error.
 */
function hasBookmarksExtension(fileName: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ext === undefined || BOOKMARKS_EXTENSIONS.has(ext);
}

/**
 * Detail lines for bookmarks the PLANNER will drop — the same conditions
 * `planImport` applies (empty or blocked-scheme URL). Parser-level rejects
 * are reported separately by each format branch.
 */
function unsafeBookmarkDetails(
  items: readonly ImportItem[],
  into: string[] = [],
): string[] {
  for (const item of items) {
    if (item.kind === "folder") {
      unsafeBookmarkDetails(item.children, into);
      continue;
    }
    const label = item.title === "" ? "(untitled)" : `"${item.title}"`;
    if (item.url.trim() === "") {
      into.push(`${label} — empty URL`);
    } else if (isBlockedScheme(item.url)) {
      into.push(`${label} — blocked URL scheme: ${item.url}`);
    }
  }
  return into;
}

function parseSource(
  format: ImportFormat,
  fileName: string,
  text: string,
): ParsedSource | UiError {
  switch (format) {
    case "json": {
      const result = parseExport(text);
      if (!result.ok) {
        return { code: result.code, message: result.message };
      }
      const items = fromEnvelope(result.data);
      return {
        format,
        fileName,
        items,
        invalidDetails: unsafeBookmarkDetails(items),
        tagDefs: result.data.tags,
      };
    }
    case "netscape": {
      const result = parseNetscape(text);
      if (!result.ok) {
        return { code: result.code, message: result.message };
      }
      const items = fromNetscape(result.tree);
      const invalidDetails: string[] = [];
      if (result.stats.invalid > 0) {
        invalidDetails.push(
          `${result.stats.invalid} row(s) skipped during parsing: ` +
            "missing or empty URL",
        );
      }
      if (result.stats.skipped > 0) {
        invalidDetails.push(
          `${result.stats.skipped} row(s) skipped during parsing: ` +
            "blocked URL scheme (javascript:, data:, vbscript:)",
        );
      }
      invalidDetails.push(...unsafeBookmarkDetails(items));
      return {
        format,
        fileName,
        items,
        parserInvalid: result.stats.invalid + result.stats.skipped,
        invalidDetails,
      };
    }
    case "csv": {
      const result = parseCsv(text);
      if (!result.ok) {
        return { code: result.code, message: result.message };
      }
      const items = fromCsvRows(result.rows);
      return {
        format,
        fileName,
        items,
        parserInvalid: result.invalid.length,
        invalidDetails: [
          ...result.invalid.map((row) => `Row ${row.row}: ${row.reason}`),
          ...unsafeBookmarkDetails(items),
        ],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live flattened tree — feeds `collectNormalizedUrls` for dupe checks. */
  tree: FlattenedTree;
}

const primaryButtonClass =
  "inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 " +
  "text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden " +
  "disabled:pointer-events-none disabled:opacity-50";

const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-md border border-input " +
  "bg-background px-4 py-2 text-sm font-medium shadow-xs hover:bg-accent " +
  "hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden disabled:pointer-events-none " +
  "disabled:opacity-50";

export function ImportDialog({
  open,
  onOpenChange,
  tree,
}: ImportDialogProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [source, setSource] = useState<ParsedSource | null>(null);
  const [importDuplicates, setImportDuplicates] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const toast = useToast();

  /** Normalized URLs already in the library — the dupe-detection domain. */
  const existingUrls = useMemo(
    () => collectNormalizedUrls(unflattenTree(tree)),
    [tree],
  );

  /** Re-planned on every "Import duplicates anyway" toggle. */
  const plan = useMemo(
    () =>
      source === null
        ? null
        : planImport({
            items: source.items,
            existingUrls,
            ...(source.parserInvalid === undefined
              ? {}
              : { invalid: source.parserInvalid }),
            options: { importDuplicates },
          }),
    [source, existingUrls, importDuplicates],
  );

  const reset = (): void => {
    setStage("pick");
    setSource(null);
    setImportDuplicates(false);
    setError(null);
    setSummary(null);
    setDeleting(false);
    setDeleted(false);
    setDeleteError(null);
  };
  const handleOpenChange = (next: boolean): void => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    // Friendly up-front guard: an obviously-not-bookmarks file (a dropped
    // PDF, an image) never reaches the parsers.
    if (!hasBookmarksExtension(file.name)) {
      setError({
        code: "unsupported_file",
        message:
          "That doesn't look like a bookmarks file — use JSON, Netscape " +
          "HTML, or CSV.",
      });
      return;
    }
    // Up-front size gate (the parsers enforce the same cap and their
    // `too_large` code surfaces too — this just avoids reading the file).
    if (file.size > MAX_FILE_BYTES) {
      setError({
        code: "too_large",
        message:
          `"${file.name}" is ${file.size} bytes — imports are capped at ` +
          `${MAX_FILE_BYTES} bytes (20 MiB).`,
      });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (cause) {
      setError({
        code: "read_failed",
        message:
          cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    const parsed = parseSource(detectFormat(file.name, text), file.name, text);
    if ("code" in parsed) {
      setError(parsed);
      return;
    }
    setSource(parsed);
    setImportDuplicates(false);
    setStage("preview");
  };

  const handleConfirm = async (): Promise<void> => {
    if (plan === null || source === null) return;
    setStage("importing");
    setError(null);
    const result = await writeImport(
      plan,
      source.tagDefs === undefined ? {} : { tagDefs: source.tagDefs },
    );
    if (!result.ok) {
      // Total failure (the import root could not be created) — back to the
      // preview with the typed code so the user can retry/adjust.
      setError({ code: result.code, message: result.message });
      setStage("preview");
      return;
    }
    setSummary(result.summary);
    setDeleting(false);
    setDeleted(false);
    setDeleteError(null);
    setStage("summary");
  };

  const handleDelete = async (): Promise<void> => {
    if (summary === null || deleting || deleted) return;
    setDeleting(true);
    setDeleteError(null);
    // Snapshot-before-delete: the shared helper captures the folder + its
    // whole subtree (and meta rows), removes it through the guarded service,
    // and reports a typed failure instead of throwing.
    const result = await deleteNodesWithUndo([summary.importRootId]);
    setDeleting(false);
    if (result.deleted === 0) {
      setDeleteError(result.error ?? "Delete failed.");
      return;
    }
    setDeleted(true);
    toast.showToast({ message: "Import folder deleted.", undoable: true });
  };

  const busy = stage === "importing";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        onDragOver={
          stage === "pick"
            ? (event) => event.preventDefault()
            : undefined
        }
        onDrop={
          stage === "pick"
            ? (event) => event.preventDefault()
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>Import bookmarks</DialogTitle>
          <DialogDescription>
            Import a JSON, Netscape HTML, or CSV export. The file is parsed
            locally — nothing is uploaded.
          </DialogDescription>
        </DialogHeader>

        {stage === "pick" && (
          <DropZone
            label="Drop your bookmarks file here"
            activeLabel="Drop to import"
            hint="or click to browse — JSON, Netscape HTML, or CSV · up to 20 MiB"
            accept=".json,.html,.htm,.csv"
            inputTestId="import-file-input"
            onFile={(file) => void handleFile(file)}
          />
        )}

        {(stage === "preview" || busy) && plan !== null && source !== null && (
          <div data-testid="import-preview" className="space-y-3">
            <p className="text-sm">
              <span className="font-medium">{source.fileName}</span>
              {" — ready to import:"}
            </p>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">Folders</dt>
                <dd data-testid="count-folders" className="font-medium">
                  {plan.folders}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bookmarks</dt>
                <dd data-testid="count-bookmarks" className="font-medium">
                  {plan.bookmarks}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Duplicates to skip
                </dt>
                <dd data-testid="count-duplicates" className="font-medium">
                  {plan.duplicatesSkipped}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Invalid rows
                </dt>
                <dd data-testid="count-invalid" className="font-medium">
                  {plan.invalid}
                </dd>
              </div>
            </dl>

            <div className="flex items-center gap-2">
              <Checkbox
                id="import-duplicates"
                aria-labelledby="import-duplicates-label"
                checked={importDuplicates}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setImportDuplicates(checked === true)
                }
              />
              <label
                id="import-duplicates-label"
                htmlFor="import-duplicates"
                className="text-sm"
              >
                Import duplicates anyway
              </label>
            </div>

            {source.invalidDetails.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Invalid items
                </p>
                <ul
                  data-testid="invalid-details"
                  className="max-h-32 space-y-0.5 overflow-y-auto text-xs
                    text-muted-foreground"
                >
                  {source.invalidDetails
                    .slice(0, MAX_INVALID_DETAILS)
                    .map((detail, index) => (
                      <li key={index}>{detail}</li>
                    ))}
                </ul>
                {source.invalidDetails.length > MAX_INVALID_DETAILS && (
                  <p className="text-xs text-muted-foreground">
                    …and{" "}
                    {source.invalidDetails.length - MAX_INVALID_DETAILS}{" "}
                    more
                  </p>
                )}
              </div>
            )}

            {busy && (
              <p role="status" className="text-sm text-muted-foreground">
                Importing…
              </p>
            )}
          </div>
        )}

        {stage === "summary" && summary !== null && (
          <div data-testid="summary" className="space-y-3">
            <p role="status" className="text-sm font-medium">
              Import complete.
            </p>
            <dl className="grid grid-cols-3 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd data-testid="summary-created" className="font-medium">
                  {summary.foldersCreated + summary.bookmarksCreated}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Skipped</dt>
                <dd data-testid="summary-skipped" className="font-medium">
                  {summary.duplicatesSkipped + summary.invalidSkipped}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Failed</dt>
                <dd data-testid="summary-failed" className="font-medium">
                  {summary.failures.length}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              {summary.foldersCreated} folder(s) and{" "}
              {summary.bookmarksCreated} bookmark(s) created under a new
              import folder in Other bookmarks
              {summary.tagsCreated > 0
                ? `; ${summary.tagsCreated} tag definition(s) restored`
                : ""}
              . {summary.duplicatesSkipped} duplicate(s) and{" "}
              {summary.invalidSkipped} invalid row(s) skipped.
            </p>
            {summary.failures.length > 0 && (
              <ul
                data-testid="failure-details"
                className="max-h-32 space-y-0.5 overflow-y-auto text-xs
                  text-muted-foreground"
              >
                {summary.failures
                  .slice(0, MAX_FAILURE_DETAILS)
                  .map((failure, index) => (
                    <li key={index}>
                      {failure.kind} &quot;{failure.title}&quot; —{" "}
                      {failure.message}
                    </li>
                  ))}
              </ul>
            )}
            {deleted && (
              <p role="status" className="text-sm text-muted-foreground">
                Import folder deleted.
              </p>
            )}
            {deleteError !== null && (
              <p role="alert" className="text-sm text-destructive">
                {deleteError}
              </p>
            )}
          </div>
        )}

        {error !== null && stage !== "summary" && (
          <p role="alert" className="text-sm text-destructive">
            {error.code}: {error.message}
          </p>
        )}

        <DialogFooter>
          {stage === "preview" || busy ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setStage("pick");
                  setSource(null);
                  setError(null);
                }}
                className={secondaryButtonClass}
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirm()}
                className={primaryButtonClass}
              >
                {busy ? "Importing…" : "Confirm import"}
              </button>
            </>
          ) : null}
          {stage === "summary" && summary !== null ? (
            <>
              <button
                type="button"
                disabled={deleting || deleted}
                onClick={() => void handleDelete()}
                className={secondaryButtonClass}
              >
                {deleting ? "Deleting…" : "Delete import folder"}
              </button>
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className={primaryButtonClass}
              >
                Close
              </button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
