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
 *
 * ## Robustness of the database drop (release + bounded wait)
 *
 * `indexedDB.deleteDatabase` — which is what Dexie's `db.delete()` issues
 * after closing its own connection — is **blocked indefinitely, without
 * rejecting**, while any OTHER extension context still holds an open
 * connection to the database. The side panel keeps one open through
 * `dexie-react-hooks`'s `useLiveQuery`, and the popup keeps one open through
 * its last-used-folder read, so a naive reset with either surface open could
 * sit on "Deleting…" forever. Two independent mitigations are applied:
 *
 *  1. **Cooperative release.** Before touching the database the module
 *     broadcasts {@link RELEASE_DB_MESSAGE} with `chrome.runtime.sendMessage`
 *     and waits {@link DB_RELEASE_GRACE_MS} for the answer. The popup and the
 *     side panel register {@link registerDbReleaseListener} on mount and
 *     respond by calling `db.close()` (with Dexie's default
 *     `disableAutoOpen: true`, so the surface does not silently re-open the
 *     connection on its next query), which removes the connections that
 *     would block the drop. The broadcast is best-effort: no receiving end,
 *     or a context that ignores it, only costs the grace delay. This
 *     listener is registered SEPARATELY from the provider `onMessage`
 *     handler in `src/entrypoints/background.ts`, which stays untouched.
 *  2. **Bounded wait with a typed outcome.** `db.delete()` is raced against
 *     {@link DB_DELETE_TIMEOUT_MS}. If it has not settled by then the reset
 *     reports `databaseDeleted: false` — a typed partial failure — and
 *     continues with the storage and permission steps instead of hanging.
 *     The pending delete request stays queued in the browser, so the
 *     database is still dropped once the blocking connection goes away; the
 *     UI tells the user to close other extension windows and reload.
 *
 * The whole operation is idempotent and safe to leave running, which is why
 * the confirm dialog stays dismissible while it works.
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
  "Provider consent records and the data-sent log",
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

/**
 * The partial-failure notice shown in place of {@link DELETE_ALL_DONE_MESSAGE}
 * when the IndexedDB database could not be dropped inside
 * {@link DB_DELETE_TIMEOUT_MS} (another extension context is holding it open).
 * The rest of the reset has still happened.
 */
export const DELETE_ALL_DATABASE_BLOCKED_MESSAGE =
  "The extension's local database is still open in another Bookmarks Manager window, so it could not be deleted yet. Close any open Bookmarks Manager windows, then reload this page.";

/**
 * The warning shown when one or more granted host permissions could not be
 * released automatically; the origins follow as a list, so the user can
 * revoke them by hand.
 */
export const DELETE_ALL_PERMISSIONS_FAILED_NOTICE =
  "These host permissions could not be released automatically. Revoke them at chrome://extensions:";

/** Outcome of {@link deleteAllExtensionData}. */
export interface DeleteAllResult {
  /**
   * `true` when the extension's IndexedDB database was dropped. `false` is a
   * typed partial failure: the drop was still blocked when
   * {@link DB_DELETE_TIMEOUT_MS} elapsed, so another extension context is
   * holding the database open. Everything else was still wiped.
   */
  databaseDeleted: boolean;
  /** Granted optional host origins whose grant was released. */
  permissionsRemoved: string[];
  /**
   * Granted optional host origins whose release failed. The user can remove
   * them manually from chrome://extensions if needed.
   */
  permissionsFailed: string[];
}

/**
 * Tunables for {@link deleteAllExtensionData}. Both exist so tests can prove
 * the blocked path without waiting on the production delays.
 */
export interface DeleteAllOptions {
  /** Overrides {@link DB_DELETE_TIMEOUT_MS}. */
  databaseTimeoutMs?: number;
  /** Overrides {@link DB_RELEASE_GRACE_MS}. */
  releaseGraceMs?: number;
}

/**
 * The message every other extension context receives before the database is
 * dropped. It carries no payload: the only instruction is "close the shared
 * Dexie connection now".
 */
export const RELEASE_DB_MESSAGE = "bookmarksManager:release-db";

/**
 * How long to wait after broadcasting {@link RELEASE_DB_MESSAGE} before
 * attempting the drop. `db.close()` is synchronous, so this only needs to
 * cover one message round trip; it is deliberately small so the reset stays
 * snappy when nothing is listening.
 */
export const DB_RELEASE_GRACE_MS = 50;

/**
 * How long `db.delete()` may take before the reset reports
 * `databaseDeleted: false` instead of waiting on a blocked drop forever.
 */
export const DB_DELETE_TIMEOUT_MS = 3000;

/**
 * `chrome` is provided by the extension runtime; only the slices this module
 * uses are declared so `vi.stubGlobal("chrome", ...)` works in tests (the
 * same lazy-slice house pattern as `src/security/keys.ts`). `storage.local` /
 * `storage.session` are optional because a test (or an unusual runtime) may
 * omit them; clearing a missing area is a no-op, not an error. `runtime` is
 * optional for the same reason: without it the release broadcast degrades to
 * "wait the grace period and try anyway".
 */
export interface ChromeRuntimeMessageApi {
  addListener(callback: (message: unknown) => void): void;
  removeListener(callback: (message: unknown) => void): void;
}

export interface ChromeRuntimeApi {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage?: ChromeRuntimeMessageApi;
}

declare const chrome: {
  runtime?: ChromeRuntimeApi;
  storage: {
    local?: { clear(): Promise<void> };
    session?: { clear(): Promise<void> };
  };
  permissions: {
    contains(permissions: { origins?: string[] }): Promise<boolean>;
    remove(permissions: { origins?: string[] }): Promise<boolean>;
    /** Optional — when present it enumerates every granted origin, including
     * dynamic custom-provider origins outside `OPTIONAL_HOST_ORIGINS`. */
    getAll?(): Promise<{ permissions?: string[]; origins?: string[] }>;
  };
};

