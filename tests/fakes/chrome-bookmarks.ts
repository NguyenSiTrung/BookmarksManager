import { vi } from "vitest";
import {
  BOOKMARKS_BAR_ID,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  ROOT_NODE_ID,
  isFixedRoot,
} from "../../src/sync/chrome-bookmarks";
import type {
  BookmarkCreateDetails,
  BookmarkMoveDestination,
  BookmarkMoveInfo,
  BookmarkReorderInfo,
  BookmarkRemoveInfo,
  BookmarkUpdateChanges,
  BookmarksTreeNode,
  ChromeBookmarksApi,
  ChromeEvent,
  OnChangedListener,
  OnChildrenReorderedListener,
  OnCreatedListener,
  OnMovedListener,
  OnRemovedListener,
} from "../../src/sync/chrome-bookmarks";

/**
 * In-memory `chrome.bookmarks` fake for unit tests. Implements
 * {@link ChromeBookmarksApi} — the exact surface `src/sync/chrome-bookmarks.ts`
 * declares — so callers can either use the fake object directly or stub the
 * global (`installBookmarksFake`) and exercise the slice's wrappers.
 *
 * Contract (mirrors Chrome unless noted):
 *  - Fixed roots "0" (root, children only), "1" (bookmarks bar), "2" (other
 *    bookmarks), "3" (mobile bookmarks). Writes on the roots themselves and
 *    under the root node "0" reject with "Can't modify the root bookmark
 *    folders." Children of "1"/"2"/"3" are writable.
 *  - `unmodifiable: "managed"` nodes and all their descendants reject every
 *    write with "Can't modify managed bookmarks."
 *  - Unknown ids reject with 'Can't find bookmark for id "<id>".'
 *  - `create` defaults `parentId` to "2"; a missing `url` makes a folder.
 *    `index` defaults to append; out-of-range indexes reject "Invalid index."
 *  - `move` requires `parentId` or `index`. `index` is the position in the
 *    destination *after* the node is removed (post-removal indexing), valid
 *    range 0..len; defaults to the end.
 *  - `remove` rejects non-empty folders ("Can't remove a non-empty folder.");
 *    `removeTree` deletes recursively.
 *  - Events fire synchronously during the mutating call (before the returned
 *    promise resolves). `onRemoved` fires once with `removeInfo.node` carrying
 *    the removed node *including descendants*. `onChildrenReordered` is only
 *    emitted via {@link FakeBookmarksApi.simulateChildrenReordered} — Chrome
 *    fires it solely for UI sorting, never for `move()`.
 *  - `get`/`getChildren` return shallow nodes (no `children` populated);
 *    `getTree`/`getSubTree` recurse. All returned nodes are fresh copies.
 *  - `dateAdded` is maintained on every node; `dateGroupModified` updates on a
 *    folder whenever its child list changes. The clock is injectable.
 */

interface FakeNode {
  id: string;
  /** Undefined only on the root node "0". */
  parent?: FakeNode;
  title: string;
  url?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  unmodifiable?: "managed";
  /** Folders only; always present (possibly empty) on folders. */
  children?: FakeNode[];
}

/** Seed shape for pre-populating the tree at construction time. */
export interface FakeBookmarkSeed {
  /** Explicit id; a sequential numeric id is generated when omitted. */
  id?: string;
  title: string;
  /** Absent ⇒ folder; `children` are only meaningful for folders. */
  url?: string;
  unmodifiable?: "managed";
  children?: FakeBookmarkSeed[];
}

export interface FakeBookmarksOptions {
  /** Clock for dateAdded/dateGroupModified; defaults to Date.now. */
  now?: () => number;
  /** Seed children under the bookmarks bar ("1"). */
  bookmarksBar?: FakeBookmarkSeed[];
  /** Seed children under other bookmarks ("2"). */
  otherBookmarks?: FakeBookmarkSeed[];
  /** Seed children under mobile bookmarks ("3"). */
  mobileBookmarks?: FakeBookmarkSeed[];
}

/**
 * The fake's full surface: the typed `chrome.bookmarks` API plus test-only
 * hooks. `install()` stubs `globalThis.chrome` with `{ bookmarks: this }`.
 */
export interface FakeBookmarksApi extends ChromeBookmarksApi {
  /**
   * Chrome-UI-sort equivalent: replaces the folder's child order with the
   * given permutation and fires `onChildrenReordered`. Synchronous — this is
   * a test hook, not part of the real API.
   */
  simulateChildrenReordered(parentId: string, childIds: string[]): void;
  /** `vi.stubGlobal("chrome", { bookmarks: this })` for slice-wrapper tests. */
  install(): void;
}

