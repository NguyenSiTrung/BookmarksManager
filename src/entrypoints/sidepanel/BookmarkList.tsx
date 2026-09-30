import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ContextMenu } from "radix-ui";
import type { BookmarkMeta } from "../../schemas/meta";
import type { BookmarkItem } from "../../sync/tree";
import { Favicon } from "../../ui/components/favicon";
import { cn } from "../../ui/lib/cn";
import { DragHandle, useDndState, useDropZone } from "./dnd";
import { displayDomain, visibleTags } from "./row-text";

/**
 * Virtualized bookmark list/grid for the right pane, plus the selection
 * model consumed by P4.T3's bulk actions.
 *
 *  - Layout toggle: "list" rows vs "grid" cards (two columns — the side
 *    panel is narrow). Rows are virtualized with @tanstack/react-virtual
 *    (fixed-height estimates; no runtime measuring) so 10k+ items stay fast.
 *    Grid is a BROWSE-ONLY layout for drag SOURCES: drag handles render in
 *    the list layout only, so a drag can never start from a grid card.
 *  - Semantics: `role="listbox"` + `aria-multiselectable`, rows are
 *    `role="option"` with `aria-selected`/`aria-posinset`/`aria-setsize`.
 *  - Selection: `useBookmarkSelection` manages `selectedIds` over the
 *    *current view's* ordered ids: plain click selects one, ctrl/cmd-click
 *    toggles, shift-click extends a range from the last anchor (ctrl+shift
 *    unions), ctrl/cmd-A selects all, Escape clears. `SelectionContext`
 *    makes the same object reachable deeper in the tree for T3+.
 *  - Keyboard on the listbox: arrows move a roving focus across rows
 *    (scrolling to off-screen rows via `scrollToIndex`), Enter activates
 *    (`onActivateItem`), Space toggles the focused row, and Delete fires
 *    `onDeleteSelection` with the current selection.
 *  - P4.T3 hooks (all optional, all additive): `renderItemActions` renders a
 *    trailing per-row control (the shell's kebab menu), and
 *    `renderItemContextMenu` wraps the row in a Radix ContextMenu whose
 *    entries the caller supplies. Both render props are invoked per row;
 *    action clicks stop propagation so they never change the selection.
 */

export const LIST_ROW_HEIGHT = 40;
export const GRID_ROW_HEIGHT = 128;
export const GRID_COLUMNS = 2;
const OVERSCAN = 6;

/** Raw Radix context-menu content styling (mirrors DropdownMenuContent's). */
const CONTEXT_MENU_CONTENT_CLASS =
  "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 " +
  "text-popover-foreground shadow-md";

/** Max tag chips on a row before the rest fold into a `+N` chip. */
const MAX_ROW_TAGS = 2;

/**
 * Row controls are drawn but transparent until the row is hovered, holds
 * focus, or is selected; touch devices (no hover) always show them. They keep
 * their width so rows never shift.
 */
const REVEAL_CLASS =
  "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 " +
  "group-aria-selected/row:opacity-100 [@media(hover:none)]:opacity-100";

/** Managed rows' drag handle is inert, so it reveals dimmed. */
const REVEAL_DIMMED_CLASS =
  "group-hover/row:opacity-40 group-focus-within/row:opacity-40 " +
  "group-aria-selected/row:opacity-40 [@media(hover:none)]:opacity-40";

// ---------------------------------------------------------------------------
// Selection model
// ---------------------------------------------------------------------------

/**
 * Multi-select state over the ordered ids of the current view. All mutators
 * re-anchor on plain/toggle clicks; range selection extends from the anchor
 * through the *ordered* list (shift-click direction-aware).
 */
