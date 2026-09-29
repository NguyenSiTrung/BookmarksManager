import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import {
  assertEgressBodiesClean,
  bookmarkMetaRows,
  grantDecisionsConsent,
  jobRows,
  restartableProvider,
  routeFakeDecisions,
  seedTags,
  type FakeDecisionsScript,
} from "./helpers/decisions";
import { collectOutboundRequests, openSurface } from "./helpers/extension";
import {
  abortProviderRequests,
  enableTypesafe,
  launchProviderExtension,
  sentLogRows,
} from "./helpers/provider";
import { createBookmark, createFolder, getChildren } from "./helpers/seed";
import {
  chooseTool,
  openMoreView,
  openOptionsPanel,
  waitForPopupReady,
  waitForSidePanelReady,
} from "./helpers/surfaces";

/**
 * Jev decisions end-to-end (Phase 5 Task 1): the real extension, real UI
 * surfaces, real worker, real egress gate — with only the TypeSafe endpoint
 * replaced by `routeFakeDecisions` (Playwright routes intercept the service
 * worker's `fetch`). Every leg asserts BOTH the user-visible outcome and the
 * device-bound artifacts (sentLog audit rows, bookmarkMeta sidecar, jobs row,
 * captured request bodies).
 *
 * The six legs mirror the plan's coverage matrix:
 *
 *  1. zero-egress until the `jev_decisions` grant exists (Ask hidden, Analyze
 *     refused, consent UI armed, sentLog and every outbound request empty);
 *  2. Analyze → Review → Approve → Undo over the real queue, with the
 *     blocklist and URL cleaning proven on the wire;
 *  3. the quick-save popup's one-shot SAVE_SUGGEST (prefill → suggestions →
 *     folder preselect → chips → minimized egress);
 *  4. Ask rerank (query on the wire as `DecisionState.query`, ranked order,
 *     no-match bar, Ask-off sends nothing);
 *  5. a paused scan across a full browser restart stays paused until the
 *     user resumes — the resume relaunches the persisted job live;
 *  6. a running scan interrupted mid-batch auto-resumes on restart from the
 *     committed batch only (no batch is ever re-sent).
 *
 * Legs 5–6 restart the browser by relaunching on the same persistent profile
 * (`restartableProvider`) — a browser restart subsumes an MV3 worker
 * restart, which no Playwright API can trigger on demand.
 */

/** Enable the TypeSafe provider AND grant jev_decisions consent, both via the real Options UI. */
async function setupConsentedProvider(
  context: Parameters<typeof openSurface>[0],
  id: string,
): Promise<{ options: Page; sidepanel: Page }> {
  const options = await openSurface(context, id, "options");
  await enableTypesafe(options, { key: "e2e-decisions-key" });
  await grantDecisionsConsent(options);
  const sidepanel = await openSurface(context, id, "sidepanel");
  await waitForSidePanelReady(sidepanel);
  return { options, sidepanel };
}

