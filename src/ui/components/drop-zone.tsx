import { useRef, useState } from "react";
import type { DragEvent, ReactElement } from "react";
import { cn } from "../lib/cn";
import { FileImportIcon } from "./icons";

/**
 * Drop zone — a dashed-border target that routes ONE picked-or-dropped file
 * to `onFile`. The real `<input type="file">` stays inside, `sr-only` (a
 * 1px visible box, so Playwright's `toBeVisible()` and `setInputFiles`
 * keep working) and `aria-hidden` + `tabIndex={-1}` (the button is the
 * keyboard path). Drag state is visual only: `dragover` arms the
 * highlight, `dragleave`/`drop` disarm it. The button carries an explicit
 * `aria-label` with the primary line so its accessible name stays exactly
 * that — the visible hint would otherwise be concatenated into the name.
 * The zone does NOT filter file types — callers own any validation in
 * `onFile`.
 */
export interface DropZoneProps {
  /** Idle primary line, e.g. "Drop your bookmarks file here". */
  readonly label: string;
  /** Primary line while a drag is over the zone, e.g. "Drop to import". */
  readonly activeLabel: string;
  /** Secondary line under the label. */
  readonly hint?: string;
  /** Passed to the input's `accept` — filters the picker, not drops. */
  readonly accept?: string;
  /** `data-testid` for the hidden input (e2e `setInputFiles`). */
  readonly inputTestId?: string;
  /** Exactly one file, picked or dropped. */
  readonly onFile: (file: File) => void;
}

export function DropZone({
  label,
  activeLabel,
  hint,
  accept,
  inputTestId,
  onFile,
}: DropZoneProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const file = event.dataTransfer?.files[0];
    if (file !== undefined) onFile(file);
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-label={dragging ? activeLabel : label}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6",
          "outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
          dragging
            ? "border-primary bg-accent/50"
            : "border-input hover:border-primary/50 hover:bg-accent/40",
        )}
      >
        <FileImportIcon className="size-6 text-muted-foreground" />
        <span className="text-sm font-medium">
          {dragging ? activeLabel : label}
        </span>
        {hint !== undefined && (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        aria-hidden="true"
        tabIndex={-1}
        data-testid={inputTestId}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so picking the same file twice still fires change.
          event.target.value = "";
          if (file !== undefined) onFile(file);
        }}
        className="sr-only"
      />
    </div>
  );
}