export interface BookmarkSelection {
  /** Ids selected AND present in the current view's ordered ids. */
  readonly selectedIds: ReadonlySet<string>;
  isSelected(id: string): boolean;
  /** Select exactly `id` and make it the range anchor. */
  selectOnly(id: string): void;
  /** Toggle `id` and make it the range anchor. */
  toggle(id: string): void;
  /**
   * Select the ordered range anchor→`id`. `additive` unions the range with
   * the existing selection (ctrl+shift-click); otherwise it replaces. The
   * anchor does not move. Without a live anchor it degrades to `selectOnly`.
   */
  selectRangeTo(id: string, additive?: boolean): void;
  selectAll(): void;
  /** Replace the selection wholesale (bulk operations, T3). */
  setSelected(ids: Iterable<string>): void;
  clear(): void;
}

/**
 * Selection state hook. `orderedIds` must be the ordered ids of the list
 * the user sees — ranges and select-all resolve through it, and ids that
 * leave the view (switched views, deletions) are filtered out of the
 * exposed `selectedIds` without needing an effect.
 */
export function useBookmarkSelection(
  orderedIds: readonly string[],
): BookmarkSelection {
  const [rawSelected, setRawSelected] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [anchorId, setAnchorId] = useState<string | null>(null);

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    orderedIds.forEach((id, index) => map.set(id, index));
    return map;
  }, [orderedIds]);

  // Pruned view of the raw set: an id that left the ordered list is not
  // reported. Mutators always write back from the pruned set, so stale ids
  // are dropped on the next mutation instead of resurfacing later.
  const selectedIds = useMemo(() => {
    const pruned = new Set<string>();
    for (const id of rawSelected) {
      if (indexById.has(id)) pruned.add(id);
    }
    return pruned;
  }, [rawSelected, indexById]);

  return {
    selectedIds,
    isSelected: (id) => selectedIds.has(id),
    selectOnly: (id) => {
      setRawSelected(new Set([id]));
      setAnchorId(id);
    },
    toggle: (id) => {
      const next = new Set(selectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setRawSelected(next);
      setAnchorId(id);
    },
    selectRangeTo: (id, additive = false) => {
      const target = indexById.get(id);
      if (target === undefined) return;
      const anchor = anchorId === null ? undefined : indexById.get(anchorId);
      if (anchor === undefined) {
        setRawSelected(new Set([id]));
        setAnchorId(id);
        return;
      }
      const [lo, hi] = anchor <= target ? [anchor, target] : [target, anchor];
      const range = orderedIds.slice(lo, hi + 1);
      setRawSelected(
        additive ? new Set([...selectedIds, ...range]) : new Set(range),
      );
    },
    selectAll: () => {
      setRawSelected(new Set(orderedIds));
    },
    setSelected: (ids) => {
      setRawSelected(new Set(ids));
    },
    clear: () => {
      setRawSelected(new Set());
    },
  };
}

export const SelectionContext = createContext<BookmarkSelection | null>(null);

/** Inert fallback so the list is still usable outside a provider. */
const EMPTY_SELECTION: BookmarkSelection = {
  selectedIds: new Set<string>(),
  isSelected: () => false,
  selectOnly: () => {},
  toggle: () => {},
  selectRangeTo: () => {},
  selectAll: () => {},
  setSelected: () => {},
  clear: () => {},
};

/** The selection for this subtree; EMPTY_SELECTION when no provider. */
export function useSelection(): BookmarkSelection {
  return useContext(SelectionContext) ?? EMPTY_SELECTION;
}

/**
 * Owns selection state for a subtree — App wraps the shell so T3's action
 * bar and dialogs can `useSelection()` without prop drilling.
 */
