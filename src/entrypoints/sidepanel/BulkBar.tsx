import { useState } from "react";
import { deleteMetaByIds } from "../../db/meta";
import { Category } from "../../schemas/bookmark";
import type { UndoMeta, UndoNode } from "../../schemas/undo";
import { removeTree } from "../../sync/mutations";
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkSetCategory,
} from "../../sync/tag-ops";
import { captureSubtree, pushSnapshot } from "../../undo/snapshot";
import { discardLatest } from "../../undo/restore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { useSelection } from "./BookmarkList";
import { errorMessage, useToast } from "./UndoToast";

/**
 * Selection action bar (appears whenever `useSelection()` holds ≥1 id) plus
 * the undoable delete helper the rest of the panel reuses.
 *
 *  - {@link deleteNodesWithUndo} is the shared delete path: every id is
 *    deep-captured (`captureSubtree` — folders keep their whole subtree and
 *    meta rows), ONE `delete` snapshot is pushed BEFORE the first removal,
 *    then each node is removed through `removeTree`. Meta rows for the
 *    removed subtrees are deleted explicitly (the worker's `onRemoved`
 *    cascade is the second, idempotent pass) because the snapshot already
 *    holds the pre-delete rows for undo. A fully rejected delete discards
 *    the snapshot again — nothing to undo.
 *  - Bar actions run the corresponding mutation/tag-op over the selected
 *    ids and report the `{affected}` count in the toast: Move to… (dialog
 *    owned by the shell), Delete, Add tag, Remove tag, Set category, Clear
 *    selection.
 *  - Selection policy (documented): Delete and Move CLEAR the selection —
 *    deleted ids leave every view, and a move may leave the current view
 *    too; tag/category ops PRESERVE it so the user can chain edits. "Clear
 *    selection" is always explicit.
 */

/** `deleteNodesWithUndo` result — counts plus the first typed failure. */
export interface DeleteNodesResult {
  /** Top-level nodes the service actually removed. */
  deleted: number;
  /** Requested ids that could not be removed. */
  failed: number;
  /** First typed failure message, when any. */
  error?: string;
}

/** Every id inside a captured undo node, depth-first. */
function undoNodeIds(node: UndoNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of node.children ?? []) undoNodeIds(child, into);
  return into;
}

/**
 * Delete `ids` (bookmarks and/or folders) undoably. Snapshots first, removes
 * through the guarded service, and cascades the meta rows for what actually
 * left the tree. Total: never throws.
 */
export async function deleteNodesWithUndo(
  ids: readonly string[],
): Promise<DeleteNodesResult> {
  try {
    const nodes: UndoNode[] = [];
    const meta: UndoMeta[] = [];
    for (const id of new Set(ids)) {
      const capture = await captureSubtree(id);
      if (capture === undefined) continue; // gone, or a fixed root
      nodes.push(capture.node);
      meta.push(...capture.meta);
    }
    if (nodes.length === 0) {
      return {
        deleted: 0,
        failed: ids.length,
        error: "Nothing to delete — the items may already be gone.",
      };
    }
    await pushSnapshot({ kind: "delete", nodes, meta });

    const removedIds: string[] = [];
    let deleted = 0;
    let firstError: string | undefined;
    for (const node of nodes) {
      try {
        await removeTree(node.id);
        deleted += 1;
        undoNodeIds(node, removedIds);
      } catch (cause) {
        firstError ??= errorMessage(cause);
      }
    }
    if (removedIds.length > 0) {
      try {
        await deleteMetaByIds(removedIds);
      } catch {
        // The worker's onRemoved cascade is the idempotent second pass.
      }
    }
    if (deleted === 0) {
      // Nothing left the tree — drop the snapshot instead of wedging the
      // stack head with an unreplayable no-op.
      await discardLatest();
      return {
        deleted: 0,
        failed: ids.length,
        error: firstError ?? "Delete failed.",
      };
    }
    return { deleted, failed: ids.length - deleted, error: firstError };
  } catch (cause) {
    return { deleted: 0, failed: ids.length, error: errorMessage(cause) };
  }
}

