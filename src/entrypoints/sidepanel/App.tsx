import { useMemo, useState } from "react";
import type { DuplicateGroup } from "../../duplicates/group";
import { DuplicatesView } from "./DuplicatesView";
import { useLiveQuery } from "dexie-react-hooks";
import { listMeta, listTags } from "../../db/meta";
import { Category } from "../../schemas/bookmark";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import type { BookmarkItem } from "../../sync/tree";
import { useBookmarkTree } from "../../ui/hooks/useBookmarkTree";
import {
  BookmarkList,
  SelectionContext,
  useBookmarkSelection,
} from "./BookmarkList";
import { FolderTree } from "./FolderTree";
import { TagManager } from "./TagManager";
import { resolveDuplicateGroups, resolveView, viewTitle } from "./views";
import type { SidePanelView } from "./views";

/**
 * Side-panel application shell — two panes:
 *
 *   ┌─────────────┬──────────────────────────────┐
 *   │ view nav    │  <view title>                │
 *   │ (all/recent/│  ┌──────────────────────────┐ │
 *   │  untagged/  │  │ virtualized BookmarkList │ │
 *   │  duplicates/│  │ (listbox, multi-select)  │ │
 *   │  tags/      │  └──────────────────────────┘ │
 *   │  categories)│                               │
 *   │             │                               │
 *   │ FolderTree  │                               │
 *   │ (ARIA tree) │                               │
 *   └─────────────┴──────────────────────────────┘
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

/** First-class views in the nav (tags/categories/folders generate theirs). */
const FIXED_VIEWS: { kind: SidePanelView["kind"]; label: string }[] = [
  { kind: "all", label: "All bookmarks" },
  { kind: "recent", label: "Recently saved" },
  { kind: "untagged", label: "Untagged" },
  { kind: "duplicates", label: "Duplicates" },
];

const navButtonClass =
  "w-full rounded-sm px-2 py-1 text-left text-sm outline-hidden " +
  "hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "aria-pressed:bg-accent aria-pressed:text-accent-foreground " +
  "aria-pressed:font-medium";

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
    default:
      return { kind: "all" };
  }
}

export function App() {
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

  const [view, setView] = useState<SidePanelView>({ kind: "all" });
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const items = useMemo(
    () => resolveView(view, tree, metas),
    [view, tree, metas],
  );
  const orderedIds = useMemo(() => items.map((item) => item.id), [items]);
  const selection = useBookmarkSelection(orderedIds);
  const metaById = useMemo(
    () => new Map(metas.map((meta) => [meta.id, meta])),
    [metas],
  );
  const duplicateGroups = useMemo(
    (): readonly DuplicateGroup<BookmarkItem>[] =>
      view.kind === "duplicates" ? resolveDuplicateGroups(tree) : [],
    [view.kind, tree],
  );
  const tagNameByKey = useMemo(
    () => new Map(tagDefs.map((tag) => [tag.nameKey, tag.name])),
    [tagDefs],
  );
  const title = viewTitle(view, tree, tagDefs);

  const openItem = (item: BookmarkItem): void => {
    window.open(item.url, "_blank", "noopener,noreferrer");
  };

  return (
    <SelectionContext.Provider value={selection}>
      <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <h1 className="text-sm font-semibold">Bookmarks Manager</h1>
          <button
            type="button"
            disabled
            title="The review queue arrives in a later phase"
            className="ml-auto rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground"
          >
            Review suggestions
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-44 shrink-0 flex-col border-r border-border">
            <nav
              aria-label="Views"
              className="shrink-0 space-y-3 overflow-y-auto p-2"
            >
              <ul className="space-y-0.5">
                {FIXED_VIEWS.map(({ kind, label }) => (
                  <li key={kind}>
                    <button
                      type="button"
                      aria-pressed={view.kind === kind}
                      onClick={() => setView(makeView(kind))}
                      className={navButtonClass}
                    >
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
              <section aria-label="Tag management">
                <button
                  type="button"
                  onClick={() => setTagManagerOpen(true)}
                  className={navButtonClass}
                >
                  Manage tags…
                </button>
              </section>
              {tagDefs.length > 0 && (
                <section aria-label="Tags">
                  <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                    Tags
                  </h2>
                  <ul className="space-y-0.5">
                    {tagDefs.map((tag) => (
                      <li key={tag.nameKey}>
                        <button
                          type="button"
                          aria-pressed={
                            view.kind === "tag" &&
                            view.nameKey === tag.nameKey
                          }
                          onClick={() =>
                            setView({ kind: "tag", nameKey: tag.nameKey })
                          }
                          className={navButtonClass}
                        >
                          <span aria-hidden="true">#</span>
                          {tag.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section aria-label="Categories">
                <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                  Categories
                </h2>
                <ul className="space-y-0.5">
                  {Category.options.map((category) => (
                    <li key={category}>
                      <button
                        type="button"
                        aria-pressed={
                          view.kind === "category" &&
                          view.category === category
                        }
                        onClick={() =>
                          setView({ kind: "category", category })
                        }
                        className={navButtonClass}
                      >
                        {category.charAt(0).toUpperCase() +
                          category.slice(1)}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border p-2">
              <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                Folders
              </h2>
              {tree.folders.size === 0 ? (
                <p className="px-2 text-xs text-muted-foreground">
                  Loading…
                </p>
              ) : (
                <FolderTree
                  tree={tree}
                  selectedFolderId={
                    view.kind === "folder" ? view.folderId : undefined
                  }
                  onSelectFolder={(folderId) =>
                    setView({ kind: "folder", folderId })
                  }
                />
              )}
            </div>
          </aside>
          <section
            aria-label={title}
            className="flex min-w-0 flex-1 flex-col"
          >
            <header className="flex shrink-0 items-baseline gap-2 border-b border-border px-3 py-2">
              <h2 className="text-sm font-medium">{title}</h2>
            </header>
            {view.kind === "duplicates" ? (
              <DuplicatesView
                groups={duplicateGroups}
                metaById={metaById}
                tagNameByKey={tagNameByKey}
                loading={tree.folders.size === 0}
                onActivateItem={openItem}
                className="flex-1"
              />
            ) : (
              <BookmarkList
                items={items}
                metaById={metaById}
                tagNameByKey={tagNameByKey}
                onActivateItem={openItem}
                className="flex-1"
              />
            )}
          </section>
        </div>
        <TagManager open={tagManagerOpen} onOpenChange={setTagManagerOpen} />
      </div>
    </SelectionContext.Provider>
  );
}