/** Minimal ChromeEvent implementation: unordered listener set, sync emit. */
class FakeEvent<Listener extends (...args: never[]) => void>
  implements ChromeEvent<Listener>
{
  private readonly listeners = new Set<Listener>();

  addListener(callback: Listener): void {
    this.listeners.add(callback);
  }

  removeListener(callback: Listener): void {
    this.listeners.delete(callback);
  }

  hasListener(callback: Listener): boolean {
    return this.listeners.has(callback);
  }

  /** Copy the set first so a listener may unsubscribe itself mid-emit. */
  emit(...args: Parameters<Listener>): void {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }
}

function nodeNotFoundError(id: string): Error {
  return new Error(`Can't find bookmark for id "${id}".`);
}

class FakeBookmarks implements FakeBookmarksApi {
  readonly onCreated = new FakeEvent<OnCreatedListener>();
  readonly onChanged = new FakeEvent<OnChangedListener>();
  readonly onMoved = new FakeEvent<OnMovedListener>();
  readonly onChildrenReordered =
    new FakeEvent<OnChildrenReorderedListener>();
  readonly onRemoved = new FakeEvent<OnRemovedListener>();

  private readonly nodes = new Map<string, FakeNode>();
  private readonly root: FakeNode;
  private readonly now: () => number;
  private nextId = 1000;

  constructor(options: FakeBookmarksOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.root = this.register({ id: ROOT_NODE_ID, title: "", children: [] });
    const bar = this.addFolder(BOOKMARKS_BAR_ID, "Bookmarks bar", this.root);
    const other = this.addFolder(
      OTHER_BOOKMARKS_ID,
      "Other bookmarks",
      this.root,
    );
    this.addFolder(MOBILE_BOOKMARKS_ID, "Mobile bookmarks", this.root);
    this.seedAll(bar, options.bookmarksBar);
    this.seedAll(other, options.otherBookmarks);
    const mobile = this.nodes.get(MOBILE_BOOKMARKS_ID);
    if (mobile) this.seedAll(mobile, options.mobileBookmarks);
  }

  // -- construction helpers --------------------------------------------------

  private register(node: FakeNode): FakeNode {
    this.nodes.set(node.id, node);
    return node;
  }

  private addFolder(id: string, title: string, parent: FakeNode): FakeNode {
    const folder = this.register({
      id,
      title,
      parent,
      dateAdded: this.now(),
      dateGroupModified: this.now(),
      children: [],
    });
    parent.children?.push(folder);
    return folder;
  }

  private generateId(): string {
    let id = String(this.nextId++);
    while (this.nodes.has(id)) {
      id = String(this.nextId++);
    }
    return id;
  }

  private seedAll(parent: FakeNode, seeds: FakeBookmarkSeed[] = []): void {
    for (const seed of seeds) {
      this.seedNode(parent, seed);
    }
  }

  private seedNode(parent: FakeNode, seed: FakeBookmarkSeed): FakeNode {
    const node = this.register({
      id: seed.id ?? this.generateId(),
      title: seed.title,
      url: seed.url,
      parent,
      dateAdded: this.now(),
      unmodifiable: seed.unmodifiable,
      children: seed.url === undefined ? [] : undefined,
    });
    if (node.url === undefined) {
      node.dateGroupModified = this.now();
    }
    parent.children?.push(node);
    for (const child of seed.children ?? []) {
      this.seedNode(node, child);
    }
    return node;
  }

  // -- lookup and write guards ------------------------------------------------

  private lookup(id: string): FakeNode {
    const node = this.nodes.get(id);
    if (!node) throw nodeNotFoundError(id);
    return node;
  }

  private isInManagedSubtree(node: FakeNode): boolean {
    let current: FakeNode | undefined = node;
    while (current) {
      if (current.unmodifiable === "managed") return true;
      current = current.parent;
    }
    return false;
  }

  /** Guard for writes on the node itself (update/move/remove/removeTree). */
  private assertNodeWritable(node: FakeNode): void {
    if (isFixedRoot(node.id)) {
      throw new Error("Can't modify the root bookmark folders.");
    }
    if (this.isInManagedSubtree(node)) {
      throw new Error("Can't modify managed bookmarks.");
    }
  }

