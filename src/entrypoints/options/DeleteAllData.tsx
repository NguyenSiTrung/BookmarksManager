import { useState } from "react";
import {
  DELETE_ALL_DATABASE_BLOCKED_MESSAGE,
  DELETE_ALL_DONE_MESSAGE,
  DELETE_ALL_ITEMS,
  DELETE_ALL_PERMISSIONS_FAILED_NOTICE,
  NATIVE_BOOKMARKS_NOTICE,
  deleteAllExtensionData,
} from "../../security/delete-all";
import type { DeleteAllOptions, DeleteAllResult } from "../../security/delete-all";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import {
  dangerButtonClass,
  dangerCardClass,
  insetClass,
  secondaryButtonClass,
  sectionHeadingClass,
} from "./ui";
import { Alert } from "./components";
import { TrashIcon, WarningIcon } from "../../ui/components/icons";

/**
 * "Delete all extension data" section of the Options page (PROJECT_PLAN.md
 * §12). A single button opens a confirm dialog that LISTS everything the
 * operation removes and states plainly that native Chrome bookmarks are
 * untouched; confirming runs {@link deleteAllExtensionData} and, on success,
 * replaces the section with the first-run state.
 *
 * The dialog stays dismissible while the reset runs (Cancel is never
 * disabled): the operation is idempotent and safe to leave running, and the
 * result is reported by the section once it lands. That matters because the
 * reset can legitimately take a few seconds — it waits for other extension
 * contexts to release the shared IndexedDB database (see
 * `src/security/delete-all.ts`), and reports a typed partial failure rather
 * than hanging when a context refuses.
 *
 * Partial failures are never hidden behind the success line: a database that
 * could not be dropped, or a granted host permission that could not be
 * released, renders as a warning naming what is left behind (and the exact
 * origins, so they can be revoked at chrome://extensions).
 *
 * The reset closes the shared Dexie connection, so the page cannot keep using
 * IndexedDB afterwards — the first-run panel tells the user to reload, which
 * recreates a clean database on next use.
 */
export function DeleteAllData(props?: { deleteOptions?: DeleteAllOptions }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeleteAllResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void deleteAllExtensionData(props?.deleteOptions)
      .then((outcome) => {
        setResult(outcome);
        setOpen(false);
      })
      .catch(() => {
        setError("Something went wrong while deleting the extension data.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  /**
   * Dismissal is always allowed, including mid-operation: the reset keeps
   * running and reports into the section when it finishes.
   */
  const handleOpenChange = (next: boolean) => {
    if (!next) setError(null);
    setOpen(next);
  };

  if (result !== null) {
    return (
      <section
        aria-labelledby="delete-all-heading"
        className={dangerCardClass}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
            <WarningIcon className="size-4" />
          </span>
          <h2 id="delete-all-heading" className={sectionHeadingClass}>
            Delete all extension data
          </h2>
        </div>
        {result.databaseDeleted ? (
          <div className="mt-3">
            <Alert tone="success">{DELETE_ALL_DONE_MESSAGE}</Alert>
          </div>
        ) : (
          <div className="mt-3">
            <Alert tone="error">{DELETE_ALL_DATABASE_BLOCKED_MESSAGE}</Alert>
          </div>
        )}
        {result.permissionsFailed.length > 0 && (
          <div
            role="alert"
            className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <p>{DELETE_ALL_PERMISSIONS_FAILED_NOTICE}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {result.permissionsFailed.map((origin) => (
                <li key={origin}>{origin}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          Reload the Options page to start fresh. Your native Chrome bookmarks
          are untouched.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="delete-all-heading"
      className={dangerCardClass}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
          <WarningIcon className="size-4" />
        </span>
        <h2 id="delete-all-heading" className={sectionHeadingClass}>
          Delete all extension data
        </h2>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Permanently remove everything this extension stored on this device.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`mt-4 ${dangerButtonClass}`}
      >
        <TrashIcon className="size-4" />
        Delete all extension data
      </button>

      {/*
        The dialog is dismissible mid-operation, so a failure that lands after
        the user closed it still has to be visible somewhere.
      */}
      {error !== null && !open && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all extension data?</DialogTitle>
            <DialogDescription>
              This permanently deletes the extension&apos;s local data. It
              cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div>
            <p className="text-sm font-medium">This will delete:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {DELETE_ALL_ITEMS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <p className={insetClass}>
            {NATIVE_BOOKMARKS_NOTICE}
          </p>

          {error !== null && <Alert tone="error">{error}</Alert>}

          <DialogFooter>
            <DialogClose asChild>
              <button type="button" className={secondaryButtonClass}>
                Cancel
              </button>
            </DialogClose>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className={dangerButtonClass}
            >
              {busy ? "Deleting…" : "Delete everything"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
