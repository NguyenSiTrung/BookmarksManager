import { defineConfig } from "vitest/config";

/**
 * Live provider smoke tests — spec FR8. A separate config so the default
 * `npm run test` suite (vitest.config.ts, WXT plugin + jsdom) never picks
 * these up: they hit the real TypeSafe/OpenRouter endpoints and only run via
 * `npm run test:live` when TYPESAFE_API_KEY / OPENROUTER_API_KEY are set in
 * the environment. Plain node environment — no extension APIs are touched.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
