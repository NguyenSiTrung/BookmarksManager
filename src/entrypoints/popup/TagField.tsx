import { useRef } from "react";
import { TagIcon } from "../../ui/components/icons";
import { TagChip } from "../../ui/components/tag-chip";

/**
 * One tag field for the quick-save popup: staged chips and the text input
 * share a single bordered box, so tagging reads as one gesture instead of a
 * chip list, an input and a button.
 *
 * Enter or "," commits the typed text, Backspace on an empty input removes
 * the last chip, and clicking anywhere in the box focuses the input. The
 * explicit "Add tag" button only appears while there is text to add, so it
 * never competes with Save for attention but stays reachable for pointer and
 * assistive-tech users.
 */

export interface TagFieldChip {
  key: string;
  label: string;
}

export interface TagFieldProps {
  chips: readonly TagFieldChip[];
  input: string;
  disabled?: boolean;
  onInputChange(value: string): void;
  /** Commit the current input as a chip (the parent trims and dedupes). */
  onCommit(): void;
  onRemove(key: string): void;
}

export function TagField({
  chips,
  input,
  disabled = false,
  onInputChange,
  onCommit,
  onRemove,
}: TagFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const last = chips[chips.length - 1];

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 py-1.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
    >
      <TagIcon className="size-4 shrink-0 text-muted-foreground" />
      {chips.map((chip) => (
        <TagChip
          key={chip.key}
          name={chip.label}
          className="border-transparent bg-accent text-accent-foreground"
          onRemove={disabled ? undefined : () => onRemove(chip.key)}
        />
      ))}
      <input
        ref={inputRef}
        aria-label="New tag name"
        // TagDef.name is capped at 64 chars — bound typing at the source so a
        // long paste never reaches the worker as a malformed message.
        maxLength={64}
        placeholder={chips.length === 0 ? "Add tags…" : ""}
        value={input}
        disabled={disabled}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            // Ctrl/Cmd+Enter is the form-level "save" shortcut; let it bubble.
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              return;
            }
            event.preventDefault();
            onCommit();
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
          onClick={onCommit}
          disabled={disabled}
          className="rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Add
        </button>
      )}
    </div>
  );
}