/** Trigger the row-menu Analyze intent for one bookmark. */
async function analyzeFromRowMenu(
  sidepanel: Page,
  bookmarkId: string,
  label: string,
): Promise<void> {
  const row = sidepanel.locator(`[data-bookmark-id="${bookmarkId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await sidepanel
    .getByRole("button", { name: `Actions for ${label}` })
    .click();
  await sidepanel.getByRole("menuitem", { name: "Analyze" }).click();
}

/** Open the side panel's library-scan dialog and return its locator. */
async function openScanDialog(sidepanel: Page): Promise<Locator> {
  await chooseTool(sidepanel, "Scan library…");
  const dialog = sidepanel.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Scan library" }),
  ).toBeVisible();
  return dialog;
}

test("zero egress until the jev_decisions grant exists", async () => {
  test.setTimeout(120_000);
  const ext = await launchProviderExtension();
  const outbound = collectOutboundRequests(ext.context);
  const abortLog = await abortProviderRequests(ext.context);

  const options = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(options, { key: "e2e-decisions-key" });
  const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
  await waitForSidePanelReady(sidepanel);
  const bookmark = await createBookmark(sidepanel, {
    title: "Tokio async tutorial",
    url: "https://tokio.rs/tutorial",
  });

  // Ask exists only behind decisions consent — the switch must not render.
  await expect(sidepanel.getByRole("switch", { name: "Ask" })).toHaveCount(0);

  // Analyze is refused before anything leaves the device — the decisions
  // gate requires the jev_decisions grant itself, so the refusal names the
  // provider, not the send.
  await analyzeFromRowMenu(sidepanel, bookmark.id, "Tokio async tutorial");
  await expect(sidepanel.getByRole("alert").first()).toContainText(
    /No provider is enabled/i,
  );

  // The consent UI itself starts unchecked with Allow disabled. It lives in
  // the Permissions panel, which the shell mounts hidden until selected.
  await openOptionsPanel(options, "Permissions");
  await expect(
    options.getByLabel(/agree to send bookmark metadata to/),
  ).not.toBeChecked();
  await expect(
    options.getByRole("button", {
      name: "Allow TypeSafe bookmark analysis",
    }),
  ).toBeDisabled();

  expect(abortLog.requests).toEqual([]);
  expect(await sentLogRows(options)).toEqual([]);
  expect(outbound.urls).toEqual([]);

  await ext.context.close();
  ext.dispose();
});

test("Analyze queues reviewable suggestions; Approve applies, Undo reverts", async () => {
  test.setTimeout(150_000);
  const ext = await launchProviderExtension();
  const script: FakeDecisionsScript = {
    choices: { category: "docs" },
    noul: {},
  };
  const route = await routeFakeDecisions(ext.context, script);
  const { options, sidepanel } = await setupConsentedProvider(
    ext.context,
    ext.id,
  );
  await seedTags(options, ["rust", "async"]);
  const tokio = await createBookmark(sidepanel, {
    title: "Tokio async tutorial",
    url: "https://tokio.rs/tutorial",
  });
  const chase = await createBookmark(sidepanel, {
    title: "Chase bank account",
    url: "https://chase.com/account",
  });
  const docs = await createBookmark(sidepanel, {
    title: "Docs guide",
    url: "https://docs.guidesite.dev/guide?token=SECRET123",
  });

  // A built-in-blocklisted host is refused locally — nothing is sent.
  await analyzeFromRowMenu(sidepanel, chase.id, "Chase bank account");
  await expect(sidepanel.getByText(/on the blocklist/)).toBeVisible();
  expect(route.requests).toHaveLength(0);

  // The sendable bookmarks: one merged request each (checks share a request).
  await analyzeFromRowMenu(sidepanel, tokio.id, "Tokio async tutorial");
  await expect(
    sidepanel.getByText(/Analyzed “Tokio async tutorial”/),
  ).toBeVisible({ timeout: 30_000 });
  await analyzeFromRowMenu(sidepanel, docs.id, "Docs guide");
  await expect(sidepanel.getByText(/Analyzed “Docs guide”/)).toBeVisible({
    timeout: 30_000,
  });
  expect(route.requests).toHaveLength(2);
  const log = await sentLogRows(sidepanel);
  expect(log).toHaveLength(2);
  for (const row of log) {
    expect(row.feature).toBe("jev_decisions");
  }
  // The query string (and any notes) never reached the wire.
  assertEgressBodiesClean(route.requests, ["SECRET123"]);

  // The review queue holds both kinds per analyzed bookmark.
  await openMoreView(sidepanel, "Review suggestions");
  const queue = sidepanel.getByRole("listbox", {
    name: "Pending suggestions",
  });
  await expect(queue.getByRole("option")).toHaveCount(4);
  const tokioCategory = queue
    .getByRole("option")
    .filter({ hasText: "Set category" })
    .filter({ hasText: "Tokio async tutorial" });
  await expect(tokioCategory).toContainText("category: docs");
  const tokioTags = queue
    .getByRole("option")
    .filter({ hasText: "Add tags" })
    .filter({ hasText: "Tokio async tutorial" });
  await expect(tokioTags).toContainText("rust");
  await expect(tokioTags).toContainText("async");

  // Approve applies the category to the real bookmarkMeta sidecar…
  await tokioCategory
    .getByRole("button", {
      name: "Approve the suggestion for Tokio async tutorial",
    })
    .click();
  await expect
    .poll(
      async () =>
        (await bookmarkMetaRows(sidepanel)).find((row) => row.id === tokio.id)
          ?.category,
    )
    .toBe("docs");

  // …and the toast's Undo reverts it.
  const undo = sidepanel.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect
    .poll(
      async () =>
        (await bookmarkMetaRows(sidepanel)).find((row) => row.id === tokio.id)
          ?.category,
    )
    .toBeUndefined();

  await ext.context.close();
  ext.dispose();
});

test("quick-save popup: prefill drives one minimized SAVE_SUGGEST", async () => {
  test.setTimeout(120_000);
  // `tabs` on the patched copy only: production prefills via `activeTab`,
  // which Playwright cannot grant. Everything after the prefill runs
  // unchanged.
  const ext = await launchProviderExtension({ grantTabsPermission: true });
  const script: FakeDecisionsScript = {
    choices: { category: "docs" },
    noul: {},
  };
  const route = await routeFakeDecisions(ext.context, script);
  const options = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(options, { key: "e2e-decisions-key" });
  await grantDecisionsConsent(options);
  const work = await createFolder(options, "Work");
  // A folder answer at 0.8 sits above the 0.7 preselect threshold.
  script.choices.folder = work.id;
  script.confidence = 0.8;

  // A real https page behind a route, carrying a query the send must strip.
  await ext.context.route("https://suggest.guidesite.dev/**", (pageRoute) =>
    pageRoute.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><head><title>Tokio guide</title></head><body>Tokio guide</body></html>",
    }),
  );
  const httpsPage = await ext.context.newPage();
  await httpsPage.goto("https://suggest.guidesite.dev/tokio/guide?utm_source=e2e", {
    waitUntil: "commit",
  });
  const popup = await ext.context.newPage();
  // The tab the popup prefills from must be the https page. A new page steals
  // the active-tab slot, so flip it back BEFORE the popup's scripts load
  // (the goto below) — that makes the prefill deterministic.
  await httpsPage.bringToFront();
  await popup.goto(`chrome-extension://${ext.id}/popup.html`);
  await waitForPopupReady(popup);

  // The prefill is the real tab title and the full URL (query intact).
  await expect(popup.locator("#popup-title")).toHaveValue("Tokio guide");
  await expect(popup.locator("#popup-url")).toHaveValue(
    "https://suggest.guidesite.dev/tokio/guide?utm_source=e2e",
  );

  // The one-shot SAVE_SUGGEST at ready: a category chip and the ≥0.7 folder
  // preselect land in the form.
  const categoryChip = popup.getByRole("button", {
    name: "Set category to Docs",
  });
  await expect(categoryChip).toBeVisible({ timeout: 15_000 });
  await expect(popup.locator("#popup-folder")).toHaveValue(work.id, {
    timeout: 15_000,
  });

  await categoryChip.click();
  await popup.getByRole("button", { name: "Save" }).click();
  await expect(popup.getByTestId("save-confirmation")).toBeVisible();

  // The bookmark landed under Work with the form's URL verbatim…
  const children = await getChildren(popup, work.id);
  expect(children).toHaveLength(1);
  expect(children[0]?.url).toBe(
    "https://suggest.guidesite.dev/tokio/guide?utm_source=e2e",
  );

  // …while exactly one egress left, carrying the cleaned URL only.
  expect(route.requests).toHaveLength(1);
  assertEgressBodiesClean(route.requests, ["utm_source", "notes"]);
  // Exactly one audit row for the one request — the save path must never
  // double-write.
  const log = await sentLogRows(popup);
  expect(log).toHaveLength(1);
  expect(log[0]?.feature).toBe("jev_decisions");

  await ext.context.close();
  ext.dispose();
});

