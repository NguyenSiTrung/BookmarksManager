import { expect, test } from "@playwright/test";
import { openSurface } from "./helpers/extension";
import { sentLogRows } from "./helpers/provider";
import { bookmarkMetaRows, jobRows } from "./helpers/decisions";
import {
  AUDIT_FIXTURE_ORIGIN,
  AUDIT_FRAGMENT_SECRET,
  AUDIT_LLM_ORIGIN,
  AUDIT_MODEL,
  AUDIT_QUERY_SECRET,
  AUDIT_SUMMARY_MAX_TOKENS,
  AUDIT_TEST_MAX_TOKENS,
  agreeAndSummarize,
  auditBookmark,
  auditFixtureUrl,
  auditLlmReservations,
  auditLlmUsage,
  clearBlocklist,
  closeSummaryDialog,
  enableAuditJevAndConsent,
  enableAuditLlm,
  launchAuditExtension,
  openAuditFixture,
  openAuditReview,
  openAuditSidePanel,
  openPermissionsPanelNoReload,
  openSummaryFromRow,
  patchUndoValve,
  releaseUndoValve,
  renameAuditBookmark,
  routeAuditJev,
  routeAuditLlm,
  seedBlocklist,
  sendAuditMessage,
  serializedAuditBodies,
  serveAuditFixture,
  undoDispatchCount,
} from "./helpers/audit-provider";

/**
 * Phase 6 Task 3 — cross-feature browser privacy and provider-workflow
 * regressions (audit improvements I04/I08; bugs B05–B12/B14 plus bounded
 * scan/UI behavior).
 *
 * Everything runs against the BUILT MV3 extension in a real Chromium context:
 * the Options React UI, the side-panel disclosure dialog, the real scan
 * controls, `chrome.runtime.sendMessage` across the page↔worker boundary, the
 * worker's own re-verification and egress gate, the genuine service-worker
 * `fetch`, and the device-bound IndexedDB artifacts. Only the wire after
 * Chromium's network stack is faked — `context.route` intercepts the worker's
 * fetch and answers from synthetic exact-origin endpoints (see
 * `./helpers/audit-provider.ts`).
 *
 * Permission disclosure: the audit launcher promotes the synthetic host
 * patterns to `host_permissions` in a temporary manifest copy, so Chrome
 * grants them silently at install. This BYPASSES the native
 * `chrome.permissions.request` prompt, which Playwright's Chromium never
 * resolves; that prompt widget is the one production behavior not exercised.
 * Every later production check (the worker's `permissions.contains` re-check,
 * consent records, the egress gate, budget accounting, the `sentLog` audit
 * write) runs unchanged. No real keys, URLs, excerpts, or user data appear —
 * every origin is a routed synthetic `*.dev` name and every marker is a fixed
 * `audit_*_secret` token.
 */

