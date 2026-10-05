import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
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
  settleLlmUsageAgain,
} from "./helpers/llm";
import type { FakeOpenAiReply } from "./helpers/llm";
import type { BudgetReservation, LlmUsageRow } from "../../src/llm/budget";
import {
  buildFakeResponse,
  grantDecisionsConsent,
  isRecord,
  routeFakeDecisions,
} from "./helpers/decisions";
import { enableTypesafe, readStoreRows } from "./helpers/provider";
import { createBookmark, createFolder } from "./helpers/seed";
import { jobRows } from "./helpers/decisions";
import { openMoreView, openOptionsPanel } from "./helpers/surfaces";
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
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>> };
  };
};

/** The OpenAI proposal completion — one `dev` folder. */
const PROPOSAL = JSON.stringify({
  folders: [{ path: "dev", description: "Developer tools" }],
});

/** Exercise the real unchecked dialog — never seed feature grants. */
async function acceptFeatureConsent(page: Page, action: string) {
  const dialog = page.getByRole("dialog", { name: /^Allow/ });
  await expect(dialog).toBeVisible();
  const checkbox = dialog.getByRole("checkbox");
  await expect(checkbox).toHaveAttribute("aria-checked", "false");
  const approve = dialog.getByRole("button", { name: action, exact: true });
  await expect(approve).toBeDisabled();
  await checkbox.click();
  await approve.click();
}

async function startRestructureFromUi(panel: Page) {
  await openMoreView(panel, "Restructure");
  await panel.getByRole("button", { name: "Propose a layout…", exact: true }).click();
  await acceptFeatureConsent(panel, "Agree and propose");
  await panel.getByRole("dialog").getByRole("button", { name: "Send anyway", exact: true }).click();
  await expect.poll(async () => (await jobRows(panel)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const job = (await jobRows(panel)).find((row) => row.kind === "restructure");
  expect(job).toBeDefined();
  return job!;
}

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

const ACCOUNTING_ORIGIN = "https://llm-accounting.test";
const ACCOUNTING_PROVIDER = `custom:${ACCOUNTING_ORIGIN}/v1`;
const ACCOUNTING_MODEL = "accounting-model";

test("accounting: omitted successful usage commits conservative estimated exposure once", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension({ extraHostPatterns: [`${ACCOUNTING_ORIGIN}/*`] });
  try {
    const wire = await routeFakeOpenAi(ext.context, {
      model: ACCOUNTING_MODEL,
      content: '{"ok":true}',
      usage: null,
    }, ACCOUNTING_ORIGIN);
    const page = await openSurface(ext.context, ext.id, "options");
    await enableCustom(page, {
      baseUrl: `${ACCOUNTING_ORIGIN}/v1`,
      key: "sk-synthetic-accounting",
      model: ACCOUNTING_MODEL,
      budgetCap: "1",
      inputPrice: "2",
      outputPrice: "4",
    });
    const reply = await sendLlmMessage(page, { type: "LLM_TEST", providerId: ACCOUNTING_PROVIDER });
    expect(reply).toMatchObject({ ok: true, code: "test_ok" });
    expect(reply).not.toHaveProperty("result.usage");
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]).toMatchObject({
      method: "POST",
      url: `${ACCOUNTING_ORIGIN}/v1/chat/completions`,
      postData: { model: ACCOUNTING_MODEL, max_tokens: 16 },
    });
    const reservations = await readStoreRows<BudgetReservation>(page, "llmReservations");
    expect(reservations).toHaveLength(1);
    // A04: the reservation covers the real serialized prompt — the estimate
    // beats the declared 64-token bound on this body. Independently derived
    // from the wire body: (bound * $2 + 16 * $4) / million.
    const inputBound = Math.ceil(
      (JSON.stringify(wire.requests[0]!.postData).length / 4) * 1.25,
    );
    const reservedUsd = (inputBound * 2 + 16 * 4) / 1e6;
    expect(reservations[0]).toMatchObject({
      maxInputTokens: inputBound,
      maxOutputTokens: 16,
      reservedUsd,
      status: "settled",
      pricing: { inputPerMillion: 2, outputPerMillion: 4 },
    });
    const rows = await readStoreRows<LlmUsageRow>(page, "llmUsage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: ACCOUNTING_PROVIDER,
      model: ACCOUNTING_MODEL,
      configuredModel: ACCOUNTING_MODEL,
      feature: "llm_test",
      inputTokens: inputBound,
      outputTokens: 16,
      estimatedCostUsd: reservedUsd,
    });
    // Estimated provenance is represented by estimatedCostUsd, not costUsd.
    expect(rows[0]).not.toHaveProperty("costUsd");
    expect(await sendLlmMessage(page, { type: "LLM_BUDGET_SNAPSHOT", providerId: ACCOUNTING_PROVIDER }))
      .toMatchObject({ ok: true, snapshot: {
        requestCount: 1, reportedCostUsd: 0, estimatedCostUsd: reservedUsd,
        unknownCostRequests: 0, reservedUsd: 0, committedUsd: reservedUsd,
      } });
    await settleLlmUsageAgain(page, reservations[0]!.id);
    expect(await readStoreRows<LlmUsageRow>(page, "llmUsage")).toEqual(rows);
    expect(wire.requests).toHaveLength(1);
  } finally {
    try {
      await ext.context.close();
    } finally {
      ext.dispose();
    }
  }
});

