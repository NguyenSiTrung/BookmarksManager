import { expect } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { BudgetReservation, LlmUsageRow } from "../../../src/llm/budget";
import { DB_NAME } from "./db";
import { openSurface } from "./extension";
import type { Extension } from "./extension";
import { captureRequest } from "./provider";
import type { CapturedProviderRequest } from "./provider";
import { launchLlmExtension, enableCustom, sendLlmMessage } from "./llm";
import type { LlmExtension, LlmLaunchOptions } from "./llm";
import {
  grantDecisionsConsent,
  routeFakeDecisions,
  type FakeDecisionsRoute,
  type FakeDecisionsScript,
} from "./decisions";
import { enableTypesafe, readStoreRows } from "./provider";
import { createBookmark, renameBookmark } from "./seed";
import { openOptionsPanel, openMoreView, waitForSidePanelReady } from "./surfaces";

/**
 * Audit-hardening cross-feature provider/privacy e2e plumbing (Phase 6
 * Task 3): synthetic EXACT-ORIGIN fakes for the LLM and Jev hops, a
 * deterministic request valve for holding responses mid-flight, the real
 * disclosed-click summary flow, the real scan controls, a page-local
 * `chrome.runtime.sendMessage` valve for the decision-undo dispatch, and
 * guarded IndexedDB/blocklist probes.
 *
 * Permission disclosure (same contract as `./provider.ts`): every launch
 * copies the built extension into a temporary directory and promotes the
 * TypeSafe, OpenAI, audit-LLM, and audit-fixture host patterns from
 * `optional_host_permissions` to `host_permissions`, which Chrome grants
 * silently at install. This BYPASSES the native `chrome.permissions.request`
 * prompt — Playwright's Chromium never resolves it (headed or headless), so
 * the prompt widget is the one production behavior not exercised here. Every
 * later step (the worker's own `permissions.contains` re-check, the consent
 * records, the egress gate, the wire after Chromium's network stack) runs
 * unchanged.
 *
 * No real keys, URLs, excerpts, or user data appear anywhere in this module:
 * every origin is a synthetic `*.dev` name that is routed locally, every
 * secret marker is a fixed `audit_*_secret` token, and every fixture is
 * generated inline.
 */

/** Synthetic LLM endpoint origin (routed; never resolved). */
export const AUDIT_LLM_ORIGIN = "https://audit-llm.dev";
/** Synthetic page origin the extension is granted at install (routed). */
export const AUDIT_FIXTURE_ORIGIN = "https://audit-fixture.dev";
/** Secret query marker that must never reach any provider body. */
export const AUDIT_QUERY_SECRET = "audit_query_secret";
/** Secret fragment marker that must never reach any provider body. */
export const AUDIT_FRAGMENT_SECRET = "audit_fragment_secret";
/** Configured model name for the synthetic LLM provider. */
export const AUDIT_MODEL = "audit-model";
/** Synthetic API key (obviously fake; never a real credential). */
export const AUDIT_LLM_KEY = "sk-audit-e2e-not-a-real-key";
/** Synthetic Jev API key. */
export const AUDIT_JEV_KEY = "e2e-audit-jev-key";
/** The summary feature's declared output allowance (`MAX_OUTPUT_TOKENS`). */
export const AUDIT_SUMMARY_MAX_TOKENS = 1_024;
/** The `LLM_TEST` feature's declared output allowance. */
export const AUDIT_TEST_MAX_TOKENS = 16;

/** A synthetic fixture URL carrying both secret markers. */
export function auditFixtureUrl(tag: string): string {
  return `${AUDIT_FIXTURE_ORIGIN}/${tag}?${AUDIT_QUERY_SECRET}=1#${AUDIT_FRAGMENT_SECRET}`;
}

/**
 * Launch the built extension from a patched-manifest copy granting the
 * TypeSafe (Jev), audit-LLM, and audit-fixture host patterns. Wraps the
 * existing harness launcher so the audit origins are always pre-authorized;
 * see the module doc for the native-prompt disclosure.
 */
