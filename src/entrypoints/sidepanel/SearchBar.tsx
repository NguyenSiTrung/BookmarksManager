import type { Ref } from "react";
import { parseQuery } from "../../search/query";
import type { SuggestionSources } from "../../search/suggest";
import { QueryInput } from "../../ui/components/query-input";
import { askNoteText, useAskSearch } from "./ask";

/**
 * Side-panel search bar (spec §4, FR10): the input above the bookmark list.
 *
 * - A non-empty `value` puts the app in the `search` view; clearing returns
 *   to the previous view (the App derives the view, this component is
 *   controlled).
 * - `Esc` inside the input clears the query and keeps focus.
 * - The `/` shortcut that focuses this input lives in App (it needs the
 *   global keydown listener); the input element is exposed through `ref`.
 * - Parser warnings render inline under the input; the result count is a
 *   `role="status"` live region so screen readers hear it change per
 *   keystroke. `resultCount === null` while the index is still building
 *   (shows "Indexing…").
 * - **Ask (FR10, P4.T5).** When a provider holds `jev_decisions` consent, a
 *   `role="switch"` toggle appears beside the input. Switched on, it
 *   reranks the settled query through the worker's RERANK intent and
 *   reports the reranked bookmark-id order via the OPTIONAL
 *   {@link SearchBarProps.onRerankOrder} callback (`null` = local order);
 *   its quiet per-query note ("Asking Jev…" / "Ranked by Ask." / the
 *   no-match state / not-sent / redacted errors) renders as a second
 *   `role="status"` line. With the prop absent — the current App call
 *   site — the toggle and notes still render and the search path is
 *   byte-for-byte the old, purely local one: zero runtime messages.
 *   (See `./ask.tsx` for the debounce, consent, and stale-reply rules.)
 */
export interface SearchBarProps {
  value: string;
  onChange(value: string): void;
  /** `null` while the search index is still building. */
  resultCount: number | null;
  /** Tag/folder vocabularies for query autocomplete. */
  sources: SuggestionSources;
  ref?: Ref<HTMLInputElement>;
  /**
   * P4.T5 (optional; absent at the current App call site): receives the
   * Ask-reranked bookmark-id order (`results[].id` from the RERANK reply,
   * already local ids, probability-descending) whenever a rerank lands,
   * and `null` whenever the local relevance order applies — Ask off, query
   * cleared/changed (pending rerank), nothing sent, or an error. Wire it
   * in App to reorder the `search` view's item list; ids that no longer
   * resolve against the tree are the caller's concern.
   */
  onRerankOrder?: (ids: readonly string[] | null) => void;
  /** Debounce milliseconds for Ask rerank (defaults to ASK_DEBOUNCE_MS). */
  askDebounceMs?: number;
  }

  export function SearchBar({
  value,
  onChange,
  resultCount,
  sources,
  ref,
  onRerankOrder,
  askDebounceMs,
  }: SearchBarProps) {
  const warnings = value === "" ? [] : parseQuery(value).warnings;
  const ask = useAskSearch(value, onRerankOrder, askDebounceMs);
  const askText = ask.askOn ? askNoteText(ask.note) : null;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <QueryInput
            ref={ref}
            aria-label="Search bookmarks"
            placeholder="Search — / to focus, Esc to clear"
            value={value}
            onChange={onChange}
            sources={sources}
            onEscape={() => onChange("")}
          />
        </div>
        {ask.consent && (
          <button
            type="button"
            role="switch"
            aria-checked={ask.askOn}
            onClick={ask.toggleAsk}
            title="Rerank results with the consented analysis provider"
            className="shrink-0 rounded-sm px-2 py-1 text-xs text-muted-foreground outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-primary aria-checked:text-primary-foreground"
          >
            Ask
          </button>
        )}
      </div>
      {askText !== null && (
        <p
          role="status"
          aria-live="polite"
          data-testid="ask-status"
          className="mt-1 text-xs text-muted-foreground"
        >
          {askText}
        </p>
      )}
      {value !== "" && (
        <p
          role="status"
          aria-live="polite"
          data-testid="search-status"
          className="mt-1 text-xs text-muted-foreground"
        >
          {resultCount === null
            ? "Indexing…"
            : `${resultCount} ${resultCount === 1 ? "result" : "results"}`}
        </p>
      )}
      {warnings.length > 0 && (
        <ul
          data-testid="search-warnings"
          className="mt-1 space-y-0.5 text-xs text-amber-600 dark:text-amber-400"
        >
          {warnings.map((warning, i) => (
            <li key={`${warning.token}-${i}`}>{warning.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