  /** Guard for writes *inside* a folder (create-under / move-into / reorder). */
  private assertWritableParent(parent: FakeNode): FakeNode {
    if (parent.id === ROOT_NODE_ID) {
      throw new Error("Can't modify the root bookmark folders.");
    }
    if (this.isInManagedSubtree(parent)) {
      throw new Error("Can't modify managed bookmarks.");
    }
    if (parent.url !== undefined) {
      throw new Error(
        `Parent id "${parent.id}" is a bookmark, not a folder.`,
      );
    }
    return parent;
  }

  private isDescendant(candidate: FakeNode, ancestor: FakeNode): boolean {
    let current: FakeNode | undefined = candidate;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  }

  private touchGroupModified(folder: FakeNode): void {
    if (folder.url === undefined) {
      folder.dateGroupModified = this.now();
    }
  }

  // -- materialization ---------------------------------------------------------

  /**
   * Fresh snapshot of a node. `deep` recurses into children (getTree,
   * getSubTree, and the onRemoved snapshot); shallow copies omit `children`
   * exactly like Chrome's get/getChildren.
   */
  private materialize(node: FakeNode, deep: boolean): BookmarksTreeNode {
    const result: BookmarksTreeNode = { id: node.id, title: node.title };
    if (node.parent !== undefined) {
      result.parentId = node.parent.id;
      if (node.parent.children !== undefined) {
        result.index = node.parent.children.indexOf(node);
      }
    }
    if (node.url !== undefined) result.url = node.url;
    if (node.dateAdded !== undefined) result.dateAdded = node.dateAdded;
    if (node.dateGroupModified !== undefined) {
      result.dateGroupModified = node.dateGroupModified;
    }
    if (node.unmodifiable !== undefined) {
      result.unmodifiable = node.unmodifiable;
    }
    if (deep && node.children !== undefined) {
      result.children = node.children.map((child) =>
        this.materialize(child, true),
      );
    }
    return result;
  }

  private removeFromParent(node: FakeNode): number {
    const siblings = node.parent?.children;
    const index = siblings ? siblings.indexOf(node) : -1;
    if (siblings && index >= 0) {
      siblings.splice(index, 1);
      this.touchGroupModified(node.parent as FakeNode);
    }
    return index;
  }

  // -- ChromeBookmarksApi ------------------------------------------------------

  async get(idOrIdList: string | string[]): Promise<BookmarksTreeNode[]> {
    const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
    return ids.map((id) => this.materialize(this.lookup(id), false));
  }

  async getChildren(id: string): Promise<BookmarksTreeNode[]> {
    const node = this.lookup(id);
    return (node.children ?? []).map((child) =>
      this.materialize(child, false),
    );
  }

  async getSubTree(id: string): Promise<BookmarksTreeNode[]> {
    return [this.materialize(this.lookup(id), true)];
  }

  async getTree(): Promise<BookmarksTreeNode[]> {
    return [this.materialize(this.root, true)];
  }

  async create(
    bookmark: BookmarkCreateDetails,
  ): Promise<BookmarksTreeNode> {
    const parentId = bookmark.parentId ?? OTHER_BOOKMARKS_ID;
    const parent = this.assertWritableParent(this.lookup(parentId));
    const children = parent.children as FakeNode[];
    const index = bookmark.index ?? children.length;
    if (!Number.isInteger(index) || index < 0 || index > children.length) {
      throw new Error("Invalid index.");
    }
    const node = this.register({
      id: this.generateId(),
      title: bookmark.title ?? "",
      url: bookmark.url,
      parent,
      dateAdded: this.now(),
      unmodifiable: undefined,
      children: bookmark.url === undefined ? [] : undefined,
    });
    if (node.url === undefined) {
      node.dateGroupModified = node.dateAdded;
    }
    children.splice(index, 0, node);
    this.touchGroupModified(parent);
    const snapshot = this.materialize(node, false);
    this.onCreated.emit(node.id, snapshot);
    return snapshot;
  }

