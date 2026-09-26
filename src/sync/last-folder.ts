import { db } from "../db/database";
import { OTHER_BOOKMARKS_ID } from "./chrome-bookmarks";

/**
 * Last-used quick-save folder, persisted for the popup's folder picker
 * (spec §3: "choose a folder (defaults to last used)").
 *
 * Storage choice: the Dexie `metadata` table under the namespaced key
 * `prefs:lastFolderId`. `chrome.storage.local` is RESERVED for encrypted
 * provider-key envelopes (`src/security/keys.ts`), and the `metadata` table is
 * already the extension's settings store — reusing it needs no schema bump
 * (no `version(3)`) and no migration, and the value is wiped together with the
 * rest of the database by "Delete all extension data" (spec §9). Rows are
 * `{ key, value }` with the folder id as a plain string.
 *
 * Every function is total: a missing row, a non-string value, or a storage
 * failure degrades to the caller's default instead of throwing, so a broken
 * database can never stop the popup from saving.
 */

/** Namespaced `metadata` key holding the last-used save folder id. */
export const LAST_FOLDER_KEY = "prefs:lastFolderId";

/** Fallback save folder: Other bookmarks ("2"), Chrome's own create default. */
export const DEFAULT_SAVE_FOLDER_ID = OTHER_BOOKMARKS_ID;

/** The stored last-used folder id, or `null` when none is recorded. */
export async function getLastFolderId(): Promise<string | null> {
  try {
    const row = await db.metadata.get(LAST_FOLDER_KEY);
    const value = row?.value;
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** Record `folderId` as the last-used save folder. Best-effort. */
export async function setLastFolderId(folderId: string): Promise<void> {
  try {
    await db.metadata.put({ key: LAST_FOLDER_KEY, value: folderId });
  } catch {
    // Storage unavailable — the next save simply keeps using the default.
  }
}

/**
 * Resolve the folder the picker should preselect: `lastFolderId` when it still
 * names a folder in the current tree (a stored id whose folder was deleted
 * must not be offered), else {@link DEFAULT_SAVE_FOLDER_ID}. Pure — callers
 * pass `tree.folders.keys()` so this stays free of `chrome` and Dexie.
 */
export function resolveSaveFolder(
  folderIds: ReadonlySet<string>,
  lastFolderId: string | null,
): string {
  if (lastFolderId !== null && folderIds.has(lastFolderId)) {
    return lastFolderId;
  }
  return DEFAULT_SAVE_FOLDER_ID;
}
