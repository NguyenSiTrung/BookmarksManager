import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import { isInternalRequestUrl } from "./helpers/extension";

const extensionDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.output/chrome-mv3",
);

if (!existsSync(extensionDir)) {
  throw new Error(
    `Built extension not found at ${extensionDir} — run \`npm run build\` before the e2e smoke.`,
  );
}

// Headed is the default because MV3 extension loading historically needs a
// real window (CI supplies one via xvfb-run). E2E_HEADLESS=1 opts into
// headless for environments whose Chromium supports it.
const headless = process.env.E2E_HEADLESS === "1";

test("extension loads, renders all three surfaces, and sends no requests", async () => {
  // A cold Chromium profile can take well over the 30s default to register
  // the MV3 service worker — give this spec a larger budget without raising
  // the suite-wide timeout in playwright.config.ts.
  test.setTimeout(90_000);
  // Fresh-install privacy assertion: nothing is consented yet, so the
  // extension may not emit a single outbound request — not even at service-
  // worker startup. Playwright reports page- and service-worker-issued
  // requests on the context; only INTERNAL schemes (chrome-extension:,
  // chrome:, devtools:, data:, blob:, about:) are filtered out, so a request
  // on any other scheme (ws://, wss://, ftp://, …) would fail this assertion
  // too. The filter is shared with the core-manager egress walk
  // (`isInternalRequestUrl` in ./helpers/extension.ts).
  const outboundUrls: string[] = [];
  const recordRequest = (url: string): void => {
    if (!isInternalRequestUrl(url)) {
      outboundUrls.push(url);
    }
  };

  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  context.on("request", (request) => recordRequest(request.url()));
  try {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    const extensionId = new URL(serviceWorker.url()).host;

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      popup.getByRole("heading", { name: "Bookmarks Manager" }),
    ).toBeVisible();
    // P5.T1 replaced the popup's search UI with the quick-save form: title,
    // URL, folder picker, tag entry, category and notes, plus the Save and
    // "Open manager" actions (the fields render once the active-tab prefill
    // and tree load settle).
    await expect(popup.getByLabel("Title")).toBeVisible();
    await expect(popup.getByLabel("URL")).toBeVisible();
    await expect(popup.getByLabel("Folder")).toBeVisible();
    await expect(popup.getByLabel("New tag name")).toBeVisible();
    await expect(popup.getByLabel("Category")).toBeVisible();
    await expect(popup.getByLabel("Notes")).toBeVisible();
    await expect(popup.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Open manager" }),
    ).toBeVisible();

    const sidepanel = await context.newPage();
    await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(
      sidepanel.getByRole("heading", { name: "Bookmarks Manager" }),
    ).toBeVisible();
    await expect(
      sidepanel.getByRole("button", { name: "Review suggestions" }),
    ).toBeVisible();

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(
      options.getByRole("heading", { name: "Bookmarks Manager Options" }),
    ).toBeVisible();
    await expect(options.getByLabel("Provider")).toBeVisible();

    // Give any deferred startup work (timers, microtasks in the worker or
    // pages) a quiet window in which it would fire a request.
    await options.waitForLoadState("networkidle");
  } finally {
    // Closing the context is part of the observation window: any teardown- or
    // unload-time traffic is still recorded before the assertion below.
    await context.close();
  }
  expect(
    outboundUrls,
    "fresh install must not send any outbound (non-internal) request",
  ).toEqual([]);
});