export function launchAuditExtension(
  options: LlmLaunchOptions = {},
): Promise<LlmExtension> {
  return launchLlmExtension({
    ...options,
    extraHostPatterns: [
      `${AUDIT_LLM_ORIGIN}/*`,
      `${AUDIT_FIXTURE_ORIGIN}/*`,
      ...(options.extraHostPatterns ?? []),
    ],
  });
}

/** Scripted fields of the synthetic audit LLM's OpenAI-compatible reply. */
export interface AuditLlmReply {
  /** Assistant message content — a JSON string for structured tiers. */
  content?: string;
  /** Model id the fake claims answered; default {@link AUDIT_MODEL}. */
  model?: string;
  /** Reported usage; `null` OMITS the envelope (the missing-usage path). */
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  /** HTTP status — 4xx/5xx exercises the error path. */
  status?: number;
  /** Explicit OpenAI-compatible HTTP error body, not assistant content. */
  error?: string | { message: string; param?: string; code?: string; type?: string };
}

/** Live capture log plus a deterministic hold valve for the audit LLM. */
export interface AuditLlmRoute {
  readonly requests: CapturedProviderRequest[];
  /** Fulfil every held request and let later requests through immediately. */
  release(): void;
}

/**
 * Route the synthetic audit LLM origin with a self-contained, revision-
 * independent OpenAI-compatible fake. The first `autoRelease` requests
 * (default: all) answer immediately; the rest are HELD at the route until
 * {@link AuditLlmRoute.release}. This module owns the fake so the audit spec
 * exercises the same behavior on any audited revision, including a reply
 * that OMITS the usage envelope. No real endpoint is contacted.
 */
export async function routeAuditLlm(
  context: BrowserContext,
  options: { autoRelease?: number; reply?: AuditLlmReply } = {},
): Promise<AuditLlmRoute> {
  const requests: CapturedProviderRequest[] = [];
  const autoRelease = options.autoRelease ?? Number.POSITIVE_INFINITY;
  const reply = options.reply ?? {
    content: JSON.stringify({ summary: "A minimized audit fixture summary." }),
  };
  let released = 0;
  let open = false;
  const waiting: Array<() => void> = [];
  await context.route(`${AUDIT_LLM_ORIGIN}/**`, async (route) => {
    let captured: CapturedProviderRequest;
    try {
      captured = captureRequest(route.request());
    } catch {
      return;
    }
    requests.push(captured);
    if (!open && released >= autoRelease) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    released += 1;
    const body = {
      id: `chatcmpl-audit-${requests.length}`,
      object: "chat.completion",
      created: 1_700_000_000,
      model: reply.model ?? AUDIT_MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply.content ?? "{}" },
          finish_reason: "stop",
        },
      ],
      ...(reply.usage === null
        ? {}
        : { usage: reply.usage ?? { prompt_tokens: 40, completion_tokens: 12 } }),
    };
    try {
      await route.fulfill({
        status: reply.status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(
          reply.error === undefined ? body : { error: reply.error },
        ),
      });
    } catch {
      // The context died mid-flight — nothing to answer.
    }
  });
  return {
    requests,
    release: () => {
      open = true;
      const wake = [...waiting];
      waiting.length = 0;
      for (const resolve of wake) resolve();
    },
  };
}

/** Route the TypeSafe origin with the scriptable decisions/Jev fake. */
export function routeAuditJev(
  context: BrowserContext,
  script: FakeDecisionsScript = { choices: { verdict: "supported" }, noul: {} },
  options?: Parameters<typeof routeFakeDecisions>[2],
): Promise<FakeDecisionsRoute> {
  return routeFakeDecisions(context, script, options);
}

