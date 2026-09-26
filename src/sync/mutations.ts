import { MetaRepoError, patchMeta, putMeta } from "../db/meta";
import type { MetaPatch } from "../db/meta";
import {
  create as apiCreate,
  get as apiGet,
  getChildren as apiGetChildren,
  isFixedRoot,
  isFolder,
  move as apiMove,
  remove as apiRemove,
  removeTree as apiRemoveTree,
  ROOT_NODE_ID,
  update as apiUpdate,
} from "./chrome-bookmarks";
import type {
  BookmarkCreateDetails,
  BookmarkMoveDestination,
  BookmarkUpdateChanges,
  BookmarksTreeNode,
} from "./chrome-bookmarks";

/**
 * Guarded write service over the `chrome.bookmarks` typed slice
 * (`src/sync/chrome-bookmarks.ts`). Chrome enforces its own write rules —
 * fixed roots "0"–"3" are read-only, `unmodifiable: "managed"` nodes and
 * everything under them reject every write — but it reports violations as
 * untyped `Error` rejections, and only *after* the call is dispatched.
 * Callers here get the guard FIRST: every public function verifies the
 * target node (and its ancestor chain, since a managed ancestor anywhere
 * makes a node untouchable) before a single API call is made, and every
 * rejection the service produces is a typed {@link MutationError}.
 *
 * Design rules (locked by tests/unit/sync-mutations.test.ts):
 *
 * - **One error model.** Every rejection is a `MutationError` carrying a
 *   {@link MutationErrorCode}: `root` / `managed` / `not_found` / `invalid`
 *   come from this module's own guards (the API is never called in those
 *   cases — tests assert this with spies), `api` wraps a rejection from the
 *   underlying `chrome.bookmarks` call that slipped past the guards (e.g. a
 *   concurrent tree change between check and write). The wrapped error is
 *   preserved on `cause`.
 * - **Reads before writes.** Guards resolve nodes through `get` and walk
 *   ancestors via `parentId` until the chain ends at the root — the fake in
 *   `tests/fakes/chrome-bookmarks.ts` exercises the exact same path.
 * - **Fixed roots.** Writes ON nodes "0"–"3" reject `root`. Creating or
 *   moving *under* "1"/"2"/"3" is allowed (Chrome's semantics); only the
 *   synthetic root "0" rejects as a parent.
 * - **Index validation is pre-computed.** `create`/`move` bounds are checked
 *   against the destination's child count (`move` uses Chrome's
 *   post-removal indexing: same-parent capacity is `length - 1`), so bad
 *   indexes reject `invalid`, not `api`.
 * - **Metadata sidecar.** `createBookmark`/`createFolder` accept a `meta`
 *   field; `updateBookmark`/`renameFolder` accept a trailing `meta`
 *   argument. The chrome write happens FIRST (it yields the real new id),
 *   then `putMeta` (create — replace semantics) or `patchMeta` (update —
 *   merge semantics) writes under that id. A `MetaRepoError` from the
 *   sidecar surfaces as `MutationError` `invalid` with the repo error on
 *   `cause`; the chrome mutation is NOT rolled back. Meta cleanup on
 *   remove/removeTree is the `onRemoved` cascade's job
 *   (`src/sync/listeners.ts`), not this service's.
 * - **Removal split.** `removeNode` mirrors `chrome.bookmarks.remove`:
 *   leaf bookmarks and *empty* folders only — a non-empty folder rejects
 *   `invalid` pointing at `removeTree`, which deletes whole subtrees
 *   (and works on leaves too).
 * - No `fetch`, no DOM, no mutation of caller objects.
 */

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type MutationErrorCode =
  /** Write targets a fixed root "0"–"3", or parents directly under "0". */
  | "root"
  /** The node — or an ancestor, or the destination subtree — is managed. */
  | "managed"
  /** The node id, parent id, or an ancestor id does not exist. */
  | "not_found"
  /**
   * Structurally impossible request: leaf-as-parent, folder into itself or
   * a descendant, url on a folder, empty move destination, out-of-range
   * index, non-empty folder passed to `removeNode`, or invalid `meta`.
   */
  | "invalid"
  /** Guards passed but the `chrome.bookmarks` call itself rejected. */
  | "api";

