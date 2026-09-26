import { db } from "../db/database";
import { PRESETS } from "../net/presets";

/**
 * "Delete all extension data" (PROJECT_PLAN.md §12): the user-facing reset
 * that removes everything the extension stored for itself and returns it to
 * a first-run state. Zero network — every step is local.
 *
 * What it removes:
 *  1. The extension's IndexedDB database (`db.delete()` on the Dexie instance
 *     in `src/db/database.ts`) — tags, categories, notes, undo snapshots,
 *     imported-file metadata, consent records, the sent log, and the
 *     non-extractable provider CryptoKeys all live there.
 *  2. `chrome.storage.local` (settings rows and provider-key ciphertext
 *     envelopes) and, best-effort, `chrome.storage.session`.
 *  3. Every GRANTED optional host permission (the provider origins from
 *     `optional_host_permissions` in `wxt.config.ts`). Origins that were
 *     never granted are skipped rather than treated as failures.
 *
 * What it deliberately does NOT touch: native Chrome bookmarks. The flow
 * never calls `chrome.bookmarks`, so the user's own bookmarks are
 * byte-identical before and after.
 *
 * Post-delete DB state: Dexie's `delete()` closes the connection and drops
 * the underlying database, so the module-level `db` instance is unusable
 * afterwards. A caller that wants to keep using IndexedDB in the same page
 * lifetime must `db.open()` again (which recreates empty stores); the Options
 * UI instead surfaces the first-run state and asks the user to reload, which
 * is the simplest correct recovery.
 */

/**
 * The optional host origins the extension can hold — exactly the
 * `optional_host_permissions` list in `wxt.config.ts`, derived from the
 * frozen `PRESETS` registry (`permissionPattern` per preset) so the two can
 * never drift apart.
 */
export const OPTIONAL_HOST_ORIGINS: readonly string[] = Object.freeze(
  Object.values(PRESETS).map((preset) => preset.permissionPattern),
);

/**
 * Everything the confirm dialog must list as deleted, in user-facing
 * language. Exported so the UI copy and its tests share one source of truth.
 */
export const DELETE_ALL_ITEMS: readonly string[] = Object.freeze([
  "Tags and categories",
  "Notes you added to bookmarks",
  "Undo history",
  "Imported-file metadata",
  "Saved provider keys and settings",
  "Granted host permissions",
]);

/**
 * The reassurance the confirm dialog must state — native bookmarks survive.
 */
export const NATIVE_BOOKMARKS_NOTICE =
  "Your native Chrome bookmarks are untouched — this deletes only data the extension stored for itself.";

/** The message the UI shows once the reset has completed (first-run state). */
export const DELETE_ALL_DONE_MESSAGE =
  "All extension data has been deleted. The extension is back to its first-run state.";

/** Outcome of {@link deleteAllExtensionData}. */
export interface DeleteAllResult {
  /** Granted optional host origins whose grant was released. */
  permissionsRemoved: string[];
  /**
   * Granted optional host origins whose release failed. The user can remove
   * them manually from chrome://extensions if needed.
   */
  permissionsFailed: string[];
}

/**
 * `chrome` is provided by the extension runtime; only the slices this module
 * uses are declared so `vi.stubGlobal("chrome", ...)` works in tests (the
 * same lazy-slice house pattern as `src/security/keys.ts`). `storage.local` /
 * `storage.session` are optional because a test (or an unusual runtime) may
 * omit them; clearing a missing area is a no-op, not an error.
 */
declare const chrome: {
  storage: {
    local?: { clear(): Promise<void> };
    session?: { clear(): Promise<void> };
  };
  permissions: {
    contains(permissions: { origins?: string[] }): Promise<boolean>;
    remove(permissions: { origins?: string[] }): Promise<boolean>;
  };
};

/** Best-effort clear of one storage area; a missing area is a no-op. */
async function clearSessionArea(
  area: { clear(): Promise<void> } | undefined,
): Promise<void> {
  if (area === undefined) return;
  try {
    await area.clear();
  } catch {
    // Best-effort: a failed session clear must not abort the reset.
  }
}

/** Fail-closed grant check: any API error counts as "not granted". */
async function isOriginGranted(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Delete every piece of extension-owned data and return the extension to a
 * first-run state. Native Chrome bookmarks are never touched.
 *
 * Steps run in a fixed order — the database and local storage are wiped
 * first, then the granted host permissions are released — so a partial
 * failure still leaves the extension without user data. Permission removal is
 * the only step allowed to report partial failures; a granted origin that
 * cannot be released is collected in `permissionsFailed` rather than throwing.
 */
export async function deleteAllExtensionData(): Promise<DeleteAllResult> {
  // 1. Drop the extension's IndexedDB database. This also closes the shared
  //    `db` connection, so `db` must be re-opened (or the page reloaded)
  //    before any further DB work.
  await db.delete();

  // 2. Clear extension-local storage: settings rows and the provider-key
  //    ciphertext envelopes. `session` is cleared best-effort when present.
  if (chrome.storage.local !== undefined) {
    await chrome.storage.local.clear();
  }
  await clearSessionArea(chrome.storage.session);

  // 3. Release granted optional host permissions, one origin at a time.
  //    Origins that were never granted are skipped — there is nothing to
  //    remove and their absence is not a failure.
  const permissionsRemoved: string[] = [];
  const permissionsFailed: string[] = [];
  for (const origin of OPTIONAL_HOST_ORIGINS) {
    if (!(await isOriginGranted(origin))) continue;
    try {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      // `remove` can report false while the grant is already gone; count the
      // step as done when the permission is not held afterwards.
      if (removed === true || !(await isOriginGranted(origin))) {
        permissionsRemoved.push(origin);
      } else {
        permissionsFailed.push(origin);
      }
    } catch {
      permissionsFailed.push(origin);
    }
  }

  return { permissionsRemoved, permissionsFailed };
}
