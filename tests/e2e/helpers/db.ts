import type { Page } from "@playwright/test";

/**
 * Raw IndexedDB inspection from an extension page — used to prove the
 * delete-all flow actually drops the extension's own database rather than
 * only flipping the UI. The specs cannot import `src/db/database.ts` into a
 * browser page, so the store is read directly by name (both the database and
 * the `bookmarkMeta` store are part of the app's public storage contract).
 *
 * Both helpers are deliberately NON-CREATING: `indexedDB.open()` on a name
 * that no longer exists creates an empty database, which would (a) make
 * "rows are 0" pass for a database that is merely empty rather than dropped,
 * and (b) leave a stray empty database behind after the spec. `indexedDB
 * .databases()` reports what exists without touching it, so
 * {@link databaseExists} is the assertion the delete-all spec wants.
 */

/** Dexie database name (`src/db/database.ts`). */
export const DB_NAME = "BookmarksManager";

/** `true` when the extension's IndexedDB database exists in this origin. */
export async function databaseExists(page: Page): Promise<boolean> {
  return page.evaluate(async (dbName) => {
    const databases = await indexedDB.databases();
    return databases.some((info) => info.name === dbName);
  }, DB_NAME);
}

/**
 * Rows in the extension's `bookmarkMeta` object store. Returns `0` WITHOUT
 * opening the database when it does not exist (see the module doc), so a
 * dropped database reports `0` and no empty database is created as a side
 * effect. Use {@link databaseExists} to distinguish "dropped" from "empty".
 */
export async function bookmarkMetaCount(page: Page): Promise<number> {
  return page.evaluate(async (dbName) => {
    const databases = await indexedDB.databases();
    if (!databases.some((info) => info.name === dbName)) return 0;
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
