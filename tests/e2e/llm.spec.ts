import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  collectOutboundRequests,
  openSurface,
} from "./helpers/extension";
import {
  abortLlmRequests,
  enableCustom,
  enableOpenAi,
  launchLlmExtension,
  routeFakeOpenAi,
  sendLlmMessage,
} from "./helpers/llm";
import {
  grantDecisionsConsent,
  routeFakeDecisions,
} from "./helpers/decisions";
import { enableTypesafe, readStoreRows } from "./helpers/provider";
import { createBookmark, createFolder } from "./helpers/seed";
import { jobRows } from "./helpers/decisions";
import { openOptionsPanel } from "./helpers/surfaces";
import { SummaryConsentPreflight, SummarizeMessageResult } from "../../src/messages/summaries";

/**
 * Phase 6 Task 1 (track spec FR7–FR10) — real-browser coverage of the LLM
 * layer: provider setup, gated egress to the OpenAI-compatible endpoint,
 * the restructure workflow end to end (proposal → Jev assignment → guarded
 * apply → undo), budget refusal, revoke, and restart-from-committed-progress.
 *
 * Real end to end: the Options React UI, `chrome.runtime.sendMessage`
 * crossing the page↔worker boundary, the worker's re-verification
 * (sender/consent/permission/budget), the egress gate's genuine service-
 * worker `fetch`, consent/budget/audit persistence, and the bookmark tree
 * mutations the apply performs. Faked only at the wire: routed OpenAI +
 * TypeSafe endpoints (Playwright intercepts MV3 worker fetches), and the
 * install-time host grant that replaces the `chrome.permissions.request`
 * prompt Playwright's Chromium never resolves (see helpers/provider.ts).
 */

const OPENAI_ORIGIN = "https://api.openai.com";

declare const chrome: {
  bookmarks: {
    get(id: string): Promise<Array<{ parentId?: string }>>;
    getSubTree(id: string): Promise<Array<{ children?: Array<{ id: string; title: string }> }>>;
  };
  tabs: {
    query(query: { url: string }): Promise<Array<{ id?: number }>>;
  };
};

/** The OpenAI proposal completion — one `dev` folder. */
const PROPOSAL = JSON.stringify({
  folders: [{ path: "dev", description: "Developer tools" }],
});

test.describe.configure({ mode: "serial" });

test("fresh install: every LLM intent refuses with zero egress", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension();
  const openaiLog = await abortLlmRequests(ext.context);
  const jevLog = await (
    await import("./helpers/provider")
  ).abortProviderRequests(ext.context);
  const outbound = collectOutboundRequests(ext.context);
  const page = await openSurface(ext.context, ext.id, "options");

  for (const msg of [
    { type: "RESTRUCTURE_START", providerId: "preset:openai" },
    { type: "RESTRUCTURE_UNDO" },
  ]) {
    const reply = (await sendLlmMessage(page, msg)) as {
      ok: boolean;
      code: string;
    };
    expect(reply.ok).toBe(false);
  }
  expect(openaiLog.requests).toHaveLength(0);
  expect(jevLog.requests).toHaveLength(0);
  expect(outbound.urls).toHaveLength(0);

  await ext.context.close();
  ext.dispose();
});

test("Options setup enables the provider and Test connection hits only its origin", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension();
  const route = await routeFakeOpenAi(ext.context);
  const page = await openSurface(ext.context, ext.id, "options");
  await enableOpenAi(page, { key: "sk-e2e-test", model: "gpt-4o-mini-2024-07-18" });

  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Connection test succeeded/)).toBeVisible({
    timeout: 15_000,
  });
  expect(route.requests).toHaveLength(1);
  const req = route.requests[0]!;
  expect(req.url).toBe(`${OPENAI_ORIGIN}/v1/chat/completions`);
  expect(req.headers["authorization"]).toBe("Bearer sk-e2e-test");
  // Structured-output tier on the wire.
  const body = req.postData as { response_format?: { type?: string } };
  expect(body.response_format?.type).toBe("json_schema");

  await ext.context.close();
  ext.dispose();
});

