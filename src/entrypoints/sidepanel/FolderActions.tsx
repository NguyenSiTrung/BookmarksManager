import { useState } from "react";
import { ContextMenu } from "radix-ui";
import { createFolder, renameFolder } from "../../sync/mutations";
import type { FlattenedTree, FolderNode } from "../../sync/tree";
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
import { cn } from "../../ui/lib/cn";
import { deleteNodesWithUndo } from "./BulkBar";
import { errorMessage, useToast } from "./UndoToast";
import { subtreeBookmarkIds } from "./views";

/**
 * Per-folder actions for the tree: New folder inside, Rename, Move to…, and
 * Delete (with a count of the bookmarks that will go with it).
 *
 *  - {@link FolderActions} is the kebab dropdown rendered on each tree row;
 *    {@link FolderActionsContextItems} renders the same four entries as
 *    right-click context-menu items (the tree wraps the row in a Radix
 *    ContextMenu and asks the shell for these entries).
 *  - **Everything is disabled on fixed roots and managed folders** — a fixed
 *    root "1"–"3" rejects renames/deletes by Chrome's own rules, and a
 *    managed folder (or anything under it) rejects every write. The kebab
 *    carries the reason as its `title` tooltip; context-menu items carry it
 *    on the disabled item.
 *  - {@link FolderActionDialog} owns create/rename/delete: create writes
 *    through `createFolder`, rename through `renameFolder`, and delete
 *    snapshots FIRST (`deleteNodesWithUndo` — a `delete` snapshot of the
 *    whole subtree) so the Undo toast can restore it. The confirm step
 *    counts the subtree's bookmarks from the flattened tree via
 *    `subtreeBookmarkIds` before anything is removed.
 */

export type FolderActionKind = "create" | "rename" | "move" | "delete";

/** Dialog-backed actions (moves go through the shell's MoveToDialog). */
export interface FolderActionRequest {
  kind: "create" | "rename" | "delete";
  node: FolderNode;
}

const KEBAB_CLASS =
  "shrink-0 rounded-sm px-1 text-xs text-muted-foreground outline-hidden " +
  "hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Raw Radix context-menu item styling (mirrors DropdownMenuItem's). */
const CONTEXT_ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 " +
  "text-sm outline-hidden select-none focus:bg-accent " +
  "focus:text-accent-foreground data-[disabled]:pointer-events-none " +
  "data-[disabled]:opacity-50";

/** Why a folder's actions are blocked, or `undefined` when they are usable. */
function blockedReason(node: FolderNode): string | undefined {
  if (node.isManaged) {
    return "This folder is managed by policy — it can't be changed.";
  }
  if (node.isRoot) {
    return "Chrome's built-in folders can't be changed.";
  }
  return undefined;
}

function folderLabel(node: FolderNode): string {
  return node.title === "" ? "Untitled folder" : node.title;
}

export interface FolderActionsProps {
  node: FolderNode;
  onAction: (kind: FolderActionKind, node: FolderNode) => void;
  className?: string;
}

/** Kebab dropdown rendered on a tree row. */
export function FolderActions({ node, onAction, className }: FolderActionsProps) {
  const reason = blockedReason(node);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={reason !== undefined}
          title={reason}
          aria-label={`Folder actions for ${folderLabel(node)}`}
          className={cn(KEBAB_CLASS, className)}
          onClick={(event) => event.stopPropagation()}
        >
          ⋯
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAction("create", node)}>
          New folder inside
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("rename", node)}>
          Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction("move", node)}>
          Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onAction("delete", node)}
        >
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same four entries as right-click menu items for a tree row. */
export function FolderActionsContextItems({
  node,
  onAction,
}: FolderActionsProps) {
  const reason = blockedReason(node);
  const disabled = reason !== undefined;
  const entries: { kind: FolderActionKind; label: string }[] = [
    { kind: "create", label: "New folder inside" },
    { kind: "rename", label: "Rename…" },
    { kind: "move", label: "Move to…" },
    { kind: "delete", label: "Delete…" },
  ];
  return (
    <>
      {entries.map((entry) => (
        <ContextMenu.Item
          key={entry.kind}
          className={CONTEXT_ITEM_CLASS}
          disabled={disabled}
          title={reason}
          onSelect={() => onAction(entry.kind, node)}
        >
          {entry.label}
        </ContextMenu.Item>
      ))}
    </>
  );
}

export interface FolderActionDialogProps {
  request: FolderActionRequest | null;
  tree: FlattenedTree;
  onClose: () => void;
}

export function FolderActionDialog({
  request,
  tree,
  onClose,
}: FolderActionDialogProps) {
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {request !== null && (
          <FolderActionForm
            key={`${request.kind}:${request.node.id}`}
            request={request}
            tree={tree}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FolderActionForm({
  request,
  tree,
  onClose,
}: {
  request: FolderActionRequest;
  tree: FlattenedTree;
  onClose: () => void;
}) {
  const toast = useToast();
  const { kind, node } = request;
  const [name, setName] = useState(kind === "rename" ? node.title : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = folderLabel(node);
  const bookmarkCount =
    kind === "delete" ? subtreeBookmarkIds(tree, node.id).length : 0;

  const fail = (cause: unknown): void => {
    const message = errorMessage(cause);
    setError(message);
    toast.showToast({ message, error: true });
  };

  if (kind === "delete") {
    const handleDelete = async (): Promise<void> => {
      setBusy(true);
      setError(null);
      const result = await deleteNodesWithUndo([node.id]);
      setBusy(false);
      if (result.deleted === 0) {
        setError(
          `Could not delete “${label}”${result.error === undefined ? "." : `: ${result.error}`}`,
        );
        return;
      }
      toast.showToast({
        message: `Deleted folder “${label}”`,
        undoable: true,
        snapshotId: result.snapshotId,
      });
      onClose();
    };
    return (
      <>
        <DialogHeader>
          <DialogTitle>Delete “{label}”?</DialogTitle>
          <DialogDescription>
            This folder contains {bookmarkCount}{" "}
            {bookmarkCount === 1 ? "bookmark" : "bookmarks"}. Deleting it
            removes the folder and everything inside — you can undo
            afterwards.
          </DialogDescription>
        </DialogHeader>
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
            disabled={busy}
            onClick={() => void handleDelete()}
            className={
              "rounded-md bg-destructive px-4 py-2 text-sm font-medium " +
              "text-destructive-foreground disabled:opacity-50"
            }
          >
            Delete folder
          </button>
        </DialogFooter>
      </>
    );
  }

  const heading =
    kind === "create" ? `New folder inside “${label}”` : "Rename folder";
  const submitLabel = kind === "create" ? "Create folder" : "Rename";

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "create") {
        await createFolder({ parentId: node.id, title: trimmed });
        toast.showToast({ message: `Created folder “${trimmed}”` });
      } else {
        await renameFolder(node.id, trimmed);
        toast.showToast({ message: `Renamed folder to “${trimmed}”` });
      }
      onClose();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{heading}</DialogTitle>
      </DialogHeader>
      <label htmlFor="folder-name" className="text-sm font-medium">
        Folder name
      </label>
      <input
        id="folder-name"
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
          {submitLabel}
        </button>
      </DialogFooter>
    </>
  );
}
