import type { Page } from "@playwright/test";

/**
 * Seeding and inspection through `chrome.bookmarks` from an extension page.
 *
 * Every helper runs its body inside `page.evaluate`, i.e. inside the real
 * extension context, so the browser dispatches the resulting bookmark events
 * to *all* extension contexts (the service worker and every open page). That
 * is what makes the live-sync specs genuine rather than stubbed: a bookmark
 * created on one page is observed by another page's `onCreated`/`onChanged`
 * listeners.
 *
 * `chrome` is declared as a narrow local slice — the house pattern the app's
 * own modules follow (`@types/chrome` supplies the namespace but no usable
 * global value binding, so the tests declare exactly the surface they call).
 * The declaration is module-scoped and only type-level: the evaluated callback
 * is serialized and re-runs in the page, where the real `chrome` exists.
 */

/** The `chrome.bookmarks` node fields the specs care about. */
export interface BookmarkNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
}

/** Argument shape for `chrome.bookmarks.create`. */
export interface CreateDetails {
  parentId?: string;
  title?: string;
  url?: string;
}

declare const chrome: {
  bookmarks: {
    create(details: CreateDetails): Promise<BookmarkNode>;
    update(
      id: string,
      changes: { title?: string; url?: string },
    ): Promise<BookmarkNode>;
    get(idOrIdList: string): Promise<BookmarkNode[]>;
    getChildren(id: string): Promise<BookmarkNode[]>;
  };
};

/** Chrome's "Other bookmarks" fixed root. */
export const OTHER_BOOKMARKS_ID = "2";

/** Create one bookmark (or folder, when `url` is omitted). */
export async function createBookmark(
  page: Page,
  details: CreateDetails,
): Promise<BookmarkNode> {
  return page.evaluate(async (payload) => {
    const node = await chrome.bookmarks.create(payload);
    return {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      url: node.url,
    };
  }, details);
}

/** Create one folder under `parentId` (Other bookmarks by default). */
export async function createFolder(
  page: Page,
  title: string,
  parentId: string = OTHER_BOOKMARKS_ID,
): Promise<BookmarkNode> {
  return page.evaluate(async (payload) => {
    const node = await chrome.bookmarks.create(payload);
    return {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      url: node.url,
    };
  }, { parentId, title });
}

/**
 * Create `count` bookmarks under Other bookmarks in ONE `page.evaluate`, in
 * batches of 250 concurrent `chrome.bookmarks.create` calls. Titles are
 * `"<titlePrefix><5-digit index>"` (e.g. `Seed 00042`). Returns the created
 * ids in creation order (which is also tree order, since each create appends).
 * Seeding 10k this way measured ~12 s locally; a per-bookmark round trip from
 * the test process would be far slower.
 */
export async function seedManyBookmarks(
  page: Page,
  count: number,
  titlePrefix: string,
): Promise<string[]> {
  return page.evaluate(
    async (payload) => {
      const ids: string[] = [];
      for (let start = 0; start < payload.count; start += 250) {
        const batch = await Promise.all(
          Array.from(
            { length: Math.min(250, payload.count - start) },
            (_, offset) => {
              const index = start + offset;
              return chrome.bookmarks.create({
                parentId: "2",
                title: payload.titlePrefix + String(index).padStart(5, "0"),
                url: `https://seed.example/${index}`,
              });
            },
          ),
        );
        for (const node of batch) ids.push(node.id);
      }
      return ids;
    },
    { count, titlePrefix },
  );
}

/** Rename a node (title and/or url) — the `onChanged` path. */
export async function renameBookmark(
  page: Page,
  id: string,
  changes: { title?: string; url?: string },
): Promise<void> {
  await page.evaluate(async (payload) => {
    await chrome.bookmarks.update(payload.id, payload.changes);
  }, { id, changes });
}

/** Fetch one node by id (no `children`). `null` when it no longer exists. */
export async function getBookmark(
  page: Page,
  id: string,
): Promise<BookmarkNode | null> {
  return page.evaluate(async (bookmarkId) => {
    const nodes = await chrome.bookmarks.get(bookmarkId);
    const node = nodes[0];
    if (node === undefined) return null;
    return {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      url: node.url,
    };
  }, id);
}

/** Shallow children of a folder, in Chrome `index` order. */
export async function getChildren(
  page: Page,
  parentId: string,
): Promise<BookmarkNode[]> {
  return page.evaluate(async (folderId) => {
    const nodes = await chrome.bookmarks.getChildren(folderId);
    return nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      url: node.url,
    }));
  }, parentId);
}

/** The `Imported <…>` folder the import flow creates under Other bookmarks. */
export async function findImportRoot(
  page: Page,
): Promise<BookmarkNode | undefined> {
  const children = await getChildren(page, OTHER_BOOKMARKS_ID);
  return children.find((child) => child.title.startsWith("Imported "));
}

/** One seeded bookmark's id, keyed by its title. */
export async function findBookmarkByTitle(
  page: Page,
  parentId: string,
  title: string,
): Promise<BookmarkNode | undefined> {
  const children = await getChildren(page, parentId);
  return children.find((child) => child.title === title);
}
