import { Fragment, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { ContextMenu } from "radix-ui";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { FlattenedTree, FolderNode } from "../../sync/tree";
import { cn } from "../../ui/lib/cn";
import { FolderRowDnd, useDndState } from "./dnd";

/**
 * ARIA folder tree for the side panel's left pane.
 *
 * Implements the WAI-ARIA treeview pattern:
 *  - `role="tree"` on the container; flat `role="treeitem"` list carrying
 *    `aria-level` / `aria-setsize` / `aria-posinset` (flat rendering keeps
 *    the visible-window computation trivial and still exposes hierarchy).
 *  - `aria-expanded` on expandable items only (a folder is expandable iff
 *    it has at least one FOLDER child — bookmark children are never shown
 *    in the tree, they surface in the right-pane list instead).
 *  - `aria-selected` mirrors `selectedFolderId`.
 *  - Roving `tabIndex`: exactly the focused item is `0`, all others `-1`.
 *  - Keyboard: ArrowUp/Down move through the *visible* window; ArrowRight
 *    expands a closed node then moves to its first child; ArrowLeft closes
 *    an open node then moves to its parent; Home/End jump to the ends;
 *    Enter/Space selects.
 *
 * The synthetic root `"0"` is NEVER rendered — the tree's top level is the
 * fixed roots `"1","2","3"` (they render when present in the tree).
 *
 * Expansion is local UI state: a `Map<id, boolean>` of overrides — Chrome's
 * fixed roots default to expanded, every other folder to collapsed. An
 * override-based map (rather than a Set of ids) means the defaults still
 * apply after the tree loads asynchronously.
 *
 * P4.T3 hooks (optional, additive): `renderFolderActions` renders a trailing
 * per-row control (the shell's kebab menu) and `renderFolderContextMenu`
 * wraps the row in a Radix ContextMenu whose entries the caller supplies.
 * Action clicks/keys stop at their wrapper so they never select the row or
 * move the roving focus.
 */
export interface FolderTreeProps {
  tree: FlattenedTree;
  /** Currently selected folder view, if any. */
  selectedFolderId?: string;
  /** Fired when the user activates a folder (Enter/Space/click). */
  onSelectFolder?: (folderId: string) => void;
  /** Trailing per-row action control (kebab menu); P4.T3, optional. */
  renderFolderActions?: (node: FolderNode) => ReactNode;
  /** Right-click menu entries per row; P4.T3, optional. */
  renderFolderContextMenu?: (node: FolderNode) => ReactNode;
  className?: string;
  "aria-label"?: string;
}

/** Raw Radix context-menu content styling (mirrors DropdownMenuContent's). */
const CONTEXT_MENU_CONTENT_CLASS =
  "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 " +
  "text-popover-foreground shadow-md";

interface VisibleFolder {
  node: FolderNode;
  /** `aria-level`; the fixed roots are level 1. */
  level: number;
  posInSet: number;
  setSize: number;
  /** Has at least one folder child. */
  expandable: boolean;
  expanded: boolean;
}

/**
 * Ids of the tree's top level: children of the synthetic root when it is in
 * the model (the normal `getTree()` path), else every folder whose parent
 * is absent — a defensive fallback for hand-built subtree models.
 */
function topLevelIds(folders: FlattenedTree["folders"]): string[] {
  const root = folders.get(ROOT_NODE_ID);
  if (root !== undefined) {
    return root.childIds.filter((id) => folders.has(id));
  }
  return [...folders.values()]
    .filter(
      (folder) =>
        folder.parentId === undefined || !folders.has(folder.parentId),
    )
    .map((folder) => folder.id);
}

/**
 * Flatten the folder hierarchy to the *visible* window: a folder appears
 * only when every rendered ancestor is expanded.
 */
function computeVisibleFolders(
  tree: FlattenedTree,
  overrides: ReadonlyMap<string, boolean>,
): VisibleFolder[] {
  const { folders } = tree;
  const out: VisibleFolder[] = [];

  const visit = (
    id: string,
    level: number,
    posInSet: number,
    setSize: number,
  ): void => {
    const node = folders.get(id);
    if (node === undefined) return;
    const childFolderIds = node.childIds.filter((childId) =>
      folders.has(childId),
    );
    const expandable = childFolderIds.length > 0;
    const expanded = overrides.get(id) ?? node.isRoot;
    out.push({ node, level, posInSet, setSize, expandable, expanded });
    if (expanded) {
      childFolderIds.forEach((childId, index) =>
        visit(childId, level + 1, index + 1, childFolderIds.length),
      );
    }
  };

  const roots = topLevelIds(folders);
  roots.forEach((id, index) => visit(id, 1, index + 1, roots.length));
  return out;
}

/** Small inline folder glyph (lucide-react is intentionally absent). */
function FolderGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="14"
      height="14"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

export function FolderTree({
  tree,
  selectedFolderId,
  onSelectFolder,
  renderFolderActions,
  renderFolderContextMenu,
  className,
  "aria-label": ariaLabel,
}: FolderTreeProps) {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const itemEls = useRef(new Map<string, HTMLElement>());
  // While a drag is live, dnd-kit owns the arrow/Space/Esc keys — the tree
  // must not also move roving focus or expand/collapse rows.
  const { dragging } = useDndState();

  const visible = useMemo(
    () => computeVisibleFolders(tree, overrides),
    [tree, overrides],
  );
  const visibleIds = useMemo(
    () => new Set(visible.map((entry) => entry.node.id)),
    [visible],
  );

  // Roving tabindex target: the focused item while it stays visible, else
  // the selected folder when visible, else the first item.
  const activeId =
    focusedId !== null && visibleIds.has(focusedId)
      ? focusedId
      : selectedFolderId !== undefined && visibleIds.has(selectedFolderId)
        ? selectedFolderId
        : (visible[0]?.node.id ?? null);

  const registerItem = (id: string, el: HTMLElement | null): void => {
    if (el === null) {
      itemEls.current.delete(id);
    } else {
      itemEls.current.set(id, el);
    }
  };

  /** Move roving focus and apply it to the DOM node. */
  const focusItem = (id: string): void => {
    setFocusedId(id);
    itemEls.current.get(id)?.focus();
  };

  const focusIndex = (index: number): void => {
    const entry = visible[index];
    if (entry !== undefined) focusItem(entry.node.id);
  };

  const setExpanded = (entry: VisibleFolder, expanded: boolean): void => {
    if (!entry.expandable) return;
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(entry.node.id, expanded);
      return next;
    });
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
    index: number,
  ): void => {
    if (dragging) return;
    const entry = visible[index];
    if (entry === undefined) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusIndex(Math.min(index + 1, visible.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusIndex(Math.max(index - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        focusIndex(0);
        break;
      case "End":
        event.preventDefault();
        focusIndex(visible.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (entry.expandable && !entry.expanded) {
          setExpanded(entry, true);
        } else if (entry.expanded) {
          // The first child is always the next visible item.
          focusIndex(index + 1);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (entry.expandable && entry.expanded) {
          setExpanded(entry, false);
        } else {
          const parentId = entry.node.parentId;
          if (parentId !== undefined && visibleIds.has(parentId)) {
            focusItem(parentId);
          }
        }
        break;
      case "Enter":
      case " ":
      case "Spacebar":
        event.preventDefault();
        focusItem(entry.node.id);
        onSelectFolder?.(entry.node.id);
        break;
    }
  };

  return (
    <ul
      role="tree"
      aria-label={ariaLabel ?? "Folders"}
      className={cn("w-full", className)}
    >
      {visible.map((entry, index) => {
        const { node } = entry;
        const selected = node.id === selectedFolderId;
        const actions = renderFolderActions?.(node);
        const menuContent = renderFolderContextMenu?.(node);
        const item = (
          <li
            role="treeitem"
            // Explicit name: the row may carry trailing action controls
            // (P4.T3's kebab) whose labels must not join the tree item's
            // accessible name.
            aria-label={node.title === "" ? "Untitled folder" : node.title}
            aria-expanded={entry.expandable ? entry.expanded : undefined}
            aria-selected={selected}
            aria-level={entry.level}
            aria-setsize={entry.setSize}
            aria-posinset={entry.posInSet}
            tabIndex={node.id === activeId ? 0 : -1}
            data-node-id={node.id}
            ref={(el) => registerItem(node.id, el)}
            onClick={() => {
              focusItem(node.id);
              onSelectFolder?.(node.id);
            }}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "relative flex cursor-default items-center gap-1 rounded-sm px-1 py-1 text-sm outline-hidden select-none",
              "focus-visible:bg-accent focus-visible:text-accent-foreground",
              selected && "bg-accent text-accent-foreground",
              node.isManaged && "text-muted-foreground",
            )}
            style={{ paddingInlineStart: `${(entry.level - 1) * 14 + 4}px` }}
          >
            <span
              aria-hidden="true"
              className="w-4 shrink-0 cursor-pointer text-center text-xs text-muted-foreground"
              onClick={(event) => {
                // Caret toggles expansion only; it must not select the row.
                event.stopPropagation();
                setExpanded(entry, !entry.expanded);
              }}
            >
              {entry.expandable ? (entry.expanded ? "▾" : "▸") : ""}
            </span>
            <FolderGlyph className="shrink-0 text-muted-foreground" />
            {/* P4.T4: the drag handle + the (absolute) drop overlay for this
                row. The overlay is positioned over the `relative` <li>, so
                the row markup itself is untouched. */}
            <FolderRowDnd node={node} />
            <span className="truncate">
              {node.title === "" ? "Untitled folder" : node.title}
            </span>
            {actions !== undefined && (
              // Row-action control: clicks/keys stop here so they never
              // select the row or reach the tree's roving-focus handler.
              <span
                className="ml-auto flex shrink-0 items-center"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {actions}
              </span>
            )}
          </li>
        );
        if (menuContent === undefined) {
          return <Fragment key={node.id}>{item}</Fragment>;
        }
        return (
          <ContextMenu.Root key={node.id}>
            <ContextMenu.Trigger asChild>{item}</ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={CONTEXT_MENU_CONTENT_CLASS}>
                {menuContent}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}
    </ul>
  );
}
