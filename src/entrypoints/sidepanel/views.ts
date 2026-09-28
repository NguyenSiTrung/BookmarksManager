import { groupDuplicates } from "../../duplicates/group";
import type { DuplicateGroup } from "../../duplicates/group";
import type { Category } from "../../schemas/bookmark";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import { runQuery } from "../../search/run";
import type { SearchIndexHandle } from "../../search/run";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { BookmarkItem, FlattenedTree } from "../../sync/tree";

/**
 * View router for the side panel: a discriminated union describing WHAT the
 * bookmark list shows, plus the pure resolution from (view, tree, meta rows)
 * to an ordered `BookmarkItem[]`.
 *
 * Views:
 *  - `all`        — every bookmark in the tree, depth-first order.
 *  - `folder`     — the folder's *subtree* bookmarks (spec §1: "clicking a
 *                   folder shows its bookmarks"). SUBTREE was chosen over
 *                   direct-children so nested folders' contents are visible
 *                   without extra navigation; ordering is depth-first,
 *                   Chrome's `index` order within each level.
 *  - `tag`        — bookmarks whose meta row carries the tag `nameKey`.
 *  - `category`   — bookmarks whose meta row has that `Category`.
 *  - `untagged`   — bookmarks with NO meta row or an EMPTY `tags` list
 *                   (a row that only carries a category/notes still counts
 *                   as untagged).
 *  - `duplicates` — every id appearing in a `groupDuplicates` group of any
 *                   kind; order is group order (exact groups first, then
 *                   normalized), first occurrence wins.
 *  - `review`     — the pending-decisions queue (P4.T3). Its rows are
 *                   `Decision` documents, not bookmarks, so it resolves to
 *                   an empty bookmark list; the shell renders `ReviewView`
 *                   in place of `BookmarkList`, the same swap `duplicates`
 *                   makes.
 *  - `restructure` — the LLM restructure workflow (P5): propose → assign
 *                   → preview → apply. Its rows are the job's diff, not
 *                   bookmarks, so it resolves to an empty bookmark list and
 *                   the shell renders `RestructureView` in place of
 *                   `BookmarkList` — the same swap `review` makes.
 *  - `recent`     — all bookmarks sorted by `dateAdded` descending, capped
 *                   at {@link RECENT_VIEW_LIMIT}.
 *  - `search`     — results of `runQuery` over the whole library for the
 *                   typed query; relevance order for text, tree order for
 *                   filter-only queries. Not tree-ordered, so reorder drop
 *                   slots stay off (the same rule as tag/category/recent).
 *
 * Everything here is pure — no `chrome`, no Dexie, no React — so the same
 * resolution can run in tests, workers, or a future search implementation.
 */
export type SidePanelView =
  | { kind: "all" }
  | { kind: "folder"; folderId: string }
  | { kind: "tag"; nameKey: string }
  | { kind: "category"; category: Category }
  | { kind: "untagged" }
  | { kind: "duplicates" }
  | { kind: "review" }
  | { kind: "restructure" }
  | { kind: "recent" }
  | { kind: "search"; query: string };

export type SidePanelViewKind = SidePanelView["kind"];

/** Cap for the "Recently saved" view. */
export const RECENT_VIEW_LIMIT = 200;

/**
 * Depth-first bookmark ids reachable below `folderId` through `childIds`.
 * Non-folder, missing, and cyclic child ids are skipped defensively. Returns
 * `[]` when `folderId` is not a folder in the tree. `"0"` (the synthetic
 * root) is legal input and yields every bookmark.
 */
export function subtreeBookmarkIds(
  tree: FlattenedTree,
  folderId: string,
): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const folder = tree.folders.get(id);
    if (folder === undefined) return;
    for (const childId of folder.childIds) {
      if (tree.bookmarks.has(childId)) {
        out.push(childId);
      } else {
        walk(childId);
      }
    }
  };
  walk(folderId);
  return out;
}

/**
 * Bookmarks that appear in any duplicate group. `groupDuplicates` emits
 * exact groups first, then normalized ones; an id appearing in several
 * groups keeps its first position.
 */
