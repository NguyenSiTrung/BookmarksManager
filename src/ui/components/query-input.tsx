import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Ref } from "react";
import { suggestFilters } from "../../search/suggest";
import type { SuggestionSources } from "../../search/suggest";
import { cn } from "../lib/cn";

/**
 * QueryInput — the shared search-query input used by the side panel,
 * command palette, and popup (spec §3). Controlled: the parent owns `value`
 * and receives every edit through `onChange`.
 *
 * Autocomplete comes from the pure `suggestFilters` scanner: the token
 * under the caret yields filter-key or value completions, rendered as an
 * ARIA combobox (`role="combobox"` + `aria-expanded`/`aria-controls`/
 * `aria-activedescendant` on the input, `role="listbox"`/`option` popup).
 *
 * Keyboard contract:
 *  - ArrowDown/ArrowUp cycle the highlight (wrapping); ArrowDown on a
 *    dismissed-but-suggestable query reopens the popup.
 *  - Enter accepts the highlighted option — with no highlight it falls
 *    through so the surface can keep its own Enter behavior (e.g. the
 *    popup's "open first result").
 *  - Esc closes the popup first; once closed it forwards to `onEscape` so
 *    the surface decides (side panel clears, palette closes the dialog).
 *
 * Accepted suggestions splice via their `replaceFrom`/`replaceTo` span —
 * negation prefixes, quoting, and partial values are all handled inside
 * `suggestFilters`. The caret lands just past the inserted text.
 */
export interface QueryInputProps {
  value: string;
  onChange(value: string): void;
  /** Live tag/folder vocabularies; `suggestFilters` owns the rest. */
  sources?: SuggestionSources;
  /** Called when Esc arrives with the suggestion popup already closed. */
  onEscape?: () => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  placeholder?: string;
  id?: string;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

const EMPTY_SOURCES: SuggestionSources = { tags: [], folders: [] };

export function QueryInput({
  value,
  onChange,
  sources = EMPTY_SOURCES,
  onEscape,
  className,
  ref,
  ...rest
}: QueryInputProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [caret, setCaret] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  /** Caret to apply after the next render — set when a suggestion is spliced. */
  const pendingCaret = useRef<number | null>(null);

  const suggestions = useMemo(
    () => suggestFilters(value, caret, sources),
    [value, caret, sources],
  );
  const open = focused && !dismissed && suggestions.length > 0;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el !== null && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const setRefs = (el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };

  const syncCaret = (el: HTMLInputElement) => {
    const pos = el.selectionStart ?? el.value.length;
    setCaret(pos);
  };

  const accept = (index: number) => {
    const s = suggestions[index];
    const el = inputRef.current;
    if (!s || !el) return;
    const next =
      value.slice(0, s.replaceFrom) +
      s.insertText +
      value.slice(s.replaceTo);
    pendingCaret.current = s.replaceFrom + s.insertText.length;
    setActiveIndex(-1);
    onChange(next);
  };

  return (
    <div className="relative">
      <input
        {...rest}
        ref={setRefs}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${listId}-opt-${activeIndex}`
            : undefined
        }
        value={value}
        onFocus={(e) => {
          setFocused(true);
          syncCaret(e.target);
        }}
        onBlur={() => {
          setFocused(false);
          setActiveIndex(-1);
        }}
        onChange={(e) => {
          setDismissed(false);
          syncCaret(e.target);
          onChange(e.target.value);
        }}
        onSelect={(e) => syncCaret(e.target as HTMLInputElement)}
        onKeyUp={(e) => syncCaret(e.target as HTMLInputElement)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (open || suggestions.length > 0) {
              e.preventDefault();
              setDismissed(false);
              const n = suggestions.length;
              setActiveIndex((prev) =>
                e.key === "ArrowDown"
                  ? (prev + 1) % n
                  : prev <= 0
                    ? n - 1
                    : prev - 1,
              );
            }
            return;
          }
          if (e.key === "Enter") {
            if (open && activeIndex >= 0) {
              e.preventDefault();
              accept(activeIndex);
            }
            return;
          }
          if (e.key === "Escape") {
            if (open) {
              e.stopPropagation();
              e.preventDefault();
              setDismissed(true);
              setActiveIndex(-1);
            } else {
              onEscape?.();
            }
          }
        }}
        className={cn(
          "w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={`${s.kind}:${s.key}:${s.label}`}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                // preventDefault keeps focus in the input through the click.
                e.preventDefault();
                accept(i);
              }}
              className={cn(
                "cursor-default rounded-sm px-2 py-1",
                i === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              {s.kind === "key" ? (
                <span className="font-medium">{s.label}</span>
              ) : (
                s.label
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
