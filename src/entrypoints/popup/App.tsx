import { useEffect, useMemo, useRef, useState } from "react";
import { listMeta, listTags, patchMeta } from "../../db/meta";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import { normalizeUrl } from "../../duplicates/normalize";
import type { Category } from "../../schemas/bookmark";
import { tagNameKey } from "../../schemas/meta";
import { getTree, ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../sync/chrome-bookmarks";
import {
  DEFAULT_SAVE_FOLDER_ID,
  getLastFolderId,
  resolveSaveFolder,
  setLastFolderId,
} from "../../sync/last-folder";
import { createBookmark } from "../../sync/mutations";
import { bulkAddTag } from "../../sync/tag-ops";
import { flattenTree } from "../../sync/tree";
import type { BookmarkItem, FlattenedTree } from "../../sync/tree";
import { registerDbReleaseListener } from "../../security/delete-all";
import { CategorySelect } from "../../ui/components/category-select";
import { useSearchIndex } from "../../ui/hooks/useSearchIndex";
import { openBookmarkUrl } from "../../sync/tabs";
import type { OpenUrlDisposition } from "../../sync/tabs";
import { openSidePanel, queryActiveTab, setPendingEditId } from "./chrome";
import { PopupSearch } from "./Search";

/**
 * Quick-save popup (spec §3).
 *
 * Data flow: on mount one effect resolves the ACTIVE TAB (`chrome.tabs.query`
 * behind the `activeTab` permission), the native tree (`getTree` +
 * `flattenTree`), and the last-used folder (Dexie `metadata`, see
 * `src/sync/last-folder.ts`) — in parallel — then prefills the form. Title and
 * URL stay editable; the folder picker lists every folder except the synthetic
 * root "0" and is preselected to the last-used folder (Other bookmarks when
 * there is none, or when the stored folder no longer exists).
 *
 * Save writes through the guarded mutation service: `createBookmark` first
 * (Chrome yields the real id), then tag definitions are resolved-or-created
 * per staged chip through `bulkAddTag`, and one `patchMeta` commits the exact
 * tag list plus category/notes. The chosen folder is then remembered as the
 * last-used default. Zero network.
 *
 * Duplicate detection is local and deterministic: when the typed URL
 * normalizes (see `src/duplicates/normalize.ts`) to an existing bookmark's
 * URL, the popup shows "Already saved in <folder>" and offers "Edit that
 * bookmark", which stashes the existing id in `chrome.storage.session` and
 * opens the side panel (see `./chrome.ts` for the handoff contract).
 *
 * "Open manager" opens the side panel for the popup's window. Both side-panel
 * actions call `chrome.sidePanel.open()` synchronously inside the click
 * handler to satisfy Chrome's user-gesture requirement.
 *
 * Duplicate discipline: `savingRef` is a synchronous re-entrancy guard (state
 * lags a fast double submit), and a successful save refreshes the popup's tree
 * snapshot so the just-created bookmark is recognised as a duplicate straight
 * away — the notice and "Edit that bookmark" then work for it, and a second
 * submit cannot silently create a copy.
 *
 * While open, the popup also answers the Options page's "delete all extension
 * data" release broadcast (`registerDbReleaseListener`) by closing its shared
 * Dexie connection, so the popup cannot block the database drop.
 */

const EMPTY_TREE: FlattenedTree = { folders: new Map(), bookmarks: new Map() };

/** One staged tag chip: the storage key plus the display label. */
interface StagedTag {
  key: string;
  label: string;
}

/** One pickable save destination. */
interface FolderOption {
  id: string;
  label: string;
}

/** Display path for a folder id, e.g. "Bookmarks bar / Dev". */
function folderLabel(tree: FlattenedTree, id: string): string {
  const folder = tree.folders.get(id);
  if (folder === undefined) return "Other bookmarks";
  const parts = [...folder.path, folder.title].filter((part) => part !== "");
  return parts.length === 0 ? "Folder" : parts.join(" / ");
}

/** Every folder except the synthetic root "0", in tree order. */
function folderOptions(tree: FlattenedTree): FolderOption[] {
  const out: FolderOption[] = [];
  for (const folder of tree.folders.values()) {
    if (folder.id === ROOT_NODE_ID) continue;
    out.push({ id: folder.id, label: folderLabel(tree, folder.id) });
  }
  return out;
}

/** `getTree()` may throw synchronously when the surface is missing. */
async function loadTree(): Promise<BookmarksTreeNode[]> {
  try {
    return await getTree();
  } catch {
    return [];
  }
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function App() {
  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState<FlattenedTree>(EMPTY_TREE);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [folderId, setFolderId] = useState(DEFAULT_SAVE_FOLDER_ID);
  const [chips, setChips] = useState<StagedTag[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFolder, setSavedFolder] = useState<string | null>(null);
  /** The popup window's id, captured with the active tab for `sidePanel.open`. */
  const windowIdRef = useRef<number | undefined>(undefined);
  /** Synchronous re-entrancy guard — `busy` state lags a fast double submit. */
  const savingRef = useRef(false);
  /** Search box text; while non-empty the results list replaces the form. */
  const [searchQuery, setSearchQuery] = useState("");
  /** Meta/tag rows for the search index — loaded lazily post-paint. */
  const [metas, setMetas] = useState<readonly BookmarkMeta[]>([]);
  const [tagDefs, setTagDefs] = useState<readonly TagDef[]>([]);

  // Answer the Options page's "delete all extension data" broadcast by closing
  // this page's Dexie connection; an open connection would block the drop.
  useEffect(() => registerDbReleaseListener(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tab, rawTree, lastFolderId] = await Promise.all([
        queryActiveTab(),
        loadTree(),
        getLastFolderId(),
      ]);
      if (cancelled) return;
      const flat = flattenTree(rawTree);
      windowIdRef.current = tab?.windowId;
      setTree(flat);
      setTitle(tab?.title ?? "");
      setUrl(tab?.url ?? "");
      setFolderId(
        resolveSaveFolder(new Set(flat.folders.keys()), lastFolderId),
      );
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy index inputs: the save form is the popup's hot path, so the meta /
  // tag rows the search index needs are fetched only after the first real
  // paint (ready === true). `useSearchIndex` then builds off-paint inside an
  // effect; until the handle lands, the results area reads "Indexing…".
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      const [metaRows, tagRows] = await Promise.all([
        listMeta().catch((): BookmarkMeta[] => []),
        listTags().catch((): TagDef[] => []),
      ]);
      if (cancelled) return;
      setMetas(metaRows);
      setTagDefs(tagRows);
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const search = useSearchIndex(tree, metas, tagDefs);

  const destinations = useMemo(() => folderOptions(tree), [tree]);

  /** The existing bookmark whose normalized URL matches the typed one. */
  const duplicate = useMemo((): BookmarkItem | null => {
    const key = normalizeUrl(url.trim());
    if (key === null) return null;
    for (const item of tree.bookmarks.values()) {
      if (normalizeUrl(item.url) === key) return item;
    }
    return null;
  }, [url, tree]);

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

  /**
   * Re-read the native tree so the duplicate notice reflects what is actually
   * stored. Called after a successful save; a refresh that comes back empty
   * (an unreadable tree) keeps the previous snapshot rather than emptying the
   * folder picker.
   */
  const refreshTree = async (): Promise<void> => {
    const flat = flattenTree(await loadTree());
    if (flat.folders.size === 0) return;
    setTree(flat);
  };

  const handleSave = async (): Promise<void> => {
    // Guard first, synchronously: two submits dispatched in the same task
    // would both pass a `busy`-state check and create two bookmarks.
    if (savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const trimmedUrl = url.trim();
      const trimmedTitle = title.trim();
      const created = await createBookmark({
        parentId: folderId,
        title: trimmedTitle === "" ? trimmedUrl : trimmedTitle,
        url: trimmedUrl,
      });
      // Tag definitions resolve-or-create on demand; the final patchMeta
      // writes the exact staged key list (removed chips are dropped).
      for (const chip of chips) {
        const result = await bulkAddTag([created.id], chip.label);
        if (!result.ok) throw new Error(result.message);
      }
      await patchMeta(created.id, {
        tags: chips.map((chip) => chip.key),
        category: category === "" ? null : category,
        notes: notes === "" ? null : notes,
      });
      await setLastFolderId(folderId);
      setSavedFolder(folderLabel(tree, folderId));
      await refreshTree();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Handoff ordering: the session write is dispatched first but NOT awaited,
   * and `openSidePanel` runs synchronously on the same tick so
   * `chrome.sidePanel.open()` still counts as a user gesture. The side panel
   * only reads the key after its tree load settles, so the write always lands
   * first in practice.
   */
  const handleEditExisting = (): void => {
    if (duplicate === null) return;
    void setPendingEditId(duplicate.id);
    openSidePanel(windowIdRef.current);
  };

  const handleOpenManager = (): void => {
    openSidePanel(windowIdRef.current);
  };

  /**
   * Result opens route through the typed tabs slice: foreground/click →
   * `tabs.create`, Ctrl/Cmd+Enter → `tabs.update` on the current tab. No
   * `tabs` permission needed; unopenable URLs are filtered in the component.
   */
  const handleOpenResult = (
    resultUrl: string,
    disposition: OpenUrlDisposition,
  ): void => {
    void openBookmarkUrl(resultUrl, disposition);
  };

  return (
    <main
      data-testid="popup-quick-save"
      className="w-80 bg-background p-3 text-foreground"
    >
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-sm font-semibold">Bookmarks Manager</h1>
        <button
          type="button"
          onClick={handleOpenManager}
          className="rounded-sm border border-border px-2 py-1 text-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open manager
        </button>
      </header>

      <PopupSearch
        search={search}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onOpen={handleOpenResult}
      />

      {!ready ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
      ) : searchQuery !== "" ? null : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div className="space-y-1">
            <label htmlFor="popup-title" className="text-sm font-medium">
              Title
            </label>
            <input
              id="popup-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="popup-url" className="text-sm font-medium">
              URL
            </label>
            <input
              id="popup-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="popup-folder" className="text-sm font-medium">
              Folder
            </label>
            <select
              id="popup-folder"
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium" id="popup-tags-label">
              Tags
            </span>
            <div
              aria-labelledby="popup-tags-label"
              className="flex flex-wrap items-center gap-1 rounded-md border border-input p-1"
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
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={addChip}
                disabled={tagInput.trim() === ""}
                className="rounded-md border border-input px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
              >
                Add tag
              </button>
            </div>
          </div>
          <CategorySelect
            label="Category"
            value={category === "" ? null : category}
            onChange={(next) => setCategory(next ?? "")}
          />
          <div className="space-y-1">
            <label htmlFor="popup-notes" className="text-sm font-medium">
              Notes
            </label>
            <textarea
              id="popup-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={busy || url.trim() === ""}
            className="w-full rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Save
          </button>
        </form>
      )}

      {duplicate !== null && (
        <div
          data-testid="duplicate-notice"
          role="status"
          className="mt-3 space-y-1 rounded-md border border-border p-2"
        >
          <p className="text-xs">
            Already saved in{" "}
            {duplicate.path.filter((part) => part !== "").join(" / ") ||
              folderLabel(tree, duplicate.parentId ?? "")}
          </p>
          <button
            type="button"
            onClick={handleEditExisting}
            className="rounded-sm border border-border px-2 py-1 text-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Edit that bookmark
          </button>
        </div>
      )}

      {savedFolder !== null && (
        <p
          data-testid="save-confirmation"
          role="status"
          className="mt-3 text-xs text-muted-foreground"
        >
          Saved to {savedFolder}.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </main>
  );
}
