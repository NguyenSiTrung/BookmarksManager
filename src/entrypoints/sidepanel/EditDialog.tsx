import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { listTags, patchMeta } from "../../db/meta";
import type { MetaPatch } from "../../db/meta";
import { Category } from "../../schemas/bookmark";
import { NOTES_MAX_LENGTH, tagNameKey } from "../../schemas/meta";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import { moveNode, renameFolder, updateBookmark } from "../../sync/mutations";
import type { FlattenedTree, TreeEntry } from "../../sync/tree";
import { bulkAddTag, bulkRemoveTag } from "../../sync/tag-ops";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import { TagField } from "../../ui/components/tag-field";
import type { TagFieldChip } from "../../ui/components/tag-field";
import { folderDestinations, moveDeniedIds } from "./MoveToDialog";
import { errorMessage, useToast } from "./UndoToast";

/**
 * Edit dialog for a bookmark OR a folder: title, url (bookmarks only), the
 * parent folder, tag chips, category and notes.
 *
 *  - **Save is staged, one write path per field group, and only fields the
 *    user changed are written.** Title/url go through `updateBookmark` (or
 *    `renameFolder` for a folder), a changed parent through `moveNode`, and
 *    tag/category/notes reach `patchMeta` only when they differ from the
 *    opening snapshot — merge semantics keep every untouched field (and any
 *    external write) intact. Chrome is written first, then the metadata
 *    sidecar — the same order the mutation service documents.
 *  - **Tag chips resolve-or-create defs on demand.** Chips stage display
 *    names locally; on Save only the delta against the opening tag set is
 *    applied — added chips run `bulkAddTag` (which resolves the
 *    case-insensitive `nameKey`, creates the definition when new, and
 *    appends to the LIVE tag list), removed keys run `bulkRemoveTag`
 *    (filter the live list). Both are transactional read-modify-writes, so
 *    a tag that landed while the dialog was open — say from an applied
 *    suggestion — is preserved instead of lost to a stale whole-list write.
 *  - **Parent picker deny list.** Managed folders are disabled, and when the
 *    target is a folder its own subtree is disabled too (`moveDeniedIds`) —
 *    the same deny list the "Move to…" dialog uses.
 *  - **Failure keeps the dialog open** with the typed message inline (and in
 *    the toast) so the user can correct the input.
 */

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
  /** Defined tags for combobox autocomplete and chip colors. */
  tagDefs?: readonly TagDef[];
}

export function EditDialog({
  target,
  open,
  onOpenChange,
  tree,
  meta,
  tagNameByKey,
  tagDefs,
}: EditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        {target !== null && (
          <EditForm
            key={target.id}
            target={target}
            tree={tree}
            meta={meta}
            tagNameByKey={tagNameByKey}
            tagDefs={tagDefs}
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
  tagDefs,
  onClose,
}: {
  target: TreeEntry;
  tree: FlattenedTree;
  meta?: BookmarkMeta;
  tagNameByKey?: ReadonlyMap<string, string>;
  tagDefs?: readonly TagDef[];
  onClose: () => void;
}) {
  const toast = useToast();
  const isBookmark = target.kind === "bookmark";
  const liveTagDefs = useLiveQuery(
    () => (tagDefs !== undefined ? [] : listTags().catch((): TagDef[] => [])),
    [tagDefs !== undefined],
  );
  const availableTags = tagDefs ?? liveTagDefs ?? [];
  const [title, setTitle] = useState(target.title);
  const [url, setUrl] = useState(isBookmark ? target.url : "");
  const [parentId, setParentId] = useState(target.parentId ?? "");
  const [chips, setChips] = useState<TagFieldChip[]>(() =>
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
  const [summary, setSummary] = useState(meta?.summary ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const destinations = useMemo(() => folderDestinations(tree), [tree]);
  const denied = useMemo(
    () => moveDeniedIds(tree, [target.id]),
    [tree, target.id],
  );

  const addChip = (explicitLabel?: string): void => {
    const label = (explicitLabel ?? tagInput).trim();
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
      if (isBookmark) {
        let effectiveChips = chips;
        if (tagInput.trim() !== "") {
          const pendingLabel = tagInput.trim();
          const pendingKey = tagNameKey(pendingLabel);
          if (
            pendingKey !== "" &&
            !chips.some((chip) => chip.key === pendingKey)
          ) {
            effectiveChips = [
              ...chips,
              { key: pendingKey, label: pendingLabel },
            ];
            setChips(effectiveChips);
          }
          setTagInput("");
        }
        // 2. Tag deltas against the OPENING tag set: new chips resolve-or-
        //    create their def and append to the live list; removed chips are
        //    filtered from it. Untouched keys — and any tag added externally
        //    while this dialog was open — are preserved.
        const openKeys = new Set(meta?.tags ?? []);
        const stagedKeys = new Set(effectiveChips.map((chip) => chip.key));
        for (const chip of effectiveChips) {
          if (openKeys.has(chip.key)) continue;
          const result = await bulkAddTag([target.id], chip.label);
          if (!result.ok) throw new Error(result.message);
        }
        for (const key of openKeys) {
          if (stagedKeys.has(key)) continue;
          const result = await bulkRemoveTag([target.id], key);
          if (!result.ok) throw new Error(result.message);
        }
        // 3. Meta merge for only the fields the user changed — absent keys
        //    keep their stored values, so an external category/notes edit is
        //    never clobbered by the dialog's opening snapshot. `url` (D12)
        //    records the url the bookmark now carries when the dialog edited
        //    it — `target.url` is stale by then.
        const metaPatch: MetaPatch = {};
        if (category !== (meta?.category ?? "")) {
          metaPatch.category = category === "" ? null : category;
        }
        if (notes !== (meta?.notes ?? "")) {
          metaPatch.notes = notes === "" ? null : notes;
        }
        if (summary !== (meta?.summary ?? "") && summary === "") {
          metaPatch.summary = null;
        }
        if (url !== target.url) {
          metaPatch.url = url;
        }
        if (Object.keys(metaPatch).length > 0) {
          metaPatch.url = url;
          await patchMeta(target.id, metaPatch);
        }
      }
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
            maxLength={500}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
              maxLength={2048}
              onChange={(event) => setUrl(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
        {isBookmark && (
          <>
            <div className="space-y-1">
              <span className="text-sm font-medium" id="edit-tags-label">
                Tags
              </span>
              <div aria-labelledby="edit-tags-label">
                <TagField
                  chips={chips}
                  input={tagInput}
                  disabled={busy}
                  availableTags={availableTags}
                  onInputChange={setTagInput}
                  onCommit={addChip}
                  onRemove={removeChip}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="edit-category" className="text-sm font-medium">
                Category
              </label>
              <select
                id="edit-category"
                value={category}
                onChange={(event) => {
                  const next = Category.safeParse(event.target.value);
                  setCategory(next.success ? next.data : "");
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
                maxLength={NOTES_MAX_LENGTH}
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            {summary !== "" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Saved summary</span>
                  <button
                    type="button"
                    onClick={() => setSummary("")}
                    className="rounded-md border border-input px-2 py-1 text-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Clear summary
                  </button>
                </div>
                <p
                  data-testid="edit-saved-summary"
                  className="rounded-md border border-input bg-muted/40 p-2 text-xs text-foreground"
                >
                  {summary}
                </p>
              </div>
            )}
          </>
        )}
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
          className="rounded-md border border-input px-4 py-2 text-sm font-medium outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || (isBookmark && url.trim() === "")}
          onClick={() => void handleSave()}
          className={
            "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
            "text-primary-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          }
        >
          Save
        </button>
      </DialogFooter>
    </>
  );
}
