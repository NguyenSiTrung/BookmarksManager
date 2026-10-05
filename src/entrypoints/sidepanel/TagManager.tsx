import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  createTag,
  getMetaByTag,
  listMeta,
  listTags,
  MetaRepoError,
  updateTag,
} from "../../db/meta";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import {
  deleteTagWithUndo,
  recolorTag,
  renameTag,
} from "../../sync/tag-ops";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import { TagChip } from "../../ui/components/tag-chip";
import { cn } from "../../ui/lib/cn";

/**
 * TagManager — dialog for the whole tag-definition lifecycle (spec §4):
 *
 *  - Lists every `TagDef` (name chip with its color dot, per-tag bookmark
 *    count from a `listMeta` scan) behind a case-insensitive filter box.
 *  - Create: name input → repo `createTag`; a case-insensitive duplicate
 *    surfaces the typed `tag_exists` error, schema violations `invalid_tag`.
 *  - Per-tag inline editors (one open at a time): Rename (tag-ops
 *    `renameTag` — propagates nameKeys through every meta row and reports
 *    `affectedBookmarks`), Recolor (preset palette + clear → tag-ops
 *    `recolorTag`), Description (≤300 chars, live counter, hard-blocked
 *    save over the limit → repo `updateTag`), and Delete — a confirm step
 *    that fetches the affected count via `getMetaByTag` BEFORE calling
 *    `deleteTagWithUndo`.
 *  - Deletes push a `tag_delete` snapshot; the returned `snapshotId` is
 *    handed to the optional `onRequestUndo` seam so the coordinator's
 *    UndoToast can offer `undoLatest()`. Without the seam the delete just
 *    reports its affected count.
 *
 * Data flows through `useLiveQuery` on the `tags`/`bookmarkMeta` tables,
 * so every mutation refreshes the list on its own — the component needs
 * no tag props from App, only open state and the undo seam.
 *
 * Errors render in a single `role="alert"` line; successes in
 * `role="status"` — both sit under the create row, adjacent to the input
 * for inline conflict errors.
 */

/** Preset swatch colors for the recolor editor (10 + Clear). */
export const TAG_COLOR_PRESETS: readonly { label: string; value: string }[] =
  [
    { label: "red", value: "#ef4444" },
    { label: "orange", value: "#f97316" },
    { label: "yellow", value: "#eab308" },
    { label: "green", value: "#22c55e" },
    { label: "teal", value: "#14b8a6" },
    { label: "blue", value: "#3b82f6" },
    { label: "indigo", value: "#6366f1" },
    { label: "purple", value: "#a855f7" },
    { label: "pink", value: "#ec4899" },
    { label: "gray", value: "#78716c" },
  ];

/** TagDef.description schema limit (src/schemas/meta.ts). */
export const TAG_DESCRIPTION_MAX = 300;

/** Payload delivered to the `onRequestUndo` seam after a successful delete. */
export interface TagManagerUndoInfo {
  /** The def as stored immediately before deletion (snapshot data). */
  tag: TagDef;
  /** Meta rows that carried the tag — the count the confirm step showed. */
  affected: number;
  /** Row id of the pushed `tag_delete` snapshot — feed `undoLatest()`. */
  snapshotId: number;
}

export interface TagManagerProps {
  /** Controls the dialog; App holds the open/close state. */
  open: boolean;
  /** Called when the dialog wants to change open state (Esc, ×, overlay). */
  onOpenChange?: (open: boolean) => void;
  /**
   * Undo seam: fired after a successful `deleteTagWithUndo` with the
   * snapshot id, so App can surface its UndoToast. Absent ⇒ the delete is
   * a no-op beyond the status message.
   */
  onRequestUndo?: (info: TagManagerUndoInfo) => void;
}

type EditorMode = "rename" | "recolor" | "describe" | "delete";

interface OpStatus {
  kind: "success" | "error";
  text: string;
}

const EMPTY_TAGS: readonly TagDef[] = [];
const EMPTY_METAS: readonly BookmarkMeta[] = [];

const inputClass =
  "rounded-md border border-input bg-background px-2 py-1 text-sm " +
  "outline-hidden focus-visible:ring-2 focus-visible:ring-ring";
