import { beforeEach } from "vitest";
import { installWebLocksFake } from "./fakes/web-locks";

/**
 * Registered as `setupFiles` for BOTH Vitest projects (unit/node and
 * components/jsdom) by `vitest.config.ts`.
 *
 * `src/undo/lock.ts` takes one extension-wide exclusive Web Lock around every
 * undo replay/discard path. Neither Node nor jsdom implements
 * `navigator.locks`, so without this fake every existing undo caller would
 * exercise the lock-unavailable refusal branch instead of the real
 * serialization contract. A FRESH fake per test keeps the lock registry from
 * leaking a held/pending request between tests, and tests that need a missing
 * or rejected lock override the installed fake explicitly.
 */
beforeEach(() => {
  installWebLocksFake();
});