test("restructure: propose → assign → preview → apply → undo", async () => {
  test.setTimeout(180_000);
  const ext = await launchLlmExtension();
  const openai = await routeFakeOpenAi(ext.context, { content: PROPOSAL });
  const jev = await routeFakeDecisions(ext.context, {
    choices: { folder: "p0" },
    noul: {},
  });
  const page = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(page, { key: "e2e-jev-key" });
  await grantDecisionsConsent(page);
  await enableOpenAi(page, { key: "sk-e2e", model: "gpt-4o-mini-2024-07-18" });

  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  const folder = await createFolder(panel, "Old", "1");
  const bm = await createBookmark(panel, {
    title: "Dev tool",
    url: "https://devtools.io/t",
    parentId: folder.id,
  });

  const refused = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_START",
    providerId: "preset:openai",
  })) as {
    ok: boolean;
    code: string;
    destinationOrigin?: string;
  };
  // The unpriced model needs an explicit unknown-cost confirmation first —
  // the reply names the destination origin (a target, never content).
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("confirmation_required");
  expect(refused.destinationOrigin).toBe(OPENAI_ORIGIN);

  const start = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_START",
    providerId: "preset:openai",
    unknownCostConfirmed: true,
  })) as { ok: boolean; code: string; job?: { id: string } };
  expect(start.ok, JSON.stringify(start)).toBe(true);
  expect(start.job?.id).toBeDefined();

  // Poll until the job completes — Jev assigns via the fake.
  const deadline = Date.now() + 30_000;
  interface StatusReply {
    ok: boolean;
    code: string;
    result?: { job: { status: string }; diff?: { resolved: number } };
  }
  let status: StatusReply | null = null;
  while (Date.now() < deadline) {
    status = (await sendLlmMessage(panel, {
      type: "RESTRUCTURE_STATUS",
      jobId: start.job!.id,
    })) as StatusReply;
    if (status.ok && status.result?.job.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(status?.result?.job.status).toBe("completed");
  expect(status?.result?.diff?.resolved).toBe(1);
  // The proposal used the gated OpenAI wire exactly once.
  expect(openai.requests).toHaveLength(1);
  expect(jev.requests.length).toBeGreaterThan(0);

  const confirmed = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_CONFIRM",
    jobId: start.job!.id,
  })) as { ok: boolean; code: string; moved?: number };
  expect(confirmed).toMatchObject({ ok: true, code: "applied", moved: 1 });
  const moved = await panel.evaluate(async (id: string) => {
    const [node] = await chrome.bookmarks.get(id);
    return node?.parentId;
  }, bm.id);
  const devFolder = await panel.evaluate(async () => {
    const [bar] = await chrome.bookmarks.getSubTree("1");
    return bar?.children?.find((c: { title: string }) => c.title === "dev");
  });
  expect(moved).toBe(devFolder?.id);

  const undone = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_UNDO",
  })) as { ok: boolean; code: string };
  expect(undone).toMatchObject({ ok: true, code: "undone" });
  const restored = await panel.evaluate(async (id: string) => {
    const [node] = await chrome.bookmarks.get(id);
    return node?.parentId;
  }, bm.id);
  expect(restored).toBe(folder.id);

  await ext.context.close();
  ext.dispose();
});

test("budget exhaustion and revoke refuse further sends", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension({
    extraHostPatterns: ["https://llm-custom.test/*"],
  });
  const openai = await routeFakeOpenAi(ext.context, { content: PROPOSAL });
  const page = await openSurface(ext.context, ext.id, "options");
  // Custom endpoints are the only branch exposing per-token pricing — a
  // $0 cap + priced model means the reservation estimate refuses before
  // anything reaches the wire.
  await enableCustom(page, {
    baseUrl: "https://llm-custom.test/v1",
    key: "sk-e2e",
    model: "custom-model",
    budgetCap: "0",
    inputPrice: "5",
    outputPrice: "15",
  });
  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  await createBookmark(panel, { title: "B", url: "https://b.io/" });

  const refused = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_START",
    providerId: "custom:https://llm-custom.test/v1",
  })) as { ok: boolean; code: string };
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("budget_exceeded");
  expect(openai.requests).toHaveLength(0);

  // Revoke through the real UI. Consent-first ordering removes the grant
  // before host-permission removal, which refuses under the manifest-patch
  // workaround (install-time grants are not optional). Either the success
  // notice or the permission error appears — the grant is gone either way.
  await page.getByRole("button", { name: "Revoke LLM provider access" }).click();
  await expect(
    page
      .getByText(/consent and browser access were removed|browser access could not be removed|could not be removed/)
      .first(),
  ).toBeVisible({ timeout: 15_000 });
  const after = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_START",
    providerId: "custom:https://llm-custom.test/v1",
  })) as { ok: boolean; code: string };
  expect(after.ok, JSON.stringify(after)).toBe(false);
  expect(["no_provider", "no_consent"]).toContain(after.code);
  expect(openai.requests).toHaveLength(0);

  await ext.context.close();
  ext.dispose();
});