/** Enable the synthetic custom LLM provider through the real Options UI. */
export function enableAuditLlm(
  page: Page,
  details: {
    budgetCap?: string;
    inputPrice?: string;
    outputPrice?: string;
    model?: string;
  } = {},
): Promise<void> {
  return enableCustom(page, {
    baseUrl: `${AUDIT_LLM_ORIGIN}/v1`,
    key: AUDIT_LLM_KEY,
    model: details.model ?? AUDIT_MODEL,
    budgetCap: details.budgetCap ?? "5",
    inputPrice: details.inputPrice ?? "1",
    outputPrice: details.outputPrice ?? "2",
  });
}

/** Enable the TypeSafe (Jev) provider and grant the decisions consent. */
export async function enableAuditJevAndConsent(
  page: Page,
): Promise<void> {
  await enableTypesafe(page, { key: AUDIT_JEV_KEY });
  await grantDecisionsConsent(page);
}

/**
 * Serve a bounded synthetic article at the audit-fixture origin. The body is
 * generated inline; nothing is fetched from the network.
 */
export async function serveAuditFixture(context: BrowserContext): Promise<void> {
  await context.route(`${AUDIT_FIXTURE_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><head><title>Audit fixture</title></head><body><article><h1>Audit fixture</h1><p>Synthetic page text for the audit provider workflow.</p></article></body></html>",
    }),
  );
}

/** Open the synthetic fixture page as a real tab and return it. */
export async function openAuditFixture(
  context: BrowserContext,
  url: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "commit" });
  return page;
}

/**
 * The worker's reservation rows for the synthetic LLM provider, newest
 * last — the device-bound evidence the wire caps and settlement assert on.
 */
export function auditLlmReservations(page: Page): Promise<BudgetReservation[]> {
  return readStoreRows<BudgetReservation>(page, "llmReservations");
}

/** The worker's committed usage rows (the real `llmUsage` table). */
export function auditLlmUsage(page: Page): Promise<LlmUsageRow[]> {
  return readStoreRows<LlmUsageRow>(page, "llmUsage");
}

/** Rows in one extension object store (non-creating, house contract). */
export function auditStoreRows<Row>(page: Page, store: string): Promise<Row[]> {
  return readStoreRows<Row>(page, store);
}

/**
 * Write one `metadata` row (the blocklist and similar namespaced state), or
 * an array of rows. Refuses when the extension database does not exist yet:
 * seeding must never be the write that creates it.
 */
export async function writeAuditMetadata(
  page: Page,
  rows: readonly { key: string; value: unknown }[],
): Promise<void> {
  await page.evaluate(
    async ({ dbName, payload }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((info) => info.name === dbName)) {
        throw new Error(
          "The extension database does not exist yet — open an extension surface before seeding metadata.",
        );
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("metadata", "readwrite");
          const store = transaction.objectStore("metadata");
          for (const row of payload) store.put(row);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, payload: [...rows] },
  );
}

/** Persist the user blocklist (normalized hosts) under its namespaced key. */
export function seedBlocklist(page: Page, hosts: readonly string[]): Promise<void> {
  return writeAuditMetadata(page, [
    { key: "decisions:blocklist", value: [...hosts] },
  ]);
}

/** Clear the user blocklist. */
export function clearBlocklist(page: Page): Promise<void> {
  return seedBlocklist(page, []);
}

/** Extract a bookmark's live native id from the side panel (already seeded). */
export async function auditBookmark(
  panel: Page,
  details: { title: string; url: string },
): Promise<{ id: string }> {
  return createBookmark(panel, details);
}

/** Rename a bookmark's URL (the mismatch path). */
export function renameAuditBookmark(
  panel: Page,
  id: string,
  url: string,
): Promise<void> {
  return renameBookmark(panel, id, { url });
}

// ---------------------------------------------------------------------------
// Real disclosed-click summary flow
// ---------------------------------------------------------------------------

/** The Summarize dialog for one bookmark title. */
export function summaryDialog(page: Page, title: string): Locator {
  return page.getByRole("dialog", {
    name: `Summarize “${title}”`,
    exact: true,
  });
}

/**
 * Drive the real row-menu Summarize intent: select the bookmark row, open
 * its actions menu, choose "Summarize…", and wait for the disclosure dialog.
 * `title` is the bookmark's visible title.
 */
export async function openSummaryFromRow(
  page: Page,
  bookmarkId: string,
  title: string,
): Promise<Locator> {
  const row = page.locator(`[data-bookmark-id="${bookmarkId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Summarize…", exact: true }).click();
  const dialog = summaryDialog(page, title);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Click the dialog's real affirmative "Agree and summarize" action. The
 * synthetic provider is priced, so no cost-confirmation step appears; the
 * worker grants the disclosed summary scopes at the exact origins and runs
 * the extraction → LLM → Jev pipeline.
 */
export async function agreeAndSummarize(dialog: Locator): Promise<void> {
  const agree = dialog.getByRole("button", {
    name: "Agree and summarize",
    exact: true,
  });
  await expect(agree).toBeVisible();
  await agree.click();
}

/** Close the summary dialog through its real Close control. */
export async function closeSummaryDialog(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Serialize every captured provider request body into one string. */
export function serializedAuditBodies(
  requests: readonly { postData: unknown }[],
): string {
  return JSON.stringify(requests.map((request) => request.postData));
}

// ---------------------------------------------------------------------------
// Page-local message valve (decision undo dispatch count)
// ---------------------------------------------------------------------------

/**
 * Patch THIS page's `chrome.runtime.sendMessage` so every `REVERT_DECISION`
 * is counted and HELD until the returned release function runs. The valve is
 * a deterministic exact-count probe for the decision-undo dispatch guard:
 * the app resolves `chrome.runtime.sendMessage` at call time, so the patch
 * interposes without touching production wiring. Fresh-context only.
 */
export async function patchUndoValve(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as unknown as {
      chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
      __auditUndo?: {
        count: number;
        release?: () => void;
      };
    };
    const runtime = scope.chrome.runtime;
    const original = runtime.sendMessage.bind(runtime);
    const state: { count: number; release?: () => void } = { count: 0 };
    scope.__auditUndo = state;
    runtime.sendMessage = (message: unknown) => {
      const type =
        typeof message === "object" && message !== null
          ? (message as { type?: unknown }).type
          : undefined;
      if (type === "REVERT_DECISION") {
        state.count += 1;
        return new Promise((resolve, reject) => {
          state.release = () => {
            original(message).then(resolve, reject);
          };
        });
      }
      return original(message);
    };
  });
}