const smallButtonClass =
  "rounded-sm border border-border bg-background px-2 py-0.5 text-xs " +
  "outline-hidden hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:pointer-events-none disabled:opacity-50";

/** "n bookmark(s)" — count phrasing used in rows and the delete confirm. */
function pluralBookmarks(n: number): string {
  return `${n} ${n === 1 ? "bookmark" : "bookmarks"}`;
}

/** Repo throws `MetaRepoError`; surface its typed code with the message. */
function describeCause(cause: unknown): string {
  if (cause instanceof MetaRepoError) {
    return `${cause.code}: ${cause.message}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** tag-ops failures carry `code` on the result; same formatting as throws. */
function describeFailure(result: { code: string; message: string }): string {
  return `${result.code}: ${result.message}`;
}

// ---------------------------------------------------------------------------
// TagRow — one def plus its per-mode inline editor
// ---------------------------------------------------------------------------

interface TagRowProps {
  tag: TagDef;
  /** Meta rows carrying this tag's nameKey. */
  count: number;
  /** Which editor is open on THIS row; `null` when idle. */
  mode: EditorMode | null;
  /** Switch this row's editor (`null` closes); only one row edits at a time. */
  onModeChange: (mode: EditorMode | null) => void;
  /** Push an op result to the dialog status line. */
  onStatus: (status: OpStatus) => void;
  onRequestUndo?: (info: TagManagerUndoInfo) => void;
}

function TagRow({
  tag,
  count,
  mode,
  onModeChange,
  onStatus,
  onRequestUndo,
}: TagRowProps) {
  const [draftName, setDraftName] = useState(tag.name);
  const [draftDesc, setDraftDesc] = useState(tag.description ?? "");
  const [affected, setAffected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Opening an editor resets its drafts (event handler, not an effect).
  const openEditor = (next: EditorMode): void => {
    setDraftName(tag.name);
    setDraftDesc(tag.description ?? "");
    setAffected(null);
    onModeChange(next);
  };

  // Entering "delete" fetches the affected count via getMetaByTag so the
  // confirm shows it BEFORE deleting (async setState only — no cascading
  // synchronous renders in the effect body).
  useEffect(() => {
    if (mode !== "delete") return;
    let live = true;
    void getMetaByTag(tag.nameKey)
      .then((rows) => {
        if (live) setAffected(rows.length);
      })
      .catch(() => {
        if (live) setAffected(0);
      });
    return () => {
      live = false;
    };
  }, [mode, tag.nameKey]);

  const saveRename = async (): Promise<void> => {
    setBusy(true);
    const result = await renameTag(tag.nameKey, draftName);
    setBusy(false);
    if (!result.ok) {
      onStatus({ kind: "error", text: describeFailure(result) });
      return;
    }
    onStatus({
      kind: "success",
      text:
        `Renamed to "${result.renamed.name}" — ` +
        `${pluralBookmarks(result.affectedBookmarks)} updated.`,
    });
    onModeChange(null);
  };

  const applyColor = async (color: string | null): Promise<void> => {
    setBusy(true);
    const result = await recolorTag(tag.nameKey, color);
    setBusy(false);
    if (!result.ok) {
      onStatus({ kind: "error", text: describeFailure(result) });
      return;
    }
    onStatus({
      kind: "success",
      text:
        color === null
          ? `Cleared color on "${tag.name}".`
          : `Recolored "${tag.name}".`,
    });
    onModeChange(null);
  };

  const saveDescription = async (): Promise<void> => {
    // Hard block — the Save button is also disabled over the limit.
    if (draftDesc.length > TAG_DESCRIPTION_MAX) return;
    setBusy(true);
    try {
      const updated = await updateTag(tag.nameKey, {
        description: draftDesc.trim() === "" ? null : draftDesc,
      });
      if (updated === undefined) {
        onStatus({
          kind: "error",
          text: `not_found: No tag exists for "${tag.nameKey}".`,
        });
      } else {
        onStatus({
          kind: "success",
          text: `Description saved on "${updated.name}".`,
        });
      }
      onModeChange(null);
    } catch (cause) {
      onStatus({ kind: "error", text: describeCause(cause) });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    setBusy(true);
    const result = await deleteTagWithUndo(tag.nameKey);
    setBusy(false);
    if (!result.ok) {
      onStatus({ kind: "error", text: describeFailure(result) });
      return;
    }
    onStatus({
      kind: "success",
      text:
        `Deleted "${tag.name}" — ` +
        `${pluralBookmarks(result.affected)} affected.`,
    });
    // Undo seam: App's UndoToast calls undoLatest() with this snapshot.
    onRequestUndo?.({
      tag,
      affected: result.affected,
      snapshotId: result.snapshotId,
    });
    onModeChange(null);
  };

  const descOverLimit = draftDesc.length > TAG_DESCRIPTION_MAX;

  return (
    <li className="rounded-md border border-border p-2">
      <div className="flex items-center gap-2">
        <TagChip name={tag.name} color={tag.color} size="sm" />
        <span className="shrink-0 text-xs text-muted-foreground">
          {pluralBookmarks(count)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Rename ${tag.name}`}
            className={smallButtonClass}
            onClick={() => openEditor("rename")}
          >
            Rename
          </button>
          <button
            type="button"
            aria-label={`Recolor ${tag.name}`}
            className={smallButtonClass}
            onClick={() => openEditor("recolor")}
          >
            Color
          </button>
          <button
            type="button"
            aria-label={`Edit description of ${tag.name}`}
            className={smallButtonClass}
            onClick={() => openEditor("describe")}
          >
            Description
          </button>
          <button
            type="button"
            aria-label={`Delete ${tag.name}`}
            className={cn(smallButtonClass, "text-destructive")}
            onClick={() => openEditor("delete")}
          >
            Delete
          </button>
        </span>
      </div>
      {tag.description !== undefined && mode === null && (
        <p
          title={tag.description}
          className="mt-1 truncate text-xs text-muted-foreground"
        >
          {tag.description}
        </p>
      )}

      {mode === "rename" && (
        <div className="mt-2 flex items-center gap-2">
          <input
            aria-label={`New name for ${tag.name}`}
            className={cn(inputClass, "min-w-0 flex-1")}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
          />
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy}
            onClick={() => void saveRename()}
          >
            Save
          </button>
          <button
            type="button"
            className={smallButtonClass}
            onClick={() => onModeChange(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "recolor" && (
        <div
          role="group"
          aria-label={`Color choices for ${tag.name}`}
          className="mt-2 flex flex-wrap items-center gap-1.5"
        >
          {TAG_COLOR_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              aria-label={preset.label}
              title={preset.label}
              disabled={busy}
              onClick={() => void applyColor(preset.value)}
              className={cn(
                "size-5 shrink-0 rounded-full border border-border shadow-xs",
                "outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50",
                tag.color === preset.value && "ring-2 ring-ring",
              )}
              style={{ backgroundColor: preset.value }}
            />
          ))}
          <button
            type="button"
            className={smallButtonClass}
            disabled={busy}
            onClick={() => void applyColor(null)}
          >
            Clear color
          </button>
          <button
            type="button"
            className={smallButtonClass}
            onClick={() => onModeChange(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {mode === "describe" && (
        <div className="mt-2">
          <textarea
            aria-label={`Description for ${tag.name}`}
            aria-invalid={descOverLimit}
            rows={2}
            value={draftDesc}
            onChange={(event) => setDraftDesc(event.target.value)}
            className={cn(inputClass, "w-full resize-y")}
          />
          <div className="mt-1 flex items-center gap-2">
            <span
              className={cn(
                "text-xs",
                descOverLimit
                  ? "font-medium text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {draftDesc.length}/{TAG_DESCRIPTION_MAX}
            </span>
            {descOverLimit && (
              <span className="text-xs text-destructive">
                Over the {TAG_DESCRIPTION_MAX}-character limit.
              </span>
            )}
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                className={smallButtonClass}
                disabled={busy || descOverLimit}
                onClick={() => void saveDescription()}
              >
                Save
              </button>
              <button
                type="button"
                className={smallButtonClass}
                onClick={() => onModeChange(null)}
              >
                Cancel
              </button>
            </span>
          </div>
        </div>
      )}

      {mode === "delete" && (
        <div className="mt-2 rounded-sm border border-destructive/50 bg-destructive/10 p-2">
          {affected === null ? (
            <p className="text-xs text-muted-foreground">
              Counting bookmarks…
            </p>
          ) : (
            <p className="text-xs">
              Delete “{tag.name}”? It will be removed from{" "}
              {pluralBookmarks(affected)}.
            </p>
          )}
          <div className="mt-2 flex gap-1">
            <button
              type="button"
              className={cn(
                smallButtonClass,
                "border-destructive/50 text-destructive",
              )}
              disabled={busy || affected === null}
              onClick={() => void confirmDelete()}
            >
              Confirm delete
            </button>
            <button
              type="button"
              className={smallButtonClass}
              onClick={() => onModeChange(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// TagManager dialog
// ---------------------------------------------------------------------------

export function TagManager({
  open,
  onOpenChange,
  onRequestUndo,
}: TagManagerProps) {
  // Both live queries degrade to [] when IndexedDB is unreachable (same
  // pattern as App), and re-emit on every write the ops make. The querier
  // only touches the tables while the dialog is OPEN — a closed manager
  // runs no live queries and no `listMeta` scan at all, so background
  // writes do not pay for a hidden dialog (U11).
  const tagDefs =
    useLiveQuery(
      () =>
        open
          ? listTags().catch((): TagDef[] => [])
          : Promise.resolve(EMPTY_TAGS as TagDef[]),
      [open],
    ) ?? EMPTY_TAGS;
  const metas =
    useLiveQuery(
      () =>
        open
          ? listMeta().catch((): BookmarkMeta[] => [])
          : Promise.resolve(EMPTY_METAS as BookmarkMeta[]),
      [open],
    ) ?? EMPTY_METAS;

  // nameKey → number of meta rows carrying it (the list-scan count).
  const countByKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const meta of metas) {
      for (const key of meta.tags) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [metas]);

  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [status, setStatus] = useState<OpStatus | null>(null);
  const [editor, setEditor] = useState<{
    nameKey: string;
    mode: EditorMode;
  } | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return tagDefs;
    return tagDefs.filter(
      (tag) =>
        tag.name.toLowerCase().includes(needle) ||
        tag.nameKey.includes(needle),
    );
  }, [tagDefs, query]);

  const handleCreate = async (): Promise<void> => {
    setCreating(true);
    try {
      const def = await createTag(newName);
      setNewName("");
      setStatus({ kind: "success", text: `Created "${def.name}".` });
    } catch (cause) {
      // tag_exists on a case-insensitive dupe; invalid_tag on schema breaks.
      setStatus({ kind: "error", text: describeCause(cause) });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col"
        aria-label="Tag manager"
      >
        <DialogHeader>
          <DialogTitle>Manage tags</DialogTitle>
          <DialogDescription>
            Rename, recolor, describe, or delete tags. Renames and deletes
            propagate to every bookmark.
          </DialogDescription>
        </DialogHeader>

        <input
          aria-label="Filter tags"
          placeholder="Filter tags…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={cn(inputClass, "w-full")}
        />

        <div className="flex items-center gap-2">
          <input
            aria-label="New tag name"
            placeholder="New tag name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreate();
              }
            }}
            className={cn(inputClass, "min-w-0 flex-1")}
          />
          <button
            type="button"
            className={smallButtonClass}
            disabled={creating || newName === ""}
            onClick={() => void handleCreate()}
          >
            Create tag
          </button>
        </div>

        {status !== null && (
          <p
            role={status.kind === "error" ? "alert" : "status"}
            className={cn(
              "text-xs",
              status.kind === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {status.text}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tagDefs.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">No tags yet.</p>
          ) : filtered.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              No tags match “{query}”.
            </p>
          ) : (
            <ul aria-label="Tags" className="space-y-2">
              {filtered.map((tag) => (
                <TagRow
                  key={tag.nameKey}
                  tag={tag}
                  count={countByKey.get(tag.nameKey) ?? 0}
                  mode={
                    editor?.nameKey === tag.nameKey ? editor.mode : null
                  }
                  onModeChange={(mode) =>
                    setEditor(
                      mode === null
                        ? null
                        : { nameKey: tag.nameKey, mode },
                    )
                  }
                  onStatus={setStatus}
                  onRequestUndo={onRequestUndo}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