test("summary: blocked and mismatched pages send nothing; the allowed page sends exactly the disclosed hops without the secret marker", async () => {
  test.setTimeout(180_000);
  const ext = await launchAuditExtension();
  const { context, id } = ext;
  try {
    const llm = await routeAuditLlm(context);
    const jev = await routeAuditJev(context);
    const options = await openSurface(context, id, "options");
    await enableAuditJevAndConsent(options);
    await enableAuditLlm(options);
    await serveAuditFixture(context);

    const url = auditFixtureUrl("article");
    const fixture = await openAuditFixture(context, url);
    const panel = await openAuditSidePanel(ext);
    const bookmark = await auditBookmark(panel, {
      title: "Audit fixture",
      url,
    });
    await fixture.bringToFront();

    // --- Blocked (B05): the host is on the user blocklist -> zero egress.
    await seedBlocklist(options, ["audit-fixture.dev"]);
    const blocked = await openSummaryFromRow(panel, bookmark.id, "Audit fixture");
    await agreeAndSummarize(blocked);
    await expect(blocked.getByRole("alert")).toContainText(
      /blocked|not be sent/i,
      { timeout: 15_000 },
    );
    expect(llm.requests).toHaveLength(0);
    expect(jev.requests).toHaveLength(0);
    expect(await sentLogRows(options)).toHaveLength(0);
    await closeSummaryDialog(blocked);

    // --- Mismatch (B07): the saved bookmark differs from the active page in
    // a NON-tracking query value. A naive "cleaned URLs are equal" check
    // erases that difference and would send; resource identity must not.
    await clearBlocklist(options);
    await renameAuditBookmark(
      panel,
      bookmark.id,
      `${AUDIT_FIXTURE_ORIGIN}/article?doc=B&${AUDIT_QUERY_SECRET}=1#${AUDIT_FRAGMENT_SECRET}`,
    );
    const mismatch = await openSummaryFromRow(panel, bookmark.id, "Audit fixture");
    await agreeAndSummarize(mismatch);
    // The on-screen refusal is the event that proves the pipeline reached its
    // terminal state. A poll-based ABSENCE check over a bounded soak window
    // then proves nothing leaked BEFORE that state: polling a journal that is
    // already empty is vacuous on its own, so the window is bounded and
    // justified — a naive impl sends within milliseconds of the click, long
    // before this refusal settles, so this window still discriminates (the
    // pre-fix revision at c779b2e fails here with a captured request; the
    // request is already on the journal before the refusal renders).
    const soakDeadline = Date.now() + 2_000;
    await expect
      .poll(
        () => {
          expect(llm.requests).toHaveLength(0);
          expect(jev.requests).toHaveLength(0);
          return Date.now() >= soakDeadline;
        },
        { timeout: 10_000, intervals: [250] },
      )
      .toBe(true);
    await expect(mismatch.getByRole("alert")).toContainText(
      /does not match/i,
      { timeout: 15_000 },
    );
    await closeSummaryDialog(mismatch);

    // --- Allowed positive control: the exact page URL is restored.
    await renameAuditBookmark(panel, bookmark.id, url);
    const allowed = await openSummaryFromRow(panel, bookmark.id, "Audit fixture");
    await agreeAndSummarize(allowed);
    await expect(allowed.getByTestId("summary-text")).toContainText(
      "minimized audit fixture",
      { timeout: 30_000 },
    );

    // Exactly the two disclosed hops: one LLM summarize + the Jev verify.
    expect(llm.requests).toHaveLength(1);
    expect(jev.requests.length).toBeGreaterThan(0);
    expect(await sentLogRows(options)).toHaveLength(2);

    // B06: no raw query/fragment marker in any serialized provider body; the
    // cleaned URL is what left the device.
    const serialized = serializedAuditBodies([...llm.requests, ...jev.requests]);
    expect(serialized).not.toContain(AUDIT_QUERY_SECRET);
    expect(serialized).not.toContain(AUDIT_FRAGMENT_SECRET);
    expect(serialized).toContain(`${AUDIT_FIXTURE_ORIGIN}/article`);
    expect(serialized).not.toMatch(/"notes"/);

    // B08: the gate-owned reserved output allowance is what the wire carries,
    // and it matches the persisted reservation.
    const llmBody = llm.requests[0]!.postData as { max_tokens?: number };
    expect(llmBody.max_tokens).toBe(AUDIT_SUMMARY_MAX_TOKENS);
    const reservations = await auditLlmReservations(options);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      maxOutputTokens: AUDIT_SUMMARY_MAX_TOKENS,
    });

    await closeSummaryDialog(allowed);
  } finally {
    await context.close();
    ext.dispose();
  }
});

test("bounded output and missing usage: the reserved cap is on the wire and absent usage settles conservatively", async () => {
  test.setTimeout(120_000);
  const ext = await launchAuditExtension();
  const { context, id } = ext;
  try {
    // The synthetic endpoint answers successfully but OMITS the usage
    // envelope, the missing-usage path B09 must account conservatively.
    const wire = await routeAuditLlm(context, {
      reply: {
        model: AUDIT_MODEL,
        content: JSON.stringify({ ok: true }),
        usage: null,
      },
    });
    const options = await openSurface(context, id, "options");
    await enableAuditLlm(options);
    const providerId = `custom:${AUDIT_LLM_ORIGIN}/v1`;

    const reply = await sendAuditMessage(options, {
      type: "LLM_TEST",
      providerId,
    });
    expect(reply).toMatchObject({ ok: true, code: "test_ok" });
    expect(reply).not.toHaveProperty("result.usage");

    // B08: the wire carries exactly the gate-owned reserved cap.
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]).toMatchObject({
      method: "POST",
      url: `${AUDIT_LLM_ORIGIN}/v1/chat/completions`,
      postData: { model: AUDIT_MODEL, max_tokens: AUDIT_TEST_MAX_TOKENS },
    });

    const reservations = await auditLlmReservations(options);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      status: "settled",
      maxInputTokens: 64,
      maxOutputTokens: AUDIT_TEST_MAX_TOKENS,
    });
    const reservedUsd = reservations[0]!.reservedUsd;
    expect(reservedUsd).toBeGreaterThan(0);

    // B09: absent usage must NOT become zero — the conservative reservation
    // bound is committed as the estimated exposure.
    const usage = await auditLlmUsage(options);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      feature: "llm_test",
      inputTokens: 64,
      outputTokens: 16,
      estimatedCostUsd: reservedUsd,
    });
    expect(usage[0]).not.toHaveProperty("costUsd");
    expect(await sentLogRows(options)).toHaveLength(1);
  } finally {
    await context.close();
    ext.dispose();
  }
});