export function duplicateBookmarkItems(tree: FlattenedTree): BookmarkItem[] {
  const groups = groupDuplicates([...tree.bookmarks.values()]);
  const seen = new Set<string>();
  const out: BookmarkItem[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * Grouped-duplicates resolution for the dedicated duplicates view (P4.T6):
 * the same `groupDuplicates` pass {@link duplicateBookmarkItems} flattens
 * into the generic `duplicates` list, but keeping each group's `kind`/`key`
 * and the full `BookmarkItem` rows — the grouped UI shows exact/normalized
 * badges, the shared key, and per-member folder paths from `item.path`.
 * Exact groups come first, then normalized ones (see `groupDuplicates`).
 * Pure — same purity contract as the rest of this module.
 */
export function resolveDuplicateGroups(
  tree: FlattenedTree,
): DuplicateGroup<BookmarkItem>[] {
  return groupDuplicates([...tree.bookmarks.values()]);
}

/**
 * Resolve a view to an ordered list of bookmarks. `metas` is the flat
 * `bookmarkMeta` table contents (any order); a `Map` is built lazily only
 * for views that join through meta rows. `search` is the live index handle
 * from `useSearchIndex` — required only by the `search` view; while it is
 * still building the view resolves to an empty list.
 */
export function resolveView(
  view: SidePanelView,
  tree: FlattenedTree,
  metas: readonly BookmarkMeta[] = [],
  search?: SearchIndexHandle | null,
): BookmarkItem[] {
  let metaById: Map<string, BookmarkMeta> | undefined;
  const metaOf = (id: string): BookmarkMeta | undefined => {
    metaById ??= new Map(metas.map((meta) => [meta.id, meta]));
    return metaById.get(id);
  };

  switch (view.kind) {
    case "all":
      return [...tree.bookmarks.values()];
    case "folder": {
      const out: BookmarkItem[] = [];
      for (const id of subtreeBookmarkIds(tree, view.folderId)) {
        const item = tree.bookmarks.get(id);
        if (item !== undefined) out.push(item);
      }
      return out;
    }
    case "tag": {
      const out: BookmarkItem[] = [];
      for (const item of tree.bookmarks.values()) {
        if (metaOf(item.id)?.tags.includes(view.nameKey) === true) {
          out.push(item);
        }
      }
      return out;
    }
    case "category": {
      const out: BookmarkItem[] = [];
      for (const item of tree.bookmarks.values()) {
        if (metaOf(item.id)?.category === view.category) {
          out.push(item);
        }
      }
      return out;
    }
    case "untagged": {
      const out: BookmarkItem[] = [];
      for (const item of tree.bookmarks.values()) {
        const meta = metaOf(item.id);
        if (meta === undefined || meta.tags.length === 0) {
          out.push(item);
        }
      }
      return out;
    }
    case "duplicates":
      return duplicateBookmarkItems(tree);
    case "review":
      // The review pane renders `ReviewView` — its rows are Decision rows
      // read from Dexie, not bookmarks — so there is no bookmark list to
      // resolve. Empty also means the shared selection empties, which keeps
      // the bookmark bulk bar out of the review pane.
      return [];
    case "restructure":
      // The restructure pane renders `RestructureView` — its rows are the
      // job's diff, not bookmarks — so there is no bookmark list to
      // resolve. Empty also keeps the bookmark bulk bar out of the pane.
      return [];
    case "recent": {
      return [...tree.bookmarks.values()]
        .sort(
          (a, b) =>
            (b.dateAdded ?? Number.NEGATIVE_INFINITY) -
            (a.dateAdded ?? Number.NEGATIVE_INFINITY),
        )
        .slice(0, RECENT_VIEW_LIMIT);
    }
    case "search": {
      // Index still building (or the query only has whitespace) → nothing
      // to show yet. Hits resolve to live BookmarkItems via the tree so row
      // actions/selection keep working on search results.
      if (search == null || view.query.trim() === "") return [];
      const hits = runQuery(search.index, view.query, search.ctx).hits;
      const out: BookmarkItem[] = [];
      for (const hit of hits) {
        const item = tree.bookmarks.get(hit.id);
        if (item !== undefined) out.push(item);
      }
      return out;
    }
  }
}

/**
 * Human-readable title for a view, used in the right-pane header. `tagDefs`
 * is optional — without it a tag view falls back to the nameKey.
 */
export function viewTitle(
  view: SidePanelView,
  tree: FlattenedTree,
  tagDefs?: readonly TagDef[],
): string {
  switch (view.kind) {
    case "all":
      return "All bookmarks";
    case "folder": {
      if (view.folderId === ROOT_NODE_ID) return "All bookmarks";
      const title = tree.folders.get(view.folderId)?.title;
      return title === undefined || title === "" ? "Folder" : title;
    }
    case "tag": {
      const def = tagDefs?.find((tag) => tag.nameKey === view.nameKey);
      return `#${def?.name ?? view.nameKey}`;
    }
    case "category":
      return view.category.charAt(0).toUpperCase() + view.category.slice(1);
    case "untagged":
      return "Untagged";
    case "duplicates":
      return "Duplicates";
    case "review":
      return "Review suggestions";
    case "restructure":
      return "Restructure library";
    case "recent":
      return "Recently saved";
    case "search": {
      const query = view.query.trim();
      const shown = query.length > 40 ? `${query.slice(0, 40)}…` : query;
      return `Results for “${shown}”`;
    }
  }
}
