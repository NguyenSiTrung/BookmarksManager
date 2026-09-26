import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { bookmarkMetaCount } from "./helpers/db";
import {
  collectOutboundRequests,
  extensionId,
  launchExtensionContext,
  openSurface,
  startExtension,
} from "./helpers/extension";
import {
  OTHER_BOOKMARKS_ID,
  createBookmark,
  createFolder,
  findBookmarkByTitle,
  findImportRoot,
  getBookmark,
  renameBookmark,
  seedManyBookmarks,
} from "./helpers/seed";
import {
  dismissDialog,
  moveBookmarkViaDialog,
  openExportDialog,
  openImportDialog,
  quickSaveFromPopup,
  waitForPopupReady,
  waitForSidePanelReady,
} from "./helpers/surfaces";

/**
 * Phase 5 Task 6 — real-browser coverage of the core manager.
 *
 * Every spec drives the BUILT extension in a persistent Chromium context (see
 * `./helpers/extension.ts`) and seeds/inspects state through the extension's
 * own `chrome.bookmarks` surface from `page.evaluate` (`./helpers/seed.ts`).
 * That keeps the specs honest: bookmark events really cross extension
 * contexts, so the side panel's live `onCreated`/`onChanged` refetches are
 * exercised rather than stubbed.
 *
 * Cold MV3 service-worker registration dominates the wall clock of every spec
 * (the shell spec raises its budget for the same reason), so each test sets
 * its own generous `test.setTimeout`. The 10k seed additionally costs ~12 s of
 * `chrome.bookmarks.create` time, measured locally.
 *
 * Nothing here fetches: the extension must stay offline and the specs use
 * local temp fixtures plus Blob downloads only.
 */

/** Number of bookmarks the virtualization spec seeds. */
const SEED_COUNT = 10_000;

/**
 * A minimal, schema-valid v1 JSON export: one folder with one bookmark plus a
 * tag definition and its `meta` sidecar. Imports into a new
 * `Imported <…>` folder under Other bookmarks.
 */
const IMPORT_ENVELOPE = {
  version: 1,
  exportedAt: "2026-01-02T03:04:05.000Z",
  tree: [
    {
      id: "imp-folder",
      title: "Round trip folder",
      children: [
        {
          id: "imp-bookmark",
          title: "Round trip bookmark",
          url: "https://roundtrip.example/page",
        },
      ],
    },
  ],
  tags: [
    {
      name: "Round trip tag",
      nameKey: "round trip tag",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    },
  ],
  meta: [
    {
      id: "imp-bookmark",
      tags: ["round trip tag"],
      updatedAt: "2026-01-02T03:04:05.000Z",
    },
  ],
} as const;

/** Write the import fixture into a fresh temp directory. */
function writeImportFixture(dir: string): string {
  const file = path.join(dir, "import.json");
  writeFileSync(file, JSON.stringify(IMPORT_ENVELOPE, null, 2));
  return file;
}

/**
 * Export the whole library as JSON through the Export dialog and read the
 * downloaded file back. `acceptDownloads` defaults on for
 * `launchPersistentContext`, and a Blob + `<a download>` click fires a real
 * Playwright `download` event (verified against the built extension), so no
 * anchor-attribute fallback is needed.
 */
async function exportLibraryJson(
  page: Page,
): Promise<{ name: string; text: string }> {
  await openExportDialog(page);
  await page.getByRole("radio", { name: "JSON (.json)" }).click();
  const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  if (filePath === null) {
    throw new Error("the export download produced no readable file");
  }
  return {
    name: download.suggestedFilename(),
    text: readFileSync(filePath, "utf8"),
  };
}

test("side panel lists externally created bookmarks and updates live on changes", async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  try {
    // A second extension page acts as the "external" writer; the side panel is
    // opened first so its tree is already loaded when the events fire.
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);
    const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    const created = await createBookmark(driver, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Live sync seed",
      url: "https://live-sync.example/one",
    });
    // No reload: the panel's own chrome.bookmarks.onCreated listener refetched
    // the tree and the new row is already there.
    await expect(
      sidepanel.locator(`[data-bookmark-id="${created.id}"]`),
    ).toBeVisible();
    await expect(
      sidepanel.getByText("Live sync seed", { exact: true }),
    ).toBeVisible();

    // Rename from the driver page — the onChanged broadcast path. The panel's
    // title updates in place and the old title disappears.
    await renameBookmark(driver, created.id, { title: "Live sync renamed" });
    await expect(
      sidepanel.getByText("Live sync renamed", { exact: true }),
    ).toBeVisible();
    await expect(
      sidepanel.getByText("Live sync seed", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await ext.context.close();
  }
});

