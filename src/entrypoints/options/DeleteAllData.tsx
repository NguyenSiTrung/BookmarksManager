import { useState } from "react";
import {
  DELETE_ALL_DONE_MESSAGE,
  DELETE_ALL_ITEMS,
  NATIVE_BOOKMARKS_NOTICE,
  deleteAllExtensionData,
} from "../../security/delete-all";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";

/**
 * "Delete all extension data" section of the Options page (PROJECT_PLAN.md
 * §12). A single button opens a confirm dialog that LISTS everything the
 * operation removes and states plainly that native Chrome bookmarks are
 * untouched; confirming runs {@link deleteAllExtensionData} and, on success,
 * replaces the section with the first-run state.
 *
 * The reset closes the shared Dexie connection, so the page cannot keep using
 * IndexedDB afterwards — the first-run panel tells the user to reload, which
 * recreates a clean database on next use.
 */
const dangerButtonClass =
  "inline-flex items-center justify-center rounded-md bg-red-600 px-3 py-1 " +
  "text-sm font-medium text-white shadow-xs hover:bg-red-700 " +
  "focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-hidden " +
  "disabled:pointer-events-none disabled:opacity-50";

const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-md border border-gray-300 " +
  "bg-white px-4 py-2 text-sm font-medium text-gray-800 shadow-xs " +
  "hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-gray-400 " +
  "focus-visible:outline-hidden";

export function DeleteAllData() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void deleteAllExtensionData()
      .then(() => {
        setDone(true);
        setOpen(false);
      })
      .catch(() => {
        setError("Something went wrong while deleting the extension data.");
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next) setError(null);
    setOpen(next);
  };

  if (done) {
    return (
      <section
        aria-labelledby="delete-all-heading"
        className="mx-auto max-w-xl p-6"
      >
        <h2 id="delete-all-heading" className="text-lg font-medium">
          Delete all extension data
        </h2>
        <p role="status" className="mt-2 text-sm text-green-700">
          {DELETE_ALL_DONE_MESSAGE}
        </p>
        <p className="mt-1 text-sm text-gray-700">
          Reload the Options page to start fresh. Your native Chrome bookmarks
          are untouched.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="delete-all-heading"
      className="mx-auto max-w-xl p-6"
    >
      <h2 id="delete-all-heading" className="text-lg font-medium">
        Delete all extension data
      </h2>
      <p className="mt-1 text-sm text-gray-700">
        Permanently remove everything this extension stored on this device.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`mt-3 ${dangerButtonClass}`}
      >
        Delete all extension data
      </button>

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

          <p className="rounded border border-gray-300 bg-gray-50 p-3 text-sm">
            {NATIVE_BOOKMARKS_NOTICE}
          </p>

          {error !== null && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <button
                type="button"
                disabled={busy}
                className={secondaryButtonClass}
              >
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
