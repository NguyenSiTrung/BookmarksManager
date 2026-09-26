/**
 * Typed `chrome.bookmarks` slice plus promise-based wrappers.
 *
 * This is the only module that knows the shape of the native bookmarks API.
 * `chrome` is declared per the house lazy-slice pattern (see
 * `src/security/keys.ts`): `@types/chrome` declares the namespace but no
 * worker-scope global binding, and WXT's `browser` export captures
 * `globalThis.chrome` at module load — too early for `vi.stubGlobal` in
 * tests. Every function here resolves `chrome.bookmarks` lazily at call time.
 *
 * The in-memory fake in `tests/fakes/chrome-bookmarks.ts` implements
 * {@link ChromeBookmarksApi} exactly, so unit tests exercise the same surface.
 *
 * Chrome references (developer.chrome.com/docs/extensions/reference/api/bookmarks):
 *  - Fixed root ids: "0" root (children only), "1" bookmarks bar,
 *    "2" other bookmarks, "3" mobile bookmarks. Roots and their entries can be
 *    listed but never created/renamed/moved/deleted.
 *  - `unmodifiable: "managed"` marks administrator-controlled nodes; a managed
 *    node and all its descendants reject every write.
 *  - `index` is the dense 0-based position within the parent; mutations
 *    renumber siblings.
 */

// ---------------------------------------------------------------------------
// Node and payload shapes (mirror chrome.bookmarks.* types)
// ---------------------------------------------------------------------------

/** A bookmark tree node, mirroring `chrome.bookmarks.BookmarkTreeNode`. */
export interface BookmarksTreeNode {
  id: string;
  /** Omitted only on the root node "0". */
  parentId?: string;
  /** Omitted only on the root node "0". */
  index?: number;
  title: string;
  /** Absent ⇒ folder. */
  url?: string;
  /** Milliseconds since the epoch. */
  dateAdded?: number;
  /** Milliseconds since the epoch; set when a folder's child list changes. */
  dateGroupModified?: number;
  /** "managed" nodes and their descendants reject all writes. */
  unmodifiable?: "managed";
  /** Populated only by getTree/getSubTree (and onRemoved's snapshot). */
  children?: BookmarksTreeNode[];
}

/** Chrome's own spelling, kept as an alias for callers that prefer it. */
export type BookmarkTreeNode = BookmarksTreeNode;

/** Argument shape for `chrome.bookmarks.create`. */
export interface BookmarkCreateDetails {
  /** Defaults to the Other Bookmarks folder ("2"). */
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
}

/** Argument shape for `chrome.bookmarks.update` (only title/url supported). */
export interface BookmarkUpdateChanges {
  title?: string;
  url?: string;
}

/** Argument shape for `chrome.bookmarks.move`. */
export interface BookmarkMoveDestination {
  parentId?: string;
  index?: number;
}

/** `changeInfo` payload of `bookmarks.onChanged`. */
export interface BookmarkChangeInfo {
  title: string;
  /** Present only for bookmarks (nodes with a url). */
  url?: string;
}

/** `moveInfo` payload of `bookmarks.onMoved`. */
export interface BookmarkMoveInfo {
  parentId: string;
  index: number;
  oldParentId: string;
  oldIndex: number;
}

/** `reorderInfo` payload of `bookmarks.onChildrenReordered`. */
export interface BookmarkReorderInfo {
  /** The folder's child ids in their new order. */
  childIds: string[];
}

/**
 * `removeInfo` payload of `bookmarks.onRemoved`. `node` is the removed node
 * including its full descendant tree, so metadata can be cascade-deleted.
 */
export interface BookmarkRemoveInfo {
  parentId: string;
  index: number;
  node: BookmarksTreeNode;
}

// ---------------------------------------------------------------------------
// Event surface
// ---------------------------------------------------------------------------

export type OnCreatedListener = (id: string, node: BookmarksTreeNode) => void;
export type OnChangedListener = (
  id: string,
  changeInfo: BookmarkChangeInfo,
) => void;
export type OnMovedListener = (id: string, moveInfo: BookmarkMoveInfo) => void;
export type OnChildrenReorderedListener = (
  id: string,
  reorderInfo: BookmarkReorderInfo,
) => void;
export type OnRemovedListener = (
  id: string,
  removeInfo: BookmarkRemoveInfo,
) => void;

/** Minimal shape of a `chrome.events.Event` registration surface. */
export interface ChromeEvent<Listener> {
  addListener(callback: Listener): void;
  removeListener(callback: Listener): void;
  hasListener(callback: Listener): boolean;
}

/**
 * The `chrome.bookmarks` namespace as used by this project. `search`,
 * `getRecent`, and `onImportBegan`/`onImportEnded` are intentionally out of
 * scope for the Phase 1 slice.
 */
