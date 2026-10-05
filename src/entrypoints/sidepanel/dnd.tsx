import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { createContext, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import { moveNode } from "../../sync/mutations";
import type { FolderNode, FlattenedTree } from "../../sync/tree";
import { discardById } from "../../undo/restore";
import { captureNodes, pushSnapshot } from "../../undo/snapshot";
import { cn } from "../../ui/lib/cn";
import type { BookmarkSelection } from "./BookmarkList";
import { moveDeniedIds, moveNodesWithUndo } from "./MoveToDialog";
import type { MoveNodesResult } from "./MoveToDialog";
import { errorMessage, useToast } from "./UndoToast";

/**
 * Drag and drop for the side panel, built on `@dnd-kit/core`.
 *
 *  - {@link DndProvider} owns the single `DndContext` for the whole shell: a
 *    `PointerSensor` (with a small distance activation constraint so plain
 *    row clicks still select) and a `KeyboardSensor` (Space/Enter to lift,
 *    arrows to move, Space/Enter to drop, Esc to cancel) with a custom
 *    coordinate getter that SNAPS the drag between drop targets instead of
 *    nudging by fixed pixels — the arrow keys therefore hop from one valid
 *    drop target to the next. The `DragOverlay` renders the dragged row from
 *    captured data (virtual rows unmount while scrolling, so DOM lookup
 *    would be unsafe).
 *  - {@link DragHandle} is the per-row draggable: a small focusable control
 *    rendered as a SIBLING of T3's kebab wrapper (whose span stops
 *    propagation). The row itself keeps T2's roving tabindex / click-select
 *    behaviour untouched — drags never start from the row body.
 *  - {@link useDropZone} registers a droppable and reports whether the
 *    current hovered target is an INVALID drop (T3's deny rules), so callers
 *    can render the invalid affordance.
 *  - {@link resolveDrop} is the pure resolver: it turns (tree, dragged ids,
 *    hovered target) into either a concrete move (`parentId` + optional
 *    `index`) or a typed rejection. It is the friendly UI layer — the
 *    mutation service re-validates every move and stays authoritative.
 *
 * Moves reuse T3's snapshot semantics: {@link moveNodesWithUndo} for a drop
 * INTO a folder, and {@link moveNodesToIndexWithUndo} (same capture/push/
 * discard shape, plus an `index`) for a reorder. A rejected or cancelled drag
 * never reaches the mutation layer, so no snapshot is ever pushed for it and
 * there is nothing to discard.
 */

// ---------------------------------------------------------------------------
// Drag / drop data
// ---------------------------------------------------------------------------

/** Payload carried by a draggable row. */
export interface DragItemData {
  kind: "bookmark" | "folder";
  id: string;
  /** Display name, captured at drag start for the overlay. */
  label: string;
  parentId?: string;
  index?: number;
}

/** What is being dragged, after multi-select expansion at drag start. */
export interface DragPayload {
  ids: readonly string[];
  primaryId: string;
  kind: "bookmark" | "folder";
  label: string;
}

/** Data carried by a droppable target. */
export type DropTargetData =
  | {
      /** A folder row — drop INTO it (or reorder among siblings). */
      kind: "folder";
      folderId: string;
      parentId?: string;
      index?: number;
    }
  | {
      /** A row's index slot — insert before that row. */
      kind: "slot";
      parentId?: string;
      index?: number;
    };

/** Where a drop lands, or why it is refused. */
export type DropResolution =
  | {
      ok: true;
      parentId: string;
      index?: number;
      mode: "into" | "reorder";
    }
  | { ok: false; reason: string };

/** True when every dragged id is a folder (only folders can reorder). */
function allFolders(tree: FlattenedTree, ids: readonly string[]): boolean {
  return ids.every((id) => tree.folders.has(id));
}

/**
 * Resolve a drop. Rejections (never dispatched):
 *  - the synthetic root "0" (it is never a rendered target anyway),
 *  - a managed folder (policy wall),
 *  - a folder's own subtree — itself included (self/descendant),
 *  - a leaf bookmark used as a folder target.
 *
 * Fixed roots "1"–"3" ARE valid destinations: Chrome parents them normally
 * and "move to the Bookmarks bar" is a primary workflow. A root is never a
 * MOVE SUBJECT — its drag handle is disabled (see {@link DragHandle}).
 *
 * A folder dropped onto a folder in the SAME parent reorders among siblings;
 * a drop onto any other folder moves INTO it (appended). Bookmarks always
 * move INTO a folder row, or to a slot's index.
 */
export function resolveDrop(
  tree: FlattenedTree,
  payload: DragPayload,
  target: DropTargetData | undefined,
): DropResolution {
  if (target === undefined) return { ok: false, reason: "No drop target." };

  if (target.kind === "folder") {
    if (target.folderId === ROOT_NODE_ID) {
      return { ok: false, reason: "The root node can't receive drops." };
    }
    const folder = tree.folders.get(target.folderId);
    if (folder === undefined) {
      return { ok: false, reason: "That item is a bookmark, not a folder." };
    }
    if (folder.isManaged) {
      return { ok: false, reason: "Managed folders can't receive items." };
    }
    if (moveDeniedIds(tree, payload.ids).has(target.folderId)) {
      return {
        ok: false,
        reason: "Can't move a folder into itself or its own subtree.",
      };
    }
    if (
      target.parentId !== undefined &&
      target.index !== undefined &&
      allFolders(tree, payload.ids) &&
      payload.ids.every(
        (id) => tree.folders.get(id)?.parentId === target.parentId,
      )
    ) {
      return {
        ok: true,
        parentId: target.parentId,
        index: target.index,
        mode: "reorder",
      };
    }
    return { ok: true, parentId: target.folderId, mode: "into" };
  }

  if (target.parentId === undefined || target.index === undefined) {
    return { ok: false, reason: "No drop target." };
  }
  if (target.parentId === ROOT_NODE_ID) {
    return { ok: false, reason: "The root node can't receive drops." };
  }
  const parent = tree.folders.get(target.parentId);
  if (parent === undefined) {
    return { ok: false, reason: "That item is a bookmark, not a folder." };
  }
  if (parent.isManaged) {
    return { ok: false, reason: "Managed folders can't receive items." };
  }
  if (moveDeniedIds(tree, payload.ids).has(target.parentId)) {
    return {
      ok: false,
      reason: "Can't move a folder into itself or its own subtree.",
    };
  }
  return {
    ok: true,
    parentId: target.parentId,
    index: target.index,
    mode: "reorder",
  };
}

// ---------------------------------------------------------------------------
// Move helpers (snapshot-first, total)
// ---------------------------------------------------------------------------

/**
 * Move `ids` to `parentId` at `index`, undoably — the reorder counterpart of
 * T3's {@link moveNodesWithUndo}. Same contract: the `bulk_move` snapshot is
 * pushed BEFORE the first `moveNode`, a fully rejected move discards that
 * specific row again (`discardById`, so a concurrent flow's snapshot is
 * never popped instead), and the result is counted rather than thrown.
 */
export async function moveNodesToIndexWithUndo(
  ids: readonly string[],
  parentId: string,
  index: number,
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
    const snapshotId = await pushSnapshot({
      kind: "bulk_move",
      // movedToParentId (D09): undo skips a node moved again afterwards.
      nodes: capture.nodes.map((node) => ({
        ...node,
        movedToParentId: parentId,
      })),
      meta: capture.meta,
    });
    let moved = 0;
    let firstError: string | undefined;
    for (const node of capture.nodes) {
      try {
        // Each subsequent item lands after the previous one so a multi-item
        // reorder keeps its relative order.
        await moveNode(node.id, { parentId, index: index + moved });
        moved += 1;
      } catch (cause) {
        firstError ??= errorMessage(cause);
      }
    }
    if (moved === 0) {
      await discardById(snapshotId);
      return {
        moved: 0,
        failed: ids.length,
        error: firstError ?? "Move failed.",
      };
    }
    return {
      moved,
      failed: ids.length - moved,
      error: firstError,
      snapshotId,
    };
  } catch (cause) {
    return { moved: 0, failed: ids.length, error: errorMessage(cause) };
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** State shared with every row while a drag is live. */
export interface DndState {
  /** Droppable id currently hovered with an INVALID target, else null. */
  invalidOverId: string | null;
  /** True while a drag is in flight. */
  dragging: boolean;
}

const DndStateContext = createContext<DndState>({
  invalidOverId: null,
  dragging: false,
});

/** The nearest drag state (inert outside a provider). */
export function useDndState(): DndState {
  return useContext(DndStateContext);
}

/**
 * Keyboard coordinate getter: instead of nudging by a fixed pixel step,
 * return the centre of the next enabled drop target in the arrow's
 * direction. `closestCenter` then resolves the hovered target exactly, so
 * the keyboard hops target-to-target (and the behaviour is deterministic
 * under jsdom's stubbed rects).
 */
const snapCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  const horizontal =
    event.code === "ArrowLeft" || event.code === "ArrowRight";
  const forward = event.code === "ArrowDown" || event.code === "ArrowRight";
  const axis = horizontal ? "x" : "y";
  const current = currentCoordinates[axis];

  const candidates: { x: number; y: number }[] = [];
  context.droppableRects.forEach((rect) => {
    candidates.push({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  });
  if (candidates.length === 0) return undefined;

  const ahead = candidates
    .filter((point) =>
      forward ? point[axis] > current + 0.5 : point[axis] < current - 0.5,
    )
    .sort((a, b) => (forward ? a[axis] - b[axis] : b[axis] - a[axis]));

  return ahead[0];
};

/** What the DragOverlay renders: captured at drag start, never DOM lookup. */
interface ActiveDrag {
  label: string;
  count: number;
}

export interface DndProviderProps {
  tree: FlattenedTree;
  /** The shell's selection model (T3) — multi-select drags expand through it. */
  selection: BookmarkSelection;
  children: ReactNode;
}

export function DndProvider({ tree, selection, children }: DndProviderProps) {
  const toast = useToast();
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const [invalidOverId, setInvalidOverId] = useState<string | null>(null);
  const payloadRef = useRef<DragPayload | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: snapCoordinateGetter }),
  );

  const handleDragStart = (event: DragStartEvent): void => {
    const data = event.active.data.current as DragItemData | undefined;
    if (data === undefined) return;
    // Dragging a selected row drags the whole selection; anything else drags
    // just the row under the handle.
    const ids =
      selection.isSelected(data.id) && selection.selectedIds.size > 0
        ? [...selection.selectedIds]
        : [data.id];
    payloadRef.current = {
      ids,
      primaryId: data.id,
      kind: data.kind,
      label: data.label,
    };
    setActive({ label: data.label, count: ids.length });
  };

  const handleDragOver = (event: DragOverEvent): void => {
    const payload = payloadRef.current;
    if (payload === null || event.over === null) {
      setInvalidOverId(null);
      return;
    }
    const resolution = resolveDrop(
      tree,
      payload,
      event.over.data.current as DropTargetData | undefined,
    );
    setInvalidOverId(resolution.ok ? null : String(event.over.id));
  };

  const clear = (): void => {
    payloadRef.current = null;
    setActive(null);
    setInvalidOverId(null);
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const payload = payloadRef.current;
    const over = event.over;
    clear();
    if (payload === null || over === null) return;
    const resolution = resolveDrop(
      tree,
      payload,
      over.data.current as DropTargetData | undefined,
    );
    if (!resolution.ok) return; // friendly layer refuses; nothing dispatched
    void performDrop(
      payload,
      resolution,
      tree,
      toast.showToast,
      // Same policy as delete/move: a successful drop clears the selection.
      () => selection.clear(),
    );
  };

  const handleDragCancel = (): void => {
    // A cancelled drag never reached the mutation layer, so no snapshot was
    // pushed and there is nothing to discard.
    clear();
  };

  const state = useMemo<DndState>(
    () => ({ invalidOverId, dragging: active !== null }),
    [invalidOverId, active],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <DndStateContext.Provider value={state}>
        {children}
      </DndStateContext.Provider>
      <DragOverlay dropAnimation={null}>
        {active === null ? null : (
          <div
            data-testid="dnd-overlay"
            className="flex max-w-[16rem] items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-sm text-popover-foreground shadow-lg"
          >
            <span aria-hidden="true">⠿</span>
            <span className="truncate">{active.label}</span>
            {active.count > 1 && (
              <span className="shrink-0 rounded-sm bg-muted px-1 text-xs text-muted-foreground">
                {active.count}
              </span>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

async function performDrop(
  payload: DragPayload,
  resolution: Extract<DropResolution, { ok: true }>,
  tree: FlattenedTree,
  showToast: (toast: {
    message: string;
    undoable?: boolean;
    snapshotId?: number;
    error?: boolean;
  }) => void,
  clearSelection: () => void,
): Promise<void> {
  const result =
    resolution.index === undefined
      ? await moveNodesWithUndo(payload.ids, resolution.parentId)
      : await moveNodesToIndexWithUndo(
          payload.ids,
          resolution.parentId,
          resolution.index,
        );

  if (result.moved === 0) {
    showToast({ message: result.error ?? "Move failed.", error: true });
    return;
  }
  // A successful drop clears the selection — the same policy delete and the
  // Move-to dialog follow, so a dragged selection does not linger.
  clearSelection();
  const dest = tree.folders.get(resolution.parentId)?.title ?? "";
  const destLabel = dest === "" ? "folder" : `“${dest}”`;
  const noun = result.moved === 1 ? "item" : "items";
  const partial =
    result.failed > 0
      ? ` — ${result.failed} failed${
          result.error === undefined ? "" : `: ${result.error}`
        }`
      : "";
  const verb = resolution.mode === "reorder" ? "Reordered" : "Moved";
  showToast({
    message: `${verb} ${result.moved} ${noun} in ${destLabel}${partial}`,
    undoable: true,
    snapshotId: result.snapshotId,
  });
}

// ---------------------------------------------------------------------------
// Per-row draggable / droppable
// ---------------------------------------------------------------------------

export interface DragHandleProps {
  id: string;
  kind: "bookmark" | "folder";
  label: string;
  parentId?: string;
  index?: number;
  /** Managed or fixed-root nodes can't be moved — the handle is inert. */
  disabled?: boolean;
  className?: string;
}

/**
 * The per-row drag handle. Rendered as a SIBLING of T3's kebab wrapper (whose
 * span stops event propagation), so pointer/keyboard drags never collide with
 * the row's click-select or roving-focus handlers.
 */
export function DragHandle({
  id,
  kind,
  label,
  parentId,
  index,
  disabled = false,
  className,
}: DragHandleProps) {
  const data: DragItemData = {
    kind,
    id,
    label,
    ...(parentId === undefined ? {} : { parentId }),
    ...(index === undefined ? {} : { index }),
  };
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: `drag:${id}`, data, disabled });

  return (
    <span
      ref={(el) => {
        setNodeRef(el);
        setActivatorNodeRef(el);
      }}
      {...attributes}
      {...listeners}
      aria-label={`Drag ${label}`}
      aria-disabled={disabled}
      data-dnd-drag={id}
      className={cn(
        "shrink-0 cursor-grab rounded-sm px-1 text-xs text-muted-foreground",
        "outline-hidden hover:bg-accent hover:text-accent-foreground",
        "focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "cursor-not-allowed opacity-40",
        isDragging && "opacity-50",
        className,
      )}
    >
      ⠿
    </span>
  );
}

export interface DropZone {
  /** Ref callback for the droppable element. */
  dropRef: (el: HTMLElement | null) => void;
  /** True when this target is hovered with an invalid drop. */
  invalid: boolean;
}

/**
 * Register `id` as a droppable carrying `data`, and report whether it is the
 * invalid hovered target so the caller can render the invalid affordance.
 */
export function useDropZone(
  id: string,
  data: DropTargetData,
  disabled = false,
): DropZone {
  const { setNodeRef } = useDroppable({ id: `drop:${id}`, data, disabled });
  const { invalidOverId } = useDndState();
  const droppableId = `drop:${id}`;
  return {
    dropRef: setNodeRef,
    invalid: invalidOverId === droppableId,
  };
}

/** Props for {@link FolderRowDnd}. */
export interface FolderRowDndProps {
  node: FolderNode;
}

/**
 * Draggable handle + droppable overlay for one folder-tree row, as a single
 * fragment. The overlay is absolutely positioned over the row (the `<li>`
 * carries `relative`), so no row markup is restructured — the handle stays a
 * sibling of the kebab wrapper and the overlay never intercepts clicks.
 */
export function FolderRowDnd({ node }: FolderRowDndProps) {
  const label = node.title === "" ? "Untitled folder" : node.title;
  const { dropRef, invalid } = useDropZone(`folder:${node.id}`, {
    kind: "folder",
    folderId: node.id,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    ...(node.index === undefined ? {} : { index: node.index }),
  });
  return (
    <>
      <DragHandle
        id={node.id}
        kind="folder"
        label={label}
        parentId={node.parentId}
        index={node.index}
        disabled={node.isManaged || node.isRoot}
      />
      <span
        ref={dropRef}
        aria-hidden="true"
        data-dnd-drop={`folder:${node.id}`}
        data-drop-invalid={invalid ? "true" : undefined}
        className={cn(
          "pointer-events-none absolute inset-0 rounded-sm",
          invalid && "ring-2 ring-destructive",
        )}
      />
    </>
  );
}