/** How many `REVERT_DECISION` dispatches the patched page has observed. */
export async function undoDispatchCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as { __auditUndo?: { count: number } }
      ).__auditUndo?.count ?? 0,
  );
}

/** Open the held valve so the counted `REVERT_DECISION` resolves (idempotent). */
export async function releaseUndoValve(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      globalThis as unknown as { __auditUndo?: { release?: () => void } }
    ).__auditUndo?.release?.();
  });
}

/**
 * Send one worker message from an extension page (the audit helper's own
 * bridge, so audit specs do not depend on another spec's private helper).
 */
export async function sendAuditMessage(
  page: Page,
  message: unknown,
): Promise<unknown> {
  return sendLlmMessage(page, message);
}

/** Open the side panel and wait until its live tree has loaded. */
export async function openAuditSidePanel(ext: Extension): Promise<Page> {
  const panel = await openSurface(ext.context, ext.id, "sidepanel");
  await waitForSidePanelReady(panel);
  return panel;
}

// ---------------------------------------------------------------------------
// Live Options transition (B14)
// ---------------------------------------------------------------------------

/**
 * Switch the Options page to the Permissions panel WITHOUT reloading and
 * return the escalation consent label locator. Used to prove the panel picks
 * up a provider enabled in the Connections panel from a live read.
 */
export async function openPermissionsPanelNoReload(page: Page): Promise<void> {
  await openOptionsPanel(page, "Permissions");
}

/** Open the Review suggestions view in the side panel. */
export async function openAuditReview(page: Page): Promise<void> {
  await openMoreView(page, "Review suggestions");
}
