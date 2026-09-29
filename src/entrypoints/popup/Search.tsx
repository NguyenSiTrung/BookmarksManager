import { useEffect, useMemo, useRef, useState } from "react";
import { isOpenableUrl } from "../../search/openable";
import { runQuery } from "../../search/run";
import type { SearchIndexHandle } from "../../search/run";
import type { SearchHit } from "../../search/index";
import type { OpenUrlDisposition } from "../../sync/tabs";
import { Favicon } from "../../ui/components/favicon";
import { SearchIcon, XIcon } from "../../ui/components/icons";
import { cn } from "../../ui/lib/cn";
import { hostOf } from "./PageCard";

/**
 * Popup search (PROJECT_PLAN §5.1, Phase 3). Sits at the top of the
 * quick-save popup: while `query` has text a top-10 results list replaces
 * the save form (the parent hides it; form state lives in `App` so it comes
 * back untouched on clear).
 *
 * The index handle arrives lazily — `App` loads metas/tag defs after first
 * paint and `useSearchIndex` builds in an effect — so a non-empty query may
 * briefly see `search === null`; that renders "Indexing…" instead of an
 * empty list.
 *
 * Opening is delegated through `onOpen` (the typed `openBookmarkUrl` slice
 * in production): Enter or click opens in a NEW tab, Ctrl/Cmd+Enter
 * retargets the CURRENT tab. Hits whose URL {@link isOpenableUrl} rejects
 * (javascript:, data:, …) render `aria-disabled` and refuse every open
 * gesture. Results run through `runQuery`, so the full filter syntax
 * (`tag:`, `folder:`, `in:`, `is:`, negation, quotes) works here too.
 *
 * Escape clears the query (returning to the save form); the active row is
 * scrolled into view so long result lists stay keyboard-navigable.
 */

const TOP_N = 10;

export interface PopupSearchProps {
  /** `null` until the lazy index build lands. */
  search: SearchIndexHandle | null;
  query: string;
  onQueryChange(query: string): void;
  onOpen(url: string, disposition: OpenUrlDisposition): void;
}

export function PopupSearch({
  search,
  query,
  onQueryChange,
  onOpen,
}: PopupSearchProps) {
  const listId = "popup-search-results";
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const [lastQuery, setLastQuery] = useState(query);

  const hits = useMemo<SearchHit[]>(() => {
    if (search === null || query === "") return [];
    return runQuery(search.index, query, search.ctx).hits.slice(0, TOP_N);
  }, [search, query]);

  // Adjust-during-render reset (same rule as the command palette): a new
  // query re-highlights the first hit, and an out-of-range index clamps.
  if (query !== lastQuery) {
    setLastQuery(query);
    setActive(0);
  } else if (active >= hits.length && hits.length > 0) {
    setActive(hits.length - 1);
  }

  const activeHit = hits[active];

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    optionRefs.current[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, hits]);

  const openHit = (hit: SearchHit, disposition: OpenUrlDisposition): void => {
    if (!isOpenableUrl(hit.url)) return;
    onOpen(hit.url, disposition);
  };

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(active + 1, hits.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(active - 1, 0));
    } else if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      onQueryChange("");
    } else if (event.key === "Enter" && activeHit !== undefined) {
      event.preventDefault();
      openHit(
        activeHit,
        event.ctrlKey || event.metaKey ? "current" : "foreground",
      );
    }
  };

  return (
    <div>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          role="combobox"
          aria-label="Search bookmarks"
          aria-expanded={query !== ""}
          aria-controls={listId}
          aria-activedescendant={
            activeHit === undefined ? undefined : `${listId}-${activeHit.id}`
          }
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search bookmarks…"
          className="h-9 w-full rounded-lg border border-transparent bg-secondary pr-8 pl-9 text-sm outline-hidden transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/30"
        />
        {query !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
            className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      {query !== "" &&
        (search === null ? (
          <p className="mt-3 px-1 text-xs text-muted-foreground">Indexing…</p>
        ) : hits.length === 0 ? (
          <p className="mt-3 px-1 text-xs text-muted-foreground">No matches.</p>
        ) : (
          <>
            <ul
              role="listbox"
              aria-label="Popup results"
              id={listId}
              className="mt-2 max-h-72 space-y-0.5 overflow-y-auto"
            >
              {hits.map((hit, index) => {
                const openable = isOpenableUrl(hit.url);
                const host = hostOf(hit.url);
                return (
                  <li
                    key={hit.id}
                    ref={(el) => {
                      optionRefs.current[index] = el;
                    }}
                    role="option"
                    id={`${listId}-${hit.id}`}
                    aria-selected={index === active}
                    aria-disabled={!openable}
                    data-url={hit.url}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => openHit(hit, "foreground")}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                      openable
                        ? "cursor-pointer"
                        : "cursor-not-allowed opacity-50",
                      index === active && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span aria-hidden="true" className="shrink-0">
                      <Favicon
                        pageUrl={hit.url}
                        size={16}
                        className="size-4 rounded-xs"
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm leading-tight font-medium">
                        {hit.title}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {host ?? hit.url}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 px-1 text-[11px] text-muted-foreground">
              ↑↓ navigate · Enter opens in a new tab · Ctrl/⌘ Enter opens here
            </p>
          </>
        ))}
    </div>
  );
}
