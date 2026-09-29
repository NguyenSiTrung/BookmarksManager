import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * Surface-level interactions shared by the core-manager specs: waiting for a
 * surface to finish its async boot, and driving the import/export/move
 * affordances by their accessible names.
 *
 * Locators are deliberately role/label based (never CSS) so a rename of a
 * class or wrapper element cannot silently weaken a spec — the same contract
 * the shell spec uses.
 */

/**
 * The Options page's four panels (track options_redesign_20260929). Panels
 * stay mounted — `hidden` toggles visibility so in-progress form state
 * survives a switch — which means a locator resolves inside an inactive
 * panel without being visible, and `getByRole` does not resolve there at all.
 * Every helper that drives panel-specific UI selects its panel first.
 */
export type OptionsPanel = "Connections" | "Permissions" | "Activity" | "Data";

/**
 * Switch the Options page to one panel through the real left-rail link, then
 * wait until that link is the current one (`aria-current="page"`, which the
 * shell sets from its `active` state) so callers can rely on the panel's
 * contents being visible.
 */
export async function openOptionsPanel(
  page: Page,
  panel: OptionsPanel,
): Promise<void> {
  const link = page.getByRole("link", { name: panel, exact: true });
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(link).toHaveAttribute("aria-current", "page");
}

/**
 * Wait until the quick-save popup has resolved its prefill and rendered. The
 * form only mounts once `tabs.query` + `getTree` + the last-folder read have
 * settled, and on a cold profile that first IndexedDB open can outlast the 5 s
 * default `expect` timeout (observed as an intermittent failure in the full
 * suite), so the prefill assertion gets a generous budget.
 */
export async function waitForPopupReady(page: Page): Promise<void> {
  await expect(page.getByTestId("popup-quick-save")).toBeVisible();
  await expect(page.getByLabel("Title")).toBeVisible({ timeout: 15_000 });
}

/**
 * Wait until the side panel's live tree has loaded. Before the first
 * `getTree()` resolves the folder pane renders "Loading…" and no treeitems
 * exist, so a rendered "Other bookmarks" row is the ready signal.
 */
export async function waitForSidePanelReady(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Bookmarks Manager" }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: "Other bookmarks" }),
  ).toBeVisible();
}

/**
 * Drive the quick-save popup end to end: fill the title/URL, optionally stage
 * one tag chip, submit, and wait for the save confirmation. Returns once the
 * bookmark exists and its `bookmarkMeta` sidecar has been written.
 */
export async function quickSaveFromPopup(
  page: Page,
  details: { title: string; url: string; tag?: string },
): Promise<void> {
  await page.getByLabel("Title").fill(details.title);
  await page.getByLabel("URL").fill(details.url);
  if (details.tag !== undefined) {
    await page.getByLabel("New tag name").fill(details.tag);
    await page.getByRole("button", { name: "Add tag" }).click();
  }
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("save-confirmation")).toBeVisible();
}

/** Open the side panel's Import dialog and return its file input. */
export async function openImportDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Import…" }).click();
  const input = page.getByTestId("import-file-input");
  await expect(input).toBeVisible();
  return input;
}

/** Open the side panel's Export dialog (JSON is the default format). */
export async function openExportDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Export…" }).click();
  await expect(page.getByRole("radio", { name: "JSON (.json)" })).toBeVisible();
}

/**
 * Close the currently open Radix dialog with Escape. The import summary has
 * two buttons whose accessible name is "Close" (the corner X and the footer
 * button), so Escape is the unambiguous dismissal path.
 */
export async function dismissDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * Move one bookmark through the row's "Move to…" dialog: select the row, open
 * the row menu, choose the destination by its display path, and confirm.
 * `label` is the bookmark's title (the row menu's accessible name) and
 * `destinationLabel` is the folder path shown in the picker, e.g.
 * "Other bookmarks / Target folder".
 */
export async function moveBookmarkViaDialog(
  page: Page,
  bookmarkId: string,
  label: string,
  destinationLabel: string,
): Promise<void> {
  const row = page.locator(`[data-bookmark-id="${bookmarkId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("button", { name: `Actions for ${label}` }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Move to…" })).toBeVisible();
  await dialog.getByRole("button", { name: destinationLabel }).click();
  await dialog.getByRole("button", { name: "Move", exact: true }).click();
}