test("Ask reranks results by query and reports the no-match bar", async () => {
  test.setTimeout(120_000);
  const ext = await launchProviderExtension();
  // Local order for "rust async" ranks the guide (candidate_0) above the
  // cookbook (candidate_1); the scripted answers flip that.
  const script: FakeDecisionsScript = {
    choices: {},
    noul: { candidate_0: 0.05, candidate_1: 0.95 },
  };
  const route = await routeFakeDecisions(ext.context, script);
  const { sidepanel } = await setupConsentedProvider(ext.context, ext.id);
  const guide = await createBookmark(sidepanel, {
    title: "Rust async guide",
    url: "https://rust.guidesite.dev/async/guide",
  });
  const cookbook = await createBookmark(sidepanel, {
    title: "Rust async cookbook",
    url: "https://rust.guidesite.dev/cookbook",
  });

  const search = sidepanel.getByLabel("Search bookmarks");
  const askSwitch = sidepanel.getByRole("switch", { name: "Ask" });
  await expect(askSwitch).toBeVisible();
  await askSwitch.click();

  await search.fill("rust async");
  await expect(sidepanel.getByTestId("ask-status")).toHaveText(
    "Ranked by Ask.",
    { timeout: 15_000 },
  );
  // Self-calibrating flip proof: the shortlist on the wire names both
  // candidates; candidate_1's noul (0.95) promotes it over candidate_0.
  const firstState = (
    route.requests[0]?.postData as
      | {
          state?: {
            query?: string;
            candidateBookmarks?: Array<{ url: string }>;
          };
        }
      | undefined
  )?.state;
  expect(firstState?.query).toBe("rust async");
  const candidates = firstState?.candidateBookmarks ?? [];
  expect(candidates).toHaveLength(2);
  // Pin the pre-rank order: MiniSearch ranks the guide above the cookbook
  // (both terms in both titles, but only the guide's URL also contains
  // "async"), so the scripted flip below is a real reorder, never a no-op.
  expect(candidates[0]?.url).toBe(guide.url);
  const winner = candidates[1]?.url === cookbook.url ? cookbook : guide;
  await expect(sidepanel.locator("[data-bookmark-id]").first()).toHaveAttribute(
    "data-bookmark-id",
    winner.id,
  );
  // The flip is real: the local winner (candidate_0) is no longer first.
  const localWinner = candidates[0]?.url === cookbook.url ? cookbook : guide;
  await expect(
    sidepanel.locator("[data-bookmark-id]").first(),
  ).not.toHaveAttribute("data-bookmark-id", localWinner.id);

  // Everything below the 0.5 bar → the quiet no-match note.
  script.noul.candidate_0 = 0.2;
  script.noul.candidate_1 = 0.2;
  await search.fill("");
  await search.fill("rust async");
  await expect(sidepanel.getByTestId("ask-status")).toHaveText(
    "No close match — showing the best local guesses.",
    { timeout: 15_000 },
  );

  // Ask off: a new query is local-only — no third request, ever.
  await askSwitch.click();
  await search.fill("");
  await search.fill("rust cookbook");
  await sidepanel.waitForTimeout(1_000);
  expect(route.requests).toHaveLength(2);
  expect(await sentLogRows(sidepanel)).toHaveLength(2);

  await ext.context.close();
  ext.dispose();
});

