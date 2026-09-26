import { useMemo, useState } from "react";
import { patchMeta } from "../../db/meta";
import { Category } from "../../schemas/bookmark";
import { tagNameKey } from "../../schemas/meta";
import type { BookmarkMeta } from "../../schemas/meta";
import { moveNode, renameFolder, updateBookmark } from "../../sync/mutations";
import type { FlattenedTree, TreeEntry } from "../../sync/tree";
import { bulkAddTag } from "../../sync/tag-ops";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import { folderDestinations, moveDeniedIds } from "./MoveToDialog";
import { errorMessage, useToast } from "./UndoToast";

/**
 * Edit dialog for a bookmark OR a folder: title, url (bookmarks only), the
 * parent folder, tag chips, category and notes.
 *
 *  - **Save is staged, one write path per field group.** Title/url go through
 *    `updateBookmark` (or `renameFolder` for a folder), a changed parent
 *    through `moveNode`, and tags/category/notes through ONE `patchMeta`
 *    (merge semantics: `null` clears). Chrome is written first, then the
 *    metadata sidecar — the same order the mutation service documents.
 *  - **Tag chips resolve-or-create defs on demand.** Chips stage display
 *    names locally; on Save each one runs through `bulkAddTag`, which
 *    resolves the case-insensitive `nameKey` and creates the definition when
 *    it is new, then the final `patchMeta` writes the exact staged key list
 *    (so removed chips are dropped and the stored order is the visible one).
 *  - **Parent picker deny list.** Managed folders are disabled, and when the
 *    target is a folder its own subtree is disabled too (`moveDeniedIds`) —
 *    the same deny list the "Move to…" dialog uses.
 *  - **Failure keeps the dialog open** with the typed message inline (and in
 *    the toast) so the user can correct the input.
 */

/** One staged tag chip: the storage key plus the display name. */
interface TagChip {
  key: string;
  label: string;
}

export interface EditDialogProps {
  /** The node being edited; `null` while closed. */
  target: TreeEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tree: FlattenedTree;
  /** The target's current meta row, when it has one. */
  meta?: BookmarkMeta;
  /** Tag display names keyed by nameKey (falls back to the key). */
  tagNameByKey?: ReadonlyMap<string, string>;
}

export function EditDialog({
  target,
  open,
  onOpenChange,
  tree,
  meta,
  tagNameByKey,
}: EditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {target !== null && (
          <EditForm
            key={target.id}
            target={target}
            tree={tree}
            meta={meta}
            tagNameByKey={tagNameByKey}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({
  target,
  tree,
  meta,
  tagNameByKey,
  onClose,
}: {
  target: TreeEntry;
  tree: FlattenedTree;
  meta?: BookmarkMeta;
  tagNameByKey?: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const toast = useToast();
  const isBookmark = target.kind === "bookmark";
  const [title, setTitle] = useState(target.title);
  const [url, setUrl] = useState(isBookmark ? target.url : "");
  const [parentId, setParentId] = useState(target.parentId ?? "");
  const [chips, setChips] = useState<TagChip[]>(() =>
    (meta?.tags ?? []).map((key) => ({
      key,
      label: tagNameByKey?.get(key) ?? key,
    })),
  );
  const [tagInput, setTagInput] = useState("");
  const [category, setCategory] = useState<Category | "">(
    meta?.category ?? "",
  );
  const [notes, setNotes] = useState(meta?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destinations = useMemo(() => folderDestinations(tree), [tree]);
  const denied = useMemo(
    () => moveDeniedIds(tree, [target.id]),
    [tree, target.id],
  );

  const addChip = (): void => {
    const label = tagInput.trim();
    const key = tagNameKey(label);
    if (key === "" || chips.some((chip) => chip.key === key)) return;
    setChips([...chips, { key, label }]);
    setTagInput("");
  };

  const removeChip = (key: string): void => {
    setChips(chips.filter((chip) => chip.key !== key));
  };

  const displayName =
    title !== ""
      ? title
      : isBookmark
        ? url
        : "Untitled folder";

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // 1. Chrome tree writes (the metadata sidecar must not get ahead).
      if (target.kind === "bookmark") {
        if (title !== target.title || url !== target.url) {
          await updateBookmark(target.id, { title, url });
        }
      } else if (title !== target.title) {
        await renameFolder(target.id, title);
      }
      if (parentId !== "" && parentId !== target.parentId) {
        await moveNode(target.id, { parentId });
      }
      // 2. Tag definitions — resolve-or-create through tag-ops.
      for (const chip of chips) {
        const result = await bulkAddTag([target.id], chip.label);
        if (!result.ok) throw new Error(result.message);
      }
      // 3. One meta merge: exact staged tags, category/notes (null clears).
      await patchMeta(target.id, {
        tags: chips.map((chip) => chip.key),
        category: category === "" ? null : category,
        notes: notes === "" ? null : notes,
      });
      toast.showToast({ message: `Saved “${displayName}”.` });
      onClose();
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.showToast({ message, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit {isBookmark ? "bookmark" : "folder"}</DialogTitle>
        <DialogDescription>
          {displayName} — changes apply when you save.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="edit-title" className="text-sm font-medium">
            Title
          </label>
          <input
            id="edit-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
        {isBookmark && (
          <div className="space-y-1">
            <label htmlFor="edit-url" className="text-sm font-medium">
              URL
            </label>
            <input
              id="edit-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        )}
        <div className="space-y-1">
          <label htmlFor="edit-folder" className="text-sm font-medium">
            Folder
          </label>
          <select
            id="edit-folder"
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {destinations.map((dest) => (
              <option
                key={dest.id}
                value={dest.id}
                disabled={dest.isManaged || denied.has(dest.id)}
              >
                {dest.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <span className="text-sm font-medium" id="edit-tags-label">
            Tags
          </span>
          <div
            aria-labelledby="edit-tags-label"
            className="flex flex-wrap items-center gap-1 rounded-md border border-input p-2"
          >
            {chips.length === 0 && (
              <span className="text-xs text-muted-foreground">No tags</span>
            )}
            {chips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs"
              >
                {chip.label}
                <button
                  type="button"
                  aria-label={`Remove tag ${chip.label}`}
                  onClick={() => removeChip(chip.key)}
                  className="rounded-sm text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <input
              aria-label="New tag name"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addChip();
                }
              }}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={addChip}
              disabled={tagInput.trim() === ""}
              className="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              Add tag
            </button>
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="edit-category" className="text-sm font-medium">
            Category
          </label>
          <select
            id="edit-category"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as Category | "")
            }
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">No category</option>
            {Category.options.map((option) => (
              <option key={option} value={option}>
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="edit-notes" className="text-sm font-medium">
            Notes
          </label>
          <textarea
            id="edit-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || (isBookmark && url.trim() === "")}
          onClick={() => void handleSave()}
          className={
            "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
            "text-primary-foreground disabled:opacity-50"
          }
        >
          Save
        </button>
      </DialogFooter>
    </>
  );
}
