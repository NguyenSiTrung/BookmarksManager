import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DuplicateGroup } from "../../duplicates/group";
import { DuplicatesView } from "./DuplicatesView";
import { useLiveQuery } from "dexie-react-hooks";
import { ContextMenu } from "radix-ui";
import { listMeta, listTags } from "../../db/meta";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import type { BookmarkItem, FolderNode, TreeEntry } from "../../sync/tree";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { useBookmarkTree } from "../../ui/hooks/useBookmarkTree";
import { useSearchIndex } from "../../ui/hooks/useSearchIndex";
import { EmptyState } from "../../ui/components/empty-state";
import { openBookmarkUrl } from "../../sync/tabs";
import { isOpenableUrl } from "../../search/openable";
import {
  BookmarkList,
  SelectionContext,
  useBookmarkSelection,
} from "./BookmarkList";
import { BulkBar, deleteNodesWithUndo, deleteResultMessage } from "./BulkBar";
import { DndProvider } from "./dnd";
import { EditDialog } from "./EditDialog";
import { RestructureView } from "./RestructureView";
import { SummaryDialog } from "./SummaryDialog";
import {
  FolderActionDialog,
  FolderActions,
  FolderActionsContextItems,
} from "./FolderActions";
import type {
  FolderActionKind,
  FolderActionRequest,
} from "./FolderActions";
import { ExportDialog } from "./ExportDialog";
import { ImportDialog } from "./ImportDialog";
import { MoveToDialog } from "./MoveToDialog";
import { CommandPalette } from "./CommandPalette";
import { ScanPanel } from "./ScanPanel";
import type { ScanBookmark } from "./ScanPanel";
import { SearchBar } from "./SearchBar";
import { emptyStateFor } from "./empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";

import {
  clearPendingEditId,
  onPendingEditId,
  readPendingEditId,
} from "../popup/chrome";
import { registerDbReleaseListener } from "../../security/delete-all";
import { listReviewable } from "../../decisions/store";
import type { DecisionRow } from "../../decisions/store";
import { DecisionMessage } from "../../messages/decisions";
import { TagManager } from "./TagManager";
import {
  ReviewView,
  analyzeResultMessage,
  reviewQueue,
  sendDecisionMessage,
} from "./ReviewView";
import { ScopeHeading } from "./ScopeHeading";
import { ScopePane } from "./ScopePane";
import { TopBar } from "./TopBar";
import type { ToolsAction } from "./TopBar";
import { ViewChips } from "./ViewChips";
import { aiVisibility, categoryCounts } from "./scope";
import { useAiConnected } from "./useAiConnected";
import { useIsWide } from "./useIsWide";
import { ToastProvider, UndoToast, useUndoToastController } from "./UndoToast";
import type { ToastApi, ToastState } from "./UndoToast";
import { resolveDuplicateGroups, resolveView, viewTitle } from "./views";
import type { SidePanelView } from "./views";

/** Lazy slice: `chrome.runtime.openOptionsPage` + `tabs.query` (absent in tests/popup). */
declare const chrome: {
  tabs?: {
    query?(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
    }): Promise<{ id?: number }[]>;
  };
  runtime?: { openOptionsPage?: () => Promise<void> | void } | null;
};

function openOptionsPage(): void {
  try {
    const fn = chrome.runtime?.openOptionsPage;
    if (typeof fn === "function") void fn.call(chrome.runtime);
  } catch {
    // No runtime surface — nothing to do.
  }
}

/**
 * Side-panel application shell — narrow-first, search-first:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ TopBar: search · Tools ⋯ · Settings      │
 *   ├─────────────┬────────────────────────────┤
 *   │ ScopePane   │ ViewChips: All · Recent …  │
 *   │ (wide only: │ scope heading · count · ▦  │
 *   │  folders,   │ ┌────────────────────────┐ │
 *   │  tags,      │ │ virtualized list       │ │
 *   │  categories)│ └────────────────────────┘ │
 *   └─────────────┴────────────────────────────┘
 *
 * Narrow panels (under 640px, see `useIsWide`) drop the left column: the
 * scope heading opens the same `ScopePane` in a `ScopeDrawer` instead.
 *
 * Data flow: `useBookmarkTree` supplies the live flattened Chrome tree;
 * `useLiveQuery` streams the `bookmarkMeta` and `tags` Dexie tables (both
 * degrade to `[]` if the DB can't be reached, keeping the panel usable);
 * `resolveView` turns (view, tree, metas) into the ordered item list; and
 * `useBookmarkSelection` owns multi-select state, shared through
 * `SelectionContext` so deeper components (P4.T3's action bar and dialogs)
 * can read it without prop drilling.
 */