test("structured tiers fall back on capability rejection", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension();
  // Reject the first two calls with validated OpenAI-compatible capability
  // errors, then answer the prompt_only retry with the proposal.
  const openai = await routeFakeOpenAi(ext.context, (body, call) =>
    call <= 2
      ? {
          status: 400,
          error: {
            param: "response_format",
            message: "unsupported response_format json_schema/json_object",
          },
        }
      : { content: PROPOSAL },
  );
  const jev = await routeFakeDecisions(ext.context, {
    choices: { folder: "p0" },
    noul: {},
  });
  const page = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(page, { key: "e2e-jev-key" });
  await grantDecisionsConsent(page);
  await enableOpenAi(page, { key: "sk-e2e", model: "gpt-4o-mini-2024-07-18" });
  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  await createBookmark(panel, { title: "B", url: "https://b.io/" });

  const start = (await sendLlmMessage(panel, {
    type: "RESTRUCTURE_START",
    providerId: "preset:openai",
    unknownCostConfirmed: true,
  })) as { ok: boolean; job?: { id: string } };
  expect(start.ok, JSON.stringify(start)).toBe(true);
  const deadline = Date.now() + 30_000;
  let status = "";
  while (Date.now() < deadline) {
    const rows = await jobRows(panel);
    status = rows.find((r) => r.id === start.job!.id)?.status ?? "";
    if (status === "completed" || status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(status).toBe("completed");

  // Wire evidence: json_schema → json_object → prompt_only (no
  // response_format key) — capability-only fallback in order.
  expect(openai.requests).toHaveLength(3);
  const formats = openai.requests.map(
    (r) =>
      (r.postData as { response_format?: { type?: string } }).response_format
        ?.type ?? null,
  );
  expect(formats).toEqual(["json_schema", "json_object", null]);
  for (const request of openai.requests) {
    expect(request.postData).toMatchObject({ max_tokens: 1_500 });
  }
  expect(jev.requests.length).toBeGreaterThan(0);

  await ext.context.close();
  ext.dispose();
});

test("Explain answers a pending decision over the gated wire", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension();
  const openai = await routeFakeOpenAi(ext.context, {
    content: JSON.stringify({ rationale: "It is a docs page." }),
  });
  await routeFakeDecisions(ext.context, { choices: {}, noul: {} });
  const page = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(page, { key: "e2e-jev-key" });
  await grantDecisionsConsent(page);
  await enableOpenAi(page, { key: "sk-e2e", model: "gpt-4o-mini-2024-07-18" });
  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  const bm = await createBookmark(panel, {
    title: "Tokio async tutorial",
    url: "https://tokio.rs/tutorial",
  });

  const analyzed = (await sendLlmMessage(panel, {
    type: "ANALYZE_BOOKMARK",
    bookmarkId: bm.id,
  })) as { ok: boolean; result?: { sent: boolean; decisionCount: number } };
  expect(analyzed.ok, JSON.stringify(analyzed)).toBe(true);
  expect(analyzed.result?.decisionCount).toBeGreaterThan(0);

  const rows = await readStoreRows<{ id: string; status: string }>(
    panel,
    "decisions",
  );
  const pending = rows.find((r) => r.status === "pending");
  expect(pending, JSON.stringify(rows)).toBeDefined();

  const refused = (await sendLlmMessage(panel, {
    type: "LLM_EXPLAIN",
    decisionId: pending!.id,
  })) as { ok: boolean; code: string };
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("confirmation_required");

  const explained = (await sendLlmMessage(panel, {
    type: "LLM_EXPLAIN",
    decisionId: pending!.id,
    unknownCostConfirmed: true,
  })) as {
    ok: boolean;
    code: string;
    result?: { rationale: string; decisionId: string };
  };
  expect(explained.ok, JSON.stringify(explained)).toBe(true);
  expect(explained.result?.rationale).toContain("docs page");
  expect(explained.result?.decisionId).toBe(pending!.id);
  expect(openai.requests).toHaveLength(1);

  await ext.context.close();
  ext.dispose();
});

