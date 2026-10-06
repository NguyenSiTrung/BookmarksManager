import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  launchExtensionContext,
  extensionId,
  openSurface,
} from "./helpers/extension";
import { createBookmark, createFolder } from "./helpers/seed";
import {
  openMoreView,
  openOptionsPanel,
  openPopupDetails,
  waitForPopupReady,
  waitForSidePanelReady,
} from "./helpers/surfaces";

/**
 * Public Chrome Web Store listing capture.
 *
 * Runs ONLY under `UPDATE_STORE_ASSETS=1`: it launches the production build,
 * seeds a deterministic synthetic tree (no real browsing data, no keys), and
 * screenshots the real UI at the store's 1280×800 size. Everything rendered
 * in the shots is synthetic `*.example` content — no personal data, no
 * provider logos, no test controls.
 *
 * Five shots, in listing order:
 *   1. screenshot-manager-1280x800.png    side panel — tree + virtualized list
 *   2. screenshot-search-1280x800.png     command palette with live results
 *   3. screenshot-duplicates-1280x800.png duplicates view with two groups
 *   4. screenshot-popup-save-1280x800.png quick-save popup mid-save
 *   5. screenshot-options-ai-1280x800.png options — LLM provider disclosure
 *
 * The popup shot frames the real, unmodified popup UI on a flat backdrop so
 * it reads at store scale — the backdrop is the only added visual.
 *
 * Regenerate with:
 *   UPDATE_STORE_ASSETS=1 xvfb-run -a npx playwright test tests/e2e/store-assets.spec.ts
 */
test.skip(
  process.env.UPDATE_STORE_ASSETS !== "1",
  "screenshot capture only runs with UPDATE_STORE_ASSETS=1",
);

// The runner's default action timeout is unlimited — a missing locator must
// fail this maintenance capture, not hang it.
test.use({ actionTimeout: 30_000 });

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

/**
 * Deterministic duplicate rows for the Duplicates shot: one exact URL pair
 * and one tracking-parameter pair (the normalized matcher ignores `utm_*`).
 */
const DUPLICATE_ROWS: [string, string][] = [
  ["Service API reference (saved twice)", "https://work.example/api"],
  [
    "Local-first software — the paper",
    "https://read.example/local-first?utm_source=newsletter",
  ],
];

/**
 * Neutral frame for the popup shot: flat brand backdrop, real popup centered
 * in a card. No product styles are altered — only the page shell around it.
 */
const POPUP_BACKDROP = `
  html, body {
    width: 100% !important;
    height: 100% !important;
    margin: 0 !important;
    background: linear-gradient(135deg, #16305e 0%, #265099 100%) !important;
  }
  body {
    display: flex !important;
    align-items: center;
    justify-content: center;
  }
  #root {
    width: 420px;
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.4);
  }
`;

function shot(page: Page, name: string): Promise<Buffer> {
  return page.screenshot({ path: path.join(OUT_DIR, name) });
}

test("capture the public listing screenshots at 1280×800", async () => {
  // Cold-profile extension launches are slow on modest hardware — the whole
  // five-shot pass can take minutes.
  test.setTimeout(600_000);
  const context = await launchExtensionContext();
  try {
    const id = await extensionId(context);
    mkdirSync(OUT_DIR, { recursive: true });

    // --- 1. side panel manager ------------------------------------------
    const panel = await openSurface(context, id, "sidepanel");
    await panel.setViewportSize({ width: 1280, height: 800 });
    await waitForSidePanelReady(panel);

    const folders: Record<string, string> = {};
    for (const [folder, items] of Object.entries(SEED)) {
      const node = await createFolder(panel, folder);
      folders[folder] = node.id;
      for (const [title, url] of items) {
        await createBookmark(panel, { parentId: node.id, title, url });
      }
    }
    for (const [title, url] of DUPLICATE_ROWS) {
      await createBookmark(panel, { parentId: folders["Reading"], title, url });
    }

    // Re-open so the seeded tree is what the shot renders.
    await panel.reload();
    await waitForSidePanelReady(panel);
    await shot(panel, "screenshot-manager-1280x800.png");

    // --- 2. command palette with live results ---------------------------
    await panel.keyboard.press("Control+k");
    const palette = panel.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    const paletteInput = palette.getByRole("combobox", {
      name: "Command palette",
    });
    await paletteInput.fill("api");
    await expect(palette.getByRole("option").first()).toBeVisible();
    await shot(panel, "screenshot-search-1280x800.png");
    await panel.keyboard.press("Escape");

    // --- 3. duplicates view --------------------------------------------
    await openMoreView(panel, "Duplicates");
    await expect(panel.locator('[aria-label$="duplicate group"]').first())
      .toBeVisible();
    // Park the pointer off the chip row so no hover tooltip lands in the shot.
    await panel.mouse.move(640, 780);
    await panel.waitForTimeout(400);
    await shot(panel, "screenshot-duplicates-1280x800.png");

    // --- 4. quick-save popup -------------------------------------------
    const popup = await openSurface(context, id, "popup");
    await popup.setViewportSize({ width: 1280, height: 800 });
    await waitForPopupReady(popup);
    await popup.getByLabel("Title").fill("Kimchi fried rice — 10 minutes");
    await openPopupDetails(popup);
    await popup.getByLabel("URL").fill("https://cook.example/kimchi-fried-rice");
    await popup.getByLabel("New tag name").fill("recipes");
    await popup.getByRole("button", { name: "Add tag" }).click();
    await expect(popup.getByText("recipes", { exact: true })).toBeVisible();
    await popup.getByLabel("Category").selectOption({ index: 1 });
    await popup
      .getByLabel("Notes")
      .fill("Crispy rice technique and the gochujang ratio.");
    await popup.addStyleTag({ content: POPUP_BACKDROP });
    await shot(popup, "screenshot-popup-save-1280x800.png");
    await popup.close();

    // --- 5. options — LLM provider disclosure --------------------------
    // The disclosure trigger is a <summary> (Disclosure renders
    // <details>/<summary>), so it is matched by tag + text, not by role.
    const options = await openSurface(context, id, "options");
    await options.setViewportSize({ width: 1280, height: 800 });
    await openOptionsPanel(options, "Connections");
    await options
      .locator("summary", { hasText: "What enabling an LLM provider means" })
      .click();
    const disclosure = options.getByRole("region", {
      name: "LLM provider data disclosure",
    });
    await expect(disclosure).toBeVisible();
    await disclosure.scrollIntoViewIfNeeded();
    await shot(options, "screenshot-options-ai-1280x800.png");
  } finally {
    await context.close();
  }
});
