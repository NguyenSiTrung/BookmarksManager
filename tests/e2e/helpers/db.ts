import type { Page } from "@playwright/test";

/**
 * Raw IndexedDB inspection from an extension page — used to prove the
 * delete-all flow actually drops the extension's own database rather than
 * only flipping the UI. The specs cannot import `src/db/database.ts` into a
 * browser page, so the store is read directly by name (both the database and
 * the `bookmarkMeta` store are part of the app's public storage contract).
 */

/** Dexie database name (`src/db/database.ts`). */
export const DB_NAME = "BookmarksManager";

/**
 * Rows in the extension's `bookmarkMeta` object store. Opening a database
 * that no longer exists creates an empty one with no stores, so a deleted
 * database reports `0` — exactly what the delete-all assertion wants.
 */
export async function bookmarkMetaCount(page: Page): Promise<number> {
  return page.evaluate(async (dbName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains("bookmarkMeta")) return 0;
      return await new Promise<number>((resolve, reject) => {
        const transaction = database.transaction("bookmarkMeta", "readonly");
        const count = transaction.objectStore("bookmarkMeta").count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => reject(count.error);
      });
    } finally {
      database.close();
    }
  }, DB_NAME);
}
