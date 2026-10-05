import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  bookmarkParentId,
  childFolderId,
  fixedRootIds,
  launchPersistentExtension,
  metaRows,
  pageCreateEntered,
  patchPageCreateGate,
  patchWorkerMove,
  releasePageCreate,
  restorePageCreate,
  restoreWorkerMove,
  restoredBookmarkCount,
  sendWorkerMessage,
  syntheticFolderName,
  syntheticUrl,
  tempProfileDir,
  undoRows,
  writeStoreRows,
  type AuditJobRow,
} from "./helpers/audit-data";
import { openSurface, startExtension } from "./helpers/extension";
import {
  OTHER_BOOKMARKS_ID,
  createBookmark,
  getChildren,
} from "./helpers/seed";
import {
  dismissDialog,
  openExportDialog,
  openImportDialog,
  waitForPopupReady,
  waitForSidePanelReady,
} from "./helpers/surfaces";

/**
 * Phase 6 Task 2 — cross-feature browser data-safety regressions (I04/I08).
 *
 * Exercises the audited data-integrity defects end to end over the BUILT
 * extension: real bookmark tree, real Dexie/IndexedDB, real worker message
 * channel, and the isolated extension launcher. Each leg asserts the FINAL
 * device state (native parents, persisted metadata rows, restored bookmark
 * uniqueness) — never just button visibility.
 *
 *  1. JSON export/import round trip preserves summaries AND the rest of the
 *     metadata sidecar (B03).
 *  2. Undo restores a deleted bookmark's summary metadata (B02).
 *  3. Restructure apply revalidates the full reviewed scope, covering
 *     Bookmarks bar + Other + Mobile roots (B15).
 *  4. A failed restructure apply compensates non-destructively: originals
 *     return, an occupied created folder is retained, and the snapshot stays
 *     retryable (B01).
 *  5. Two sidepanel contexts racing one undo row replay it exactly once
 *     (B13).
 *  6. Startup metadata reconciliation keeps live rows and reaps only dead
 *     ones (B04).
 *
 * ## Coverage limitations (read before treating a leg as RED-capable)
 *
 * - **B15 / Mobile root is conditional.** This desktop Chromium profile only
 *   exposes the fixed roots "1" (Bookmarks bar) and "2" (Other bookmarks);
 *   "3" (Mobile bookmarks) materializes only on a profile that actually has
 *   mobile bookmarks, which no desktop Playwright launch produces. The leg
 *   therefore includes Mobile ONLY when {@link fixedRootIds} reports it. That
 *   is enough for the B15 regression: the pre-fix apply revalidated against a
 *   `getSubTree(BOOKMARKS_BAR_ID)` slice, so the Other-root bookmark is
 *   already dropped and the leg fails on `moved` (observed `moved: 1` vs the
 *   expected full set). Mobile would exercise the same code path once a
 *   profile exposes root "3"; no assertion here depends on it existing.
 * - **B04 is a contract check, not a replayable race.** `reconcileMetadata()`
 *   runs only from the MV3 worker's `defineBackground` startup pass, and its
 *   input read (`chrome.bookmarks.getTree`) cannot be intercepted, held, or
 *   re-entered from Playwright: `addInitScript` does not apply to service
 *   workers, a worker-side patch is lost across the restart, and there is no
 *   reconcile message or hook in the production protocol. With no way to
 *   freeze the stale tree read, the pre-fix ordering defect
 *   (`getTree()` before the stored-id snapshot) is NOT observable in a
 *   browser, so this leg PASSES at both the pre-fix and fixed revisions. It
 *   asserts the reconcile contract only: a dead row is reaped, a live
 *   summary row survives, and metadata written after the one-shot startup
 *   pass is never treated as a candidate. The actual race is covered by the
 *   Phase 1 Task 4 unit test (`tests/unit/sync-reconcile.test.ts`, commit
 *   `e183cc2`), which can hold the stale `getTree` read directly.
 *
 * Nothing here fetches: the extension stays offline and only the local temp
 * fixtures plus the chrome.bookmarks / IndexedDB surfaces are touched.
 */