test("accounting: held real probe settles once after trusted revoke and key removal", async () => {
  test.setTimeout(120_000);
  const ext = await launchLlmExtension({ extraHostPatterns: [`${ACCOUNTING_ORIGIN}/*`] });
  let release!: (reply: FakeOpenAiReply) => void;
  const held = new Promise<FakeOpenAiReply>((resolve) => { release = resolve; });
  const completion: FakeOpenAiReply = {
    model: ACCOUNTING_MODEL,
    content: '{"ok":true}',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  let pending: Promise<unknown> | undefined;
  try {
    const wire = await routeFakeOpenAi(ext.context, () => held, ACCOUNTING_ORIGIN);
    const page = await openSurface(ext.context, ext.id, "options");
    await enableCustom(page, {
      baseUrl: `${ACCOUNTING_ORIGIN}/v1`,
      key: "sk-synthetic-held",
      model: ACCOUNTING_MODEL,
      budgetCap: "1",
      inputPrice: "2",
      outputPrice: "4",
    });
    const panel = await openSurface(ext.context, ext.id, "sidepanel");
    await createBookmark(panel, { title: "Synthetic accounting fixture", url: "https://accounting-fixture.test/" });
    pending = sendLlmMessage(page, { type: "LLM_TEST", providerId: ACCOUNTING_PROVIDER });
    // This is the actual worker fetch, not a deferred client/gate mock.
    await expect.poll(() => wire.requests.length).toBe(1);
    expect(wire.requests[0]?.postData).toMatchObject({ model: ACCOUNTING_MODEL, max_tokens: 16 });
    const [reservation] = await readStoreRows<BudgetReservation>(page, "llmReservations");
    // A04: honest input bound from the real serialized probe body.
    const inputBound = Math.ceil(
      (JSON.stringify(wire.requests[0]!.postData).length / 4) * 1.25,
    );
    expect(reservation).toMatchObject({
      status: "active", reservedUsd: (inputBound * 2 + 16 * 4) / 1e6,
      pricing: { inputPerMillion: 2, outputPerMillion: 4 },
    });
    expect(await readStoreRows(page, "llmUsage")).toHaveLength(0);
    const revoked = await sendLlmMessage(page, {
      type: "LLM_REVOKE", providerId: ACCOUNTING_PROVIDER, deleteKey: true,
    }) as { ok: boolean; code?: string };
    // Install-time permissions cannot always be released; consent/settings/key
    // removal and the genuine gate refusal are still mandatory.
    expect(revoked.ok || revoked.code === "revoke_failed").toBe(true);
    const assertRevoked = async () => {
      const metadata = await readStoreRows<{ key: string }>(page, "metadata");
      expect(metadata.some((row) => row.key === `llmProvider:${ACCOUNTING_PROVIDER}`)).toBe(false);
      expect(metadata.some((row) => row.key === "llmActiveProvider")).toBe(false);
      expect(await readStoreRows(page, "consents")).toHaveLength(0);
      expect(await page.evaluate(async (id) => {
        const key = `credential:${id}`;
        return Object.hasOwn(await chrome.storage.local.get(key), key);
      }, ACCOUNTING_PROVIDER)).toBe(false);
    };
    await assertRevoked();
    expect(await sendLlmMessage(page, { type: "LLM_TEST", providerId: ACCOUNTING_PROVIDER }))
      .toMatchObject({ ok: false, code: "not_configured" });
    expect(await sendLlmMessage(panel, { type: "RESTRUCTURE_START", providerId: ACCOUNTING_PROVIDER }))
      .toMatchObject({ ok: false, code: "no_provider" });
    expect(wire.requests).toHaveLength(1);
    release(completion);
    expect(await pending).toMatchObject({ ok: true, code: "test_ok" });
    const rows = await readStoreRows<LlmUsageRow>(page, "llmUsage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: ACCOUNTING_PROVIDER,
      model: ACCOUNTING_MODEL,
      configuredModel: ACCOUNTING_MODEL,
      feature: "llm_test",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.00004, // Original rates: (10 * $2 + 5 * $4)/million.
    });
    expect(rows[0]).not.toHaveProperty("costUsd");
    await assertRevoked(); // Also exercises the late LLM_TEST tier-write guard.
    expect(await readStoreRows<BudgetReservation>(page, "llmReservations"))
      .toMatchObject([{ id: reservation!.id, status: "settled" }]);
    await settleLlmUsageAgain(page, reservation!.id);
    expect(await readStoreRows<LlmUsageRow>(page, "llmUsage")).toEqual(rows);
    expect(wire.requests).toHaveLength(1);
  } finally {
    // Promise resolution is idempotent; drain the wire and message before close
    // even when an assertion fails while the response is held.
    release(completion);
    try {
      await pending?.catch(() => undefined);
    } finally {
      try {
        await ext.context.close();
      } finally {
        ext.dispose();
      }
    }
  }
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
  // Missing consent is a read-only refusal: the worker never writes grants.
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe("consent_required");
  expect(openai.requests).toHaveLength(0);
  expect((await readStoreRows<{ scope: string }>(panel, "consents"))
    .some((row) => row.scope === "llm_restructure")).toBe(false);

  const start = await startRestructureFromUi(panel);
  expect(start.id).toBeDefined();

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
      jobId: start.id,
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
    jobId: start.id,
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

  await openMoreView(panel, "Restructure");
  await panel.getByRole("button", { name: "Propose a layout…", exact: true }).click();
  await acceptFeatureConsent(panel, "Agree and propose");
  await expect(panel.getByText(/monthly.*budget|budget.*exceed/i)).toBeVisible();
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

  const start = await startRestructureFromUi(panel);
  const deadline = Date.now() + 30_000;
  let status = "";
  while (Date.now() < deadline) {
    const rows = await jobRows(panel);
    status = rows.find((r) => r.id === start.id)?.status ?? "";
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
  expect(refused.code).toBe("consent_required");
  expect(openai.requests).toHaveLength(0);
  await openMoreView(panel, "Review suggestions");
  const reviewRow = panel.locator(`[data-decision-id="${pending!.id}"]`);
  await reviewRow.getByRole("button", { name: /^Explain/ }).click();
  const disclosure = panel.getByRole("dialog", { name: /^Allow/ });
  await expect(disclosure).toContainText(OPENAI_ORIGIN);
  await expect(disclosure).toContainText("cleaned URL");
  // Dismissing a checked disclosure grants and sends nothing.
  await disclosure.getByRole("checkbox").click();
  await disclosure.getByRole("button", { name: "Don’t send", exact: true }).click();
  expect(openai.requests).toHaveLength(0);
  expect((await readStoreRows<{ scope: string }>(panel, "consents"))
    .some((row) => row.scope === "llm_explain")).toBe(false);
  await reviewRow.getByRole("button", { name: /^Explain/ }).click();
  await acceptFeatureConsent(panel, "Agree and explain");
  await panel.getByRole("dialog").getByRole("button", { name: "Send anyway", exact: true }).click();
  await expect(reviewRow).toContainText("docs page", { timeout: 15_000 });
  const explained = (await readStoreRows<{ id: string; rationale?: string }>(panel, "decisions"))
    .find((row) => row.id === pending!.id);
  expect(explained?.rationale).toContain("docs page");
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

    const start = await startRestructureFromUi(panel);
    const jobId = start.id;
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
    // The persisted profile's service worker is already running before any
    // `context.route` call lands, and Playwright's interception does not bind
    // to it reliably (host-resolver rules don't reach it either) — a resumed
    // provider send can escape to real egress and 401 the job. Patch the
    // worker's own `fetch` instead: deterministic, in-realm, and scoped to
    // the provider origin while every consent/permission gate still runs.
    const resumeWorker =
      relaunch.context.serviceWorkers()[0] ??
      (await relaunch.context.waitForEvent("serviceworker"));
    await resumeWorker.evaluate(
        ([isRecordSrc, buildSrc, scriptJson]: string[]) => {
          const isRecord = new Function(`return ${isRecordSrc}`)() as (v: unknown) => v is Record<string, unknown>;
          const build = new Function("isRecord", `return (${buildSrc})`)(isRecord) as (postData: unknown, script: unknown) => unknown;
          const script = JSON.parse(scriptJson as string) as unknown;
          const real = self.fetch.bind(self);
          self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!url.includes("api.typesafe.ai")) return real(input, init);
            let postData: unknown = {};
            try {
              postData = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : {};
            } catch {
              postData = {};
            }
            (self as unknown as { __fakeFetchCount?: number }).__fakeFetchCount =
              ((self as unknown as { __fakeFetchCount?: number }).__fakeFetchCount ?? 0) + 1;
            return Promise.resolve(
              new Response(JSON.stringify(build(postData, script)), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }) as typeof fetch;
        },
        [isRecord.toString(), buildFakeResponse.toString(), JSON.stringify({ choices: { folder: "p0" }, noul: {} })],
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
    const fakeFetchCount = await resumeWorker.evaluate(
      () => (self as unknown as { __fakeFetchCount?: number }).__fakeFetchCount ?? 0,
    );
    expect(
      status,
      `row=${JSON.stringify(row)} openai=${openai2.requests.length} jev=${jev2.requests.length}`,
    ).toBe("completed");
    // The resume must have re-sent at least one provider request through the
    // patched fetch — otherwise the uncommitted tail never actually ran.
    expect(fakeFetchCount).toBeGreaterThan(0);
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