/** Resolve `chrome.runtime` without throwing on a partial/absent surface. */
function runtimeApi(): ChromeRuntimeApi | null {
  try {
    return chrome.runtime ?? null;
  } catch {
    return null;
  }
}

/**
 * Ask every other extension context to close its Dexie connection, then give
 * the listeners {@link DB_RELEASE_GRACE_MS} to run. Total: a missing
 * `chrome.runtime`, a rejected `sendMessage` (no receiving end — the usual
 * case when no other surface is open) and a missing `onMessage` surface all
 * degrade to "just wait the grace period".
 */
export async function requestDbRelease(graceMs: number): Promise<void> {
  const api = runtimeApi();
  if (api !== null) {
    try {
      await api.sendMessage(RELEASE_DB_MESSAGE);
    } catch {
      // No receiving end or a closed channel — nothing to release.
    }
  }
  if (graceMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, graceMs);
  });
}

/**
 * Register the answering half of {@link requestDbRelease} on an extension
 * page: a `chrome.runtime.onMessage` listener that closes THIS page's shared
 * Dexie connection when the release message arrives. Returns an unsubscribe.
 *
 * The listener is registered independently of the provider `onMessage`
 * handler in `src/entrypoints/background.ts` (which is deliberately left
 * untouched), and it answers nothing — the provider handler owns the response
 * channel. Total: a missing `runtime` / `onMessage` surface returns an inert
 * unsubscribe, and a `db` that was never opened (or is already closed) is
 * handled by Dexie's idempotent `close()`.
 */
export function registerDbReleaseListener(): () => void {
  const api = runtimeApi();
  const onMessage = api?.onMessage;
  if (onMessage === undefined) return () => {};

  const listener = (message: unknown): void => {
    if (message !== RELEASE_DB_MESSAGE) return;
    try {
      // `disableAutoOpen` (Dexie's default) is what makes this stick: without
      // it the very next query would silently re-open the connection and
      // block the drop again.
      db.close();
    } catch {
      // Already closed / never opened — nothing to release.
    }
  };

  try {
    onMessage.addListener(listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      onMessage.removeListener(listener);
    } catch {
      // The listener never attached (torn-down surface) — nothing to detach.
    }
  };
}

/**
 * Drop the extension's IndexedDB database with a bounded wait. Resolves
 * `true` when the database is gone and `false` when the drop was still
 * blocked after `timeoutMs` (or rejected) — the typed partial failure
 * {@link DeleteAllResult.databaseDeleted} reports.
 */
async function dropDatabase(timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blocked = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([db.delete().then(() => true as const), blocked]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
 * Origins to try releasing: the preset registry plus every origin
 * `permissions.getAll()` reports as granted — the LLM layer grants
 * user-configured dynamic origins that no static list can name. A missing or
 * failing `getAll` degrades to the registry alone (the original behavior).
 */
async function removableOriginCandidates(): Promise<string[]> {
  const candidates = new Set<string>(OPTIONAL_HOST_ORIGINS);
  const getAll = chrome.permissions.getAll;
  if (getAll !== undefined) {
    try {
      const granted = await getAll.call(chrome.permissions);
      for (const origin of granted.origins ?? []) {
        candidates.add(origin);
      }
    } catch {
      // Fall back to the static registry only.
    }
  }
  return [...candidates];
}

/**
 * Delete every piece of extension-owned data and return the extension to a
 * first-run state. Native Chrome bookmarks are never touched.
 *
 * Steps run in a fixed order — the database and local storage are wiped
 * first, then the granted host permissions are released — so a partial
 * failure still leaves the extension without user data. Two steps are allowed
 * to report partial failures instead of throwing: the database drop (blocked
 * by another open context, reported as `databaseDeleted: false`) and
 * permission removal (a granted origin that cannot be released lands in
 * `permissionsFailed`). See the module doc for the release + bounded-wait
 * strategy behind the database step.
 */
export async function deleteAllExtensionData(
  options: DeleteAllOptions = {},
): Promise<DeleteAllResult> {
  const releaseGraceMs = options.releaseGraceMs ?? DB_RELEASE_GRACE_MS;
  const databaseTimeoutMs = options.databaseTimeoutMs ?? DB_DELETE_TIMEOUT_MS;

  // 1. Ask every other extension context to close its Dexie connection (the
  //    side panel and popup answer `RELEASE_DB_MESSAGE` by calling
  //    `db.close()`), then drop the database with a bounded wait. This also
  //    closes THIS page's `db` connection, so `db` must be re-opened (or the
  //    page reloaded) before any further DB work.
  await requestDbRelease(releaseGraceMs);
  const databaseDeleted = await dropDatabase(databaseTimeoutMs);

  // 2. Clear extension-local storage: settings rows and the provider-key
  //    ciphertext envelopes. `session` is cleared best-effort when present.
  if (chrome.storage.local !== undefined) {
    await chrome.storage.local.clear();
  }
  await clearSessionArea(chrome.storage.session);

  // 3. Release granted optional host permissions, one origin at a time.
  //    Candidates are the preset registry plus every granted origin
  //    `permissions.getAll` reports (dynamic custom LLM origins included).
  //    Origins that were never granted are skipped — there is nothing to
  //    remove and their absence is not a failure.
  const permissionsRemoved: string[] = [];
  const permissionsFailed: string[] = [];
  for (const origin of await removableOriginCandidates()) {
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

  return { databaseDeleted, permissionsRemoved, permissionsFailed };
}
