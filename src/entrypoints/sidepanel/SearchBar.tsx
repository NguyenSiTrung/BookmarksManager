import type { Ref } from "react";
import { parseQuery } from "../../search/query";
import type { SuggestionSources } from "../../search/suggest";
import { QueryInput } from "../../ui/components/query-input";

/**
 * Side-panel search bar (spec §4): the input above the bookmark list.
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
 */
export interface SearchBarProps {
  value: string;
  onChange(value: string): void;
  /** `null` while the search index is still building. */
  resultCount: number | null;
  /** Tag/folder vocabularies for query autocomplete. */
  sources: SuggestionSources;
  ref?: Ref<HTMLInputElement>;
}

export function SearchBar({
  value,
  onChange,
  resultCount,
  sources,
  ref,
}: SearchBarProps) {
  const warnings = value === "" ? [] : parseQuery(value).warnings;
  return (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <QueryInput
        ref={ref}
        aria-label="Search bookmarks"
        placeholder="Search — / to focus, Esc to clear"
        value={value}
        onChange={onChange}
        sources={sources}
        onEscape={() => onChange("")}
      />
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