test("revoke while the routed response is held settles the in-flight request exactly once", async () => {
  test.setTimeout(120_000);
  const ext = await launchAuditExtension();
  const { context, id } = ext;
  let pending: Promise<unknown> | undefined;
  try {
    // Hold the first request at the valve so the real worker fetch is in
    // flight when the provider is revoked.
    const wire = await routeAuditLlm(context, {
      autoRelease: 0,
      reply: {
        model: AUDIT_MODEL,
        content: JSON.stringify({ ok: true }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    });
    const options = await openSurface(context, id, "options");
    await enableAuditLlm(options);
    const providerId = `custom:${AUDIT_LLM_ORIGIN}/v1`;

    pending = sendAuditMessage(options, { type: "LLM_TEST", providerId });
    await expect.poll(() => wire.requests.length).toBe(1);
    const [reservation] = await auditLlmReservations(options);
    expect(reservation).toMatchObject({ status: "active" });
    expect(await auditLlmUsage(options)).toHaveLength(0);

    // Revoke while the real worker fetch is held.
    const revoked = (await sendAuditMessage(options, {
      type: "LLM_REVOKE",
      providerId,
      deleteKey: true,
    })) as { ok: boolean; code?: string };
    expect(revoked.ok || revoked.code === "revoke_failed").toBe(true);
    // A new send is refused, and nothing new reached the wire.
    expect(await sendAuditMessage(options, { type: "LLM_TEST", providerId }))
      .toMatchObject({ ok: false });
    expect(wire.requests).toHaveLength(1);

    // Release the held successful response — the in-flight request still
    // settles, exactly once, against its persisted reservation snapshot.
    wire.release();
    await expect(pending).resolves.toMatchObject({ ok: true, code: "test_ok" });
    expect(await auditLlmUsage(options)).toHaveLength(1);
    expect(await auditLlmReservations(options)).toMatchObject([
      { id: reservation!.id, status: "settled" },
    ]);
    expect(wire.requests).toHaveLength(1);
  } finally {
    await pending?.catch(() => undefined);
    await context.close();
    ext.dispose();
  }
});

test("a held library scan pauses without further sends and resumes to completion", async () => {
  test.setTimeout(180_000);
  const ext = await launchAuditExtension();
  const { context, id } = ext;
  try {
    // Batch size is 5: six bookmarks means batch 1 (5) auto-releases and
    // commits, batch 2 (1) is HELD at the valve.
    const jev = await routeAuditJev(
      context,
      { choices: { category: "docs" }, noul: {} },
      { autoRelease: 5 },
    );
    const options = await openSurface(context, id, "options");
    await enableAuditJevAndConsent(options);
    const panel = await openAuditSidePanel(ext);
    for (let index = 0; index < 6; index += 1) {
      await auditBookmark(panel, {
        title: `Audit scan ${index}`,
        url: `${AUDIT_FIXTURE_ORIGIN}/scan-${index}`,
      });
    }

    await panel.getByRole("button", { name: "Tools" }).click();
    await panel.getByRole("menuitem", { name: "Scan library…" }).click();
    const dialog = panel.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Scan library" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Start scan" }).click();

    // Batch 1's five analyses released; batch 2's first analysis is held.
    await expect.poll(() => jev.requests.length, { timeout: 60_000 }).toBe(6);

    await dialog.getByRole("button", { name: "Pause" }).click();
    await expect(dialog.getByText("Scan: Paused")).toBeVisible({
      timeout: 30_000,
    });
    // Open the valve: the held analysis completes, but a paused scan must
    // start no new paid work. Poll the wire journal as an ABSENCE check over a
    // bounded soak window: the paused row is the observable terminal state, so
    // this window is what proves no extra request was issued in the meantime.
    // (The runner is strictly sequential, so a naive resume-while-paused
    // regression sends within milliseconds of the release.)
    jev.release();
    const pauseSoakDeadline = Date.now() + 1_500;
    await expect
      .poll(
        () => {
          expect(jev.requests).toHaveLength(6);
          return Date.now() >= pauseSoakDeadline;
        },
        { timeout: 10_000, intervals: [250] },
      )
      .toBe(true);
    await expect(dialog.getByText("Scan: Paused")).toBeVisible();

    await dialog.getByRole("button", { name: "Resume" }).click();
    await expect(dialog.getByText("Scan: Completed")).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog.getByText(/6 bookmarks processed/)).toBeVisible();
    // Every bookmark was requested at least once across the run, and the
    // persisted job reached a terminal completed state. (A batch that was
    // interrupted mid-flight before it committed may be re-sent on resume —
    // the documented at-least-once uncommitted-batch behavior — so the total
    // is bounded below, never forced to an exact duplicate-free count.)
    expect(jev.requests.length).toBeGreaterThanOrEqual(6);
    const scanJob = (await jobRows(panel)).find(
      (job) => job.kind === "library_scan",
    );
    expect(scanJob?.status).toBe("completed");
  } finally {
    await context.close();
    ext.dispose();
  }
});

