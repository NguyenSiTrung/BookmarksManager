import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONSENT_VERSION } from "../../consent/records";
import { db } from "../../db/database";
import {
  createTag,
  getTag,
  listMeta,
  listTags,
  MetaRepoError,
  patchMeta,
} from "../../db/meta";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import { normalizeUrl } from "../../duplicates/normalize";
import { isBlockedScheme } from "../../io/netscape";
import {
  DecisionMessage,
  DecisionMessageResult,
} from "../../messages/decisions";
import type { Category } from "../../schemas/bookmark";
import { tagNameKey } from "../../schemas/meta";
import { DECISIONS_CONSENT_SCOPE } from "../../schemas/provider";
import { getTree, ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../sync/chrome-bookmarks";
import {
  DEFAULT_SAVE_FOLDER_ID,
  getLastFolderId,
  resolveSaveFolder,
  setLastFolderId,
} from "../../sync/last-folder";
import { createBookmark, removeTree } from "../../sync/mutations";
import { flattenTree } from "../../sync/tree";
import type { BookmarkItem, FlattenedTree } from "../../sync/tree";
import { registerDbReleaseListener } from "../../security/delete-all";
import {
  CategorySelect,
  humanizeCategory,
} from "../../ui/components/category-select";
import {
  BookmarkIcon,
  ChevronDownIcon,
  FolderIcon,
  PanelRightIcon,
  SearchIcon,
} from "../../ui/components/icons";
import { useSearchIndex } from "../../ui/hooks/useSearchIndex";
import { openBookmarkUrl } from "../../sync/tabs";
import type { OpenUrlDisposition } from "../../sync/tabs";
import { SettingsIcon } from "../../ui/components/settings-icon";
import { cn } from "../../ui/lib/cn";
import {
  openOptionsPage,
  openSidePanel,
  queryActiveTab,
  setPendingEditId,
} from "./chrome";
import { DuplicateNotice, ErrorAlert, SaveSuccess } from "./Notices";
import { hostOf, PageCard } from "./PageCard";
import { PopupSearch } from "./Search";
import { Suggestions } from "./Suggestions";
import type { SuggestionStatus } from "./Suggestions";
import { TagField } from "./TagField";

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
 * Save writes through the guarded mutation service. The URL is checked
 * against the shared `isBlockedScheme` write boundary first (the same
 * blocklist the import writer and the context menu enforce). Tag
 * definitions resolve-or-create per staged chip BEFORE `createBookmark`
 * runs, then one `patchMeta` commits the exact tag list plus
 * category/notes; a failed meta write unwinds the just-created bookmark so
 * a save is all-or-nothing. The chosen folder is then remembered as the
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
 *
 * Jev save suggestions (FR10) ride on top of the same form without ever
 * blocking it: once the prefill settles, one `SAVE_SUGGEST` message goes out
 * under a synthetic `popup:<uuid>` bookmark id — but only when some provider
 * already holds a `jev_decisions` consent grant (a cheap local check; the
 * worker refuses `ok:false` anyway, which reads the same in the UI). The
 * reply carries only counts; the suggestions themselves are persisted
 * `db.decisions` rows correlated by that id, which `./Suggestions.tsx`
 * live-queries. Nothing arrives synchronously and nothing applies without a
 * click — except a `move` decision at confidence ≥ 0.7, which pre-selects the
 * folder ONLY while the picker is untouched (`folderTouchedRef`): a folder
 * the user already chose is never overridden by a late suggestion.
 */

/**
 * The popup's one addition to the lazy-chrome surface: `runtime.sendMessage`
 * for the SAVE_SUGGEST intent. Declared locally (house pattern) so the module
 * loads before any `vi.stubGlobal` and degrades when the surface is absent.
 */
declare const chrome: {
  runtime?: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

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

/** Label for the Ctrl/Cmd+Enter save shortcut hint. */
const SAVE_SHORTCUT =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
    ? "⌘ ↵"
    : "Ctrl ↵";

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
  /**
   * The "Details" disclosure (URL, category, notes). Collapsed by default so
   * the common case is title → Save.
   */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /**
   * True when the active tab gave us nothing saveable (a new-tab / chrome://
   * page, or no URL at all). The URL field then lives in the page card so the
   * popup reads "paste a link to save" instead of hiding the one field that
   * matters inside Details. Decided once at prefill — flipping it while the
   * user types would move the input out from under them.
   */
  const [urlInCard, setUrlInCard] = useState(false);
  /** The popup window's id, captured with the active tab for `sidePanel.open`. */
  const windowIdRef = useRef<number | undefined>(undefined);
  /** Synchronous re-entrancy guard — `busy` state lags a fast double submit. */
  const savingRef = useRef(false);
  /** Search box text; while non-empty the results list replaces the form. */
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  /** Meta/tag rows for the search index — loaded lazily post-paint. */
  const [metas, setMetas] = useState<readonly BookmarkMeta[]>([]);
  const [tagDefs, setTagDefs] = useState<readonly TagDef[]>([]);

  /**
   * Correlation id for this popup's SAVE_SUGGEST round-trip: the worker keys
   * the decision rows it persists on `bookmarkIds: [id]`, and `<Suggestions>`
   * reads them back by the same id. The `"popup:"` + uuid scheme is synthetic
   * (a not-yet-saved bookmark has no Chrome node id), collision-safe across
   * popup opens, and can never alias a real bookmark.
   */
  const [suggestId] = useState(() => `popup:${crypto.randomUUID()}`);
  /** Outcome of the suggestion request, for `<Suggestions>`' quiet notes. */
  const [suggestionStatus, setSuggestionStatus] =
    useState<SuggestionStatus>("idle");
  /** Single-shot guard: SAVE_SUGGEST goes out exactly once per popup open. */
  const suggestAttemptedRef = useRef(false);
  /**
   * True once the user changes the folder picker. A late `move` suggestion is
   * then suppressed by `handleFolderSuggestion`, so a pre-select can never
   * clobber a folder the user already chose.
   */
  const folderTouchedRef = useRef(false);
  /**
   * Always holds the latest form values. The SAVE_SUGGEST effect is one-shot
   * per popup open (`suggestAttemptedRef`), so it must not depend on
   * `title`/`url`/`folderId`: a keystroke would re-run the effect, tear down
   * the in-flight request via its cleanup, and drop the reply. Instead the
   * effect reads the payload here at send time, so it still reflects the
   * current values without re-subscribing to their state. Kept in sync by an
   * effect (declared before the SAVE_SUGGEST effect so it always runs first)
   * rather than during render, which React forbids.
   */
  const latestInputRef = useRef({ title, url, folderId });
  useEffect(() => {
    latestInputRef.current = { title, url, folderId };
  }, [title, url, folderId]);

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
      const tabUrl = tab?.url ?? "";
      setUrlInCard(hostOf(tabUrl) === null || isBlockedScheme(tabUrl.trim()));
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

  // --- Jev save suggestions (FR10): fire-and-forget -------------------------
  // Exactly once per popup open, off the render path. A refusal at any step —
  // no consent grant, an absent runtime surface, a rejection, a malformed or
  // `ok:false` reply — collapses to "unavailable" and the UI simply renders
  // nothing; the form is never gated on this. `sent:false` with the
  // "blocklisted" reason is the one outcome with a visible note. The reply
  // carries counts only; suggested values arrive as `db.decisions` rows.
  //
  // Deps are `[ready, suggestId]` only — `suggestId` is stable per mount, and
  // `title`/`url`/`folderId` are read at send time from `latestInputRef`. The
  // effect must NOT re-run on edits: its cleanup would cancel an in-flight
  // request and drop the reply, defeating the `suggestAttemptedRef` one-shot.
  useEffect(() => {
    if (!ready || suggestAttemptedRef.current) return;
    suggestAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      // Cheap local gate: skip the worker round-trip entirely when no
      // provider holds a current `jev_decisions` grant — the worker would
      // refuse `ok:false` anyway, so the outcome in the UI is identical.
      // Origin-agnostic like the side panel's Ask gate: the popup does not
      // know which provider the worker will use, so ANY current
      // `jev_decisions` grant lets the suggestion attempt proceed.
      let consented = false;
      try {
        consented = (await db.consents.toArray()).some(
          (row) =>
            row.scope === DECISIONS_CONSENT_SCOPE &&
            row.consentVersion === CONSENT_VERSION,
        );
      } catch {
        consented = false;
      }
      if (cancelled) return;
      const { title: currentTitle, url: currentUrl, folderId: currentFolderId } =
        latestInputRef.current;
      const trimmedUrl = currentUrl.trim();
      if (!consented || trimmedUrl === "") {
        setSuggestionStatus("unavailable");
        return;
      }
      try {
        // `notes` is deliberately omitted: the protocol accepts it but the
        // popup never sends it — notes stay on the device.
        const raw = await chrome.runtime?.sendMessage(
          DecisionMessage.parse({
            type: "SAVE_SUGGEST",
            bookmark: {
              id: suggestId,
              title: currentTitle.trim(),
              url: trimmedUrl,
              parentId: currentFolderId,
            },
          }),
        );
        if (cancelled) return;
        const parsed = DecisionMessageResult.safeParse(raw);
        if (
          !parsed.success ||
          !parsed.data.ok ||
          parsed.data.code !== "analyze_ok"
        ) {
          setSuggestionStatus("unavailable");
          return;
        }
        const summary = parsed.data.result;
        if (!summary.sent) {
          setSuggestionStatus(
            summary.reason === "blocklisted" ? "blocklisted" : "unavailable",
          );
        } else {
          setSuggestionStatus("sent");
        }
      } catch {
        if (!cancelled) setSuggestionStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, suggestId]);

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

  /** Tag nameKeys already staged — matching suggestions hide themselves. */
  const appliedTagKeys = useMemo(
    () => new Set(chips.map((chip) => chip.key)),
    [chips],
  );

  /** User picked a folder: mark it touched, then apply the choice. */
  const handleFolderChange = (next: string): void => {
    folderTouchedRef.current = true;
    setFolderId(next);
  };

  /**
   * A ≥0.7 `move` suggestion asking for the picker. Suppressed when the user
   * already chose a folder (`folderTouchedRef`), and dropped when the target
   * is no longer a pickable folder (gone or the synthetic root) so the select
   * never lands on an option it does not render.
   */
  const handleFolderSuggestion = useCallback(
    (targetFolderId: string): void => {
      if (folderTouchedRef.current) return;
      if (targetFolderId === ROOT_NODE_ID) return;
      if (!tree.folders.has(targetFolderId)) return;
      setFolderId(targetFolderId);
    },
    [tree],
  );

  /** Merge one clicked suggested tag into the staged chips (deduped by key). */
  const handleAcceptTag = (label: string): void => {
    const trimmed = label.trim();
    const key = tagNameKey(trimmed);
    if (key === "") return;
    setChips((current) =>
      current.some((chip) => chip.key === key)
        ? current
        : [...current, { key, label: trimmed }],
    );
  };

  /** Apply a clicked category suggestion. */
  const handleAcceptCategory = (next: Category): void => {
    setCategory(next);
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
      if (trimmedUrl === "") {
        throw new Error("Enter a URL to save.");
      }
      if (isBlockedScheme(trimmedUrl)) {
        throw new Error("This URL scheme cannot be saved as a bookmark.");
      }
      // Resolve-or-create every staged chip's def BEFORE the bookmark
      // exists: defs are the only step that can fail without the tree, so
      // ordering them first keeps the save atomic. A tag_exists race just
      // means the def is already stored.
      for (const chip of chips) {
        if ((await getTag(chip.key)) !== undefined) continue;
        try {
          await createTag(chip.label);
        } catch (cause) {
          if (
            !(cause instanceof MetaRepoError && cause.code === "tag_exists")
          ) {
            throw cause;
          }
        }
      }
      const created = await createBookmark({
        parentId: folderId,
        title: trimmedTitle === "" ? trimmedUrl : trimmedTitle,
        url: trimmedUrl,
      });
      try {
        // The exact staged key list (removed chips are dropped) plus
        // category/notes in one meta write.
        await patchMeta(created.id, {
          tags: chips.map((chip) => chip.key),
          category: category === "" ? null : category,
          notes: notes === "" ? null : notes,
        });
      } catch (metaCause) {
        // Nothing should reference a half-saved bookmark — unwind it so the
        // failed save leaves only the (harmless) tag defs behind.
        await removeTree(created.id).catch(() => undefined);
        throw metaCause;
      }
      await setLastFolderId(folderId);
      setSavedFolder(folderLabel(tree, folderId));
      // Keeps the saved state inside Chrome's popup height cap; the Details
      // summary line still lists what was set.
      setDetailsOpen(false);
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

  const searchIconButtonRef = useRef<HTMLButtonElement>(null);
  // Closing with a live query clears it; focus returns to the header icon.
  const closeSearch = (): void => {
    setSearchOpen(false);
    setSearchQuery("");
    searchIconButtonRef.current?.focus();
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

  const saved = savedFolder !== null;
  const pageHost = hostOf(url);
  const detailsSummary = [
    category === "" ? null : humanizeCategory(category),
    notes.trim() === "" ? null : "Notes",
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const duplicateLocation =
    duplicate === null
      ? ""
      : duplicate.path.filter((part) => part !== "").join(" / ") ||
        folderLabel(tree, duplicate.parentId ?? "");

  const fieldClass =
    "w-full rounded-lg border border-input bg-background px-3 text-sm outline-hidden transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-70";
  const captionClass = "text-xs font-medium text-muted-foreground";
  const ghostButton =
    "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <main
      data-testid="popup-quick-save"
      className="popup-root flex max-h-[600px] w-[380px] flex-col overflow-hidden bg-background text-sm text-foreground"
    >
      <header className="flex shrink-0 items-center gap-2 px-4 pt-3.5 pb-3">
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-card"
        >
          <BookmarkIcon className="size-4" />
        </span>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
          Bookmarks Manager
        </h1>
        <button
          type="button"
          aria-label="Search bookmarks"
          aria-expanded={searchOpen}
          aria-controls="popup-search-row"
          title="Search bookmarks"
          ref={searchIconButtonRef}
          onClick={() => setSearchOpen(true)}
          className={cn(ghostButton, "w-8 justify-center px-0")}
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          aria-label="Open manager"
          title="Open manager"
          onClick={handleOpenManager}
          className={cn(ghostButton, "w-8 justify-center px-0")}
        >
          <PanelRightIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          onClick={openOptionsPage}
          className={cn(ghostButton, "w-8 justify-center px-0")}
        >
          <SettingsIcon />
        </button>
      </header>

      {searchOpen && (
        <div id="popup-search-row" className="shrink-0 px-4 pb-3">
          <PopupSearch
            search={search}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onOpen={handleOpenResult}
            onClose={closeSearch}
          />
        </div>
      )}

      {!ready ? (
        <div aria-busy="true" className="animate-pulse space-y-3 px-4 pb-4">
          <p className="sr-only">Loading…</p>
          <div className="h-[68px] rounded-xl bg-secondary" />
          <div className="h-10 rounded-lg bg-secondary" />
          <div className="h-10 rounded-lg bg-secondary" />
          <div className="h-10 rounded-lg bg-secondary" />
        </div>
      ) : searchQuery !== "" ? null : (
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !saved
            ) {
              event.preventDefault();
              void handleSave();
            }
          }}
        >
          {/* Only this region scrolls: the Save footer below stays put, so
              the primary action can never be pushed under Chrome's popup
              height cap. */}
          <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-3">
            {duplicate !== null && !saved && (
              <DuplicateNotice
                location={duplicateLocation}
                onEdit={handleEditExisting}
              />
            )}

            <fieldset disabled={saved} className="min-w-0 space-y-3">
              <PageCard
                title={title}
                host={pageHost}
                url={url}
                disabled={saved}
                urlEditable={urlInCard}
                onTitleChange={setTitle}
                onUrlChange={setUrl}
              />

              <div className="relative">
                <label htmlFor="popup-folder" className="sr-only">
                  Folder
                </label>
                <FolderIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <select
                  id="popup-folder"
                  value={folderId}
                  onChange={(event) => handleFolderChange(event.target.value)}
                  className={cn(fieldClass, "h-10 appearance-none pr-9 pl-9")}
                >
                  {destinations.map((destination) => (
                    <option key={destination.id} value={destination.id}>
                      {destination.label}
                    </option>
                  ))}
                </select>
                <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>

              <div className="space-y-2">
                <TagField
                  chips={chips}
                  input={tagInput}
                  disabled={saved}
                  onInputChange={setTagInput}
                  onCommit={addChip}
                  onRemove={removeChip}
                />
                <Suggestions
                  bookmarkId={suggestId}
                  status={suggestionStatus}
                  appliedTagKeys={appliedTagKeys}
                  category={category}
                  onFolderSuggestion={handleFolderSuggestion}
                  onAcceptTag={handleAcceptTag}
                  onAcceptCategory={handleAcceptCategory}
                />
              </div>

              <div>
                <button
                  type="button"
                  aria-expanded={detailsOpen}
                  aria-controls="popup-details"
                  onClick={() => setDetailsOpen((open) => !open)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-xs font-medium text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronDownIcon
                    className={cn(
                      "size-3.5 transition-transform",
                      !detailsOpen && "-rotate-90",
                    )}
                  />
                  Details
                  {detailsSummary !== "" && (
                    <span className="font-normal">· {detailsSummary}</span>
                  )}
                </button>
                {/* `hidden` (not unmounting) keeps the fields addressable and
                    their state intact while collapsed. */}
                <div
                  id="popup-details"
                  hidden={!detailsOpen}
                  className="mt-1 space-y-3 rounded-xl border border-border bg-card p-3"
                >
                  {!urlInCard && (
                    <div className="space-y-1.5">
                      <label htmlFor="popup-url" className={captionClass}>
                        URL
                      </label>
                      <input
                        id="popup-url"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        spellCheck={false}
                        className={cn(fieldClass, "h-9")}
                      />
                    </div>
                  )}
                  <CategorySelect
                    label="Category"
                    value={category === "" ? null : category}
                    onChange={(next) => setCategory(next ?? "")}
                    disabled={saved}
                    className="flex flex-col items-stretch gap-1.5 [&_label]:text-xs [&_label]:font-medium"
                    selectClassName={cn(fieldClass, "h-9 px-2.5")}
                  />
                  <div className="space-y-1.5">
                    <label htmlFor="popup-notes" className={captionClass}>
                      Notes
                    </label>
                    <textarea
                      id="popup-notes"
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      rows={2}
                      className={cn(fieldClass, "resize-none py-2")}
                    />
                  </div>
                </div>
              </div>
            </fieldset>
          </div>

          <div className="shrink-0 space-y-2 border-t border-border bg-background px-4 py-3">
            {error !== null && <ErrorAlert message={error} />}

            {saved ? (
              <SaveSuccess
                folder={savedFolder}
                onEdit={handleEditExisting}
              />
            ) : (
              <button
                type="submit"
                aria-label="Save"
                aria-busy={busy}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                disabled={busy || url.trim() === ""}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-card outline-hidden transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:saturate-50"
              >
                {busy ? "Saving…" : "Save"}
                {!busy && (
                  <kbd
                    aria-hidden="true"
                    className="rounded-sm bg-primary-foreground/15 px-1.5 py-0.5 text-[10px] font-medium"
                  >
                    {SAVE_SHORTCUT}
                  </kbd>
                )}
              </button>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