test("a paused scan stays paused across a restart; Resume relaunches it live", async () => {
  test.setTimeout(180_000);
  const provider = restartableProvider();
  const script: FakeDecisionsScript = {
    choices: { category: "docs" },
    noul: {},
  };

  // Context 1: start the scan and pause it with the batch held mid-flight.
  const ext1 = await provider.launch();
  const route1 = await routeFakeDecisions(ext1.context, script, {
    autoRelease: 0,
  });
  const { sidepanel: sp1 } = await setupConsentedProvider(
    ext1.context,
    ext1.id,
  );
  const titles = ["Alpha notes", "Beta guide", "Gamma tool"];
  for (const [index, title] of titles.entries()) {
    await createBookmark(sp1, {
      title,
      url: `https://site${index}.scanbooks.dev/page-${index}`,
    });
  }
  const dialog1 = await openScanDialog(sp1);
  await dialog1.getByRole("button", { name: "Start scan" }).click();
  await expect(dialog1.getByText("Scan: Running")).toBeVisible({
    timeout: 30_000,
  });
  // The runner is strictly sequential: one batch of 3, and with the valve
  // closed exactly the FIRST analysis is held mid-batch (the other two
  // have not been sent yet).
  await expect
    .poll(() => route1.requests.length, { timeout: 30_000 })
    .toBe(1);
  await dialog1.getByRole("button", { name: "Pause" }).click();
  await expect(dialog1.getByText("Scan: Paused")).toBeVisible({
    timeout: 30_000,
  });
  await ext1.context.close();

  // Context 2, same profile and extension id: the paused row is NOT
  // auto-resumed by the boot-time resume pass.
  const ext2 = await provider.launch();
  expect(ext2.id).toBe(ext1.id);
  const route2 = await routeFakeDecisions(ext2.context, script, {
    autoRelease: 0,
  });
  const sp2 = await openSurface(ext2.context, ext2.id, "sidepanel");
  await waitForSidePanelReady(sp2);
  const dialog2 = await openScanDialog(sp2);
  await expect(dialog2.getByText("Scan: Paused")).toBeVisible({
    timeout: 30_000,
  });
  await sp2.waitForTimeout(1_000);
  expect(route2.requests).toHaveLength(0);

  // Resume drives the persisted job live again — through the real
  // JOB_RESUME → relaunch path. The relaunched runner re-enters the batch
  // sequentially, so its first analysis is held at the valve...
  await dialog2.getByRole("button", { name: "Resume" }).click();
  await expect
    .poll(() => route2.requests.length, { timeout: 30_000 })
    .toBe(1);
  // ...then the valve opens: the held analysis completes and the remaining
  // two flow straight through to completion.
  route2.release();
  await expect(dialog2.getByText("Scan: Completed")).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog2.getByText(/3 bookmarks processed \(100%\)/)).toBeVisible();
  await expect(dialog2.getByText(/3 bookmarks processed/)).toBeVisible();
  expect(route2.requests).toHaveLength(3);
  expect(await sentLogRows(sp2)).toHaveLength(3);

  await ext2.context.close();
  provider.dispose();
});