/** Stable empty fallbacks — `?? []` inline would make memo deps churn. */
const EMPTY_METAS: readonly BookmarkMeta[] = [];
const EMPTY_TAG_DEFS: readonly TagDef[] = [];
const EMPTY_DECISIONS: readonly DecisionRow[] = [];

/** Per-row action control (kebab) on bookmark rows. */
const ITEM_KEBAB_CLASS =
  "shrink-0 rounded-sm px-1 text-xs text-muted-foreground outline-hidden " +
  "hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring";

/** Raw Radix context-menu item styling (mirrors DropdownMenuItem's). */
const CONTEXT_ITEM_CLASS =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 " +
  "text-sm outline-hidden select-none focus:bg-accent " +
  "focus:text-accent-foreground data-[disabled]:pointer-events-none " +
  "data-[disabled]:opacity-50";

/** Tooltip shown on disabled row actions for managed bookmarks. */
const MANAGED_ITEM_TITLE =
  "This bookmark is managed by policy — it can't be changed.";

function makeView(kind: SidePanelView["kind"]): SidePanelView {
  switch (kind) {
    case "all":
      return { kind: "all" };
    case "recent":
      return { kind: "recent" };
    case "untagged":
      return { kind: "untagged" };
    case "duplicates":
      return { kind: "duplicates" };
    case "review":
      return { kind: "review" };
    case "restructure":
      return { kind: "restructure" };
    default:
      return { kind: "all" };
  }
}

/**
 * Reorder search results by the Ask-reranked id order (probability desc,
 * P4.T5): ranked ids that resolve in the current results come first; every
 * unranked result keeps its local relevance order behind them. A pure
 * permutation of the input — no result is added or dropped.
 */
function applyRerankOrder(
  items: readonly BookmarkItem[],
  order: readonly string[],
): BookmarkItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ranked: BookmarkItem[] = [];
  const rankedIds = new Set<string>();
  for (const id of order) {
    // A repeated id ranks its item ONCE — pushing per occurrence would
    // duplicate it and, via the filter below, drop an unranked result,
    // breaking the pure-permutation contract.
    if (rankedIds.has(id)) continue;
    const item = byId.get(id);
    if (item !== undefined) {
      ranked.push(item);
      rankedIds.add(id);
    }
  }
  return [...ranked, ...items.filter((item) => !rankedIds.has(item.id))];
}

