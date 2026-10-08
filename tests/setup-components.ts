import { configure } from "@testing-library/dom";

/**
 * Components-project setup (`vitest.config.ts`, jsdom only).
 *
 * Testing Library's `waitFor`/`findBy*` default to a 1 s async timeout. That is
 * fine for a single-process run, but this suite executes ~17 worker processes
 * on one box, and the Radix dialogs in these tests mount, animate and tear down
 * through several async turns. Under contention a 1 s budget expires while the
 * component is merely descheduled — the same load artifact that made the 5 s
 * vitest default too tight (see the `testTimeout` note in `vitest.config.ts`).
 *
 * Raising the wait budget does not weaken any assertion: `waitFor` resolves as
 * soon as its callback passes, so a passing test is not slowed down, and a
 * genuinely broken component still fails — just after a longer wait. The
 * per-assertion intent (what is being awaited) is unchanged.
 */
configure({ asyncUtilTimeout: 5_000 });