export function SelectionProvider({
  orderedIds,
  children,
}: {
  orderedIds: readonly string[];
  children: ReactNode;
}) {
  const selection = useBookmarkSelection(orderedIds);
  return (
    <SelectionContext.Provider value={selection}>
      {children}
    </SelectionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Deferred row focus
// ---------------------------------------------------------------------------

/**
 * Applies deferred row-focus requests after every render: keyboard nav can
 * target a row that mounts only after `scrollToIndex` brings it into the
 * virtual window — the request parks in a ref until the element exists.
 * DOM-only (no React state), so running every render is effect-safe.
 */
function useApplyFocusRequest(
  focusRequestRef: RefObject<number | null>,
  items: readonly BookmarkItem[],
  optionElsRef: RefObject<Map<string, HTMLElement>>,
): void {
  useEffect(() => {
    const index = focusRequestRef.current;
    if (index === null) return;
    const item = items[index];
    if (item === undefined) {
      focusRequestRef.current = null;
      return;
    }
    const el = optionElsRef.current.get(item.id);
    if (el !== undefined) {
      el.focus();
      focusRequestRef.current = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

interface OptionProps {
  item: BookmarkItem;
  /** Index in the flat items array (for posinset + range anchoring). */
  index: number;
  setSize: number;
  layout: "list" | "grid";
  selected: boolean;
  active: boolean;
  /**
   * True when this row's "insert before" drop slot is active — only
   * tree-ordered views (all/folder) expose reorder drop targets; a view that
   * re-sorts the list (tag/category/untagged/recent/duplicates) does not,
   * because "before row X" there has no tree position.
   */
  reorderable: boolean;
  meta?: BookmarkMeta;
  tagNameByKey?: ReadonlyMap<string, string>;
  registerRef: (id: string, el: HTMLElement | null) => void;
  onSelect: (
    event: ReactMouseEvent<HTMLElement>,
    item: BookmarkItem,
    index: number,
  ) => void;
  onActivate: (item: BookmarkItem) => void;
  /** Trailing per-row action control (kebab menu); P4.T3, optional. */
  renderItemActions?: (item: BookmarkItem) => ReactNode;
  /** Right-click menu entries for this row; P4.T3, optional. */
  renderItemContextMenu?: (item: BookmarkItem) => ReactNode;
}

/** One `role="option"` row (list layout) or card (grid layout). */
function Option({
  item,
  index,
  setSize,
  layout,
  selected,
  active,
  reorderable,
  meta,
  tagNameByKey,
  registerRef,
  onSelect,
  onActivate,
  renderItemActions,
  renderItemContextMenu,
}: OptionProps) {
  const title = item.title === "" ? item.url : item.title;
  const domain = displayDomain(item.url);
  const actions = renderItemActions?.(item);
  const menuContent = renderItemContextMenu?.(item);
  // P4.T4: the row doubles as a reorder drop slot ("insert before this row").
  // A bookmark has no children, so it is never a folder target. The slot is
  // DISABLED outside tree-ordered views (and for unpositioned rows), so a
  // drop there can never be dispatched.
  const slotDisabled =
    !reorderable || item.parentId === undefined || item.index === undefined;
  const { dropRef, invalid } = useDropZone(
    `slot:${item.id}`,
    {
      kind: "slot",
      ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
      ...(item.index === undefined ? {} : { index: item.index }),
    },
    slotDisabled,
  );
  if (layout === "grid") {
    const card = (
      <div
        role="option"
        aria-selected={selected}
        aria-posinset={index + 1}
        aria-setsize={setSize}
        tabIndex={active ? 0 : -1}
        title={item.url}
        data-bookmark-id={item.id}
        data-dnd-drop={slotDisabled ? undefined : `slot:${item.id}`}
        data-drop-invalid={invalid ? "true" : undefined}
        ref={(el) => {
          registerRef(item.id, el);
          dropRef(el);
        }}
        onClick={(event) => onSelect(event, item, index)}
        onDoubleClick={() => onActivate(item)}
        className={cn(
          "group/row relative flex flex-col justify-between h-full w-full min-w-0 cursor-default",
          "rounded-lg border border-border/70 bg-card p-3 text-left outline-hidden select-none",
          "transition-all duration-150 ease-out",
          "hover:border-primary/40 hover:bg-card hover:shadow-xs",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          "aria-selected:border-primary aria-selected:bg-accent/40 aria-selected:ring-1 aria-selected:ring-primary/40",
          invalid && "ring-2 ring-destructive ring-inset",
        )}
      >
        {/* Card Header: Favicon squircle badge + Category chip + Action menu */}
        <div className="flex items-center justify-between gap-1.5 w-full">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/40 p-1 shadow-xs group-hover/row:border-border transition-colors">
            <Favicon
              pageUrl={item.url}
              size={16}
              className="size-4 shrink-0 rounded-xs object-contain"
            />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {meta?.category !== undefined && (
              <span
                data-category={meta.category}
                className="rounded-xs bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary capitalize"
              >
                {meta.category}
              </span>
            )}
            {actions !== undefined && (
              <span
                data-row-controls
                className={cn("flex shrink-0 items-center", REVEAL_CLASS)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {actions}
              </span>
            )}
          </div>
        </div>

        {/* Card Body: Title with 2-line clamp, left-aligned, no clip */}
        <div className="my-auto w-full min-w-0 py-1">
          <div
            className="line-clamp-2 text-xs font-semibold leading-snug text-foreground group-hover/row:text-primary transition-colors break-words"
            title={title}
          >
            {title}
          </div>
        </div>

        {/* Card Footer: Domain + Tags */}
        <div className="flex items-center justify-between gap-1.5 w-full min-w-0 pt-0.5 text-[11px] text-muted-foreground">
          <span className="truncate flex-1 font-normal" title={domain}>
            {domain}
          </span>
          {meta?.tags && meta.tags.length > 0 && (() => {
            const { shown, hidden } = visibleTags(meta.tags, 1);
            return (
              <span className="flex items-center gap-1 shrink-0">
                {shown.map((nameKey) => (
                  <span
                    key={nameKey}
                    data-tag={nameKey}
                    className="rounded-xs bg-muted/80 px-1 py-0.5 text-[10px] text-muted-foreground truncate max-w-[70px]"
                  >
                    #{tagNameByKey?.get(nameKey) ?? nameKey}
                  </span>
                ))}
                {hidden.length > 0 && (
                  <span
                    data-tag-more
                    title={hidden
                      .map((nameKey) => tagNameByKey?.get(nameKey) ?? nameKey)
                      .join(", ")}
                    className="rounded-xs bg-muted/80 px-1 py-0.5 text-[10px] text-muted-foreground"
                  >
                    +{hidden.length}
                  </span>
                )}
              </span>
            );
          })()}
        </div>
      </div>
    );

    if (menuContent === undefined) return card;
    return (
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{card}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={CONTEXT_MENU_CONTENT_CLASS}>
            {menuContent}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  }

  const row = (
    <div
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={setSize}
      tabIndex={active ? 0 : -1}
      title={item.url}
      data-bookmark-id={item.id}
      data-dnd-drop={slotDisabled ? undefined : `slot:${item.id}`}
      data-drop-invalid={invalid ? "true" : undefined}
      ref={(el) => {
        registerRef(item.id, el);
        dropRef(el);
      }}
      onClick={(event) => onSelect(event, item, index)}
      onDoubleClick={() => onActivate(item)}
      className={cn(
        "group/row h-full cursor-default overflow-hidden rounded-sm outline-hidden",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "aria-selected:bg-accent aria-selected:text-accent-foreground",
        "hover:bg-row-hover",
        invalid && "ring-2 ring-destructive ring-inset",
        "flex items-center gap-2 px-2",
      )}
    >
      <Favicon
        pageUrl={item.url}
        size={16}
        className="size-4 shrink-0 rounded-xs object-contain"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className="truncate text-xs text-muted-foreground">{domain}</div>
      </div>
      {meta !== undefined && (
        <span className="flex shrink-0 items-center gap-1">
          {(() => {
            const { shown, hidden } = visibleTags(meta.tags, MAX_ROW_TAGS);
            return (
              <>
                {shown.map((nameKey) => (
                  <span
                    key={nameKey}
                    data-tag={nameKey}
                    className="rounded-sm bg-muted px-1 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {tagNameByKey?.get(nameKey) ?? nameKey}
                  </span>
                ))}
                {hidden.length > 0 && (
                  <span
                    data-tag-more
                    title={hidden
                      .map((nameKey) => tagNameByKey?.get(nameKey) ?? nameKey)
                      .join(", ")}
                    className="rounded-sm bg-muted px-1 py-0.5 text-[11px] text-muted-foreground"
                  >
                    +{hidden.length}
                  </span>
                )}
              </>
            );
          })()}
          {meta.category !== undefined && (
            <span
              data-category={meta.category}
              className="rounded-sm bg-primary/10 px-1 py-0.5 text-[11px] text-primary"
            >
              {meta.category}
            </span>
          )}
        </span>
      )}
      {actions !== undefined && (
        // Row-action control: its clicks/keys must never select or activate
        // the row underneath, so every event stops at this wrapper.
        <span
          data-row-controls
          className={cn("flex shrink-0 items-center", REVEAL_CLASS)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {actions}
        </span>
      )}
      <DragHandle
        id={item.id}
        kind="bookmark"
        label={title}
        parentId={item.parentId}
        index={item.index}
        disabled={item.isManaged}
        className={cn(REVEAL_CLASS, item.isManaged && REVEAL_DIMMED_CLASS)}
      />
    </div>
  );
  if (menuContent === undefined) return row;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTEXT_MENU_CONTENT_CLASS}>
          {menuContent}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// BookmarkList
// ---------------------------------------------------------------------------

export interface BookmarkListProps {
  /** Ordered items of the current view (from `resolveView`). */
  items: BookmarkItem[];
  /** Meta rows keyed by bookmark id — list rows show tag/category chips. */
  metaById?: ReadonlyMap<string, BookmarkMeta>;
  /** Tag display names keyed by nameKey; falls back to the key. */
  tagNameByKey?: ReadonlyMap<string, string>;
  /** Overrides the SelectionContext value (tests, embedded usage). */
  selection?: BookmarkSelection;
  /** Fired on Enter/double-click — the "open" affordance. */
  onActivateItem?: (item: BookmarkItem) => void;
  /** Fired when Delete is pressed over the listbox with a live selection. */
  onDeleteSelection?: (ids: readonly string[]) => void;
  /**
   * Whether rows expose reorder drop slots. Only tree-ordered views
   * (`all`/`folder`) are reorderable; a view that re-sorts the list (tag,
   * category, untagged, recent, duplicates) must not offer "insert before
   * row X" because that has no tree position there. Defaults to true so the
   * list stays drop-capable when rendered standalone.
   */
  reorderable?: boolean;
  /** Trailing per-row action control (kebab menu); P4.T3, optional. */
  renderItemActions?: (item: BookmarkItem) => ReactNode;
  /** Right-click menu entries per row; P4.T3, optional. */
  renderItemContextMenu?: (item: BookmarkItem) => ReactNode;
  /**
   * Optional content at the start of the toolbar row (the shell puts the
   * scope heading here so the title, item count and List/Grid toggle share
   * one line).
   */
  leading?: ReactNode;
  /**
   * Shown below the (empty) listbox when `items` is empty. Defaults to a plain
   * "No bookmarks in this view." line.
   */
  empty?: ReactNode;
  className?: string;
}

function chunkRows(
  items: readonly BookmarkItem[],
  columns: number,
): BookmarkItem[][] {
  const rows: BookmarkItem[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns) as BookmarkItem[]);
  }
  return rows;
}

export function BookmarkList({
  items,
  metaById,
  tagNameByKey,
  selection: selectionProp,
  onActivateItem,
  onDeleteSelection,
  reorderable = true,
  renderItemActions,
  renderItemContextMenu,
  leading,
  empty,
  className,
}: BookmarkListProps) {
  const contextSelection = useSelection();
  const selection = selectionProp ?? contextSelection;
  // While a drag is live, dnd-kit owns the arrow/Space/Esc keys — the
  // listbox must not also move roving focus or toggle the selection.
  const { dragging } = useDndState();
  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [activeIndex, setActiveIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const optionEls = useRef(new Map<string, HTMLElement>());
  // Keyboard nav targeting an off-screen row parks a focus request here;
  // `useApplyFocusRequest` applies it once the row has mounted.
  const focusRequestRef = useRef<number | null>(null);

  const columns = layout === "grid" ? GRID_COLUMNS : 1;
  const rows = useMemo(() => chunkRows(items, columns), [items, columns]);
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => map.set(item.id, index));
    return map;
  }, [items]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's documented API returns non-memoizable functions by design; upstream caveat, not a bug.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () =>
      layout === "grid" ? GRID_ROW_HEIGHT : LIST_ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  useApplyFocusRequest(focusRequestRef, items, optionEls);

  // Clamp the roving-focus index when the item list changes (a view switch
  // can shrink it): without this the old index points past the end and NO
  // row carries `tabIndex=0`, leaving the listbox unreachable by keyboard.
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(items.length - 1, 0)));
  }, [items]);

  const registerOption = (id: string, el: HTMLElement | null): void => {
    if (el === null) {
      optionEls.current.delete(id);
    } else {
      optionEls.current.set(id, el);
    }
  };

  const focusIndex = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    setActiveIndex(clamped);
    focusRequestRef.current = clamped;
    // Bring the row into the rendered window; the effect focuses it once
    // mounted. The immediate focus() covers the already-rendered case.
    virtualizer.scrollToIndex(
      layout === "grid" ? Math.floor(clamped / GRID_COLUMNS) : clamped,
      { align: "auto" },
    );
    optionEls.current.get(items[clamped]?.id ?? "")?.focus();
  };

  const handleRowClick = (
    event: ReactMouseEvent<HTMLElement>,
    item: BookmarkItem,
    index: number,
  ): void => {
    focusIndex(index);
    if (event.shiftKey) {
      selection.selectRangeTo(item.id, event.ctrlKey || event.metaKey);
    } else if (event.ctrlKey || event.metaKey) {
      selection.toggle(item.id);
    } else {
      selection.selectOnly(item.id);
    }
  };

  const handleActivate = (item: BookmarkItem): void => {
    onActivateItem?.(item);
  };

  const handleListKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    // A key dnd-kit already handled (the Space/arrows/Esc that drive a drag)
    // must not ALSO move roving focus or toggle the selection. `dragging` is
    // stale during the render the lifting key arrives in, so the
    // defaultPrevented flag is the reliable signal.
    if (event.defaultPrevented || dragging) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    if (event.key === "Escape") {
      selection.clear();
      return;
    }
    const target = event.target as HTMLElement;
    const rowEl = target.closest<HTMLElement>("[data-bookmark-id]");
    const rowId = rowEl?.dataset.bookmarkId;
    const currentIndex =
      rowId === undefined ? -1 : (indexById.get(rowId) ?? -1);

    switch (event.key) {
      case "ArrowRight":
        if (layout === "grid") {
          event.preventDefault();
          focusIndex(
            currentIndex === -1
              ? 0
              : Math.min(currentIndex + 1, items.length - 1),
          );
        }
        break;
      case "ArrowLeft":
        if (layout === "grid") {
          event.preventDefault();
          focusIndex(currentIndex <= 0 ? 0 : currentIndex - 1);
        }
        break;
      case "ArrowDown":
        event.preventDefault();
        if (currentIndex === -1) {
          focusIndex(0);
        } else if (layout === "grid") {
          focusIndex(Math.min(currentIndex + GRID_COLUMNS, items.length - 1));
        } else {
          focusIndex(Math.min(currentIndex + 1, items.length - 1));
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (layout === "grid") {
          if (currentIndex < GRID_COLUMNS) {
            (event.currentTarget as HTMLElement).focus();
          } else {
            focusIndex(currentIndex - GRID_COLUMNS);
          }
        } else {
          if (currentIndex <= 0) {
            // Above the first row: back to the listbox itself.
            (event.currentTarget as HTMLElement).focus();
          } else {
            focusIndex(currentIndex - 1);
          }
        }
        break;
      case "Home":
        event.preventDefault();
        focusIndex(0);
        break;
      case "End":
        event.preventDefault();
        focusIndex(items.length - 1);
        break;
      case "Enter": {
        const item =
          currentIndex >= 0 ? items[currentIndex] : undefined;
        if (item !== undefined) {
          event.preventDefault();
          handleActivate(item);
        }
        break;
      }
      case " ": {
        if (rowId !== undefined) {
          event.preventDefault();
          selection.toggle(rowId);
          setActiveIndex(currentIndex);
        }
        break;
      }
      case "Delete": {
        // Bulk delete of the current selection (the shell snapshots first).
        if (selection.selectedIds.size > 0 && onDeleteSelection !== undefined) {
          event.preventDefault();
          onDeleteSelection([...selection.selectedIds]);
        }
        break;
      }
    }
  };

  const toggleClass = (pressed: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-all duration-150 outline-hidden",
      "focus-visible:ring-2 focus-visible:ring-ring",
      pressed
        ? "bg-background text-foreground shadow-xs"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
    );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div
        role="toolbar"
        aria-label="Display options"
        className="flex shrink-0 items-center justify-end gap-2 border-b border-border/70 px-3 py-1.5"
      >
        {leading !== undefined && (
          <div className="mr-auto min-w-0 flex-1 pr-2">{leading}</div>
        )}
        <span
          className={cn(
            "text-xs font-medium text-muted-foreground tabular-nums",
            leading === undefined && "mr-auto",
          )}
        >
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <div className="inline-flex items-center rounded-md border border-border/60 bg-muted/30 p-0.5">
          <button
            type="button"
            aria-pressed={layout === "list"}
            onClick={() => setLayout("list")}
            className={toggleClass(layout === "list")}
          >
            <svg
              aria-hidden="true"
              className="size-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            List view
          </button>
          <button
            type="button"
            aria-pressed={layout === "grid"}
            onClick={() => setLayout("grid")}
            className={toggleClass(layout === "grid")}
          >
            <svg
              aria-hidden="true"
              className="size-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
            </svg>
            Grid view
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        data-testid="bookmark-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          role="listbox"
          aria-label="Bookmarks"
          aria-multiselectable="true"
          tabIndex={0}
          data-layout={layout}
          onKeyDown={handleListKeyDown}
          className="relative w-full outline-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index] ?? [];
            const first = row[0];
            return (
              <div
                key={virtualRow.key}
                data-row-index={virtualRow.index}
                className="absolute top-0 left-0 w-full"
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {layout === "grid" ? (
                  <div className="grid h-full grid-cols-2 gap-2.5 px-3 py-1.5">
                    {row.map((item, column) => {
                      const index = virtualRow.index * GRID_COLUMNS + column;
                      return (
                        <Option
                          key={item.id}
                          item={item}
                          index={index}
                          setSize={items.length}
                          layout="grid"
                          selected={selection.isSelected(item.id)}
                          active={index === activeIndex}
                          reorderable={reorderable}
                          meta={metaById?.get(item.id)}
                          tagNameByKey={tagNameByKey}
                          registerRef={registerOption}
                          onSelect={handleRowClick}
                          onActivate={handleActivate}
                          renderItemActions={renderItemActions}
                          renderItemContextMenu={renderItemContextMenu}
                        />
                      );
                    })}
                  </div>
                ) : (
                  first !== undefined && (
                    <Option
                      item={first}
                      index={virtualRow.index}
                      setSize={items.length}
                      layout="list"
                      selected={selection.isSelected(first.id)}
                      active={virtualRow.index === activeIndex}
                      reorderable={reorderable}
                      meta={metaById?.get(first.id)}
                      tagNameByKey={tagNameByKey}
                      registerRef={registerOption}
                      onSelect={handleRowClick}
                      onActivate={handleActivate}
                      renderItemActions={renderItemActions}
                      renderItemContextMenu={renderItemContextMenu}
                    />
                  )
                )}
              </div>
            );
          })}
        </div>
        {items.length === 0 &&
          (empty ?? (
            <p className="p-4 text-sm text-muted-foreground">
              No bookmarks in this view.
            </p>
          ))}
      </div>
    </div>
  );
}
