import { defineConfig } from "@playwright/test";

/**
 * Every spec launches its own persistent context with a throwaway profile
 * (`launchPersistentContext("")` → temp user-data-dir) and every mock server
 * binds port 0, so specs are independent by construction and may run in
 * parallel. `fullyParallel` stays false: within a file, tests share seeded
 * state and `llm.spec.ts` additionally pins `mode: "serial"`.
 *
 * Measured on an 18-CPU box: 1 worker 283 s, 4 workers 112 s, 8 workers ~95 s,
 * all 48 tests passing. 4 is the default so smaller CI runners stay well
 * inside their CPU budget; override with `--workers=N` locally.
 */
const WORKERS = Number(process.env.PLAYWRIGHT_WORKERS ?? 4);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: WORKERS,
  retries: 0,
  reporter: "list",
});