test('moves a bookmark into a folder via "Move to…"', async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  try {
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);
    const folder = await createFolder(driver, "Target folder");
    const bookmark = await createBookmark(driver, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Move me",
      url: "https://move.example/me",
    });

    const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    await moveBookmarkViaDialog(
      sidepanel,
      bookmark.id,
      "Move me",
      "Other bookmarks / Target folder",
    );

    // Native state: the node's parent is the destination folder.
    await expect
      .poll(
        async () => (await getBookmark(driver, bookmark.id))?.parentId,
        { timeout: 15_000 },
      )
      .toBe(folder.id);

    // UI state: selecting the folder shows the row inside its subtree list.
    await sidepanel.getByRole("treeitem", { name: "Target folder" }).click();
    await expect(
      sidepanel.getByRole("heading", { name: "Target folder" }),
    ).toBeVisible();
    await expect(
      sidepanel.locator(`[data-bookmark-id="${bookmark.id}"]`),
    ).toBeVisible();
  } finally {
    await ext.context.close();
  }
});

test("imports a JSON export and round-trips it back out through export", async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  const dir = mkdtempSync(path.join(tmpdir(), "bm-e2e-"));
  try {
    const fixture = writeImportFixture(dir);
    const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    const input = await openImportDialog(sidepanel);
    await input.setInputFiles(fixture);

    // Preview counts come from the plan, before anything is written.
    await expect(sidepanel.getByTestId("import-preview")).toBeVisible();
    await expect(sidepanel.getByTestId("count-folders")).toHaveText("1");
    await expect(sidepanel.getByTestId("count-bookmarks")).toHaveText("1");
    await expect(sidepanel.getByTestId("count-duplicates")).toHaveText("0");
    await expect(sidepanel.getByTestId("count-invalid")).toHaveText("0");

    await sidepanel.getByRole("button", { name: "Confirm import" }).click();
    await expect(sidepanel.getByText("Import complete.")).toBeVisible();
    // One folder + one bookmark created.
    await expect(sidepanel.getByTestId("summary-created")).toHaveText("2");

    // The new `Imported <…>` folder exists under Other bookmarks.
    const importRoot = await findImportRoot(sidepanel);
    expect(importRoot).toBeDefined();
    // And the panel's live tree picked it up (so the export below sees it).
    await expect(
      sidepanel.getByText("Round trip bookmark", { exact: true }),
    ).toBeVisible();

    await dismissDialog(sidepanel);

    const exported = await exportLibraryJson(sidepanel);
    expect(exported.name).toMatch(/^bookmarks-\d{4}-\d{2}-\d{2}\.json$/);
    const envelope = JSON.parse(exported.text) as {
      version: number;
      tree: unknown[];
    };
    expect(envelope.version).toBe(1);
    expect(envelope.tree.length).toBeGreaterThan(0);
    expect(exported.text).toContain("https://roundtrip.example/page");
    expect(exported.text).toContain("Round trip folder");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await ext.context.close();
  }
});

test("delete-all wipes extension data but leaves native bookmarks intact", async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  try {
    const popup = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(popup);
    const seeded = await createBookmark(popup, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Native survivor",
      url: "https://native.example/survivor",
    });
    // Give the extension data of its own: a quick save with a tag writes a
    // `bookmarkMeta` row through the real write path.
    await quickSaveFromPopup(popup, {
      title: "Meta seed",
      url: "https://meta-seed.example/page",
      tag: "keeper",
    });
    expect(await bookmarkMetaCount(popup)).toBeGreaterThan(0);
    // The options page's reset deletes the shared IndexedDB database; an open
    // connection in another page would block that, so close the writer first.
    await popup.close();

    const options = await openSurface(ext.context, ext.id, "options");
    await options
      .getByRole("button", { name: "Delete all extension data", exact: true })
      .click();
    await options.getByRole("button", { name: "Delete everything" }).click();
    await expect(
      options.getByText("All extension data has been deleted."),
    ).toBeVisible();

    // Native Chrome bookmarks survive byte-for-byte...
    expect(await getBookmark(options, seeded.id)).not.toBeNull();
    // ...while the extension's own metadata is gone (the database is dropped,
    // so the store no longer exists and the raw count reads 0).
    expect(await bookmarkMetaCount(options)).toBe(0);
  } finally {
    await ext.context.close();
  }
});

