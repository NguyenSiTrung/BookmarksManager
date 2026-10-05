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
 * - **Joining a hold needs its token (D11).** `navigator.locks.request` is
 *   not re-entrant, so work that legitimately belongs inside a critical
 *   section joins it by passing the {@link UndoLockHold} the holder's
 *   callback received as `withUndoLock(fn, hold)`. A call WITHOUT a live
 *   token ALWAYS requests the platform lock — an unrelated same-context
 *   task can no longer slip inside another flow's hold just because a
 *   module-global depth counter was non-zero (the old `holdDepth` model
 *   could not tell "lexically nested" from "concurrently started"; it also
 *   let joined work outlive the hold that admitted it, running unprotected
 *   in its tail). Work joined via a live token is tracked on the hold and
 *   the platform lock is only released after every joiner settles — joined
 *   work is part of the critical section, never a free ride out of it.
 * - **The token is unforgeable.** `UndoLockHold` is a branded interface a
 *   caller can only obtain from inside a granted callback; the module keeps
 *   the set of live holds, and a stale (already-released) token simply
 *   re-requests the lock like any fresh call — it can never bypass.
 * - **Deadlock honesty.** A call awaiting a fresh request while its own
 *   hold is still open waits on itself forever — that is now a caller bug
 *   the API makes explicit (pass the hold) instead of a silent bypass.
 *   Joined work must likewise never await a token-less acquisition.
 * - **Typed refusal, never a fallback.** A runtime without Web Locks, a
 *   rejected request, or an aborted request raises {@link UndoLockError}
 *   rather than running the critical section unprotected; `restore.ts` maps
 *   it onto the typed `conflict` undo failure.
 * - **Body failures are not lock failures.** The callback's own rejection is
 *   rethrown unchanged, so callers keep seeing their real error (a native
 *   `chrome.bookmarks` failure, say). The lock is released either way —
 *   after every joined task has also settled — because the release is
 *   driven by the callback's returned promise settling plus the joiner
 *   drain.
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
 * Brand marker — a real Symbol (inferred `unique symbol`), so the token type
 * is unforgeable at the type level AND the key exists at runtime.
 */
const HOLD_BRAND = Symbol("bookmarks-manager:undo-hold");

/**
 * Proof that the caller's code is running inside a granted critical section.
 * `withUndoLock`'s callback receives the only valid values of this type;
 * pass it as the second argument to a nested `withUndoLock` (or to a
 * restore.ts API that accepts one) to run inside the same hold instead of
 * queueing behind it. A hold is valid only while its section is open.
 */
export interface UndoLockHold {
  readonly [HOLD_BRAND]: true;
}

/** Internal hold record: the public token plus the joiner bookkeeping. */
interface ActiveHold extends UndoLockHold {
  /** Settled-or-pending joiner promises the release must wait out (D11). */
  readonly pending: Set<Promise<unknown>>;
}

/**
 * Holds currently open in THIS module instance. Membership is what makes a
 * token live; a hold is removed only after its section AND its joiners have
 * settled, so a token can never outlive the release that owns it.
 */
const activeHolds = new Set<ActiveHold>();

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
 * result. `run` receives the {@link UndoLockHold}; pass it as `hold` to a
 * nested `withUndoLock` (or a restore API accepting one) to join THIS
 * critical section — the join is tracked and the platform lock releases only
 * once every joiner has settled. A call without a live `hold` always makes a
 * fresh platform request: it queues behind any current holder, and from
 * inside a still-open hold it waits on itself forever — thread the token.
 *
 * Rejects with {@link UndoLockError} when no lock can be taken, and with the
 * body's own error otherwise.
 */
export function withUndoLock<T>(
  run: (hold: UndoLockHold) => Promise<T> | T,
  hold?: UndoLockHold,
): Promise<T> {
  if (hold !== undefined && activeHolds.has(hold as ActiveHold)) {
    // The token is live → this context owns the platform lock right now, so
    // the join runs inline. Track it: the hold does not release while joined
    // work is still running (a joiner's tail must never escape the section).
    const active = hold as ActiveHold;
    const joined = Promise.resolve().then(() => run(active));
    active.pending.add(joined);
    joined.then(
      () => {
        active.pending.delete(joined);
      },
      () => {
        active.pending.delete(joined);
      },
    );
    return joined;
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
        const active: ActiveHold = {
          [HOLD_BRAND]: true,
          pending: new Set(),
        };
        activeHolds.add(active);
        try {
          // The wrapper keeps a body failure out of the request rejection
          // path, so only an acquisition failure is ever reported as a lock
          // failure below.
          return { failed: false as const, value: await run(active) };
        } catch (cause) {
          return { failed: true as const, cause };
        } finally {
          try {
            // Joined work is part of this critical section: the platform
            // lock stays held until every joiner has settled. Joiners may
            // spawn more joiners, so drain to empty rather than settling a
            // single snapshot of the set.
            while (active.pending.size > 0) {
              await Promise.allSettled([...active.pending]);
            }
          } finally {
            activeHolds.delete(active);
          }
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
