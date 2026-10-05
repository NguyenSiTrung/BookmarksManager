import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import {
  EXTENSION_DIR,
  extensionId,
  headlessFromEnv,
  openSurface,
} from "./helpers/extension";
import {
  chooseTool,
  openExportDialog,
  openImportDialog,
  openMoreView,
  waitForSidePanelReady,
} from "./helpers/surfaces";
import { createBookmark, createFolder } from "./helpers/seed";
import { DB_NAME } from "./helpers/db";
import { seedTags } from "./helpers/decisions";

/**
 * Phase 6 checkpoint — automated visual check of the dialog surfaces.
 *
 * For each Chromium color scheme (light and dark via `prefers-color-scheme`
 * emulation) the spec opens the real built extension, renders each dialog
 * this phase touched — the TagManager (U11), the import and export dialogs
 * (I02/I07), and the Approve-all batch confirm (U01) — and captures a
 * full-page PNG under `test-results/dialog-shots/` for review. The shots
 * are the artifact; assertions here only pin that each dialog actually
 * opened and painted (a blank surface fails `toBeVisible`).
 */

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test-results/dialog-shots",
);

const SCHEMES = ["light", "dark"] as const;

for (const scheme of SCHEMES) {
  test(`dialogs render in ${scheme} scheme`, async () => {
    test.setTimeout(120_000);
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: headlessFromEnv(),
      colorScheme: scheme,
      args: [
        `--disable-extensions-except=${EXTENSION_DIR}`,
        `--load-extension=${EXTENSION_DIR}`,
      ],
    });
    try {
      const id = await extensionId(context);
      const page = await openSurface(context, id, "sidepanel");
      await page.setViewportSize({ width: 1024, height: 700 });
      await waitForSidePanelReady(page);

      // Seed content so the dialogs have rows to render: a folder with a
      // bookmark, one tag def, and one pending add_tags decision.
      const folder = await createFolder(page, "Reading");
      const bookmark = await createBookmark(page, {
        parentId: folder.id,
        title: "Pinned article",
        url: "https://visual-check.example/article",
      });
      await seedTags(page, ["reading list"]);
      await page.evaluate(
        async ({ dbName, bookmarkId }) => {
          const database = await new Promise<IDBDatabase>(
            (resolve, reject) => {
              const request = indexedDB.open(dbName);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            },
          );
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = database.transaction("decisions", "readwrite");
              tx.objectStore("decisions").put({
                id: "11111111-2222-4333-8444-555566667777",
                kind: "add_tags",
                bookmarkIds: [bookmarkId],
                tags: ["reading list"],
                confidence: 0.9,
                status: "pending",
                source: {
                  engine: "jev",
                  providerId: "typesafe",
                  model: "jev-1.0.0",
                  questionSetVersion: "qs-1",
                },
                createdAt: new Date().toISOString(),
              });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
              tx.onabort = () => reject(tx.error);
            });
          } finally {
            database.close();
          }
        },
        { dbName: DB_NAME, bookmarkId: bookmark.id },
      );
      await page.reload();
      await waitForSidePanelReady(page);

      mkdirSync(OUT_DIR, { recursive: true });
      const shot = (name: string) =>
        page.screenshot({
          path: path.join(OUT_DIR, `${name}-${scheme}.png`),
        });

      // TagManager — seeded tag row with per-tag editors behind buttons.
      await chooseTool(page, "Manage tags…");
      const tagDialog = page.getByRole("dialog", { name: "Manage tags" });
      await expect(tagDialog).toBeVisible();
      await expect(tagDialog.getByText("reading list")).toBeVisible();
      await shot("tag-manager");
      await page.keyboard.press("Escape");
      await expect(tagDialog).toHaveCount(0);

      // Import dialog — file picker + format note (JSON/CSV/Netscape).
      await openImportDialog(page);
      const importDialog = page.getByRole("dialog");
      await expect(importDialog).toBeVisible();
      await shot("import-dialog");
      await page.keyboard.press("Escape");
      await expect(importDialog).toHaveCount(0);

      // Export dialog — format radios plus the new notes checkbox (I07).
      await openExportDialog(page);
      const exportDialog = page.getByRole("dialog");
      await expect(exportDialog).toBeVisible();
      await shot("export-dialog");
      await page.keyboard.press("Escape");
      await expect(exportDialog).toHaveCount(0);

      // Approve-all batch confirm (U01) — count + per-kind breakdown.
      await openMoreView(page, "Review suggestions");
      await page
        .getByRole("button", { name: /Approve all/ })
        .click();
      const confirmDialog = page.getByRole("dialog");
      await expect(confirmDialog).toBeVisible();
      await expect(
        confirmDialog.getByText(/tag/i).first(),
      ).toBeVisible();
      await shot("approve-all-confirm");
    } finally {
      await context.close();
    }
  });
}