test("unsure analyze escalates automatically under the cap", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension({
    extraHostPatterns: ["https://llm-custom.test/*"],
  });
  // The custom provider's egress origin — route the same fake there; the
  // default api.openai.com route would leave this call unrouted.
  const openai = await routeFakeOpenAi(
    ext.context,
    {
      content: JSON.stringify({
        verdict: "agree",
        rationale: "Second opinion agrees.",
      }),
    },
    "https://llm-custom.test",
  );
  await routeFakeDecisions(
    ext.context,
    { choices: {}, noul: {}, confidence: 0.3 },
  );
  const page = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(page, { key: "e2e-jev-key" });
  await grantDecisionsConsent(page);
  // Escalation needs a priced provider WITH a chosen ceiling. A custom
  // endpoint needs both rates entered (nothing built-in prices it); the
  // preset default model gets its price from the built-in table.
  await enableCustom(page, {
    baseUrl: "https://llm-custom.test/v1",
    key: "sk-e2e",
    model: "custom-model",
    budgetCap: "5",
    inputPrice: "5",
    outputPrice: "15",
  });

  // DecisionSettings reads provider+escalation status once on mount —
  // reload so the just-enabled provider is what the effect sees, then
  // re-select the Permissions panel the consent controls live in.
  await page.reload();
  await openOptionsPanel(page, "Permissions");
  // Task 3 read gate: open the escalation disclosure before the checkbox.
  await page
    .locator("summary", { hasText: "Automatic second opinions" })
    .click();
  await page
    .getByLabel(/I allow second opinions to be sent to https:\/\/llm-custom\.test/)
    .check();
  await page
    .getByRole("button", { name: "Allow second opinions" })
    .click();
  await expect(
    page.getByText(/Second-opinion consent recorded/),
  ).toBeVisible({ timeout: 15_000 });
  // Controlled checkbox: the SET reply roundtrip re-renders `checked`
  // asynchronously — click, then poll the checked state.
  const toggle = page.getByLabel(
    "Ask the provider for a second opinion on unsure suggestions",
  );
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 15_000 });
  await expect(page.getByText(/Monthly cap: \$5\.00/)).toBeVisible({
    timeout: 15_000,
  });

  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  const bm = await createBookmark(panel, {
    title: "Low confidence pick",
    url: "https://lowconf.io/",
  });
  const analyzed = (await sendLlmMessage(panel, {
    type: "ANALYZE_BOOKMARK",
    bookmarkId: bm.id,
  })) as { ok: boolean; result?: { sent: boolean } };
  expect(analyzed.ok, JSON.stringify(analyzed)).toBe(true);

  // The 0.3-confidence answer lands unsure → the worker escalates over the
  // OpenAI-compatible wire without a second click.
  const deadline = Date.now() + 15_000;
  let escalated = false;
  while (Date.now() < deadline) {
    if (openai.requests.length > 0) {
      escalated = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const dbg = await readStoreRows<unknown>(panel, "decisions");
  expect(escalated, `rows=${JSON.stringify(dbg)} openai=${openai.requests.length}`).toBe(true);
  const rows = await readStoreRows<{
    status: string;
    escalation?: { llmVerdict?: string };
  }>(panel, "decisions");
  expect(rows.some((r) => r.status === "unsure")).toBe(true);
  expect(rows.some((r) => r.escalation?.llmVerdict === "agree")).toBe(true);

  await ext.context.close();
  ext.dispose();
});