/** The JSON fixture written to disk for the import leg. */
function writeFixture(dir: string, name: string, text: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

/** Export the whole library as JSON and read the downloaded file back. */
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

/** One valid, completed `restructure` job row for the confirm message. */
function completedRestructureJob(options: {
  folder: string;
  assignments: readonly { bookmarkId: string; proposedPath: string }[];
}): AuditJobRow {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: "restructure",
    status: "completed",
    progress: { totalBatches: 1, committedBatches: 1, processedCount: 0 },
    batchSize: 25,
    bookmarkIds: options.assignments.map((a) => a.bookmarkId),
    usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
    restructure: {
      proposal: {
        folders: [{ path: options.folder, description: "Audit restructure" }],
      },
      assignments: options.assignments.map((a) => ({
        bookmarkId: a.bookmarkId,
        proposedPath: a.proposedPath,
        confidence: 0.95,
      })),
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Prepare the command palette with "Undo last action" highlighted. */
async function preparePaletteUndo(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  const box = page.getByRole("combobox", { name: "Command palette" });
  await expect(box).toBeVisible();
  await box.fill("Undo last action");
  await expect(
    page.getByRole("option", { name: "Undo last action" }),
  ).toBeVisible();
}

/** Delete one bookmark through the side panel's real row menu. */
async function deleteViaRowMenu(
  sidepanel: Page,
  bookmarkId: string,
  label: string,
): Promise<void> {
  const row = sidepanel.locator(`[data-bookmark-id="${bookmarkId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await sidepanel.getByRole("button", { name: `Actions for ${label}` }).click();
  await sidepanel.getByRole("menuitem", { name: "Delete" }).click();
}

test("JSON export/import round trip preserves summaries and full metadata (B03)", async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(path.join(tmpdir(), "bm-audit-io-"));
  const source = await startExtension();
  const url = syntheticUrl("b03-round-trip");
  const summary = "Audit round-trip summary.";
  const notes = "Audit round-trip notes.";
  try {
    const driver = await openSurface(source.context, source.id, "popup");
    await waitForPopupReady(driver);
    const created = await createBookmark(driver, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Audit round trip bookmark",
      url,
    });
    // The summary field is written by the verified summarize path, which the
    // offline suite cannot drive; seed the sidecar directly, exactly as the
    // real writer would (schema-valid BookmarkMeta row).
    await writeStoreRows(driver, "bookmarkMeta", [
      {
        id: created.id,
        tags: ["audit"],
        category: "docs",
        notes,
        summary,
        updatedAt: new Date().toISOString(),
      },
    ]);
    const sidepanel = await openSurface(source.context, source.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    // Export through the real dialog; the downloaded envelope must carry the
    // summary (B03's read half).
    const exported = await exportLibraryJson(sidepanel);
    const envelope = JSON.parse(exported.text) as {
      version: number;
      meta: readonly {
        id: string;
        tags?: readonly string[];
        category?: string;
        notes?: string;
        summary?: string;
      }[];
    };
    expect(envelope.version).toBe(1);
    const exportedRow = envelope.meta.find((row) => row.summary === summary);
    expect(exportedRow, "the export must carry the summary").toBeDefined();
    expect(exportedRow?.tags).toEqual(["audit"]);
    expect(exportedRow?.category).toBe("docs");
    expect(exportedRow?.notes).toBe(notes);
    const fixture = writeFixture(dir, "audit-export.json", exported.text);

    // Import into a FRESH profile so the round trip is genuine.
    const target = await startExtension();
    try {
      const targetPanel = await openSurface(
        target.context,
        target.id,
        "sidepanel",
      );
      await waitForSidePanelReady(targetPanel);
      const input = await openImportDialog(targetPanel);
      await input.setInputFiles(fixture);
      await expect(targetPanel.getByTestId("import-preview")).toBeVisible();
      await targetPanel.getByRole("button", { name: "Confirm import" }).click();
      await expect(targetPanel.getByText("Import complete.")).toBeVisible();
      await dismissDialog(targetPanel);

      // The persisted sidecar carries the summary AND every other field —
      // not just a successful-looking button.
      await expect
        .poll(async () => (await metaRows(targetPanel)).length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(0);
      const imported = (await metaRows(targetPanel)).filter(
        (row) => row.summary === summary,
      );
      expect(imported).toHaveLength(1);
      expect(imported[0]?.tags).toEqual(["audit"]);
      expect(imported[0]?.category).toBe("docs");
      expect(imported[0]?.notes).toBe(notes);
    } finally {
      await target.context.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await source.context.close();
  }
});

test("undo restores a deleted bookmark's summary metadata (B02)", async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  const url = syntheticUrl("b02-undo-summary");
  const summary = "Audit undo summary.";
  const notes = "Audit undo notes.";
  try {
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);
    const created = await createBookmark(driver, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Audit undo summary bookmark",
      url,
    });
    await writeStoreRows(driver, "bookmarkMeta", [
      {
        id: created.id,
        tags: ["undo-audit"],
        notes,
        summary,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);
    await deleteViaRowMenu(
      sidepanel,
      created.id,
      "Audit undo summary bookmark",
    );
    await expect.poll(async () => restoredBookmarkCount(driver, url)).toBe(0);

    const undo = sidepanel.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(sidepanel.getByText("Undone.", { exact: true })).toBeVisible();

    // The native node is back EXACTLY once...
    await expect.poll(async () => restoredBookmarkCount(driver, url)).toBe(1);
    // ...and its remapped metadata row still carries the summary, notes, and
    // tags (B02's remap branches must include summary).
    await expect
      .poll(
        async () =>
          (await metaRows(sidepanel)).filter((row) => row.summary === summary)
            .length,
        { timeout: 15_000 },
      )
      .toBe(1);
    const restored = (await metaRows(sidepanel)).filter(
      (row) => row.summary === summary,
    );
    expect(restored[0]?.notes).toBe(notes);
    expect(restored[0]?.tags).toContain("undo-audit");
  } finally {
    await ext.context.close();
  }
});

test("restructure apply covers Bookmarks bar, Other, and Mobile roots (B15)", async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  const folder = syntheticFolderName("scope");
  try {
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);
    const bar = await createBookmark(driver, {
      parentId: "1",
      title: "Audit scope bar",
      url: syntheticUrl("b15-bar"),
    });
    const other = await createBookmark(driver, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Audit scope other",
      url: syntheticUrl("b15-other"),
    });
    // Mobile bookmarks ("3") only exist when the profile has mobile
    // bookmarks; seed there too whenever the fixed root is present (see the
    // header's B15 coverage limitation — the desktop profile this suite
    // launches exposes only "1"/"2", and Other alone already drives the
    // pre-fix RED).
    const roots = await fixedRootIds(driver);
    const targets = [bar, other];
    if (roots.includes("3")) {
      const mobile = await createBookmark(driver, {
        parentId: "3",
        title: "Audit scope mobile",
        url: syntheticUrl("b15-mobile"),
      });
      targets.push(mobile);
    }
    const job = completedRestructureJob({
      folder,
      assignments: targets.map((node) => ({
        bookmarkId: node.id,
        proposedPath: folder,
      })),
    });
    await writeStoreRows(driver, "jobs", [job]);

    const reply = await sendWorkerMessage(driver, {
      type: "RESTRUCTURE_CONFIRM",
      jobId: job.id,
    });
    expect(reply).toMatchObject({
      ok: true,
      code: "applied",
      moved: targets.length,
    });

    // Every bookmark — including the Other (and Mobile, when present) ones
    // outside the bookmarks bar — actually moved into the created folder.
    const targetId = await childFolderId(driver, "1", folder);
    expect(targetId).not.toBeNull();
    for (const node of targets) {
      await expect
        .poll(async () => bookmarkParentId(driver, node.id))
        .toBe(targetId);
    }
    expect(await getChildren(driver, targetId as string)).toHaveLength(
      targets.length,
    );
  } finally {
    await ext.context.close();
  }
});

test("failed restructure compensation keeps originals and occupied folders (B01)", async () => {
  test.setTimeout(120_000);
  const ext = await startExtension();
  const folder = syntheticFolderName("compensation");
  const raceUrl = syntheticUrl("b01-racing-child");
  try {
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);
    const first = await createBookmark(driver, {
      parentId: "1",
      title: "Audit compensation one",
      url: syntheticUrl("b01-one"),
    });
    const second = await createBookmark(driver, {
      parentId: "1",
      title: "Audit compensation two",
      url: syntheticUrl("b01-two"),
    });
    const job = completedRestructureJob({
      folder,
      assignments: [first, second].map((node) => ({
        bookmarkId: node.id,
        proposedPath: folder,
      })),
    });
    await writeStoreRows(driver, "jobs", [job]);

    // The second forward move fails, and a "user" files a bookmark into the
    // folder the apply just created before the failure unwinds.
    await patchWorkerMove(ext.context, {
      failOnCall: 2,
      raceChild: { title: "Audit racing child", url: raceUrl },
    });
    try {
      const reply = await sendWorkerMessage(driver, {
        type: "RESTRUCTURE_CONFIRM",
        jobId: job.id,
      });
      expect(reply).toMatchObject({ ok: false });

      // Both originals are back in the bookmarks bar.
      await expect.poll(async () => bookmarkParentId(driver, first.id)).toBe("1");
      await expect
        .poll(async () => bookmarkParentId(driver, second.id))
        .toBe("1");
      // The occupied created folder survived compensation: pre-fix removed it
      // with removeTree, deleting the user's child.
      await expect.poll(async () => restoredBookmarkCount(driver, raceUrl)).toBe(
        1,
      );
      const createdFolderId = await childFolderId(driver, "1", folder);
      expect(createdFolderId).not.toBeNull();
      expect(await getChildren(driver, createdFolderId as string)).toHaveLength(
        1,
      );

      // The snapshot is retained, so the apply stays retryable via undo.
      const snapshots = await undoRows(driver);
      expect(snapshots.length).toBeGreaterThan(0);
      const undone = await sendWorkerMessage(driver, {
        type: "RESTRUCTURE_UNDO",
        snapshotId: snapshots[snapshots.length - 1]!.id,
      });
      expect(undone).toMatchObject({ ok: true, code: "undone" });
      await expect.poll(async () => bookmarkParentId(driver, first.id)).toBe("1");
    } finally {
      await restoreWorkerMove(ext.context);
    }
  } finally {
    await ext.context.close();
  }
});

test("two sidepanel contexts racing one undo row replay it exactly once (B13)", async () => {
  test.setTimeout(150_000);
  const ext = await startExtension();
  const url = syntheticUrl("b13-race");
  try {
    const driver = await openSurface(ext.context, ext.id, "popup");
    await waitForPopupReady(driver);
    const created = await createBookmark(driver, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Audit B13 race bookmark",
      url,
    });

    const panelA = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(panelA);
    const panelB = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(panelB);

    // Panel A performs the real undoable delete, pushing ONE snapshot row and
    // showing the toast Undo affordance.
    await deleteViaRowMenu(panelA, created.id, "Audit B13 race bookmark");
    const undoButton = panelA.getByRole("button", {
      name: "Undo",
      exact: true,
    });
    await expect(undoButton).toBeVisible();
    await expect.poll(async () => restoredBookmarkCount(driver, url)).toBe(0);

    // Freeze both panels' replay AFTER they peek the shared row: the gate
    // holds the recreated bookmark back so the two contexts provably overlap
    // on the same snapshot. Pre-fix (no cross-context lock) both contexts
    // recreate it; the lock lets only one through.
    await patchPageCreateGate(panelA);
    await patchPageCreateGate(panelB);
    try {
      // Panel B dispatches "Undo last action" from the command palette — a
      // second, independent extension context over the same database.
      await preparePaletteUndo(panelB);
      await Promise.all([
        undoButton.click(),
        panelB.keyboard.press("Enter"),
      ]);

      // Wait until a replay has entered its restore (whichever context won
      // the lock), then give the second context a bounded window to reach the
      // same point. Pre-fix it does — both contexts peek the same unpopped
      // row; under the fix the loser waits on the lock instead.
      await expect
        .poll(
          async () =>
            (await pageCreateEntered(panelA)) ||
            (await pageCreateEntered(panelB)),
          { timeout: 15_000 },
        )
        .toBe(true);
      const bothEntered = await Promise.race([
        (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              (await pageCreateEntered(panelA)) &&
              (await pageCreateEntered(panelB))
            ) {
              return true;
            }
            await panelB.waitForTimeout(50);
          }
          return false;
        })(),
        panelB.waitForTimeout(5_000).then(() => false),
      ]);

      await releasePageCreate(panelA);
      await releasePageCreate(panelB);

      // Exactly ONE bookmark with the synthetic URL may exist: a double
      // replay would have created a second node.
      await expect
        .poll(async () => restoredBookmarkCount(driver, url), {
          timeout: 15_000,
        })
        .toBe(1);
      // Under the lock the second context must never overlap the first.
      expect(
        bothEntered,
        "the extension-wide undo lock must keep a second context out of the replay",
      ).toBe(false);
      // The snapshot row was consumed, not duplicated.
      expect(await undoRows(driver)).toHaveLength(0);
    } finally {
      await restorePageCreate(panelA);
      await restorePageCreate(panelB);
    }
  } finally {
    await ext.context.close();
  }
});

/**
 * B04 — CONTRACT CHECK, NOT A REPLAYABLE RACE (see the header's "Coverage
 * limitations"). The startup reconcile cannot be frozen or re-entered from
 * the browser, so this leg passes at the pre-fix revision too; the ordering
 * race itself is unit-covered by Phase 1 Task 4
 * (`tests/unit/sync-reconcile.test.ts`).
 */
test("startup metadata reconciliation keeps live rows and reaps dead ones (B04)", async () => {
  test.setTimeout(180_000);
  const profile = tempProfileDir("reconcile");
  const liveUrl = syntheticUrl("b04-live");
  const liveSummary = "Audit reconcile live summary.";
  const orphanId = "audit-orphan-row";
  try {
    // First launch: a real bookmark with a summary row, plus a stale row
    // whose bookmark id never existed (an orphan reconcile must reap).
    const first = await launchPersistentExtension(profile);
    let liveId: string;
    try {
      const driver = await openSurface(first.context, first.id, "popup");
      await waitForPopupReady(driver);
      const created = await createBookmark(driver, {
        parentId: OTHER_BOOKMARKS_ID,
        title: "Audit reconcile live",
        url: liveUrl,
      });
      liveId = created.id;
      await writeStoreRows(driver, "bookmarkMeta", [
        {
          id: liveId,
          tags: [],
          summary: liveSummary,
          updatedAt: new Date().toISOString(),
        },
        {
          id: orphanId,
          tags: [],
          summary: "Audit orphan summary.",
          updatedAt: new Date().toISOString(),
        },
      ]);
    } finally {
      await first.context.close();
    }

    // Second launch over the SAME profile: the worker's startup reconcile
    // runs before any surface is opened.
    const second = await launchPersistentExtension(profile);
    try {
      const sidepanel = await openSurface(
        second.context,
        second.id,
        "sidepanel",
      );
      await waitForSidePanelReady(sidepanel);
      // The dead row is reaped...
      await expect
        .poll(
          async () =>
            (await metaRows(sidepanel)).some((row) => row.id === orphanId),
          { timeout: 15_000 },
        )
        .toBe(false);
      // ...while the live bookmark's summary row survives intact.
      const liveRow = (await metaRows(sidepanel)).find(
        (row) => row.id === liveId,
      );
      expect(liveRow?.summary).toBe(liveSummary);

      // Metadata created around the startup window is never a reconcile
      // candidate (Chrome never reuses ids): a freshly created pair survives.
      // Bounded poll on its PRESENCE rather than a fixed sleep, so the check
      // is deterministic instead of timing-dependent.
      const concurrent = await createBookmark(sidepanel, {
        parentId: OTHER_BOOKMARKS_ID,
        title: "Audit reconcile concurrent",
        url: syntheticUrl("b04-concurrent"),
      });
      await writeStoreRows(sidepanel, "bookmarkMeta", [
        {
          id: concurrent.id,
          tags: [],
          summary: "Audit concurrent summary.",
          updatedAt: new Date().toISOString(),
        },
      ]);
      const concurrentRow = expect
        .poll(
          async () =>
            (await metaRows(sidepanel)).find((row) => row.id === concurrent.id)
              ?.summary,
          { timeout: 5_000 },
        )
        .toBe("Audit concurrent summary.");
      await concurrentRow;
    } finally {
      await second.context.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
