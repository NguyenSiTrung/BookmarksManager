/**
 * Extension-wide serialization for the undo stack.
 *
 * `src/undo/restore.ts` already orders stack operations with a module-local
 * promise tail, but that only covers ONE module instance: the side panel, the
 * options page, and the service worker each load their own copy of the undo
 * modules over the same IndexedDB database, and each has its own local queue.
 * Two contexts can therefore peek the same stack head and replay it — a double
 * restore that duplicates real `chrome.bookmarks` nodes (B13).
 *
 * This module closes that hole with the platform primitive built for it: one
 * origin-scoped EXCLUSIVE Web Lock (`navigator.locks.request`) under a single
 * stable name, shared by every context of the extension. Every replay/discard
 * path runs inside {@link withUndoLock}, so peek→replay→pop is atomic across
 * contexts.
 *
 * Design rules:
 *
 * - **One name, exclusive.** {@link UNDO_LOCK_NAME} is the only lock the undo
 *   stack uses; all requests take it in `exclusive` mode so a replay and a
 *   discard can never overlap.
 * - **Never recursively acquire.** `navigator.locks.request` is not
 *   re-entrant: a context that requested the lock while holding it would wait
 *   on itself forever. Nested calls from the context that holds the lock (a
 *   caller composing `withUndoLock` around `undoExpected`, say) therefore join
 *   the existing critical section instead of requesting the lock again. This
 *   is safe for cross-context exclusion — while the lock is held, no other
 *   context can enter, so everything running inside the hold is still
 *   serialized against every OTHER context. Same-context ordering remains
 *   `restore.ts`'s module-local queue, which is what it exists for.
 * - **Typed refusal, never a fallback.** A runtime without Web Locks, a
 *   rejected request, or an aborted request raises {@link UndoLockError}
 *   rather than running the critical section unprotected; `restore.ts` maps it
 *   onto the typed `conflict` undo failure.
 * - **Body failures are not lock failures.** The callback's own rejection is
 *   rethrown unchanged, so callers keep seeing their real error (a native
 *   `chrome.bookmarks` failure, say). The lock is released either way, because
 *   the release is driven by the callback's returned promise settling.
 */

/**
 * The one lock name every extension context shares. Stable by contract: two
 * contexts that spell this differently do not exclude each other, so it is
 * never derived from a runtime value.
 */
export const UNDO_LOCK_NAME = "bookmarks-manager:undo";

/**
 * Raised when the extension-wide undo lock cannot be taken — the runtime has no
 * Web Locks, or the platform rejected/aborted the request. The undo layer
 * refuses typed rather than replaying without the lock.
 */
export class UndoLockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UndoLockError";
  }
}

/**
 * Nesting depth of holds inside THIS module instance. Non-zero means the
 * current context is inside its own critical section, so a nested call must
 * run inline instead of requesting the lock again (see the module header).
 */
let holdDepth = 0;

/** The platform lock manager, or `undefined` when this runtime has none. */
function currentLockManager(): LockManager | undefined {
  const navigatorObject = (
    globalThis as { navigator?: { locks?: LockManager } }
  ).navigator;
  const locks = navigatorObject?.locks;
  return locks !== undefined && typeof locks.request === "function"
    ? locks
    : undefined;
}

/**
 * Run `run` inside the extension-wide exclusive undo lock, resolving with its
 * result. A nested call from this same context runs inline (the lock is not
 * re-entrant); a call from another context — or a same-context call made
 * before this one's critical section began — queues on the platform lock.
 * Rejects with {@link UndoLockError} when no lock can be taken, and with the
 * body's own error otherwise.
 */
export function withUndoLock<T>(run: () => Promise<T>): Promise<T> {
  if (holdDepth > 0) {
    holdDepth += 1;
    return Promise.resolve()
      .then(run)
      .finally(() => {
        holdDepth -= 1;
      });
  }

  return Promise.resolve()
    .then(() => {
      const locks = currentLockManager();
      if (locks === undefined) {
        throw new UndoLockError(
          `This runtime has no Web Locks, so the extension-wide undo lock ` +
            `"${UNDO_LOCK_NAME}" cannot be taken and nothing may be replayed.`,
        );
      }
      return locks.request(UNDO_LOCK_NAME, { mode: "exclusive" }, async () => {
        holdDepth += 1;
        try {
          // The wrapper keeps a body failure out of the request rejection
          // path, so only an acquisition failure is ever reported as a lock
          // failure below.
          return { failed: false as const, value: await run() };
        } catch (cause) {
          return { failed: true as const, cause };
        } finally {
          holdDepth -= 1;
        }
      });
    })
    .then(
      (settled) => {
        if (settled.failed) throw settled.cause;
        return settled.value;
      },
      (cause: unknown) => {
        throw cause instanceof UndoLockError
          ? cause
          : new UndoLockError(
              `The extension-wide undo lock "${UNDO_LOCK_NAME}" could not be ` +
                `taken, so nothing was replayed.`,
              { cause },
            );
      },
    );
}