/** Rejection for every failure this service produces. */
export class MutationError extends Error {
  readonly code: MutationErrorCode;

  constructor(
    code: MutationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MutationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/**
 * `createBookmark` input. `parentId` is required — callers choose the
 * folder explicitly rather than inheriting Chrome's "2" default. `meta`
 * (when present) is written via `putMeta` under the created node's id.
 */
export interface CreateBookmarkOptions {
  parentId: string;
  title: string;
  url: string;
  index?: number;
  meta?: MetaPatch;
}

/** `createFolder` input — same as {@link CreateBookmarkOptions} minus `url`. */
export interface CreateFolderOptions {
  parentId: string;
  title: string;
  index?: number;
  meta?: MetaPatch;
}

// ---------------------------------------------------------------------------
// Guard internals — every check runs BEFORE the matching API call
// ---------------------------------------------------------------------------

/** One `get` call mapped onto the error model; `role` names the id's job. */
async function requireNode(
  id: string,
  role: string,
): Promise<BookmarksTreeNode> {
  let nodes: BookmarksTreeNode[];
  try {
    nodes = await apiGet(id);
  } catch (cause) {
    throw new MutationError("not_found", `${role} "${id}" does not exist.`, {
      cause,
    });
  }
  const node = nodes[0];
  if (node === undefined) {
    throw new MutationError("not_found", `${role} "${id}" does not exist.`);
  }
  return node;
}

/** Non-lookup API calls (children reads and every write) → `api` on failure. */
async function apiCall<T>(op: () => Promise<T>, what: string): Promise<T> {
  try {
    return await op();
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new MutationError(
      "api",
      `chrome.bookmarks ${what} failed${detail}`,
      { cause },
    );
  }
}

/**
 * `[node, ...ancestors]` walking `parentId` until the chain ends (the root
 * "0" has no parentId). A dangling ancestor id rejects `not_found`.
 */
async function ancestry(node: BookmarksTreeNode): Promise<BookmarksTreeNode[]> {
  const chain = [node];
  let current = node;
  while (current.parentId !== undefined) {
    current = await requireNode(current.parentId, "ancestor");
    chain.push(current);
  }
  return chain;
}

function managedAncestor(
  chain: BookmarksTreeNode[],
): BookmarksTreeNode | undefined {
  return chain.find((node) => node.unmodifiable === "managed");
}

/**
 * Guard for writes ON a node (update/rename/move/remove/removeTree): the
 * node must exist, not be a fixed root, and sit outside every managed
 * subtree. Returns the node for the caller's own checks.
 */
async function writableNode(
  id: string,
  action: string,
): Promise<BookmarksTreeNode> {
  const node = await requireNode(id, "node");
  if (isFixedRoot(node.id)) {
    throw new MutationError(
      "root",
      `Cannot ${action} the fixed root folder "${node.id}".`,
    );
  }
  const managed = managedAncestor(await ancestry(node));
  if (managed !== undefined) {
    throw new MutationError(
      "managed",
      `Cannot ${action} "${id}": it sits inside the managed folder ` +
        `"${managed.id}".`,
    );
  }
  return node;
}

/**
 * Guard for writes INSIDE a folder (create-under / move-into): the parent
 * must exist, not be the synthetic root "0" (children of "1"/"2"/"3" are
 * writable), be a folder, and sit outside every managed subtree. Returns
 * the parent plus its ancestor chain for callers that need both (move's
 * descendant check).
 */
async function writableParent(
  parentId: string,
  action: string,
): Promise<{ parent: BookmarksTreeNode; chain: BookmarksTreeNode[] }> {
  const parent = await requireNode(parentId, "parent");
  if (parent.id === ROOT_NODE_ID) {
    throw new MutationError(
      "root",
      `Cannot ${action} directly under the root node "0".`,
    );
  }
  if (!isFolder(parent)) {
    throw new MutationError(
      "invalid",
      `Cannot ${action} under "${parentId}": it is a bookmark, not a folder.`,
    );
  }
  const chain = await ancestry(parent);
  const managed = managedAncestor(chain);
  if (managed !== undefined) {
    throw new MutationError(
      "managed",
      `Cannot ${action} under "${parentId}": it sits inside the managed ` +
        `folder "${managed.id}".`,
    );
  }
  return { parent, chain };
}

/**
 * Pre-validate an insertion `index` against `parentId`'s child list.
 * `removed` subtracts one from the capacity for same-parent moves (Chrome's
 * post-removal indexing: the node leaves the list before it re-enters).
 */
async function assertIndexInRange(
  index: number,
  parentId: string,
  removed: number,
): Promise<void> {
  const siblings = await apiCall(() => apiGetChildren(parentId), "getChildren");
  const capacity = siblings.length - removed;
  if (!Number.isInteger(index) || index < 0 || index > capacity) {
    throw new MutationError(
      "invalid",
      `Index ${index} is out of range 0..${capacity} for parent ` +
        `"${parentId}".`,
    );
  }
}

/**
 * Metadata sidecar after a successful chrome write. `MetaRepoError`s map to
 * `invalid` (the caller's fields violate the schema); anything else — a
 * storage-level failure — maps to `api`. The chrome mutation is left in
 * place either way: the bookmark exists, its sidecar row does not.
 */
async function writeMeta(
  id: string,
  meta: MetaPatch,
  mode: "put" | "patch",
): Promise<void> {
  try {
    if (mode === "put") {
      await putMeta(id, meta);
    } else {
      await patchMeta(id, meta);
    }
  } catch (cause) {
    const code: MutationErrorCode =
      cause instanceof MetaRepoError ? "invalid" : "api";
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new MutationError(
      code,
      `metadata write failed for "${id}"${detail}`,
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a bookmark (a node carrying `url`) under `options.parentId`.
 * Guards: parent exists (`not_found`), is not the synthetic root "0"
 * (`root`), is a folder, sits outside managed subtrees (`managed`), and
 * `index` fits the parent's child list (`invalid`). When `options.meta` is
 * present it is written via `putMeta` keyed by the created id. Resolves to
 * the created node.
 */
export async function createBookmark(
  options: CreateBookmarkOptions,
): Promise<BookmarksTreeNode> {
  const { parentId } = options;
  await writableParent(parentId, "create");
  if (options.index !== undefined) {
    await assertIndexInRange(options.index, parentId, 0);
  }
  const details: BookmarkCreateDetails = {
    parentId,
    title: options.title,
    url: options.url,
  };
  if (options.index !== undefined) details.index = options.index;
  const created = await apiCall(() => apiCreate(details), "create");
  if (options.meta !== undefined) {
    await writeMeta(created.id, options.meta, "put");
  }
  return created;
}

/**
 * Create a folder (a node without `url`) under `options.parentId`. Same
 * guards and metadata sidecar as {@link createBookmark}.
 */
export async function createFolder(
  options: CreateFolderOptions,
): Promise<BookmarksTreeNode> {
  const { parentId } = options;
  await writableParent(parentId, "create");
  if (options.index !== undefined) {
    await assertIndexInRange(options.index, parentId, 0);
  }
  const details: BookmarkCreateDetails = {
    parentId,
    title: options.title,
  };
  if (options.index !== undefined) details.index = options.index;
  const created = await apiCall(() => apiCreate(details), "create");
  if (options.meta !== undefined) {
    await writeMeta(created.id, options.meta, "put");
  }
  return created;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update a node's `title`/`url` (the only fields Chrome allows). Fixed
 * roots reject `root`, managed nodes and their descendants `managed`,
 * unknown ids `not_found`, and setting a `url` on a folder rejects
 * `invalid` (folders have no url — Chrome would reject the same call).
 * `meta`, when given, is merged via `patchMeta` after the write.
 */
export async function updateBookmark(
  id: string,
  changes: BookmarkUpdateChanges,
  meta?: MetaPatch,
): Promise<BookmarksTreeNode> {
  const node = await writableNode(id, "update");
  if (isFolder(node) && changes.url !== undefined) {
    throw new MutationError(
      "invalid",
      `Cannot set a url on folder "${id}" — folders have no url.`,
    );
  }
  const updated = await apiCall(() => apiUpdate(id, changes), "update");
  if (meta !== undefined) {
    await writeMeta(id, meta, "patch");
  }
  return updated;
}

/**
 * Rename a folder — `updateBookmark` with the folder-kind check inverted:
 * a leaf bookmark id rejects `invalid` (use `updateBookmark` for titles on
 * bookmarks). Same root/managed/not_found guards and `meta` merge.
 */
export async function renameFolder(
  id: string,
  title: string,
  meta?: MetaPatch,
): Promise<BookmarksTreeNode> {
  const node = await writableNode(id, "rename");
  if (!isFolder(node)) {
    throw new MutationError(
      "invalid",
      `Cannot rename folder "${id}": it is a bookmark — use updateBookmark.`,
    );
  }
  const updated = await apiCall(() => apiUpdate(id, { title }), "update");
  if (meta !== undefined) {
    await writeMeta(id, meta, "patch");
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/**
 * Move or reorder a node. `destination` needs `parentId` and/or `index` —
 * neither rejects `invalid`. Guards, in order: the node exists and is not a
 * fixed root or inside a managed subtree; the destination parent (when
 * given) exists, is not the synthetic root "0", is a folder, and is outside
 * managed subtrees; the destination is not the node itself or one of its
 * descendants (`invalid`); and `index` fits post-removal bounds — the
 * destination's child count minus one when the node stays in its parent
 * (`invalid`). Resolves to the moved node.
 */
export async function moveNode(
  id: string,
  destination: BookmarkMoveDestination,
): Promise<BookmarksTreeNode> {
  if (destination.parentId === undefined && destination.index === undefined) {
    throw new MutationError(
      "invalid",
      `moveNode("${id}") requires a parentId and/or an index.`,
    );
  }
  const node = await writableNode(id, "move");
  if (destination.parentId !== undefined) {
    const { chain } = await writableParent(destination.parentId, "move");
    if (chain.some((ancestor) => ancestor.id === node.id)) {
      throw new MutationError(
        "invalid",
        `Cannot move "${id}" into itself or its own descendant ` +
          `"${destination.parentId}".`,
      );
    }
  }
  // `node.parentId` is defined: fixed roots — the only parentless node
  // among them being "0" — were rejected by writableNode.
  const destParentId = destination.parentId ?? node.parentId;
  if (destination.index !== undefined && destParentId !== undefined) {
    const removed = destParentId === node.parentId ? 1 : 0;
    await assertIndexInRange(destination.index, destParentId, removed);
  }
  return apiCall(() => apiMove(id, destination), "move");
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Remove a single node — `chrome.bookmarks.remove` semantics: leaf
 * bookmarks and EMPTY folders only. A folder that still has children
 * rejects `invalid` (use {@link removeTree}); fixed roots reject `root`,
 * managed nodes/descendants `managed`, unknown ids `not_found`. Meta row
 * cleanup is the onRemoved cascade's job (`src/sync/listeners.ts`).
 */
export async function removeNode(id: string): Promise<void> {
  const node = await writableNode(id, "remove");
  if (isFolder(node)) {
    const children = await apiCall(() => apiGetChildren(id), "getChildren");
    if (children.length > 0) {
      throw new MutationError(
        "invalid",
        `Folder "${id}" still has ${children.length} children — use ` +
          `removeTree to delete it with its contents.`,
      );
    }
  }
  await apiCall(() => apiRemove(id), "remove");
}

/**
 * Remove a node and its whole subtree — `chrome.bookmarks.removeTree`
 * semantics (also works on leaf bookmarks). Same root/managed/not_found
 * guards as {@link removeNode}.
 */
export async function removeTree(id: string): Promise<void> {
  await writableNode(id, "remove");
  await apiCall(() => apiRemoveTree(id), "removeTree");
}
