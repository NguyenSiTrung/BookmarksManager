import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { collectOutboundRequests, openSurface } from "./helpers/extension";
import {
  AUDIT_LLM_ORIGIN,
  auditLlmReservations,
  enableAuditJevAndConsent,
  enableAuditLlm,
  launchAuditExtension,
  routeAuditJev,
  sendAuditMessage,
} from "./helpers/audit-provider";
import {
  captureRequest,
  enableTypesafe,
  readStoreRows,
  sentLogRows,
} from "./helpers/provider";
import type { CapturedProviderRequest } from "./helpers/provider";
import { bookmarkMetaRows, jobRows } from "./helpers/decisions";
import { undoRows, writeStoreRows } from "./helpers/audit-data";
import type { AuditJobRow } from "./helpers/audit-data";
import { createBookmark } from "./helpers/seed";
import {
  waitForPopupReady,
  waitForSidePanelReady,
} from "./helpers/surfaces";
import { PRESETS } from "../../src/net/presets";
import type { DecisionRow } from "../../src/decisions/store";
import type { LlmExtension } from "./helpers/llm";

/**
 * Phase 7 Task 5 (H07) — the track's final wire-level regression sweep: one
 * spec covering the cross-feature acceptance criteria end to end over the
 * BUILT extension — real worker, real message channel, real Dexie, real
 * Chromium network stack up to the routed fakes:
 *
 *  1. P05/P06 zero-egress: opening the popup on an idle install AND a cold
 *     browser restart holding a `running` job each produce zero provider
 *     requests. Both are asserted on three independent channels: the routed
 *     capture logs, the context's `request` event journal, and an in-realm
 *     `self.fetch` counter patched into the live worker (the relaunch case —
 *     a persisted profile's service worker can escape Playwright routing in
 *     the window before a route binds; the in-realm counter is the
 *     deterministic proof, and `hostResolverSink` makes even an escaped
 *     attempt fail at 127.0.0.1 rather than reach a resolver).
 *  2. P07/A01 per-attempt accounting: on the audit LLM provider a 503 → one
 *     retry → 200 yields two `sentLog` rows (`retried`, `ok`); a hung
 *     endpoint yields `timeout` with exactly one request and a settled
 *     reservation; on the Jev provider (no retry) a redirect yields one
 *     `transport` row. Feature-scoped counts are asserted after each leg.
 *  3. J06 + D07 single-apply and targeted undo: two racing
 *     `APPROVE_DECISION` messages on the same pending row apply it exactly
 *     once (one ok reply, one refusal, one undo snapshot); a
 *     `REVERT_DECISION` for the OLDER of two applied rows reverts that row's
 *     own snapshot and leaves the newer apply untouched.
 *
 * Per-leg counts are recorded as test annotations. Same permission
 * disclosure as the rest of the audit suite: the launcher promotes the
 * synthetic host patterns to `host_permissions` on a throwaway manifest
 * copy, so the native `chrome.permissions.request` prompt widget is the one
 * production behavior not exercised; every later worker-side re-check runs
 * unchanged. Synthetic `*.dev` origins and fake keys only.
 */

/** The audit launcher's hosts, sunk so a pre-route send cannot egress. */
const SINK_HOSTS = [
  new URL(AUDIT_LLM_ORIGIN).host,
  new URL(PRESETS.typesafe.origin).host,
  "audit-fixture.dev",
];

/**
 * Patch the live service worker's `fetch` to record every outbound URL in
 * `self.__auditEgress` and fail it closed — a deterministic egress counter
 * that cannot be bypassed by Playwright-routing gaps on a relaunched
 * persistent profile. Internal schemes stay real so worker-local work is
 * unaffected.
 */
async function patchWorkerEgressCounter(context: BrowserContext): Promise<void> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await worker.evaluate(() => {
    const scope = self as unknown as {
      __auditEgress?: string[];
      fetch: typeof fetch;
    };
    scope.__auditEgress = [];
    const real = scope.fetch.bind(self);
    const INTERNAL = /^(chrome-extension|chrome|devtools|data|blob|about):/;
    scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!INTERNAL.test(url)) {
        scope.__auditEgress!.push(url);
        return Promise.reject(
          new TypeError("audit sweep: outbound fetch blocked"),
        );
      }
      return real(input, init);
    }) as typeof fetch;
  });
}

/** The outbound URLs the worker's patched fetch has recorded so far. */
async function workerEgressUrls(context: BrowserContext): Promise<string[]> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  return worker.evaluate(
    () =>
      (self as unknown as { __auditEgress?: string[] }).__auditEgress ?? [],
  );
}

