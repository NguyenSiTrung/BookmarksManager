import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";

const extensionDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.output/chrome-mv3",
);

test("extension loads and renders all three surfaces", async () => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
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
    await expect(popup.getByLabel("Search bookmarks")).toBeVisible();

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
  } finally {
    await context.close();
  }
});
