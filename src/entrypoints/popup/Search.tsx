import { useMemo, useRef, useState } from "react";
import { isOpenableUrl } from "../../search/openable";
import { runQuery } from "../../search/run";
import type { SearchIndexHandle } from "../../search/run";
import type { SearchHit } from "../../search/index";
import type { OpenUrlDisposition } from "../../sync/tabs";

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
    } else if (event.key === "Enter" && activeHit !== undefined) {
      event.preventDefault();
      openHit(
        activeHit,
        event.ctrlKey || event.metaKey ? "current" : "foreground",
      );
    }
  };

  return (
    <div className="mt-3">
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
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      />

      {query !== "" &&
        (search === null ? (
          <p className="mt-2 text-xs text-muted-foreground">Indexing…</p>
        ) : hits.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">No matches.</p>
        ) : (
          <ul
            role="listbox"
            aria-label="Popup results"
            id={listId}
            className="mt-2 max-h-64 overflow-y-auto rounded-md border border-border"
          >
            {hits.map((hit, index) => {
              const openable = isOpenableUrl(hit.url);
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
                  className={`flex flex-col gap-0.5 px-2 py-1.5 text-left ${
                    openable ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                  } ${index === active ? "bg-accent" : ""}`}
                >
                  <span className="truncate text-sm">{hit.title}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {hit.url}
                  </span>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}
