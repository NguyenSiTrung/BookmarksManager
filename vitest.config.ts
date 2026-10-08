import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    /**
     * Vitest's 5 s default is below the real cost of several integration-shaped
     * tests (200-row retention sweeps, 5k-node undo restores) once ~17 worker
     * processes contend for CPU. Under the full parallel run they timed out at
     * 5 s yet passed in isolation — a red gate that was routinely read past.
     * 20 s keeps a genuine hang failing fast while removing the load artifact.
     * Wall-clock budget assertions are handled separately (see the perf specs).
     */
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          setupFiles: ["tests/setup-web-locks.ts"],
          include: ["tests/unit/**/*.test.{ts,tsx}"],
        },
      },
      {
        test: {
          name: "components",
          environment: "jsdom",
          setupFiles: [
            "tests/setup-web-locks.ts",
            "tests/setup-components.ts",
          ],
          include: ["tests/components/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