/** User-visible summary of a delete result (the toast message). */
export function deleteResultMessage(result: DeleteNodesResult): string {
  if (result.deleted === 0) {
    return `Delete failed${result.error === undefined ? "." : `: ${result.error}`}`;
  }
  const noun = result.deleted === 1 ? "bookmark" : "bookmarks";
  const base = `Deleted ${result.deleted} ${noun}`;
  if (result.failed === 0) return base;
  return `${base} — ${result.failed} failed${
    result.error === undefined ? "" : `: ${result.error}`
  }`;
}

export interface BulkBarProps {
  /** Opens the shell's "Move to…" dialog for the current selection. */
  onMoveRequest?: (ids: readonly string[]) => void;
}

const barButtonClass =
  "rounded-sm px-2 py-1 text-xs outline-hidden " +
  "hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring";

export function BulkBar({ onMoveRequest }: BulkBarProps) {
  const selection = useSelection();
  const toast = useToast();
  const [tagPrompt, setTagPrompt] = useState<"add" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);

  const count = selection.selectedIds.size;
  const ids = [...selection.selectedIds];

  if (count === 0) return null;

  const handleDelete = async (): Promise<void> => {
    setBusy(true);
    const result = await deleteNodesWithUndo(ids);
    setBusy(false);
    toast.showToast({
      message: deleteResultMessage(result),
      undoable: result.deleted > 0,
      error: result.deleted === 0,
    });
    if (result.deleted > 0) selection.clear();
  };

  const handleSetCategory = async (
    category: Category | null,
  ): Promise<void> => {
    const result = await bulkSetCategory(ids, category);
    if (!result.ok) {
      toast.showToast({ message: result.message, error: true });
      return;
    }
    const noun = result.affected === 1 ? "bookmark" : "bookmarks";
    toast.showToast({
      message:
        category === null
          ? `Cleared category on ${result.affected} ${noun}`
          : `Set category to ${category} on ${result.affected} ${noun}`,
    });
    // Selection preserved — the user can chain further edits.
  };

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className={
        "flex shrink-0 flex-wrap items-center gap-1 border-t border-border " +
        "px-2 py-1"
      }
    >
      <span className="mr-auto text-xs font-medium">{count} selected</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => onMoveRequest?.(ids)}
        className={barButtonClass}
      >
        Move to…
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void handleDelete()}
        className={barButtonClass}
      >
        Delete
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setTagPrompt("add")}
        className={barButtonClass}
      >
        Add tag
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setTagPrompt("remove")}
        className={barButtonClass}
      >
        Remove tag
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} className={barButtonClass}>
            Set category
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {Category.options.map((category) => (
            <DropdownMenuItem
              key={category}
              onSelect={() => void handleSetCategory(category)}
            >
              {category.charAt(0).toUpperCase() + category.slice(1)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSetCategory(null)}>
            No category
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={() => selection.clear()}
        className={barButtonClass}
      >
        Clear selection
      </button>
      {tagPrompt !== null && (
        <TagPromptDialog
          mode={tagPrompt}
          ids={ids}
          onClose={() => setTagPrompt(null)}
        />
      )}
    </div>
  );
}

/**
 * Small prompt for the bar's tag actions: takes a tag NAME, resolves/creates
 * the definition through tag-ops (`bulkAddTag`), and reports the affected
 * count. Mounted only while open, so its input state is fresh each time.
 */
function TagPromptDialog({
  mode,
  ids,
  onClose,
}: {
  mode: "add" | "remove";
  ids: readonly string[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const label = name.trim();
    if (label === "") return;
    setBusy(true);
    setError(null);
    const result =
      mode === "add"
        ? await bulkAddTag(ids, label)
        : await bulkRemoveTag(ids, label);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      toast.showToast({ message: result.message, error: true });
      return;
    }
    const noun = result.affected === 1 ? "bookmark" : "bookmarks";
    toast.showToast({
      message:
        mode === "add"
          ? `Added tag “${label}” to ${result.affected} ${noun}`
          : `Removed tag “${label}” from ${result.affected} ${noun}`,
    });
    onClose();
  };

  const heading = mode === "add" ? "Add tag" : "Remove tag";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "Add a tag to every selected bookmark. New names create a tag definition."
              : "Remove a tag from every selected bookmark that carries it."}
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="tag-name" className="text-sm font-medium">
          Tag name
        </label>
        <input
          id="tag-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || name.trim() === ""}
            onClick={() => void submit()}
            className={
              "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
              "text-primary-foreground disabled:opacity-50"
            }
          >
            {heading}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
