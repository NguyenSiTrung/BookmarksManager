import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { launchExtensionContext, extensionId, openSurface } from "./helpers/extension";
import { createBookmark, createFolder } from "./helpers/seed";
import { waitForSidePanelReady } from "./helpers/surfaces";

/**
 * Phase 6 — store screenshot capture.
 *
 * Runs ONLY under `UPDATE_STORE_ASSETS=1`: it launches the production build,
 * seeds a deterministic synthetic tree (no real browsing data, no keys), and
 * screenshots the real side-panel manager at the store's 1280×800 size.
 * Everything rendered in the shot is synthetic `*.example` content — no
 * personal data, no provider logos, no test controls.
 */
test.skip(
  process.env.UPDATE_STORE_ASSETS !== "1",
  "screenshot capture only runs with UPDATE_STORE_ASSETS=1",
);

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "store",
  "assets",
);

const SEED: Record<string, [string, string][]> = {
  Work: [
    ["Sprint board — Q3 planning", "https://work.example/sprint"],
    ["Design system documentation", "https://work.example/design-system"],
    ["Service API reference", "https://work.example/api"],
    ["On-call runbook", "https://work.example/runbook"],
  ],
  Reading: [
    ["Local-first software — the paper", "https://read.example/local-first"],
    ["TypeScript 5.9 release notes", "https://read.example/ts-59"],
    ["INP deep dive", "https://read.example/inp"],
    ["Browser storage limits, explained", "https://read.example/storage"],
  ],
  "Dev tools": [
    ["Playwright docs — locators", "https://tools.example/playwright"],
    ["Vite guide — env variables", "https://tools.example/vite-env"],
    ["MDN: Array.prototype.sort", "https://tools.example/mdn-sort"],
    ["caniuse: container queries", "https://tools.example/caniuse-cq"],
  ],
  Recipes: [
    ["Sourdough starter guide", "https://cook.example/sourdough"],
    ["Weeknight pasta — 15 minutes", "https://cook.example/pasta"],
    ["Thai green curry", "https://cook.example/green-curry"],
  ],
};

test("capture the manager screenshot at 1280×800", async () => {
  test.setTimeout(120_000);
  const context = await launchExtensionContext();
  try {
    const id = await extensionId(context);
    const page = await openSurface(context, id, "sidepanel");
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitForSidePanelReady(page);

    for (const [folder, items] of Object.entries(SEED)) {
      const node = await createFolder(page, folder);
      for (const [title, url] of items) {
        await createBookmark(page, { parentId: node.id, title, url });
      }
    }

    // Re-open so the seeded tree is what the shot renders.
    await page.reload();
    await waitForSidePanelReady(page);

    mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(OUT_DIR, "screenshot-manager-1280x800.png"),
    });
  } finally {
    await context.close();
  }
});