test("a restart auto-resumes a running scan from the committed batch only", async () => {
  test.setTimeout(180_000);
  const provider = restartableProvider();
  const script: FakeDecisionsScript = {
    choices: { category: "docs" },
    noul: {},
  };

  // Context 1: 8 bookmarks = 2 batches at the default batch size of 5.
  // Batch 1 auto-releases and commits; batch 2 (3 requests) stays held while
  // the browser dies on it.
  const ext1 = await provider.launch();
  const route1 = await routeFakeDecisions(ext1.context, script, {
    autoRelease: 5,
  });
  const { sidepanel: sp1 } = await setupConsentedProvider(
    ext1.context,
    ext1.id,
  );
  for (let index = 0; index < 8; index += 1) {
    await createBookmark(sp1, {
      title: `Scan page ${index}`,
      url: `https://site${index}.scanbooks.dev/page-${index}`,
    });
  }
  const dialog1 = await openScanDialog(sp1);
  await dialog1.getByRole("button", { name: "Start scan" }).click();
  await expect(dialog1.getByText(/5 bookmarks processed \(50%\)/)).toBeVisible({
    timeout: 60_000,
  });
  // Batch 1's 5 analyses auto-released; batch 2 began and its FIRST
  // analysis is held (the runner is strictly sequential).
  await expect.poll(() => route1.requests.length).toBe(6);
  await ext1.context.close();

  // Context 2: the boot-time resume pass drives the still-running row —
  // batch 2 ONLY. The committed batch is never re-sent.
  const ext2 = await provider.launch();
  expect(ext2.id).toBe(ext1.id);
  const route2 = await routeFakeDecisions(ext2.context, script, {
    autoRelease: 0,
  });
  const sp2 = await openSurface(ext2.context, ext2.id, "sidepanel");
  await waitForSidePanelReady(sp2);
  // Auto-resume re-enters batch 2 sequentially: one analysis held at the
  // closed valve...
  await expect
    .poll(() => route2.requests.length, { timeout: 30_000 })
    .toBe(1);
  // Device artifact: the persisted row relaunched from the committed batch —
  // batch 1's commit survived the restart, and batch 2 (its first analysis
  // still held at the valve) has not committed.
  const scanJob = (await jobRows(sp2)).find(
    (row) => row.kind === "library_scan",
  );
  expect(scanJob?.status).toBe("running");
  expect(scanJob?.progress.committedBatches).toBe(1);
  expect(scanJob?.progress.processedCount).toBe(5);
  route2.release();
  // ...then the rest flow through to completion.
  const dialog2 = await openScanDialog(sp2);
  await expect(dialog2.getByText("Scan: Completed")).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog2.getByText(/8 bookmarks processed/)).toBeVisible();
  expect(route2.requests).toHaveLength(3);
  // 5 rows from the committed batch + 3 from the resumed batch.
  expect(await sentLogRows(sp2)).toHaveLength(8);

  await ext2.context.close();
  provider.dispose();
});
