import { isFixedRoot, ROOT_NODE_ID } from "./chrome-bookmarks";
import type { BookmarksTreeNode } from "./chrome-bookmarks";

/**
 * Pure read model over a `chrome.bookmarks` tree.
 *
 * `flattenTree` walks a `BookmarksTreeNode[]` forest (the shape returned by
 * `getTree()`/`getSubTree()` on the typed slice) once, depth-first, and splits
 * it into two id-keyed maps: folders and bookmarks. It is deliberately free
 * of `chrome`, DOM, and React so it is cheap to test and safe to call from
 * workers, entrypoints, and hooks alike.
 *
 * Semantics, all documented on the fields below:
 *  - `path` holds ancestor *titles*, topmost first, excluding the synthetic
 *    root "0" (its title is the empty string and it renders as nothing in a
 *    breadcrumb). Titles were chosen over ids because the primary consumer is
 *    "Move to…"-style UI that displays paths to the user.
 *  - `depth` is relative to the supplied forest: top-level nodes are 0. For a
 *    full `getTree()` result that equals Chrome's depth; for a `getSubTree()`
 *    slice it is relative to the subtree root.
 *  - `childIds` (folders only) preserves Chrome's `index` order: when every
 *    child carries a numeric `index` the array is sorted by it; otherwise the
 *    array order is kept verbatim.
 *  - Map iteration order is deterministic depth-first pre-order.
 *  - `isRoot` mirrors `isFixedRoot(id)` (ids "0"–"3" — Chrome's permanent,
 *    read-only folders). `isManaged` is true when the node itself is
 *    `unmodifiable: "managed"` or any ancestor is (propagated down the walk,
 *    equivalent to walking ancestors up).
 */

interface TreeEntryBase {
  id: string;
  /** Undefined only for the top-level nodes of the supplied forest. */
  parentId?: string;
  /** Chrome's dense position within the parent; undefined only at top level. */
  index?: number;
  title: string;
  /** Ancestor titles, topmost first, excluding the synthetic root "0". */
  path: string[];
  /** True for Chrome's fixed folders "0"–"3". */
  isRoot: boolean;
  /** True when this node or any ancestor is `unmodifiable: "managed"`. */
  isManaged: boolean;
  /** Distance below the supplied forest's top level (0-based). */
  depth: number;
}

/** A folder entry: children are referenced by id in Chrome `index` order. */
export interface FolderNode extends TreeEntryBase {
  kind: "folder";
  /** Child ids in Chrome `index` order (empty for leaf folders). */
  childIds: string[];
}

/** A bookmark entry (a node carrying a `url`). */
export interface BookmarkItem extends TreeEntryBase {
  kind: "bookmark";
  url: string;
}

/** Either half of the flattened model. */
export type TreeEntry = FolderNode | BookmarkItem;

/**
 * The flattened read model: two maps keyed by node id. Iteration order of
 * both maps is deterministic depth-first pre-order over the supplied forest.
 */
export interface FlattenedTree {
  folders: Map<string, FolderNode>;
  bookmarks: Map<string, BookmarkItem>;
}

/**
 * Returns `node.children` in Chrome `index` order. Chrome already delivers
 * children ordered by `index`; the explicit sort keeps the contract correct
 * for hand-built input. When any child lacks a numeric `index`, the array
 * order is trusted as-is.
 */
function orderedChildren(node: BookmarksTreeNode): BookmarksTreeNode[] {
  const children = node.children ?? [];
  if (children.every((child) => child.index !== undefined)) {
    return [...children].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }
  return children;
}

/** Flatten a `getTree()`/`getSubTree()`-shaped forest into id-keyed maps. */
export function flattenTree(tree: BookmarksTreeNode[]): FlattenedTree {
  const folders = new Map<string, FolderNode>();
  const bookmarks = new Map<string, BookmarkItem>();

  const visit = (
    node: BookmarksTreeNode,
    path: string[],
    depth: number,
    ancestorManaged: boolean,
  ): void => {
    const isManaged = ancestorManaged || node.unmodifiable === "managed";
    const base: TreeEntryBase = {
      id: node.id,
      parentId: node.parentId,
      index: node.index,
      title: node.title,
      path,
      isRoot: isFixedRoot(node.id),
      isManaged,
      depth,
    };

    const children = orderedChildren(node);
    // The synthetic root never contributes its (empty) title to descendants'
    // paths; every other node's title extends the path of its children.
    const childPath =
      node.id === ROOT_NODE_ID ? path : [...path, node.title];

    if (node.url === undefined) {
      folders.set(node.id, {
        ...base,
        kind: "folder",
        childIds: children.map((child) => child.id),
      });
    } else {
      bookmarks.set(node.id, { ...base, kind: "bookmark", url: node.url });
    }

    for (const child of children) {
      visit(child, childPath, depth + 1, isManaged);
    }
  };

  for (const top of orderedRoots(tree)) {
    visit(top, [], 0, false);
  }

  return { folders, bookmarks };
}

/** Top-level nodes follow the same ordering contract as children arrays. */
function orderedRoots(tree: BookmarksTreeNode[]): BookmarksTreeNode[] {
  if (tree.every((node) => node.index !== undefined)) {
    return [...tree].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }
  return tree;
}
