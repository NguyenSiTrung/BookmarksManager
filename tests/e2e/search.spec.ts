import { expect, test } from "@playwright/test";
import {
  collectOutboundRequests,
  extensionId,
  launchExtensionContext,
  openSurface,
} from "./helpers/extension";
import {
  OTHER_BOOKMARKS_ID,
  createBookmark,
  createFolder,
} from "./helpers/seed";
import { waitForPopupReady, waitForSidePanelReady } from "./helpers/surfaces";

/**
 * Phase 4 Task 1 — real-browser coverage of the local search surfaces added
 * by this track. The side-panel search bar, the Ctrl/Cmd+K command palette,
 * and the popup search box are all driven through the BUILT extension against
 * a real `chrome.bookmarks` tree; the `bm` omnibox keyword is covered by unit
 * tests because Playwright cannot drive the browser's address bar.
 *
 * The zero-egress spec records EVERY non-internal request the context makes
 * while typing, navigating results, and clearing on all three surfaces —
 * search must compute entirely on-device. (Actually OPENING an https bookmark
 * is a user-initiated navigation, not extension egress, so open-paths live in
 * the non-egress specs and this one stops short of pressing Enter on a URL.)
 */

test("side panel search filters live, picks up a new bookmark, and clears back", async () => {
  test.setTimeout(120_000);
  const context = await launchExtensionContext();
  try {
    const id = await extensionId(context);
    const sidepanel = await openSurface(context, id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    await createBookmark(sidepanel, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Warp drive manual",
      url: "https://warp.example/manual",
    });
    await createBookmark(sidepanel, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Impulse notes",
      url: "https://impulse.example/",
    });

    const input = sidepanel.getByRole("combobox", {
      name: "Search bookmarks",
    });
    await input.click();
    await input.fill("warp");

    // The search view swaps in: the Warp hit renders, the Impulse row does not.
    const list = sidepanel.getByRole("listbox", { name: "Bookmarks" });
    await expect(
      list.getByRole("option", { name: /Warp drive manual/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      list.getByRole("option", { name: /Impulse notes/ }),
    ).toHaveCount(0);

    // Live update: a bookmark created AFTER the query is typed lands in the
    // same result list once the index diff lands.
    await createBookmark(sidepanel, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Warp coil schematic",
      url: "https://warp.example/coil",
    });
    await expect(
      list.getByRole("option", { name: /Warp coil schematic/ }),
    ).toBeVisible();

    // Esc clears the query and the previous view (Other bookmarks listing
    // both bookmarks) is restored.
    await input.press("Escape");
    await expect(
      list.getByRole("option", { name: /Impulse notes/ }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("command palette opens with Ctrl+K and Enter opens the hit", async () => {
  test.setTimeout(120_000);
  const context = await launchExtensionContext();
  try {
    const id = await extensionId(context);
    const sidepanel = await openSurface(context, id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    // A chrome-extension:// URL resolves offline (fake https domains land on
    // chrome-error://), so the opened tab's final URL is a deterministic
    // assertion — and it stays an internal scheme for the egress watch.
    const targetUrl = `chrome-extension://${id}/options.html`;
    await createBookmark(sidepanel, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Palette target page",
      url: targetUrl,
    });

    await sidepanel.keyboard.press("Control+k");
    const dialog = sidepanel.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();

    const paletteInput = dialog.getByRole("combobox", {
      name: "Command palette",
    });
    await paletteInput.fill("palette target");

    const results = dialog.getByRole("listbox", { name: "Palette results" });
    await expect(
      results.getByRole("option", { name: /Palette target page/ }),
    ).toBeVisible({ timeout: 15_000 });

    // Enter opens the highlighted bookmark hit in a real new tab. The
    // Options shell rewrites its own URL to `#connections` (its default
    // panel) as soon as it mounts, so asserting a frozen hash-free URL is a
    // race — assert the page, tolerating the shell's default hash.
    const tabPromise = context.waitForEvent("page", { timeout: 15_000 });
    await paletteInput.press("Enter");
    const tab = await tabPromise;
    await expect(tab).toHaveURL(
      new RegExp(`${targetUrl.replace(/\./g, "\\.")}(#connections)?$`),
    );
    await tab.close();
  } finally {
    await context.close();
  }
});

test("popup search replaces the form and Enter opens a new tab", async () => {
  test.setTimeout(120_000);
  const context = await launchExtensionContext();
  try {
    const id = await extensionId(context);
    const seed = await openSurface(context, id, "sidepanel");
    await waitForSidePanelReady(seed);
    // See the palette spec: a chrome-extension:// URL resolves offline, so
    // the opened tab's final URL is deterministic.
    const targetUrl = `chrome-extension://${id}/popup.html`;
    await createBookmark(seed, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Popup find me",
      url: targetUrl,
    });
    await createFolder(seed, "PopupFolder");
    await seed.close();

    const popup = await openSurface(context, id, "popup");
    await waitForPopupReady(popup);

    // Search sits behind the header toggle (95d8468): the icon opens the
    // search row, and a non-empty query replaces the save form.
    await popup.getByRole("button", { name: "Search bookmarks" }).click();
    const input = popup.getByRole("combobox", { name: "Search bookmarks" });
    await input.click();
    await input.fill("popup find");

    // Results replace the save form.
    const list = popup.getByRole("listbox", { name: "Popup results" });
    await expect(
      list.getByRole("option", { name: /Popup find me/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByLabel("Title")).toHaveCount(0);

    // Enter opens the highlighted hit in a new tab.
    const tabPromise = context.waitForEvent("page", { timeout: 15_000 });
    await input.press("Enter");
    const tab = await tabPromise;
    await expect(tab).toHaveURL(targetUrl);
    await tab.close();

    // Clearing and closing the row restores the form.
    await input.fill("");
    await input.press("Escape");
    await expect(popup.getByLabel("Title")).toBeVisible();
    await expect(list).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("all search surfaces send no external requests", async () => {
  test.setTimeout(120_000);
  const context = await launchExtensionContext();
  const requests = collectOutboundRequests(context);
  try {
    const id = await extensionId(context);
    const sidepanel = await openSurface(context, id, "sidepanel");
    await waitForSidePanelReady(sidepanel);

    await createFolder(sidepanel, "EgressSearchFolder");
    await createBookmark(sidepanel, {
      parentId: OTHER_BOOKMARKS_ID,
      title: "Egress search target",
      url: "https://egress-search.example/",
    });

    // 1. Side-panel search: type, filter with the query language, clear.
    const searchInput = sidepanel.getByRole("combobox", {
      name: "Search bookmarks",
    });
    await searchInput.fill("egress");
    await expect(
      sidepanel.getByRole("option", { name: /Egress search target/ }),
    ).toBeVisible({ timeout: 15_000 });
    await searchInput.fill("folder:EgressSearchFolder");
    await searchInput.fill("");
    await searchInput.press("Escape");

    // 2. Palette: open, type, arrow through results, close with Escape
    //    (no open — Enter on an https hit would navigate, which is a
    //    user-initiated request rather than extension egress).
    await sidepanel.keyboard.press("Control+k");
    const dialog = sidepanel.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const paletteInput = dialog.getByRole("combobox", {
      name: "Command palette",
    });
    await paletteInput.fill("egress");
    await expect(
      dialog.getByRole("option", { name: /Egress search target/ }),
    ).toBeVisible();
    await paletteInput.press("ArrowDown");
    await paletteInput.press("ArrowUp");
    await sidepanel.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // 3. Popup search: open the header toggle, type, see results, then clear
    //    and close the row — the form comes back intact.
    const popup = await openSurface(context, id, "popup");
    await waitForPopupReady(popup);
    await popup.getByRole("button", { name: "Search bookmarks" }).click();
    const popupInput = popup.getByRole("combobox", {
      name: "Search bookmarks",
    });
    await popupInput.fill("egress");
    await expect(
      popup.getByRole("option", { name: /Egress search target/ }),
    ).toBeVisible({ timeout: 15_000 });
    await popupInput.press("Escape");
    await popupInput.press("Escape");
    await expect(popup.getByLabel("Title")).toBeVisible();
    await popup.close();
    await sidepanel.close();
  } finally {
    await context.close();
  }
  requests.stop();
  expect(
    requests.urls,
    "search on every surface must compute entirely on-device",
  ).toEqual([]);
});