test("an explicit unlimited ceiling unlocks preset escalation, and the ceiling stays editable", async () => {
  test.setTimeout(150_000);
  const ext = await launchLlmExtension();
  const openai = await routeFakeOpenAi(ext.context, {
    content: JSON.stringify({
      verdict: "agree",
      rationale: "Second opinion agrees.",
    }),
  });
  await routeFakeDecisions(ext.context, {
    choices: {},
    noul: {},
    confidence: 0.3,
  });
  const page = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(page, { key: "e2e-jev-key" });
  await grantDecisionsConsent(page);

  // The OpenAI preset's default model carries a built-in price, so no rates
  // are typed here: the ceiling is the only choice, and "unlimited" is a
  // deliberate one. Before the pricing table existed this combination could
  // never escalate, because nothing could price a preset's request.
  await openOptionsPanel(page, "Connections");
  await page
    .getByLabel(/no monthly cap — spend without a limit/i)
    .check();
  await expect(
    page.getByText(/library scan can send a request per bookmark/i),
  ).toBeVisible();
  await page.locator("#llm-api-key").fill("sk-e2e");
  // Task 3 read gate: open the disclosure before the agree checkbox.
  await page
    .getByRole("region", { name: "Optional LLM provider" })
    .locator("summary", { hasText: "What enabling an LLM provider means" })
    .click();
  await page.getByLabel(/agree to enable this LLM provider/).check();
  await page.getByRole("button", { name: "Enable LLM provider" }).click();
  await expect(
    page.getByRole("group", { name: "LLM enabled provider" }),
  ).toBeVisible({ timeout: 15_000 });

  // DecisionSettings reads the provider + escalation status on mount.
  await page.reload();
  await openOptionsPanel(page, "Permissions");
  // Task 3 read gate: open the escalation disclosure before the checkbox.
  await page
    .locator("summary", { hasText: "Automatic second opinions" })
    .click();
  await page
    .getByLabel(/I allow second opinions to be sent to https:\/\/api\.openai\.com/)
    .check();
  await page
    .getByRole("button", { name: "Allow second opinions" })
    .click();
  await expect(page.getByText(/Second-opinion consent recorded/)).toBeVisible({
    timeout: 15_000,
  });
  const toggle = page.getByLabel(
    "Ask the provider for a second opinion on unsure suggestions",
  );
  // Unlimited + built-in pricing is enough to unlock the unattended path.
  await expect(toggle).toBeEnabled({ timeout: 15_000 });
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 15_000 });
  await expect(page.getByText(/this can spend without a limit/i)).toBeVisible({
    timeout: 15_000,
  });

  // The unattended send really happens: analyze a low-confidence bookmark.
  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  const bm = await createBookmark(panel, {
    title: "Preset escalation",
    url: "https://lowconf-preset.io/",
  });
  const analyzed = (await sendLlmMessage(panel, {
    type: "ANALYZE_BOOKMARK",
    bookmarkId: bm.id,
  })) as { ok: boolean; result?: { sent: boolean } };
  expect(analyzed.ok, JSON.stringify(analyzed)).toBe(true);
  const deadline = Date.now() + 15_000;
  let escalated = false;
  while (Date.now() < deadline) {
    if (openai.requests.length > 0) {
      escalated = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(escalated).toBe(true);

  // The ceiling is editable on the enabled provider — no revoke, no key
  // re-entry. The budget panel lives in the Connections panel, so switch
  // back to it; the cap field stays disabled until "unlimited" is unticked.
  await openOptionsPanel(page, "Connections");
  const budgetPanel = page.getByRole("region", { name: "LLM budget" });
  const panelCap = budgetPanel.getByLabel("Monthly cap (USD)");
  await expect(panelCap).toBeVisible({ timeout: 15_000 });
  await expect(panelCap).toBeDisabled();
  await budgetPanel
    .getByLabel(/no monthly cap — spend without a limit/i)
    .uncheck();
  await expect(panelCap).toBeEnabled();
  await panelCap.fill("7.5");
  await budgetPanel.getByRole("button", { name: "Save ceiling" }).click();
  await expect(budgetPanel.getByText("$7.50", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const status = (await sendLlmMessage(page, {
    type: "LLM_ESCALATION_STATUS",
  })) as {
    ok: boolean;
    escalation?: { budget?: string; monthlyBudgetUsd?: number | null };
  };
  expect(status.ok, JSON.stringify(status)).toBe(true);
  expect(status.escalation?.budget).toBe("capped");
  expect(status.escalation?.monthlyBudgetUsd).toBe(7.5);

  await ext.context.close();
  ext.dispose();
});

test("summarize extracts, Jev-verifies, then persists the summary", async () => {
  test.setTimeout(150_000);
  const ext = await launchLlmExtension({
    extraHostPatterns: ["https://summarize-fixture.io/*"],
  });
  const openai = await routeFakeOpenAi(ext.context, {
    content: JSON.stringify({ summary: "A routed fixture page." }),
  });
  const jev = await routeFakeDecisions(ext.context, {
    choices: { verdict: "supported" },
    noul: {},
  });
  const page = await openSurface(ext.context, ext.id, "options");
  await enableTypesafe(page, { key: "e2e-jev-key" });
  await grantDecisionsConsent(page);
  await enableOpenAi(page, { key: "sk-e2e", model: "gpt-4o-mini-2024-07-18" });
  const panel = await openSurface(ext.context, ext.id, "sidepanel");

  // Serve the fixture page at a real https origin the extension was
  // granted at install time, then open it as a real tab.
  await ext.context.route("https://summarize-fixture.io/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body><article><h1>Fixture</h1><p>Page text for the summarizer.</p></article></body></html>",
    }),
  );
  const tab = await ext.context.newPage();
  await tab.goto("https://summarize-fixture.io/");
  const bm = await createBookmark(panel, {
    title: "Fixture page",
    url: "https://summarize-fixture.io/",
  });
  const tabId = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "https://summarize-fixture.io/*" });
    return tabs[0]?.id;
  });
  expect(tabId).toBeDefined();

  const preflight = SummarizeMessageResult.parse(await sendLlmMessage(panel, {
    type: "LLM_SUMMARY_PREFLIGHT",
  }));
  expect(preflight.ok).toBe(true);
  if (!preflight.ok || preflight.code !== "summary_consent") throw new Error("Summary preflight failed.");
  const consent = SummaryConsentPreflight.parse(preflight.consent);
  expect(consent.approval.consentVersion).toBe(4);
  expect(consent.approval.llm.origin).toBe(OPENAI_ORIGIN);
  expect(consent.approval.jev.origin).toBe("https://api.typesafe.ai");
  expect(openai.requests).toHaveLength(0);
  expect(jev.requests).toHaveLength(0);
  // The production disclosure must remain readable and its affirmative
  // action reachable in a narrow, short side-panel viewport. Opening and
  // dismissing it must remain read-only, regardless of the active tab.
  await panel.setViewportSize({ width: 360, height: 480 });
  await panel.getByRole("button", { name: "Actions for Fixture page", exact: true }).click();
  await panel.getByRole("menuitem", { name: "Summarize…", exact: true }).click();
  const disclosureDialog = panel.getByRole("dialog", { name: "Summarize “Fixture page”", exact: true });
  const agree = disclosureDialog.getByRole("button", { name: "Agree and summarize", exact: true });
  await expect(agree).toBeAttached();
  await agree.scrollIntoViewIfNeeded();
  await expect(agree).toBeInViewport();
  await disclosureDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(disclosureDialog).toBeHidden();
  expect(openai.requests).toHaveLength(0);
  expect(jev.requests).toHaveLength(0);
  // This fixture tab uses install-time permissions because Playwright
  // cannot grant activeTab through the native toolbar action. Affirmative
  // protocol approval echoes the real preflight, never a synthetic grant.
  const cost = SummarizeMessageResult.parse(await sendLlmMessage(panel, {
    type: "LLM_SUMMARIZE",
    tabId: tabId!,
    bookmarkId: bm.id,
    consentApproval: consent.approval,
  }));
  expect(cost).toMatchObject({
    ok: false, code: "confirmation_required", destinationOrigin: OPENAI_ORIGIN,
  });
  expect(openai.requests).toHaveLength(0);
  expect(jev.requests).toHaveLength(0);
  const summarized = (await sendLlmMessage(panel, {
    type: "LLM_SUMMARIZE",
    tabId: tabId!,
    bookmarkId: bm.id,
    unknownCostConfirmed: true,
    consentApproval: consent.approval,
  })) as { ok: boolean; code: string };
  expect(summarized.ok, JSON.stringify(summarized)).toBe(true);
  expect(summarized.code).toBe("summary_ok");
  expect(openai.requests).toHaveLength(1);
  expect(jev.requests.length).toBeGreaterThan(0);

  // Only a Jev-supported verdict persists — read it back.
  const read = (await sendLlmMessage(panel, {
    type: "LLM_SUMMARY_READ",
    bookmarkId: bm.id,
  })) as { ok: boolean; code?: string; summary?: string };
  expect(read.ok, JSON.stringify(read)).toBe(true);
  expect(read.code).toBe("summary_read");
  expect(read.summary).toContain("routed fixture");

  await tab.close();
  await ext.context.close();
  ext.dispose();
});