  async update(
    id: string,
    changes: BookmarkUpdateChanges,
  ): Promise<BookmarksTreeNode> {
    const node = this.lookup(id);
    this.assertNodeWritable(node);
    if (changes.url !== undefined && node.url === undefined) {
      throw new Error(`Can't set a URL on folder id "${id}".`);
    }
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined) node.url = changes.url;
    const snapshot = this.materialize(node, false);
    const changeInfo: { title: string; url?: string } = {
      title: node.title,
    };
    if (node.url !== undefined) changeInfo.url = node.url;
    this.onChanged.emit(id, changeInfo);
    return snapshot;
  }

  async move(
    id: string,
    destination: BookmarkMoveDestination,
  ): Promise<BookmarksTreeNode> {
    if (destination.parentId === undefined && destination.index === undefined) {
      throw new Error("move requires a parentId and/or an index.");
    }
    const node = this.lookup(id);
    this.assertNodeWritable(node);
    const oldParent = node.parent as FakeNode;
    const oldSiblings = oldParent.children as FakeNode[];
    const oldIndex = oldSiblings.indexOf(node);

    let newParent = oldParent;
    if (destination.parentId !== undefined) {
      const target = this.assertWritableParent(
        this.lookup(destination.parentId),
      );
      if (target === node || this.isDescendant(target, node)) {
        throw new Error(
          `Can't move node "${id}" into itself or a descendant.`,
        );
      }
      newParent = target;
    }

    // Post-removal indexing: `index` is the position in the destination's
    // child list after the node has been taken out of it.
    const destCapacity =
      newParent === oldParent
        ? oldSiblings.length - 1
        : (newParent.children as FakeNode[]).length;
    const index = destination.index ?? destCapacity;
    if (!Number.isInteger(index) || index < 0 || index > destCapacity) {
      throw new Error("Invalid index.");
    }

    oldSiblings.splice(oldIndex, 1);
    (newParent.children as FakeNode[]).splice(index, 0, node);
    node.parent = newParent;
    this.touchGroupModified(oldParent);
    if (newParent !== oldParent) this.touchGroupModified(newParent);

    const snapshot = this.materialize(node, false);
    const moveInfo: BookmarkMoveInfo = {
      parentId: newParent.id,
      index,
      oldParentId: oldParent.id,
      oldIndex,
    };
    this.onMoved.emit(id, moveInfo);
    return snapshot;
  }

  async remove(id: string): Promise<void> {
    const node = this.lookup(id);
    this.assertNodeWritable(node);
    if (node.children !== undefined && node.children.length > 0) {
      throw new Error(
        "Can't remove a non-empty folder. Use removeTree instead.",
      );
    }
    this.detach(id);
  }

  async removeTree(id: string): Promise<void> {
    const node = this.lookup(id);
    this.assertNodeWritable(node);
    this.detach(id);
  }

  /** Shared removal path: splice out, unregister subtree, emit onRemoved. */
  private detach(id: string): void {
    const node = this.lookup(id);
    const parent = node.parent as FakeNode;
    // Deep snapshot must be taken before unlinking (it keeps parentId/index).
    const snapshot = this.materialize(node, true);
    const index = this.removeFromParent(node);
    const removeInfo: BookmarkRemoveInfo = {
      parentId: parent.id,
      index,
      node: snapshot,
    };
    const drop = (victim: FakeNode): void => {
      this.nodes.delete(victim.id);
      for (const child of victim.children ?? []) drop(child);
    };
    drop(node);
    node.parent = undefined;
    this.onRemoved.emit(id, removeInfo);
  }

  // -- test hooks ----------------------------------------------------------------

  simulateChildrenReordered(parentId: string, childIds: string[]): void {
    const parent = this.assertWritableParent(this.lookup(parentId));
    const children = parent.children as FakeNode[];
    const currentIds = new Set(children.map((child) => child.id));
    const isPermutation =
      childIds.length === children.length &&
      childIds.every((childId) => currentIds.has(childId)) &&
      new Set(childIds).size === childIds.length;
    if (!isPermutation) {
      throw new Error(
        `simulateChildrenReordered: childIds must be a permutation of the ` +
          `children of "${parentId}".`,
      );
    }
    const byId = new Map(children.map((child) => [child.id, child]));
    parent.children = childIds.map((childId) => byId.get(childId) as FakeNode);
    this.touchGroupModified(parent);
    const reorderInfo: BookmarkReorderInfo = { childIds: [...childIds] };
    this.onChildrenReordered.emit(parentId, reorderInfo);
  }

  install(): void {
    vi.stubGlobal("chrome", { bookmarks: this });
  }
}

/** Create a fresh fake: fixed roots "0"–"3", optional seed data and clock. */
export function createFakeBookmarks(
  options: FakeBookmarksOptions = {},
): FakeBookmarksApi {
  return new FakeBookmarks(options);
}

/**
 * Create a fake and stub `globalThis.chrome` with `{ bookmarks: fake }` so the
 * wrappers in `src/sync/chrome-bookmarks.ts` exercise it. Tests that need a
 * bigger stub surface can compose `{ bookmarks: fake, ... }` manually — the
 * fake is a plain object.
 */
export function installBookmarksFake(
  options: FakeBookmarksOptions = {},
): FakeBookmarksApi {
  const fake = createFakeBookmarks(options);
  fake.install();
  return fake;
}
