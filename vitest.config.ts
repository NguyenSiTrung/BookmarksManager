import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
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
          setupFiles: ["tests/setup-web-locks.ts"],
          include: ["tests/components/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
