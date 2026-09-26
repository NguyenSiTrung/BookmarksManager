import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/components/dialog";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import { moveNode } from "../../sync/mutations";
import type { FlattenedTree } from "../../sync/tree";
import { captureNodes, pushSnapshot } from "../../undo/snapshot";
import { discardLatest } from "../../undo/restore";
import { errorMessage, useToast } from "./UndoToast";

/**
 * "Move to…" — the non-drag path for relocating bookmarks AND folders, plus
 * the move helpers the rest of the action surface reuses.
 *
 *  - {@link folderDestinations} flattens the tree into pickable destinations
 *    (every folder except the synthetic root "0"; the fixed roots "1"–"3"
 *    ARE valid destinations — Chrome allows creating/moving under them).
 *  - {@link moveDeniedIds} pre-computes the deny list: a folder being moved
 *    and its own subtree can never be a destination (the mutation service
 *    rejects it too, but the picker disables those rows up front).
 *  - {@link moveNodesWithUndo} is the shared move path: it captures the
 *    nodes' current positions (`captureNodes`), pushes a `bulk_move`
 *    snapshot BEFORE any move, moves each node through the guarded service,
 *    and drops the snapshot again when nothing moved (so a fully rejected
 *    move never leaves a dead row on the stack). Moves are counted, not
 *    thrown: per-node failures surface in the result.
 *
 * The dialog is a controlled Radix Dialog: a flat, depth-indented folder
 * list with disabled rows for managed folders and deny-listed subtrees, a
 * "Move" confirm that is inert until a destination is picked, and an inline
 * error when the whole move was rejected.
 */

/** One pickable folder destination. */
export interface FolderDestination {
  id: string;
  /** Display path, e.g. "Bookmarks bar / Dev". */
  label: string;
  /** 0-based indent level (fixed roots are 0). */
  depth: number;
  isManaged: boolean;
  isRoot: boolean;
}

/**
 * Every folder in the tree except the synthetic root "0", in tree order
 * (depth-first pre-order), labeled by its ancestor titles.
 */
export function folderDestinations(
  tree: FlattenedTree,
): FolderDestination[] {
  const out: FolderDestination[] = [];
  for (const folder of tree.folders.values()) {
    if (folder.id === ROOT_NODE_ID) continue;
    const label =
      [...folder.path, folder.title].filter((part) => part !== "").join(" / ") ||
      "Folder";
    out.push({
      id: folder.id,
      label,
      depth: Math.max(folder.depth - 1, 0),
      isManaged: folder.isManaged,
      isRoot: folder.isRoot,
    });
  }
  return out;
}

/**
 * Ids that can never receive a move of `ids`: every moving folder itself
 * plus its descendant folders. Bookmark ids contribute nothing (a bookmark
 * has no subtree, so every folder remains a valid destination for it).
 */
export function moveDeniedIds(
  tree: FlattenedTree,
  ids: readonly string[],
): ReadonlySet<string> {
  const denied = new Set<string>();
  const addSubtree = (folderId: string): void => {
    if (denied.has(folderId)) return;
    denied.add(folderId);
    const folder = tree.folders.get(folderId);
    for (const childId of folder?.childIds ?? []) {
      if (tree.folders.has(childId)) addSubtree(childId);
    }
  };
  for (const id of ids) {
    if (tree.folders.has(id)) addSubtree(id);
  }
  return denied;
}

export interface MoveNodesResult {
  /** Nodes the service actually moved. */
  moved: number;
  /** Requested ids that could not be moved. */
  failed: number;
  /** First typed failure message, when any. */
  error?: string;
}

/**
 * Move `ids` into `parentId`, undoably. The `bulk_move` snapshot is pushed
 * BEFORE the first `moveNode` and carries the nodes' recorded parent+index
 * (plus their meta rows), so `undoLatest()` replays the move in reverse.
 * Total: never throws — a fully rejected move discards the snapshot and
 * reports the first typed message.
 */
