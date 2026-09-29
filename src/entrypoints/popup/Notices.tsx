import { CheckIcon, WarningIcon } from "../../ui/components/icons";

/**
 * Status surfaces for the quick-save popup. Each one carries the same
 * `data-testid` / ARIA role the previous inline markup did, so assistive tech
 * and the test suites address them unchanged.
 */

const secondaryButton =
  "shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/** Shown BEFORE saving when the typed URL already exists in the tree. */
export function DuplicateNotice({
  location,
  onEdit,
}: {
  /** Display path of the existing bookmark, e.g. "Bookmarks bar / Dev". */
  location: string;
  onEdit(): void;
}) {
  return (
    <div
      data-testid="duplicate-notice"
      role="status"
      className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200"
    >
      <WarningIcon className="size-4 shrink-0" />
      <p className="min-w-0 flex-1 text-xs leading-snug">
        Already saved in {location}
      </p>
      <button type="button" onClick={onEdit} className={secondaryButton}>
        Edit that bookmark
      </button>
    </div>
  );
}

/**
 * Replaces the Save button once the bookmark exists. Editing the bookmark it
 * just wrote goes through the same side-panel handoff as the duplicate notice.
 */
export function SaveSuccess({
  folder,
  onEdit,
}: {
  folder: string;
  onEdit(): void;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-emerald-600/30 bg-emerald-500/10 px-3 py-2.5 text-emerald-900 dark:text-emerald-200">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full bg-emerald-600 text-white"
      >
        <CheckIcon className="size-3.5" />
      </span>
      <p
        data-testid="save-confirmation"
        role="status"
        className="min-w-0 flex-1 text-sm leading-snug font-medium"
      >
        Saved to {folder}.
      </p>
      <button type="button" onClick={onEdit} className={secondaryButton}>
        Edit that bookmark
      </button>
    </div>
  );
}

export function ErrorAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive"
    >
      <WarningIcon className="mt-px size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
    </p>
  );
}