test("rapid Undo on an applied decision dispatches exactly one revert and disables the control while held", async () => {
  test.setTimeout(180_000);
  const ext = await launchAuditExtension();
  const { context, id } = ext;
  try {
    await routeAuditJev(context, { choices: { category: "docs" }, noul: {} });
    const options = await openSurface(context, id, "options");
    await enableAuditJevAndConsent(options);
    const panel = await openAuditSidePanel(ext);
    const bookmark = await auditBookmark(panel, {
      title: "Audit decision",
      url: `${AUDIT_FIXTURE_ORIGIN}/decision`,
    });

    // Analyze, then approve the pending suggestion through the real UI.
    const row = panel.locator(`[data-bookmark-id="${bookmark.id}"]`);
    await expect(row).toBeVisible();
    await row.click();
    await panel
      .getByRole("button", { name: "Actions for Audit decision" })
      .click();
    await panel.getByRole("menuitem", { name: "Analyze" }).click();
    await expect(panel.getByText(/Analyzed “Audit decision”/)).toBeVisible({
      timeout: 30_000,
    });

    await openAuditReview(panel);
    const queue = panel.getByRole("listbox", { name: "Pending suggestions" });
    const option = queue
      .getByRole("option")
      .filter({ hasText: "Set category" })
      .filter({ hasText: "Audit decision" });
    await option
      .getByRole("button", {
        name: "Approve the suggestion for Audit decision",
      })
      .click();
    const toast = panel.getByTestId("undo-toast");
    await expect(toast).toContainText("Applied the suggestion");

    // Hold the revert mid-flight; the dispatch that starts it consumes its
    // target, so a second activation must be refused (B12).
    await patchUndoValve(panel);
    const undo = toast.getByRole("button", { name: "Undo", exact: true });
    await undo.click();
    await expect(undo).toBeDisabled({ timeout: 10_000 });
    await expect(undo).toHaveAttribute("aria-busy", "true");

    // A second activation must be refused by the B12 in-flight guard. This is
    // the REAL bypass path, not a tautology: the command palette's "Undo last
    // action" command routes to the same `handleToastUndo` and never sees the
    // disabled attribute, so the guard is the only thing stopping a second
    // REVERT_DECISION. The valve holds the first round trip, so the guard is
    // still armed while the second activation runs.
    await undo.evaluate((element) =>
      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
    await panel.keyboard.press("Control+k");
    const palette = panel.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    const command = palette
      .getByRole("option")
      .filter({ hasText: "Undo last action" });
    await expect(command).toBeVisible();
    await command.click();
    await expect(palette).toBeHidden();

    // Exactly one revert was dispatched after three activations.
    expect(await undoDispatchCount(panel)).toBe(1);

    await releaseUndoValve(panel);
    await expect(toast).toContainText("Reverted the suggestion", {
      timeout: 15_000,
    });
    expect(await undoDispatchCount(panel)).toBe(1);
    await expect
      .poll(async () =>
        (await bookmarkMetaRows(panel)).find((meta) => meta.id === bookmark.id)
          ?.category,
      )
      .toBeUndefined();
  } finally {
    await context.close();
    ext.dispose();
  }
});

test("Options reflects a newly enabled LLM provider in the Permissions panel without a reload", async () => {
  test.setTimeout(120_000);
  const ext = await launchAuditExtension();
  const { context, id } = ext;
  try {
    const options = await openSurface(context, id, "options");
    // Enable in the Connections panel. The Permissions panel is mounted from
    // page load with no provider; a live read must surface the change.
    await enableAuditLlm(options);
    await openPermissionsPanelNoReload(options);

    await expect(
      options.getByLabel(
        new RegExp(`I allow second opinions to be sent to ${AUDIT_LLM_ORIGIN}`),
      ),
    ).toBeVisible({ timeout: 15_000 });
    // The live escalation snapshot also lands: a capped, priced provider.
    await expect(options.getByText(/Monthly cap: \$5\.00/)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.close();
    ext.dispose();
  }
});
