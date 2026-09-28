import { defineConfig } from "vitest/config";

/**
 * Jev evaluation suite — Phase 6. A separate config (like
 * vitest.live.config.ts) so `npm run test` never picks these up: the live
 * sweep hits the real TypeSafe/OpenRouter endpoints and only runs cases for
 * providers whose env key (TYPESAFE_API_KEY / OPENROUTER_API_KEY) is set.
 * The plumbing tests inside run unconditionally. Plain node environment —
 * no extension APIs. Per-case tests are bounded by the client's aborts;
 * 90 s covers a worst-case bounded retry.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/eval/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
