import { groupDuplicates } from "../../duplicates/group";
import type { Category } from "../../schemas/bookmark";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
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
 *  - `recent`     — all bookmarks sorted by `dateAdded` descending, capped
 *                   at {@link RECENT_VIEW_LIMIT}.
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
  | { kind: "recent" };

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
 * Resolve a view to an ordered list of bookmarks. `metas` is the flat
 * `bookmarkMeta` table contents (any order); a `Map` is built lazily only
 * for views that join through meta rows.
 */
export function resolveView(
  view: SidePanelView,
  tree: FlattenedTree,
  metas: readonly BookmarkMeta[] = [],
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
    case "recent": {
      return [...tree.bookmarks.values()]
        .sort(
          (a, b) =>
            (b.dateAdded ?? Number.NEGATIVE_INFINITY) -
            (a.dateAdded ?? Number.NEGATIVE_INFINITY),
        )
        .slice(0, RECENT_VIEW_LIMIT);
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
    case "recent":
      return "Recently saved";
  }
}