export interface ChromeBookmarksApi {
  get(idOrIdList: string | string[]): Promise<BookmarksTreeNode[]>;
  getChildren(id: string): Promise<BookmarksTreeNode[]>;
  getSubTree(id: string): Promise<BookmarksTreeNode[]>;
  getTree(): Promise<BookmarksTreeNode[]>;
  create(bookmark: BookmarkCreateDetails): Promise<BookmarksTreeNode>;
  move(
    id: string,
    destination: BookmarkMoveDestination,
  ): Promise<BookmarksTreeNode>;
  update(
    id: string,
    changes: BookmarkUpdateChanges,
  ): Promise<BookmarksTreeNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
  onCreated: ChromeEvent<OnCreatedListener>;
  onChanged: ChromeEvent<OnChangedListener>;
  onMoved: ChromeEvent<OnMovedListener>;
  onChildrenReordered: ChromeEvent<OnChildrenReorderedListener>;
  onRemoved: ChromeEvent<OnRemovedListener>;
}

declare const chrome: { bookmarks: ChromeBookmarksApi };

// ---------------------------------------------------------------------------
// Fixed roots and node predicates
// ---------------------------------------------------------------------------

export const ROOT_NODE_ID = "0";
export const BOOKMARKS_BAR_ID = "1";
export const OTHER_BOOKMARKS_ID = "2";
export const MOBILE_BOOKMARKS_ID = "3";
export const FIXED_ROOT_IDS: readonly string[] = [
  ROOT_NODE_ID,
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
  MOBILE_BOOKMARKS_ID,
];

/** True for "0"–"3" — the permanent folders Chrome never lets callers write. */
export function isFixedRoot(id: string): boolean {
  return FIXED_ROOT_IDS.includes(id);
}

/** A node without `url` is a folder (mirrors Chrome's convention). */
export function isFolder(node: BookmarksTreeNode): boolean {
  return node.url === undefined;
}

// ---------------------------------------------------------------------------
// Lazy accessor and promise wrappers — callers never repeat `declare const`
// ---------------------------------------------------------------------------

/** Raw access to the typed `chrome.bookmarks` surface, resolved lazily. */
export function getBookmarksApi(): ChromeBookmarksApi {
  return chrome.bookmarks;
}

export function getTree(): Promise<BookmarksTreeNode[]> {
  return getBookmarksApi().getTree();
}

/** Returns a single-element array containing the subtree root. */
export function getSubTree(id: string): Promise<BookmarksTreeNode[]> {
  return getBookmarksApi().getSubTree(id);
}

/**
 * Retrieves nodes by id. Always resolves to an array (even for a single id
 * string); `get` does not populate `children` — use getSubTree for recursion.
 */
export function get(idOrIdList: string | string[]): Promise<BookmarksTreeNode[]> {
  return getBookmarksApi().get(idOrIdList);
}

/** One level of children (shallow nodes, no `children` populated). */
export function getChildren(id: string): Promise<BookmarksTreeNode[]> {
  return getBookmarksApi().getChildren(id);
}

export function create(
  bookmark: BookmarkCreateDetails,
): Promise<BookmarksTreeNode> {
  return getBookmarksApi().create(bookmark);
}

export function update(
  id: string,
  changes: BookmarkUpdateChanges,
): Promise<BookmarksTreeNode> {
  return getBookmarksApi().update(id, changes);
}

export function move(
  id: string,
  destination: BookmarkMoveDestination,
): Promise<BookmarksTreeNode> {
  return getBookmarksApi().move(id, destination);
}

/** Removes a bookmark or an *empty* folder. Use removeTree for non-empty. */
export function remove(id: string): Promise<void> {
  return getBookmarksApi().remove(id);
}

export function removeTree(id: string): Promise<void> {
  return getBookmarksApi().removeTree(id);
}

// ---------------------------------------------------------------------------
// Event subscription helpers — each returns an unsubscribe function
// ---------------------------------------------------------------------------

export function onCreated(listener: OnCreatedListener): () => void {
  const event = getBookmarksApi().onCreated;
  event.addListener(listener);
  return () => {
    event.removeListener(listener);
  };
}

export function onChanged(listener: OnChangedListener): () => void {
  const event = getBookmarksApi().onChanged;
  event.addListener(listener);
  return () => {
    event.removeListener(listener);
  };
}

export function onMoved(listener: OnMovedListener): () => void {
  const event = getBookmarksApi().onMoved;
  event.addListener(listener);
  return () => {
    event.removeListener(listener);
  };
}

export function onChildrenReordered(
  listener: OnChildrenReorderedListener,
): () => void {
  const event = getBookmarksApi().onChildrenReordered;
  event.addListener(listener);
  return () => {
    event.removeListener(listener);
  };
}

export function onRemoved(listener: OnRemovedListener): () => void {
  const event = getBookmarksApi().onRemoved;
  event.addListener(listener);
  return () => {
    event.removeListener(listener);
  };
}