export async function moveNodesWithUndo(
  ids: readonly string[],
  parentId: string,
): Promise<MoveNodesResult> {
  try {
    const capture = await captureNodes(ids);
    if (capture.nodes.length === 0) {
      return {
        moved: 0,
        failed: ids.length,
        error: "Nothing to move — the items may already be gone.",
      };
    }
    await pushSnapshot({
      kind: "bulk_move",
      nodes: capture.nodes,
      meta: capture.meta,
    });
    let moved = 0;
    let firstError: string | undefined;
    for (const node of capture.nodes) {
      try {
        await moveNode(node.id, { parentId });
        moved += 1;
      } catch (cause) {
        firstError ??= errorMessage(cause);
      }
    }
    if (moved === 0) {
      // The snapshot describes a move that never happened — drop it instead
      // of leaving a no-op row at the head of the stack.
      await discardLatest();
      return {
        moved: 0,
        failed: ids.length,
        error: firstError ?? "Move failed.",
      };
    }
    return { moved, failed: ids.length - moved, error: firstError };
  } catch (cause) {
    return { moved: 0, failed: ids.length, error: errorMessage(cause) };
  }
}

export interface MoveToDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tree: FlattenedTree;
  /** Ids to move — bookmarks and/or folders. */
  ids: readonly string[];
  /** Fired after a successful move (the shell clears its selection). */
  onMoved?: () => void;
}

export function MoveToDialog({
  open,
  onOpenChange,
  tree,
  ids,
  onMoved,
}: MoveToDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && (
          <MoveToForm
            tree={tree}
            ids={ids}
            onMoved={onMoved}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoveToForm({
  tree,
  ids,
  onMoved,
  onClose,
}: {
  tree: FlattenedTree;
  ids: readonly string[];
  onMoved?: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [destId, setDestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const denied = useMemo(() => moveDeniedIds(tree, ids), [tree, ids]);
  const destinations = useMemo(() => folderDestinations(tree), [tree]);
  const count = ids.length;

  const handleMove = async (): Promise<void> => {
    if (destId === null) return;
    setBusy(true);
    setError(null);
    const result = await moveNodesWithUndo(ids, destId);
    setBusy(false);
    if (result.moved === 0) {
      setError(result.error ?? "Move failed.");
      return;
    }
    const destTitle = tree.folders.get(destId)?.title ?? "folder";
    const noun = result.moved === 1 ? "item" : "items";
    const partial =
      result.failed > 0
        ? ` — ${result.failed} failed${result.error === undefined ? "" : `: ${result.error}`}`
        : "";
    toast.showToast({
      message: `Moved ${result.moved} ${noun} to “${destTitle}”${partial}`,
      undoable: true,
    });
    onMoved?.();
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Move to…</DialogTitle>
        <DialogDescription>
          {count === 1 ? "1 item" : `${count} items`} — choose a destination
          folder.
        </DialogDescription>
      </DialogHeader>
      <ul
        aria-label="Destination folders"
        className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border border-border p-1"
      >
        {destinations.map((dest) => {
          const blockedBySubtree = denied.has(dest.id);
          const disabled = blockedBySubtree || dest.isManaged;
          const reason = blockedBySubtree
            ? "Can't move a folder into itself or its own subtree."
            : dest.isManaged
              ? "Managed folders can't receive items."
              : undefined;
          return (
            <li key={dest.id}>
              <button
                type="button"
                aria-pressed={destId === dest.id}
                disabled={disabled}
                title={reason}
                onClick={() => setDestId(dest.id)}
                style={{ paddingInlineStart: `${dest.depth * 12 + 8}px` }}
                className={
                  "w-full rounded-sm py-1 pr-2 text-left text-sm " +
                  "outline-hidden hover:bg-accent hover:text-accent-foreground " +
                  "focus-visible:ring-2 focus-visible:ring-ring " +
                  "aria-pressed:bg-accent aria-pressed:text-accent-foreground " +
                  "disabled:cursor-not-allowed disabled:opacity-50"
                }
              >
                {dest.label}
                {dest.isManaged && (
                  <span
                    aria-hidden="true"
                    className="ml-2 text-xs text-muted-foreground"
                  >
                    (managed)
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
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
          disabled={busy || destId === null}
          onClick={() => void handleMove()}
          className={
            "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
            "text-primary-foreground disabled:opacity-50"
          }
        >
          Move
        </button>
      </DialogFooter>
    </>
  );
}