export function App(props?: { askDebounceMs?: number }) {
  const tree = useBookmarkTree();
  // liveQuery emits fresh rows on any write to the touched tables; a missing
  // or failing IndexedDB degrades to an empty list instead of throwing the
  // render (useLiveQuery rethrows observable errors).
  const metas =
    useLiveQuery(() => listMeta().catch((): BookmarkMeta[] => []), []) ??
    EMPTY_METAS;
  const tagDefs =
    useLiveQuery(() => listTags().catch((): TagDef[] => []), []) ??
    EMPTY_TAG_DEFS;
  // The review queue: pending + unsure `Decision` rows stream straight
  // from Dexie (same degrade-to-[] rule as metas/tagDefs) — the header
  // badge and the ReviewView pane both read this. `unsure` rows carry the
  // LLM second opinion and stay user-reviewable (spec FR6.9).
  const pendingDecisions =
    useLiveQuery(() => listReviewable().catch((): DecisionRow[] => []), []) ??
    EMPTY_DECISIONS;
  // The badge mirrors ReviewView's ACTIONABLE queue — save-suggest
  // placeholder (`popup:`) decisions are withheld there, so counting them
  // here would advertise rows the queue never shows.
  const pendingCount = useMemo(
    () => reviewQueue(pendingDecisions).length,
    [pendingDecisions],
  );
  const wide = useIsWide();
  const aiConnected = useAiConnected();
  const visibility = useMemo(
    () => aiVisibility({ aiConnected, pendingCount }),
    [aiConnected, pendingCount],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [view, setView] = useState<SidePanelView>({ kind: "all" });
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /**
   * The Ask-reranked result order for the query it answered (P4.T5), or
   * `null` while the local relevance order applies. Keyed by query so an
   * order can only ever permute the results of the exact query the rerank
   * answered — a new query renders local order until its own reply lands.
   */
  const [rerankOrder, setRerankOrder] = useState<{
    query: string;
    ids: readonly string[];
  } | null>(null);
  /**
   * SearchBar's `onRerankOrder` sink: a non-null order is tagged with the
   * query the hook dispatched it for (the reply is already stale-guarded,
   * so at report time `searchQuery` is the query that was answered).
   */
  const handleRerankOrder = (ids: readonly string[] | null): void => {
    setRerankOrder(ids === null ? null : { query: searchQuery, ids });
  };
  /**
   * The live search index: built after mount, diff-updated as tree/metas/
   * tagDefs change. `null` until the first build lands.
   */
  const search = useSearchIndex(tree, metas, tagDefs);
  /**
   * Any non-empty query shows the `search` view over the whole library;
   * clearing it returns to `view` untouched — the previous view is never
   * overwritten while searching, so restoring needs no bookkeeping.
   */
  const activeView: SidePanelView = useMemo(
    () =>
      searchQuery === "" ? view : { kind: "search", query: searchQuery },
    [searchQuery, view],
  );
  const items = useMemo(() => {
    const resolved = resolveView(activeView, tree, metas, search);
    // Only the query the rerank answered may be permuted by its order —
    // anything else (Ask off, new query pending its reply, non-search
    // views) renders the local order.
    if (
      activeView.kind !== "search" ||
      rerankOrder === null ||
      rerankOrder.query !== activeView.query
    ) {
      return resolved;
    }
    return applyRerankOrder(resolved, rerankOrder.ids);
  }, [activeView, tree, metas, search, rerankOrder]);
  /**
   * The scan work set as minimized rows — `{id, title, url}` per bookmark,
   * exactly what `estimateJobCost` folds and `JOB_START` sends. Notes and
   * every other meta field stay out by construction (P4.T4).
   */
  const scanBookmarks = useMemo<readonly ScanBookmark[]>(
    () =>
      [...tree.bookmarks.values()].map(({ id, title, url }) => ({
        id,
        title,
        url,
      })),
    [tree],
  );
  const orderedIds = useMemo(() => items.map((item) => item.id), [items]);
  const selection = useBookmarkSelection(orderedIds);
  const metaById = useMemo(
    () => new Map(metas.map((meta) => [meta.id, meta])),
    [metas],
  );
  const duplicateGroups = useMemo(
    (): readonly DuplicateGroup<BookmarkItem>[] =>
      activeView.kind === "duplicates" ? resolveDuplicateGroups(tree) : [],
    [activeView.kind, tree],
  );
  const tagNameByKey = useMemo(
    () => new Map(tagDefs.map((tag) => [tag.nameKey, tag.name])),
    [tagDefs],
  );
  const categories = useMemo(
    () => categoryCounts(metas, tree),
    [metas, tree],
  );
  // Autocomplete vocabularies for the search bar: tag display names plus
  // folder titles — fixed roots ("Bookmarks bar"…) are real folders; only
  // the synthetic root has no title and drops out.
  const suggestionSources = useMemo(
    () => ({
      tags: tagDefs.map((tag) => tag.name),
      folders: [...tree.folders.values()]
        .filter((folder) => folder.title !== "")
        .map((folder) => folder.title),
    }),
    [tagDefs, tree.folders],
  );
  const title = viewTitle(activeView, tree, tagDefs);

  // P4.T3 action surface: the toast controller owns notifications and the
  // Undo affordance; dialog targets are plain state so every row menu, the
  // bulk bar, and the keyboard all funnel into the same flows.
  const toastCtl = useUndoToastController();
  /**
   * When the visible toast is an applied-decision toast, this ref holds the
   * decision id its Undo button reverts via REVERT_DECISION; `null` means
   * the toast belongs to a snapshot-stack action (delete/move/tag ops) and
   * Undo goes through the controller's `undoLatest`. `reportToast` disarms
   * it on every new toast — ReviewView arms it via `armDecisionRevert`
   * AFTER its own toast is up (the arming must follow the disarm).
   */
  const decisionRevertRef = useRef<string | null>(null);
  /** Every toast goes through here so a new message disarms a stale revert. */
  const reportToast = useCallback(
    (next: ToastState): void => {
      decisionRevertRef.current = null;
      toastCtl.showToast(next);
    },
    [toastCtl],
  );
  const armDecisionRevert = useCallback((decisionId: string): void => {
    decisionRevertRef.current = decisionId;
  }, []);
  /**
   * The toast's Undo button, dispatched: a decision toast sends
   * REVERT_DECISION for the armed id (the worker replays the snapshot it
   * recorded on that row); anything else pops the snapshot stack.
   */
  const handleToastUndo = useCallback(async (): Promise<void> => {
    const decisionId = decisionRevertRef.current;
    decisionRevertRef.current = null;
    if (decisionId === null) {
      await toastCtl.undo();
      return;
    }
    const result = await sendDecisionMessage(
      DecisionMessage.parse({ type: "REVERT_DECISION", decisionId }),
    );
    reportToast(
      result.ok
        ? { message: "Reverted the suggestion." }
        : { message: result.message, error: true },
    );
  }, [reportToast, toastCtl]);
  const dismissToast = useCallback(() => {
    decisionRevertRef.current = null;
    toastCtl.dismiss();
  }, [toastCtl]);
  /**
   * The ToastContext value: identical API to `toastCtl`, but `showToast`
   * runs through `reportToast` so a deeper component's toast also disarms a
   * stale decision-revert target.
   */
  const providerToast = useMemo<ToastApi>(
    () => ({ showToast: reportToast }),
    [reportToast],
  );
  const [editTarget, setEditTarget] = useState<TreeEntry | null>(null);
  const [summarizeTarget, setSummarizeTarget] = useState<{
    tabId: number;
    item: BookmarkItem;
  } | null>(null);
  const [moveIds, setMoveIds] = useState<readonly string[] | null>(null);
  const [folderRequest, setFolderRequest] = useState<FolderActionRequest | null>(
    null,
  );
  /**
   * The live tree for the storage-change subscription below: that listener is
   * registered once, so it must resolve an arriving id against the tree as it
   * is NOW rather than the one captured at mount.
   */
  const treeRef = useRef(tree);

  /**
   * P5.T1 handoff: the quick-save popup's "Edit that bookmark" stashes the
   * existing node id in `chrome.storage.session` (see
   * `src/entrypoints/popup/chrome.ts`) before opening this panel. Two
   * additive effects cover both orderings:
   *
   *  - the STORAGE subscription below catches a handoff that arrives while
   *    this panel is already open (previously a no-op: the mount/tree effect
   *    only ran on `tree` changes, so an open panel never saw the new id);
   *  - the MOUNT/TREE read catches an id stashed before the panel existed,
   *    which only becomes resolvable once the first `getTree()` lands.
   *
   * In both paths the key is cleared as soon as it is read — unconditionally,
   * before the id is resolved — so a stale id whose bookmark was deleted can
   * never be replayed into a later mount. Absent session storage degrades to
   * `null` / an inert unsubscribe (no-op).
   */
  const openPendingEdit = useCallback((id: string): void => {
    const entry =
      treeRef.current.bookmarks.get(id) ?? treeRef.current.folders.get(id);
    if (entry === undefined) return;
    setEditTarget(entry);
  }, []);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    return onPendingEditId((id) => {
      // Clear first: the id is consumed whether or not it still resolves.
      void clearPendingEditId();
      openPendingEdit(id);
    });
  }, [openPendingEdit]);

  useEffect(() => {
    // Wait for the first `getTree()`: before it lands an id stashed by the
    // popup would look "gone" and be discarded.
    if (tree.folders.size === 0) return;
    let cancelled = false;
    void (async () => {
      const pendingId = await readPendingEditId();
      if (pendingId === null) return;
      await clearPendingEditId();
      if (cancelled) return;
      const entry =
        tree.bookmarks.get(pendingId) ?? tree.folders.get(pendingId);
      if (entry === undefined) return;
      setEditTarget(entry);
    })();
    return () => {
      cancelled = true;
    };
  }, [tree]);

  // Answer the Options page's "delete all extension data" broadcast by closing
  // this panel's Dexie connection; the `useLiveQuery` subscriptions above keep
  // one open, which would otherwise block the database drop forever.
  useEffect(() => registerDbReleaseListener(), []);

  /**
   * `/` focuses the search bar from anywhere in the panel. Guarded exactly
   * like the other global keys: `defaultPrevented` means dnd-kit (or another
   * handler) already claimed the event, and a focus inside any text-entry
   * surface (input/textarea/select/contenteditable) must not be stolen.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // Ctrl/Cmd+K toggles the command palette from anywhere — including
      // from inside text fields (it's a chord, not a printable key).
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === "k" || event.key === "K")
      ) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key !== "/") return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * All opens go through the typed tabs slice (`openBookmarkUrl`) — it
   * applies the shared `isOpenableUrl` denylist (`javascript:`/`data:`
   * refused before reaching `chrome.tabs`) and a typed failure becomes an
   * error toast instead of a silent no-op. Every activation path — Enter,
   * the row "Open" action, DuplicatesView rows, and palette background
   * opens — shares this one guard.
   */
  const openViaTabs = (url: string, active: boolean): void => {
    void openBookmarkUrl(url, active ? "foreground" : "background").then(
      (result) => {
        if (!result.ok) {
          reportToast({ message: result.message, error: true });
        }
      },
    );
  };

  /** Foreground activate: tree rows, DuplicatesView rows, the "Open" action. */
  const openItem = (item: BookmarkItem): void => {
    openViaTabs(item.url, true);
  };

  /**
   * Delete path shared by the bulk bar, row menus and the Delete key: the
   * helper snapshots first, then removes. Deleted ids drop out of every view
   * on the next refetch, so no explicit selection clear is needed.
   */
  const handleDeleteIds = async (ids: readonly string[]): Promise<void> => {
    const result = await deleteNodesWithUndo(ids);
    reportToast({
      message: deleteResultMessage(result),
      undoable: result.deleted > 0,
      error: result.deleted === 0,
    });
  };

  /** Folder menus route moves to the shared dialog, the rest to a prompt. */
  const handleFolderAction = (
    kind: FolderActionKind,
    node: FolderNode,
  ): void => {
    // A folder dialog opening over an open drawer would stack two modals.
    setDrawerOpen(false);
    if (kind === "move") {
      setMoveIds([node.id]);
      return;
    }
    setFolderRequest({ kind, node });
  };

  /**
   * Every scope/chip selection: Review clears any active search so the queue
   * is actually shown (same rule as a palette jump), and the narrow-mode
   * drawer closes once something is chosen.
   */
  const selectView = (next: SidePanelView): void => {
    if (next.kind === "review") setSearchQuery("");
    setView(next);
    setDrawerOpen(false);
  };

  const handleTools = (action: ToolsAction): void => {
    if (action === "import") setImportOpen(true);
    else if (action === "export") setExportOpen(true);
    else if (action === "manage-tags") setTagManagerOpen(true);
    else if (action === "scan") setScanOpen(true);
    else openOptionsPage();
  };

  /**
   * The empty-state block for the active view, or a plain "Loading…" while
   * the tree or the search index is still being built so "No bookmarks yet"
   * never flashes.
   */
  const emptyNode = (() => {
    const loading =
      tree.folders.size === 0 ||
      (activeView.kind === "search" && search === null);
    if (loading) return <EmptyState title="Loading…" />;
    const spec = emptyStateFor(activeView, {
      aiConnected,
      libraryEmpty: tree.bookmarks.size === 0,
    });
    const kind = spec.action?.kind;
    const runAction = (): void => {
      if (kind === "import") handleTools("import");
      else if (kind === "scan") handleTools("scan");
      else if (kind === "set-up-ai") handleTools("set-up-ai");
      else if (kind === "clear-search") setSearchQuery("");
    };
    return (
      <EmptyState
        title={spec.title}
        {...(spec.hint === undefined ? {} : { hint: spec.hint })}
        {...(spec.action === undefined
          ? {}
          : { action: { label: spec.action.label, onSelect: runAction } })}
      />
    );
  })();

  /**
   * Summarize (spec FR10): resolves the active tab inside this click handler
   * (the `activeTab` grant), then opens `SummaryDialog` which sends the
   * explicit LLM_SUMMARIZE intent. A missing/inactive tab is a toast; the
   * dialog itself reports gate/verify outcomes.
   */
  const handleSummarizeItem = async (item: BookmarkItem): Promise<void> => {
    try {
      const query = chrome.tabs?.query;
      const tabs =
        query === undefined
          ? []
          : await query.call(chrome.tabs, {
              active: true,
              currentWindow: true,
            });
      const tabId = tabs[0]?.id;
      if (tabId === undefined) {
        reportToast({
          message: "No active tab to summarize — open the page first.",
          error: true,
        });
        return;
      }
      setSummarizeTarget({ tabId, item });
    } catch {
      reportToast({
        message: "Could not reach the active tab — nothing was sent.",
        error: true,
      });
    }
  };

  /**
   * P4.T3 row action: one ANALYZE_BOOKMARK intent for this bookmark — the
   * worker runs the decision pipeline and persists any suggestions; the
   * reply (suggestion count, a quiet blocklist skip, or the redacted
   * failure) is toasted verbatim.
   */
  const handleAnalyzeItem = async (item: BookmarkItem): Promise<void> => {
    const result = await sendDecisionMessage(
      DecisionMessage.parse({
        type: "ANALYZE_BOOKMARK",
        bookmarkId: item.id,
      }),
    );
    reportToast({
      message: analyzeResultMessage(itemLabel(item), result),
      error: !result.ok,
    });
  };

  const itemActionEntries = (
    item: BookmarkItem,
  ): {
    key: string;
    label: string;
    disabled: boolean;
    destructive?: boolean;
    onSelect: () => void;
  }[] => [
    {
      key: "open",
      label: "Open",
      disabled: !isOpenableUrl(item.url),
      onSelect: () => openItem(item),
    },
    {
      key: "edit",
      label: "Edit…",
      disabled: item.isManaged,
      onSelect: () => setEditTarget(item),
    },
    {
      key: "move",
      label: "Move to…",
      disabled: item.isManaged,
      onSelect: () => setMoveIds([item.id]),
    },
    {
      // Analyze is a suggestion request, not a bookmark mutation — managed
      // rows keep it (policy gates writes, not reads/analysis).
      key: "analyze",
      label: "Analyze",
      disabled: false,
      onSelect: () => void handleAnalyzeItem(item),
    },
    {
      key: "summarize",
      label: "Summarize…",
      disabled: item.isManaged,
      onSelect: () => void handleSummarizeItem(item),
    },
    {
      key: "delete",
      label: "Delete",
      disabled: item.isManaged,
      destructive: true,
      onSelect: () => void handleDeleteIds([item.id]),
    },
  ];

  const itemLabel = (item: BookmarkItem): string =>
    item.title === "" ? item.url : item.title;

  /** Kebab dropdown appended to every bookmark row. */
  const renderItemActions = (item: BookmarkItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${itemLabel(item)}`}
          className={ITEM_KEBAB_CLASS}
          onClick={(event) => event.stopPropagation()}
        >
          ⋯
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {itemActionEntries(item).map((entry) => (
          <DropdownMenuItem
            key={entry.key}
            disabled={entry.disabled}
            title={entry.disabled ? MANAGED_ITEM_TITLE : undefined}
            variant={entry.destructive === true ? "destructive" : "default"}
            onSelect={entry.onSelect}
          >
            {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /** The same entries as right-click context-menu items. */
  const renderItemContextMenu = (item: BookmarkItem) => (
    <>
      {itemActionEntries(item).map((entry) => (
        <ContextMenu.Item
          key={entry.key}
          className={CONTEXT_ITEM_CLASS}
          disabled={entry.disabled}
          title={entry.disabled ? MANAGED_ITEM_TITLE : undefined}
          onSelect={entry.onSelect}
        >
          {entry.label}
        </ContextMenu.Item>
      ))}
    </>
  );

  const scopePane = (
    <ScopePane
      tree={tree}
      view={view}
      tagDefs={tagDefs}
      categories={categories}
      onSelect={selectView}
      renderFolderActions={(node) => (
        <FolderActions node={node} onAction={handleFolderAction} />
      )}
      renderFolderContextMenu={(node) => (
        <FolderActionsContextItems node={node} onAction={handleFolderAction} />
      )}
    />
  );
  const scopeHeading = (
    <ScopeHeading
      title={title}
      drawer={
        wide
          ? undefined
          : {
              open: drawerOpen,
              onOpenChange: setDrawerOpen,
              children: scopePane,
            }
      }
    />
  );

  return (
    <SelectionContext.Provider value={selection}>
      <ToastProvider controller={providerToast}>
        <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
          <TopBar
            search={
              <SearchBar
                ref={searchInputRef}
                value={searchQuery}
                onChange={setSearchQuery}
                onRerankOrder={handleRerankOrder}
                resultCount={
                  searchQuery === ""
                    ? null
                    : search === null
                      ? null
                      : items.length
                }
                sources={suggestionSources}
                askDebounceMs={props?.askDebounceMs}
              />
            }
            visibility={visibility}
            onTools={handleTools}
            onOpenSettings={openOptionsPage}
          />
          <DndProvider tree={tree} selection={selection}>
            <div className="flex min-h-0 flex-1">
              {wide && (
                <aside
                  aria-label="Browse"
                  className="w-56 shrink-0 overflow-y-auto border-r border-border p-2"
                >
                  {scopePane}
                </aside>
              )}
              <section
                aria-label={title}
                className="flex min-w-0 flex-1 flex-col"
              >
                <ViewChips
                  activeKind={view.kind}
                  pendingCount={pendingCount}
                  visibility={visibility}
                  onSelect={(kind) => selectView(makeView(kind))}
                />
                {activeView.kind === "duplicates" ? (
                  <>
                    <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
                      {scopeHeading}
                    </div>
                    <DuplicatesView
                      groups={duplicateGroups}
                      metaById={metaById}
                      tagNameByKey={tagNameByKey}
                      loading={tree.folders.size === 0}
                      onActivateItem={openItem}
                      onRequestUndo={() =>
                        reportToast({
                          message: "Duplicates merged.",
                          undoable: true,
                        })
                      }
                      empty={emptyNode}
                      className="flex-1"
                    />
                  </>
                ) : activeView.kind === "review" ? (
                  // The pending-decisions queue replaces BookmarkList the
                  // same way DuplicatesView does — its rows are Decision
                  // rows from Dexie, not bookmarks.
                  <>
                    <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
                      {scopeHeading}
                    </div>
                    <ReviewView
                      decisions={pendingDecisions}
                      tree={tree}
                      onApplied={armDecisionRevert}
                      empty={emptyNode}
                      className="flex-1"
                    />
                  </>
                ) : activeView.kind === "restructure" ? (
                  // The restructure workflow replaces BookmarkList the same
                  // way ReviewView does — its rows are the job's diff.
                  <>
                    <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
                      {scopeHeading}
                    </div>
                    <RestructureView className="flex-1" />
                  </>
                ) : (
                  <BookmarkList
                    items={items}
                    metaById={metaById}
                    tagNameByKey={tagNameByKey}
                    onActivateItem={openItem}
                    onDeleteSelection={(ids) => void handleDeleteIds(ids)}
                    reorderable={
                      activeView.kind === "all" || activeView.kind === "folder"
                    }
                    renderItemActions={renderItemActions}
                    renderItemContextMenu={renderItemContextMenu}
                    leading={scopeHeading}
                    empty={emptyNode}
                    className="flex-1"
                  />
                )}
                <BulkBar
                  tree={tree}
                  onMoveRequest={(ids) => setMoveIds(ids)}
                />
              </section>
            </div>
          </DndProvider>
        </div>
        <EditDialog
          target={editTarget}
          open={editTarget !== null}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          tree={tree}
          meta={editTarget === null ? undefined : metaById.get(editTarget.id)}
          tagNameByKey={tagNameByKey}
        />
        <SummaryDialog
          open={summarizeTarget !== null}
          tabId={summarizeTarget?.tabId ?? 0}
          bookmarkId={summarizeTarget?.item.id ?? ""}
          bookmarkTitle={
            summarizeTarget === null
              ? ""
              : itemLabel(summarizeTarget.item)
          }
          onClose={() => setSummarizeTarget(null)}
        />
        <MoveToDialog
          open={moveIds !== null}
          onOpenChange={(open) => {
            if (!open) setMoveIds(null);
          }}
          tree={tree}
          ids={moveIds ?? []}
          onMoved={() => selection.clear()}
        />
        <FolderActionDialog
          request={folderRequest}
          tree={tree}
          onClose={() => setFolderRequest(null)}
        />
        <TagManager
          open={tagManagerOpen}
          onOpenChange={setTagManagerOpen}
          onRequestUndo={(info) =>
            reportToast({
              message: `Deleted tag "${info.tag.name}" from ${info.affected} bookmark(s).`,
              undoable: true,
            })
          }
        />
        {/*
          P4.T4 launcher: the dialog is a window onto the live `jobs` row —
          closing it never stops the scan (the worker's runner owns it), and
          reopening renders the running/paused state straight from Dexie.
          "View results" lands on the Review queue, clearing any active
          search so the queue is actually shown.
        */}
        <Dialog open={scanOpen} onOpenChange={setScanOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Scan library</DialogTitle>
              <DialogDescription>
                Analyze every bookmark with the consented provider and queue
                the suggestions for review. Closing this never stops a
                running scan — reopen it to check progress.
              </DialogDescription>
            </DialogHeader>
            <ScanPanel
              bookmarks={scanBookmarks}
              onOpenReview={() => {
                setScanOpen(false);
                setSearchQuery("");
                setView({ kind: "review" });
              }}
            />
          </DialogContent>
        </Dialog>
        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          tree={tree}
        />
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          tree={tree}
          meta={metas}
          tagDefs={tagDefs}
          currentFolderId={view.kind === "folder" ? view.folderId : undefined}
        />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          search={search}
          tree={tree}
          tagDefs={tagDefs}
          onJump={(next) => {
            // A jump is a view switch — clear any active search so the
            // destination is actually shown.
            setSearchQuery("");
            setView(next);
          }}
          onOpenBookmark={(id) => {
            const item = tree.bookmarks.get(id);
            if (item !== undefined) openViaTabs(item.url, true);
          }}
          onBookmarkAction={(id, action) => {
            const item = tree.bookmarks.get(id);
            if (item === undefined) return;
            if (action === "open-background") {
              openViaTabs(item.url, false);
            } else if (action === "reveal") {
              // Jump to the parent folder and select the row.
              setSearchQuery("");
              setView({ kind: "folder", folderId: item.parentId ?? "0" });
              selection.selectOnly(item.id);
            } else if (action === "edit") {
              setEditTarget(item);
            } else {
              // Copy URL — clipboard write rides the user gesture; both
              // outcomes surface through the toast.
              void navigator.clipboard
                .writeText(item.url)
                .then(() =>
                  reportToast({ message: "Copied URL" }),
                )
                .catch((cause: unknown) =>
                  reportToast({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Could not copy the URL",
                    error: true,
                  }),
                );
            }
          }}
          onCommand={(command) => {
            if (command === "import") setImportOpen(true);
            else if (command === "export") setExportOpen(true);
            else if (command === "tag-manager") setTagManagerOpen(true);
            else if (command === "new-folder") {
              // Create under the folder in view, else the bookmarks bar.
              const parent =
                view.kind === "folder"
                  ? tree.folders.get(view.folderId)
                  : undefined;
              const node = parent ?? tree.folders.get("1");
              if (node !== undefined) {
                setFolderRequest({ kind: "create", node });
              }
            } else if (command === "undo") {
              void handleToastUndo();
            } else {
              openOptionsPage();
            }
          }}
        />
        <UndoToast
          toast={toastCtl.toast}
          onUndo={() => void handleToastUndo()}
          onDismiss={dismissToast}
        />
      </ToastProvider>
    </SelectionContext.Provider>
  );
}