test("worker restart resumes a restructure job from committed progress", async () => {
  test.setTimeout(180_000);
  const profileDir = mkdtempSync(path.join(tmpdir(), "bm-e2e-profile-"));
  const extensionRoot = mkdtempSync(path.join(tmpdir(), "bm-e2e-extroot-"));
  try {
    const ext = await launchLlmExtension({ profileDir, extensionRoot });
    await routeFakeOpenAi(ext.context, { content: PROPOSAL });
    // Batch 1's five calls answer; batch 2 parks until release() — the
    // parked request holds the runner mid-job so the row stays resumable.
    const jev = await routeFakeDecisions(
      ext.context,
      { choices: { folder: "p0" }, noul: {} },
      { autoRelease: 5 },
    );
    const page = await openSurface(ext.context, ext.id, "options");
    await enableTypesafe(page, { key: "e2e-jev-key" });
    await grantDecisionsConsent(page);
    await enableOpenAi(page, { key: "sk-e2e", model: "gpt-4o-mini-2024-07-18" });
    const panel = await openSurface(ext.context, ext.id, "sidepanel");
    for (let i = 0; i < 7; i += 1) {
      await createBookmark(panel, { title: `B${i}`, url: `https://b${i}.io/` });
    }

    const start = (await sendLlmMessage(panel, {
      type: "RESTRUCTURE_START",
      providerId: "preset:openai",
      unknownCostConfirmed: true,
    })) as { ok: boolean; job?: { id: string } };
    expect(start.ok, JSON.stringify(start)).toBe(true);
    const jobId = start.job!.id;
    // Wait for batch 1 to commit before pausing.
    const commitDeadline = Date.now() + 15_000;
    while (Date.now() < commitDeadline) {
      const rows = await jobRows(panel);
      const row = rows.find((r) => r.id === jobId);
      if ((row?.progress.committedBatches ?? 0) >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const paused = (await sendLlmMessage(panel, {
      type: "RESTRUCTURE_PAUSE",
      jobId,
    })) as { ok: boolean; job?: { status: string } };
    expect(paused.job?.status, JSON.stringify(paused)).toBe("paused");
    const rowsBefore = await jobRows(panel);
    expect(rowsBefore.find((r) => r.id === jobId)?.progress.committedBatches).toBe(1);
    // Drain the parked request so the worker exits cleanly before close —
    // a parked fetch aborts on context close and would poison the row.
    jev.release();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await ext.context.close();

    const relaunch = await launchLlmExtension({ profileDir, extensionRoot });
    const openai2 = await routeFakeOpenAi(relaunch.context, {
      content: PROPOSAL,
    });
    const jev2 = await routeFakeDecisions(
      relaunch.context,
      { choices: { folder: "p0" }, noul: {} },
    );
    const panel2 = await openSurface(relaunch.context, relaunch.id, "sidepanel");
    // The persisted row carried proposal + committed batch across the
    // restart; RESUME re-drives only the uncommitted tail.
    const resumed = (await sendLlmMessage(panel2, {
      type: "RESTRUCTURE_RESUME",
      jobId,
    })) as { ok: boolean; job?: { status: string } };
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    const deadline = Date.now() + 30_000;
    let status = "";
    let row = undefined as undefined | { status: string };
    while (Date.now() < deadline) {
      const rows = await jobRows(panel2);
      row = rows.find((r) => r.id === jobId);
      status = row?.status ?? "";
      if (status === "completed" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(
      status,
      `row=${JSON.stringify(row)} openai=${openai2.requests.length} jev=${jev2.requests.length}`,
    ).toBe("completed");
    // The proposal persisted on the row — the relaunch never re-egresses
    // the LLM call.
    expect(openai2.requests).toHaveLength(0);

    await relaunch.context.close();
    relaunch.dispose();
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    if (process.env.KEEP_E2E_EXTROOT !== "1") {
      rmSync(extensionRoot, { recursive: true, force: true });
    }
  }
});