/** A `running` library_scan job row for the cold-start leg. */
function runningScanJob(bookmarkIds: readonly string[]): AuditJobRow {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    kind: "library_scan",
    status: "running",
    progress: { totalBatches: 2, committedBatches: 1, processedCount: 5 },
    batchSize: 5,
    bookmarkIds: [...bookmarkIds],
    usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
    createdAt: now,
    updatedAt: now,
  };
}

test("zero egress on open and on cold start with a running job", async () => {
  test.setTimeout(180_000);
  const extensionRoot = mkdtempSync(path.join(tmpdir(), "bm-e2e-h07-ext-"));
  const profileDir = mkdtempSync(path.join(tmpdir(), "bm-e2e-h07-profile-"));
  const launch = (): Promise<LlmExtension> =>
    launchAuditExtension({ extensionRoot, profileDir, hostResolverSink: SINK_HOSTS });
  const opened: BrowserContext[] = [];
  try {
    // --- P05: the popup's own boot path on an idle install sends nothing.
    const first = await launch();
    opened.push(first.context);
    const outbound1 = collectOutboundRequests(first.context);
    const llm1: CapturedProviderRequest[] = [];
    await first.context.route(`${AUDIT_LLM_ORIGIN}/**`, async (route) => {
      llm1.push(captureRequest(route.request()));
      await route.abort();
    });
    const jev1: CapturedProviderRequest[] = [];
    await first.context.route(`${PRESETS.typesafe.origin}/**`, async (route) => {
      jev1.push(captureRequest(route.request()));
      await route.abort();
    });
    await patchWorkerEgressCounter(first.context);
    const popup = await openSurface(first.context, first.id, "popup");
    await waitForPopupReady(popup);
    const sidepanel = await openSurface(first.context, first.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);
    await sidepanel.waitForTimeout(1_500);

    expect(await workerEgressUrls(first.context)).toEqual([]);
    expect(llm1).toHaveLength(0);
    expect(jev1).toHaveLength(0);
    expect(outbound1.urls).toEqual([]);

    // Seed the interrupted job while a surface guarantees the database.
    const bookmark = await createBookmark(sidepanel, {
      title: "H07 cold start seed",
      url: "https://h07-coldstart.dev/seeded",
    });
    const seeded = runningScanJob([bookmark.id]);
    await writeStoreRows(sidepanel, "jobs", [seeded]);
    outbound1.stop();
    await first.context.close();

    // --- P06: a cold start (browser restart subsumes worker eviction) with
    // the `running` row must pause it locally without a single provider send.
    const second = await launch();
    opened.push(second.context);
    const outbound2 = collectOutboundRequests(second.context);
    const llm2: CapturedProviderRequest[] = [];
    await second.context.route(`${AUDIT_LLM_ORIGIN}/**`, async (route) => {
      llm2.push(captureRequest(route.request()));
      await route.abort();
    });
    const jev2: CapturedProviderRequest[] = [];
    await second.context.route(`${PRESETS.typesafe.origin}/**`, async (route) => {
      jev2.push(captureRequest(route.request()));
      await route.abort();
    });
    await patchWorkerEgressCounter(second.context);
    const panel2 = await openSurface(second.context, second.id, "sidepanel");
    await waitForSidePanelReady(panel2);
    await expect
      .poll(
        async () =>
          (await jobRows(panel2)).find((row) => row.id === seeded.id)?.status,
        { timeout: 20_000 },
      )
      .toBe("paused");
    await panel2.waitForTimeout(1_000);

    expect(await workerEgressUrls(second.context)).toEqual([]);
    expect(llm2).toHaveLength(0);
    expect(jev2).toHaveLength(0);
    expect(outbound2.urls).toEqual([]);
    test.info().annotations.push({
      type: "audit-counts",
      description:
        `P05/P06 — ctx1 llm:${llm1.length} jev:${jev1.length} ` +
        `outbound:${outbound1.urls.length}; ctx2 llm:${llm2.length} ` +
        `jev:${jev2.length} outbound:${outbound2.urls.length}`,
    });
    outbound2.stop();
  } finally {
    for (const context of opened) {
      await context.close().catch(() => {});
    }
    rmSync(extensionRoot, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("per-attempt log: 503-then-200 writes two rows, timeout and redirect one each", async () => {
  test.setTimeout(240_000);
  const ext = await launchAuditExtension({ hostResolverSink: SINK_HOSTS });
  try {
    // One mutable-mode wire for the audit LLM: 503 on call 1 then ok, then
    // "hang" (never fulfilled — the client's own 30s deadline aborts it).
    let mode: "fail_then_ok" | "hang" = "fail_then_ok";
    const llmCalls: CapturedProviderRequest[] = [];
    await ext.context.route(`${AUDIT_LLM_ORIGIN}/**`, async (route) => {
      llmCalls.push(captureRequest(route.request()));
      if (mode === "hang") return;
      const failing = mode === "fail_then_ok" && llmCalls.length === 1;
      await route.fulfill({
        status: failing ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          failing
            ? { error: { message: "audit 503", type: "server_error" } }
            : {
                id: `chatcmpl-h07-${llmCalls.length}`,
                object: "chat.completion",
                created: 1_700_000_000,
                model: "audit-model",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "{}" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              },
        ),
      });
    });
    const options = await openSurface(ext.context, ext.id, "options");
    await enableAuditLlm(options);

    // --- 503-then-200: one LLM_TEST, two wire attempts, two audit rows.
    const retryReply = (await sendAuditMessage(options, {
      type: "LLM_TEST",
    })) as { ok?: boolean };
    expect(retryReply.ok, JSON.stringify(retryReply)).toBe(true);
    expect(llmCalls).toHaveLength(2);
    const llmLogAfterRetry = (await sentLogRows(options)).filter(
      (row) => row.feature === "llm_test",
    );
    expect(llmLogAfterRetry.map((row) => row.outcome)).toEqual([
      "retried",
      "ok",
    ]);
    const reservationsAfterRetry = await auditLlmReservations(options);
    expect(reservationsAfterRetry).toHaveLength(2);
    expect(
      reservationsAfterRetry.filter((row) => row.status === "active"),
    ).toHaveLength(0);

    // --- Timeout (A01): the held request ends as `timeout` — one attempt,
    // one row, the reservation settled rather than left `active`.
    mode = "hang";
    const timeoutReply = (await sendAuditMessage(options, {
      type: "LLM_TEST",
    })) as { ok?: boolean; code?: string };
    expect(timeoutReply.ok, JSON.stringify(timeoutReply)).toBe(false);
    expect(llmCalls).toHaveLength(3);
    const llmLogAfterTimeout = (await sentLogRows(options)).filter(
      (row) => row.feature === "llm_test",
    );
    expect(llmLogAfterTimeout.map((row) => row.outcome)).toEqual([
      "retried",
      "ok",
      "timeout",
    ]);
    const reservationsAfterTimeout = await auditLlmReservations(options);
    expect(reservationsAfterTimeout).toHaveLength(3);
    expect(
      reservationsAfterTimeout.filter((row) => row.status === "active"),
    ).toHaveLength(0);

    // --- Redirect on the Jev path (no retry policy): exactly one row.
    const jevCalls: CapturedProviderRequest[] = [];
    await ext.context.route(`${PRESETS.typesafe.origin}/**`, async (route) => {
      jevCalls.push(captureRequest(route.request()));
      await route.fulfill({
        status: 302,
        headers: { location: "https://h07-redirect.dev/elsewhere" },
      });
    });
    await enableTypesafe(options, { key: "h07-jev-key" });
    const redirectReply = (await sendAuditMessage(options, {
      type: "TEST_PROVIDER",
      preset: "typesafe",
    })) as { ok?: boolean };
    expect(redirectReply.ok, JSON.stringify(redirectReply)).toBe(false);
    expect(jevCalls).toHaveLength(1);
    const jevLog = (await sentLogRows(options)).filter(
      (row) => row.feature === "jev_test",
    );
    expect(jevLog).toHaveLength(1);
    expect(jevLog[0]?.outcome).toBe("transport");

    test.info().annotations.push({
      type: "audit-counts",
      description:
        `P07/A01 — llm wire:${llmCalls.length} rows:` +
        `${llmLogAfterTimeout.length} (${llmLogAfterTimeout
          .map((row) => row.outcome)
          .join(",")}) reservations:${reservationsAfterTimeout.length} ` +
        `active:0; jev wire:${jevCalls.length} rows:${jevLog.length}`,
    });
  } finally {
    await ext.context.close();
    ext.dispose();
  }
});

test("double approve applies once; revert targets the addressed decision", async () => {
  test.setTimeout(150_000);
  const ext = await launchAuditExtension({ hostResolverSink: SINK_HOSTS });
  try {
    await routeAuditJev(ext.context, {
      choices: { category: "docs" },
      noul: {},
    });
    const options = await openSurface(ext.context, ext.id, "options");
    await enableAuditJevAndConsent(options);
    const sidepanel = await openSurface(ext.context, ext.id, "sidepanel");
    await waitForSidePanelReady(sidepanel);
    const first = await createBookmark(sidepanel, {
      title: "H07 approve target A",
      url: "https://h07-approve.dev/a",
    });
    const second = await createBookmark(sidepanel, {
      title: "H07 approve target B",
      url: "https://h07-approve.dev/b",
    });

    // Real pending decisions through the real pipeline (ANALYZE_BOOKMARK →
    // routed Jev fake → persisted rows carrying send-time guards).
    for (const bookmark of [first, second]) {
      const reply = (await sendAuditMessage(sidepanel, {
        type: "ANALYZE_BOOKMARK",
        bookmarkId: bookmark.id,
      })) as { ok?: boolean };
      expect(reply.ok, JSON.stringify(reply)).toBe(true);
    }
    const pending = (await readStoreRows<DecisionRow>(sidepanel, "decisions"))
      .filter(
        (row) => row.status === "pending" && row.kind === "set_category",
      );
    const decisionA = pending.find((row) =>
      row.bookmarkIds.includes(first.id),
    );
    const decisionB = pending.find((row) =>
      row.bookmarkIds.includes(second.id),
    );
    expect(decisionA).toBeDefined();
    expect(decisionB).toBeDefined();

    // Double approve: two racing messages, one decision — the serialized
    // apply lands exactly once.
    const undoBefore = await undoRows(sidepanel);
    const approvals = await Promise.all([
      sendAuditMessage(sidepanel, {
        type: "APPROVE_DECISION",
        decisionId: decisionA!.id,
      }),
      sendAuditMessage(sidepanel, {
        type: "APPROVE_DECISION",
        decisionId: decisionA!.id,
      }),
    ]);
    const winners = approvals.filter(
      (reply) => (reply as { ok?: boolean }).ok === true,
    );
    expect(winners, JSON.stringify(approvals)).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (await bookmarkMetaRows(sidepanel)).find(
            (row) => row.id === first.id,
          )?.category,
      )
      .toBe("docs");
    const rowsAfterApprove = await readStoreRows<DecisionRow>(
      sidepanel,
      "decisions",
    );
    expect(
      rowsAfterApprove.find((row) => row.id === decisionA!.id)?.status,
    ).toBe("applied");
    // Exactly one undo snapshot for the single landed apply.
    expect((await undoRows(sidepanel)).length - undoBefore.length).toBe(1);

    // Approve the second bookmark's decision too — A's snapshot is no longer
    // the stack top once B's apply lands.
    const applyB = (await sendAuditMessage(sidepanel, {
      type: "APPROVE_DECISION",
      decisionId: decisionB!.id,
    })) as { ok?: boolean };
    expect(applyB.ok, JSON.stringify(applyB)).toBe(true);
    await expect
      .poll(
        async () =>
          (await bookmarkMetaRows(sidepanel)).find(
            (row) => row.id === second.id,
          )?.category,
      )
      .toBe("docs");

    // Undo targeting: reverting the OLDER decision replays its own snapshot —
    // not whatever happens to sit on top of the undo stack.
    const revertA = (await sendAuditMessage(sidepanel, {
      type: "REVERT_DECISION",
      decisionId: decisionA!.id,
    })) as { ok?: boolean };
    expect(revertA.ok, JSON.stringify(revertA)).toBe(true);
    await expect
      .poll(
        async () =>
          (await bookmarkMetaRows(sidepanel)).find(
            (row) => row.id === first.id,
          )?.category,
      )
      .toBeUndefined();
    expect(
      (await bookmarkMetaRows(sidepanel)).find((row) => row.id === second.id)
        ?.category,
    ).toBe("docs");
    const rowsAfterRevert = await readStoreRows<DecisionRow>(
      sidepanel,
      "decisions",
    );
    expect(
      rowsAfterRevert.find((row) => row.id === decisionA!.id)?.status,
    ).toBe("reverted");
    expect(
      rowsAfterRevert.find((row) => row.id === decisionB!.id)?.status,
    ).toBe("applied");

    const finalLog = await sentLogRows(sidepanel);
    test.info().annotations.push({
      type: "audit-counts",
      description:
        `J06/D07 — approvals ok:${winners.length}/${approvals.length} ` +
        `undo-snapshots:+${(await undoRows(sidepanel)).length - undoBefore.length} ` +
        `sentLog rows:${finalLog.length}`,
    });
  } finally {
    await ext.context.close();
    ext.dispose();
  }
});
