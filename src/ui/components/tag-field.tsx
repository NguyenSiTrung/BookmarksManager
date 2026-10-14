import { useId, useMemo, useRef, useState } from "react";
import { tagNameKey } from "../../schemas/meta";
import type { TagDef } from "../../schemas/meta";
import { cn } from "../lib/cn";
import { TagIcon } from "./icons";
import { TagChip } from "./tag-chip";

/**
 * Shared TagField for quick-save popup and bookmark editing dialogs: staged
 * chips and the text input share a single bordered box, with an optional
 * `availableTags` combobox autocomplete dropdown.
 *
 * Keyboard & pointer contract:
 *  - Typing with `availableTags` (or pressing ArrowDown) opens matching
 *    unselected tag suggestions showing each tag's color dot and display name.
 *  - ArrowDown / ArrowUp navigate suggestions; Enter or MouseDown commits the
 *    highlighted suggestion chip and clears the input.
 *  - When no suggestion is highlighted, Enter or "," commits the raw typed text.
 *  - Escape closes the suggestion list without losing input focus or bubbling
 *    to parent dialogs.
 *  - Backspace on an empty input removes the last chip.
 */

export interface TagFieldChip {
  key: string;
  label: string;
  color?: string;
}

export interface TagFieldProps {
  chips: readonly TagFieldChip[];
  input: string;
  disabled?: boolean;
  /** Optional defined tags for combobox autocomplete and chip color lookup. */
  availableTags?: readonly TagDef[];
  onInputChange(value: string): void;
  /** Commit the current input (or an explicit suggestion label) as a chip. */
  onCommit(label?: string): void;
  onRemove(key: string): void;
}

const EMPTY_AVAILABLE_TAGS: readonly TagDef[] = [];

export function TagField({
  chips,
  input,
  disabled = false,
  availableTags = EMPTY_AVAILABLE_TAGS,
  onInputChange,
  onCommit,
  onRemove,
}: TagFieldProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const last = chips[chips.length - 1];

  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [arrowOpened, setArrowOpened] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const colorByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const tag of availableTags) {
      if (tag.color !== undefined) {
        map.set(tag.nameKey, tag.color);
      }
    }
    return map;
  }, [availableTags]);

  const selectedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const chip of chips) {
      set.add(chip.key.toLowerCase());
      const norm = tagNameKey(chip.label);
      if (norm !== "") set.add(norm);
    }
    return set;
  }, [chips]);

  const suggestions = useMemo(() => {
    if (availableTags.length === 0) return [];
    const query = input.trim().toLowerCase();
    const unselected = availableTags.filter(
      (tag) => !selectedKeys.has(tag.nameKey),
    );
    if (query === "") return unselected;
    const prefixMatches: TagDef[] = [];
    const substringMatches: TagDef[] = [];
    for (const tag of unselected) {
      const lowerName = tag.name.toLowerCase();
      if (lowerName.startsWith(query) || tag.nameKey.startsWith(query)) {
        prefixMatches.push(tag);
      } else if (lowerName.includes(query) || tag.nameKey.includes(query)) {
        substringMatches.push(tag);
      }
    }
    return [...prefixMatches, ...substringMatches];
  }, [availableTags, input, selectedKeys]);

  const open =
    !disabled &&
    focused &&
    !dismissed &&
    (input.trim() !== "" || arrowOpened) &&
    suggestions.length > 0;

  const clampedIndex =
    open && activeIndex >= 0 && activeIndex < suggestions.length
      ? activeIndex
      : -1;

  const acceptSuggestion = (tag: TagDef): void => {
    setActiveIndex(-1);
    setArrowOpened(false);
    setDismissed(false);
    onInputChange("");
    onCommit(tag.name);
  };

  return (
    <div className="relative">
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-1.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
      >
        <TagIcon className="size-4 shrink-0 text-muted-foreground" />
        {chips.map((chip) => {
          const resolvedColor =
            chip.color ??
            colorByKey.get(chip.key) ??
            colorByKey.get(tagNameKey(chip.label));
          return (
            <TagChip
              key={chip.key}
              name={chip.label}
              {...(resolvedColor !== undefined ? { color: resolvedColor } : {})}
              className="border-transparent bg-accent text-accent-foreground"
              {...(disabled ? {} : { onRemove: () => onRemove(chip.key) })}
            />
          );
        })}
        <input
          ref={inputRef}
          aria-label="New tag name"
          aria-expanded={open ? true : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            clampedIndex >= 0 ? `${listId}-opt-${clampedIndex}` : undefined
          }
          // TagDef.name is capped at 64 chars — bound typing at the source so a
          // long paste never reaches the worker as a malformed message.
          maxLength={64}
          placeholder={chips.length === 0 ? "Add tags…" : ""}
          value={input}
          disabled={disabled}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={() => {
            setFocused(false);
            setArrowOpened(false);
            setActiveIndex(-1);
          }}
          onChange={(event) => {
            setDismissed(false);
            setActiveIndex(-1);
            onInputChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (suggestions.length > 0) {
                event.preventDefault();
                setDismissed(false);
                setArrowOpened(true);
                const count = suggestions.length;
                setActiveIndex((prev) =>
                  event.key === "ArrowDown"
                    ? (prev + 1) % count
                    : prev <= 0
                      ? count - 1
                      : prev - 1,
                );
              }
              return;
            }
            if (event.key === "Escape") {
              if (open) {
                event.preventDefault();
                event.stopPropagation();
                setDismissed(true);
                setArrowOpened(false);
                setActiveIndex(-1);
              }
              return;
            }
            if (event.key === "Enter" || event.key === ",") {
              // Ctrl/Cmd+Enter is the form-level "save" shortcut; let it bubble.
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                return;
              }
              event.preventDefault();
              if (
                event.key === "Enter" &&
                clampedIndex >= 0 &&
                suggestions[clampedIndex] !== undefined
              ) {
                acceptSuggestion(suggestions[clampedIndex]);
              } else {
                setActiveIndex(-1);
                setArrowOpened(false);
                onCommit();
              }
            } else if (
              event.key === "Backspace" &&
              input === "" &&
              last !== undefined
            ) {
              onRemove(last.key);
            }
          }}
          className="min-w-24 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:opacity-50"
        />
        {input.trim() !== "" && (
          <button
            type="button"
            aria-label="Add tag"
            onClick={(event) => {
              event.stopPropagation();
              setActiveIndex(-1);
              setArrowOpened(false);
              onCommit();
            }}
            disabled={disabled}
            className="rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Add
          </button>
        )}
      </div>
      {open && (
        <ul
          id={listId}
          data-testid="tag-field-suggestions"
          role="listbox"
          aria-label="Tag suggestions"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-44 overflow-y-auto rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-md"
        >
          {suggestions.map((tag, index) => (
            <li
              key={tag.nameKey}
              id={`${listId}-opt-${index}`}
              role="option"
              aria-selected={index === clampedIndex}
              onMouseDown={(event) => {
                // Keep focus inside the input through suggestion click.
                event.preventDefault();
                acceptSuggestion(tag);
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 select-none hover:bg-accent hover:text-accent-foreground",
                index === clampedIndex && "bg-accent text-accent-foreground",
              )}
            >
              <span
                aria-hidden="true"
                data-tag-dot=""
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  tag.color === undefined && "bg-muted-foreground",
                )}
                style={
                  tag.color === undefined
                    ? undefined
                    : { backgroundColor: tag.color }
                }
              />
              <span className="truncate font-medium">{tag.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
