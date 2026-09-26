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
import type { BookmarkMeta } from "../../schemas/meta";
import type { BookmarkItem } from "../../sync/tree";
import { Favicon } from "../../ui/components/favicon";
import { cn } from "../../ui/lib/cn";

/**
 * Virtualized bookmark list/grid for the right pane, plus the selection
 * model consumed by P4.T3's bulk actions.
 *
 *  - Layout toggle: "list" rows vs "grid" cards (two columns — the side
 *    panel is narrow). Rows are virtualized with @tanstack/react-virtual
 *    (fixed-height estimates; no runtime measuring) so 10k+ items stay fast.
 *  - Semantics: `role="listbox"` + `aria-multiselectable`, rows are
 *    `role="option"` with `aria-selected`/`aria-posinset`/`aria-setsize`.
 *  - Selection: `useBookmarkSelection` manages `selectedIds` over the
 *    *current view's* ordered ids: plain click selects one, ctrl/cmd-click
 *    toggles, shift-click extends a range from the last anchor (ctrl+shift
 *    unions), ctrl/cmd-A selects all, Escape clears. `SelectionContext`
 *    makes the same object reachable deeper in the tree for T3+.
 *  - Keyboard on the listbox: arrows move a roving focus across rows
 *    (scrolling to off-screen rows via `scrollToIndex`), Enter activates
 *    (`onActivateItem`), Space toggles the focused row.
 */

export const LIST_ROW_HEIGHT = 40;
export const GRID_ROW_HEIGHT = 120;
export const GRID_COLUMNS = 2;
const OVERSCAN = 6;

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
  meta?: BookmarkMeta;
  tagNameByKey?: ReadonlyMap<string, string>;
  registerRef: (id: string, el: HTMLElement | null) => void;
  onSelect: (
    event: ReactMouseEvent<HTMLElement>,
    item: BookmarkItem,
    index: number,
  ) => void;
  onActivate: (item: BookmarkItem) => void;
}

/** One `role="option"` row (list layout) or card (grid layout). */
function Option({
  item,
  index,
  setSize,
  layout,
  selected,
  active,
  meta,
  tagNameByKey,
  registerRef,
  onSelect,
  onActivate,
}: OptionProps) {
  const title = item.title === "" ? item.url : item.title;
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={setSize}
      tabIndex={active ? 0 : -1}
      data-bookmark-id={item.id}
      ref={(el) => registerRef(item.id, el)}
      onClick={(event) => onSelect(event, item, index)}
      onDoubleClick={() => onActivate(item)}
      className={cn(
        "h-full cursor-default overflow-hidden rounded-sm outline-hidden",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "aria-selected:bg-accent aria-selected:text-accent-foreground",
        layout === "list"
          ? "flex items-center gap-2 px-2"
          : "flex flex-col items-center justify-center gap-1 p-2 text-center",
      )}
    >
      <Favicon
        pageUrl={item.url}
        size={layout === "list" ? 16 : 32}
        className="shrink-0"
      />
      <div className={cn("min-w-0", layout === "list" && "flex-1")}>
        <div className="truncate text-sm">{title}</div>
        {layout === "list" && (
          <div className="truncate text-xs text-muted-foreground">
            {item.url}
          </div>
        )}
      </div>
      {layout === "list" && meta !== undefined && (
        <span className="flex shrink-0 items-center gap-1">
          {meta.tags.map((nameKey) => (
            <span
              key={nameKey}
              data-tag={nameKey}
              className="rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
            >
              {tagNameByKey?.get(nameKey) ?? nameKey}
            </span>
          ))}
          {meta.category !== undefined && (
            <span
              data-category={meta.category}
              className="rounded-sm bg-secondary px-1 py-0.5 text-[10px] text-secondary-foreground"
            >
              {meta.category}
            </span>
          )}
        </span>
      )}
    </div>
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
  className,
}: BookmarkListProps) {
  const contextSelection = useSelection();
  const selection = selectionProp ?? contextSelection;
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

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () =>
      layout === "grid" ? GRID_ROW_HEIGHT : LIST_ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  useApplyFocusRequest(focusRequestRef, items, optionEls);

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
      case "ArrowDown":
        event.preventDefault();
        focusIndex(Math.min(currentIndex + 1, items.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (currentIndex <= 0) {
          // Above the first row: back to the listbox itself.
          (event.currentTarget as HTMLElement).focus();
        } else {
          focusIndex(currentIndex - 1);
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
    }
  };

  const toggleClass = (pressed: boolean) =>
    cn(
      "rounded-sm px-2 py-0.5 text-xs outline-hidden",
      "focus-visible:ring-2 focus-visible:ring-ring",
      pressed
        ? "bg-primary text-primary-foreground"
        : "bg-muted text-muted-foreground",
    );

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div
        role="toolbar"
        aria-label="Display options"
        className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1"
      >
        <span className="mr-auto text-xs text-muted-foreground">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <button
          type="button"
          aria-pressed={layout === "list"}
          onClick={() => setLayout("list")}
          className={toggleClass(layout === "list")}
        >
          List view
        </button>
        <button
          type="button"
          aria-pressed={layout === "grid"}
          onClick={() => setLayout("grid")}
          className={toggleClass(layout === "grid")}
        >
          Grid view
        </button>
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
          {items.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No bookmarks in this view.
            </p>
          )}
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
                  <div className="grid h-full grid-cols-2 gap-2 p-1">
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
                          meta={metaById?.get(item.id)}
                          tagNameByKey={tagNameByKey}
                          registerRef={registerOption}
                          onSelect={handleRowClick}
                          onActivate={handleActivate}
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
                      meta={metaById?.get(first.id)}
                      tagNameByKey={tagNameByKey}
                      registerRef={registerOption}
                      onSelect={handleRowClick}
                      onActivate={handleActivate}
                    />
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
