import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TagDef } from "../../schemas/meta";
import type { SearchIndexHandle } from "../../search/run";
import type { FlattenedTree } from "../../sync/tree";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/components/dialog";
import { cn } from "../../ui/lib/cn";
import {
  buildPaletteSections,
  flattenPaletteSections,
} from "./palette";
import type { PaletteItem } from "./palette";
import type { SidePanelView } from "./views";

/**
 * Command palette (spec §5): Ctrl/Cmd+K opens a Radix Dialog holding an ARIA
 * combobox — the input is the combobox, the sectioned results are its
 * listbox. Ranking stays with MiniSearch (`palette.ts` → `runQuery`); no
 * cmdk dependency.
 *
 * - ArrowDown/ArrowUp cycle the highlight across the FLAT item list
 *   (wrapping); Enter runs the highlighted item; Esc is Radix's own close,
 *   which also returns focus to whatever was focused before opening.
 * - Running a bookmark opens it via `onOpenBookmark`; running a jump target
 *   calls `onJump` with the resolved `SidePanelView`. Both close the
 *   dialog. Per-result secondary actions (new tab, reveal, edit, copy) land
 *   in Task 5.
 * - Sections and item resolution are computed in `palette.ts` (pure); this
 *   component only renders and dispatches.
 */
export interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  search: SearchIndexHandle | null;
  tree: FlattenedTree;
  tagDefs: readonly TagDef[];
  /** Jump targets — activating one switches the side panel's view. */
  onJump(view: SidePanelView): void;
  /** Bookmark results — activating one opens the live bookmark. */
  onOpenBookmark(id: string): void;
}

export function CommandPalette({
  open,
  onOpenChange,
  search,
  tree,
  tagDefs,
  onJump,
  onOpenBookmark,
}: CommandPaletteProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const sections = useMemo(
    () => buildPaletteSections({ query, search, tree, tagDefs }),
    [query, search, tree, tagDefs],
  );
  const flat = useMemo(() => flattenPaletteSections(sections), [sections]);

  // Fresh state per opening — React's "adjust state during render" pattern
  // (an effect calling setState would cascade a second render).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQuery("");
      setActive(0);
    }
  }
  // Clamp the highlight when the item list shrinks under it.
  const clampedActive = flat.length === 0
    ? 0
    : Math.min(active, flat.length - 1);

  // Focus: remember the pre-open element and put focus back on close —
  // Radix's own restore doesn't reach elements that were focused outside a
  // trigger button (e.g. the search input focused via `/`). Refs/DOM only —
  // no setState.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    } else if (wasOpen.current) {
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (el !== null && el.isConnected) {
        // After Radix tears down the focus scope.
        queueMicrotask(() => el.focus());
      }
    }
    wasOpen.current = open;
  }, [open]);

  const run = (item: PaletteItem | undefined): void => {
    if (item === undefined) return;
    onOpenChange(false);
    if (item.kind === "jump") onJump(item.view);
    else onOpenBookmark(item.id);
  };

  /** Flat-list index where each section starts (aria-activedescendant ids). */
  const sectionStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const section of sections) {
      starts.push(acc);
      acc += section.items.length;
    }
    return starts;
  }, [sections]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        aria-label="Command palette"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search bookmarks or jump to a view, folder, tag, or category
        </DialogDescription>
        <div className="border-b border-border px-3 py-2">
          <input
            type="search"
            role="combobox"
            aria-label="Command palette"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={`${listId}-opt-${clampedActive}`}
            placeholder="Search bookmarks or jump to…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = flat.length;
                if (n === 0) return;
                setActive((prev) =>
                  e.key === "ArrowDown"
                    ? (prev + 1) % n
                    : prev <= 0
                      ? n - 1
                      : prev - 1,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(flat[clampedActive]);
              }
            }}
            className="w-full bg-transparent text-sm outline-hidden"
          />
        </div>
        <ul
          id={listId}
          role="listbox"
          aria-label="Palette results"
          className="max-h-80 overflow-y-auto p-1"
        >
          {sections.map((section, si) => {
            const sectionStart = sectionStarts[si] ?? 0;
            return (
              <li key={section.id} role="presentation">
                <div
                  aria-hidden="true"
                  className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground"
                >
                  {section.label}
                </div>
                <ul role="group" aria-label={section.label}>
                  {section.items.map((item, i) => {
                    const index = sectionStart + i;
                    return (
                      <li
                        key={
                          item.kind === "bookmark"
                            ? `bm:${item.id}`
                            : `jump:${item.label}`
                        }
                        id={`${listId}-opt-${index}`}
                        role="option"
                        aria-selected={index === clampedActive}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => run(item)}
                        className={cn(
                          "flex cursor-default items-baseline gap-2 rounded-sm px-2 py-1.5 text-sm",
                          index === clampedActive &&
                            "bg-accent text-accent-foreground",
                        )}
                      >
                        <span className="min-w-0 truncate">{item.label}</span>
                        {item.detail !== "" && (
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
          {flat.length === 0 && (
            <li
              role="presentation"
              className="px-2 py-6 text-center text-sm text-muted-foreground"
            >
              {search === null && query !== ""
                ? "Indexing…"
                : "No matches"}
            </li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