test("renders a 10k-bookmark library through a bounded virtualized window", async () => {
  // Seeding 10,000 bookmarks (~12 s locally) plus the cold worker start is why
  // this spec carries a large budget.
  test.setTimeout(120_000);
  const ext = await startExtension();
  try {
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);

    // Batched inside ONE evaluate (see `seedManyBookmarks`): 10k test-side
    // round trips would be far slower.
    const startedAt = Date.now();
    const ids = await seedManyBookmarks(driver, SEED_COUNT, "Seed ");
    console.log(
      `seeded ${ids.length} bookmarks in ${Date.now() - startedAt} ms`,
    );
    const lastId = ids[ids.length - 1];
    if (lastId === undefined) throw new Error("the 10k seed produced no ids");
    expect(ids).toHaveLength(SEED_COUNT);

    const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);
    await expect(sidepanel.getByText(`${SEED_COUNT} items`)).toBeVisible();
    await sidepanel.locator("[data-bookmark-id]").first().waitFor();

    // The virtualizer keeps only the visible window (plus overscan) mounted.
    const renderedRows = await sidepanel.locator("[data-bookmark-id]").count();
    expect(renderedRows).toBeLessThan(200);

    // Scrolling to the end mounts the final row, proving the window follows
    // the scroll position across the whole list.
    await sidepanel.getByTestId("bookmark-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(
      sidepanel.locator(`[data-bookmark-id="${lastId}"]`),
    ).toBeVisible();
    await expect(sidepanel.getByText("Seed 09999", { exact: true })).toBeVisible();
  } finally {
    await ext.context.close();
  }
});

test("sends no http(s) requests while every core feature is exercised", async () => {
  test.setTimeout(120_000);
  const context = await launchExtensionContext();
  const requests = collectOutboundRequests(context);
  const dir = mkdtempSync(path.join(tmpdir(), "bm-e2e-"));
  try {
    const id = await extensionId(context);

    // 1. Popup quick save (bookmark + meta sidecar).
    const popup = await openSurface(context, id, "popup");
    await waitForPopupReady(popup);
    await quickSaveFromPopup(popup, {
      title: "Egress popup save",
      url: "https://egress.example/popup",
      tag: "egress",
    });
    await popup.close();

    // 2. Side panel browse + "Move to…".
    const sidepanel = await openSurface(context, id, "sidepanel");
    await waitForSidePanelReady(sidepanel);
    await createFolder(sidepanel, "Egress target");
    const saved = await findBookmarkByTitle(
      sidepanel,
      OTHER_BOOKMARKS_ID,
      "Egress popup save",
    );
    if (saved === undefined) {
      throw new Error("the popup save was not visible in the bookmark tree");
    }
    await moveBookmarkViaDialog(
      sidepanel,
      saved.id,
      "Egress popup save",
      "Other bookmarks / Egress target",
    );

    // 3. Import a JSON export fixture.
    const fixture = writeImportFixture(dir);
    const input = await openImportDialog(sidepanel);
    await input.setInputFiles(fixture);
    await expect(sidepanel.getByTestId("import-preview")).toBeVisible();
    await sidepanel.getByRole("button", { name: "Confirm import" }).click();
    await expect(sidepanel.getByText("Import complete.")).toBeVisible();
    await dismissDialog(sidepanel);

    // 4. Export the library (Blob + anchor download).
    const exported = await exportLibraryJson(sidepanel);
    expect(exported.text).toContain("https://egress.example/popup");

    // 5. Delete all extension data from the options page. The reset drops the
    //    shared IndexedDB database, which an open connection would block, so
    //    the panel is closed first.
    await sidepanel.close();
    const options = await openSurface(context, id, "options");
    await options
      .getByRole("button", { name: "Delete all extension data", exact: true })
      .click();
    await options.getByRole("button", { name: "Delete everything" }).click();
    await expect(
      options.getByText("All extension data has been deleted."),
    ).toBeVisible();
  } finally {
    // Closing the context is part of the observation window: any teardown- or
    // unload-time traffic is still recorded before the assertion below.
    await context.close();
  }
  requests.stop();
  expect(
    requests.urls,
    "exercising every feature must still send no http(s) requests",
  ).toEqual([]);
});
