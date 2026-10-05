import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  appendLlmUsage,
  appendUsage,
  AUDIT_RETENTION_CAP,
  DECISION_TERMINAL_RETENTION_CAP,
  JOB_RETENTION_CAP,
  pruneExpiredReservationsLocked,
} from "../../src/db/retention";
import {
  POPUP_DECISION_LIMIT,
  prunePopupDecisions,
  transitionStatus,
} from "../../src/decisions/store";
import { enqueueJob, jobUsageRollup, setJobStatus } from "../../src/jobs/queue";
import type { BudgetReservation } from "../../src/llm/budget";
import { saveLlmProvider } from "../../src/llm/settings";
import { sendLlmForTest, scopeRequest } from "../fakes/llm";
import { makeOpenAiServer } from "../mock-servers/openai";
import { saveCredential } from "../../src/security/credentials";
import { Decision } from "../../src/schemas/decision";
import type { LlmProviderRecord } from "../../src/schemas/llm";

/**
 * A08 retention/indexed-read contract:
 * - `usage`/`llmUsage` fold expired months into `usageMonths`/
 *   `llmUsageMonths` at write time, inside the same transaction;
 * - the budget transaction reads only the current month, through the
 *   `[providerId+month]` compound index;
 * - settled/released reservations outside the cap window prune on write;
 * - `audit`, terminal `jobs`, and terminal non-popup `decisions` stay capped;
 * - `prunePopupDecisions` never materializes the decisions table.
 */

vi.stubGlobal("crypto", webcrypto);

const NOW = new Date("2026-10-15T12:00:00.000Z");
const NOW_MONTH = "2026-10";
const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const MODEL = "gpt-4o-mini";

let containsSpy: ReturnType<typeof vi.fn>;

/** The same in-memory `chrome` stub llm-gate.test.ts installs. */
function installChromeStub() {
  const store: Record<string, unknown> = {};
  containsSpy = vi.fn(async () => true);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          const wanted =
            keys === undefined || keys === null
              ? Object.keys(store)
              : Array.isArray(keys)
                ? keys
                : [keys];
          const out: Record<string, unknown> = {};
          for (const k of wanted) {
            if (k in store) out[k] = store[k];
          }
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(store, items);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys])
            delete store[k];
        },
      },
    },
    permissions: { contains: containsSpy },
  });
}

beforeEach(async () => {
  installChromeStub();
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => db.close());

const JOB_A = "b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

describe("appendUsage monthly compaction", () => {
  it("materializes `month` and folds expired-month rows into usageMonths", async () => {
    await appendUsage(
      {
        jobId: JOB_A,
        model: "jev-1",
        inputTokens: 100,
        outputTokens: 40,
        costUsd: 0.001,
        recordedAt: "2026-09-15T00:00:00.000Z",
      },
      () => NOW,
    );
    await appendUsage(
      {
        model: "jev-1",
        inputTokens: 200,
        outputTokens: 60,
        recordedAt: "2026-09-16T00:00:00.000Z",
      },
      () => NOW,
    );
    // Both rows predate the writer's month: the raw table is empty, the
    // folded rows live in usageMonths keyed `${jobId}|${month}` / `|${month}`.
    expect(await db.usage.count()).toBe(0);
    const jobRoll = await db.usageMonths.get(`${JOB_A}|2026-09`);
    expect(jobRoll).toMatchObject({
      jobId: JOB_A,
      month: "2026-09",
      requests: 1,
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.001,
      unpricedRequests: 0,
    });
    const jobless = await db.usageMonths.get("|2026-09");
    expect(jobless).toMatchObject({
      month: "2026-09",
      requests: 1,
      inputTokens: 200,
      outputTokens: 60,
      unpricedRequests: 1,
    });
    expect(jobless?.jobId).toBeUndefined();
    expect(jobless?.costUsd).toBeUndefined();
  });

  it("keeps current-month rows raw and merges repeat folds into the rollup", async () => {
    await appendUsage(
      {
        jobId: JOB_A,
        model: "jev-1",
        inputTokens: 10,
        outputTokens: 5,
        recordedAt: "2026-09-15T00:00:00.000Z",
      },
      () => NOW,
    );
    await appendUsage(
      {
        jobId: JOB_A,
        model: "jev-1",
        inputTokens: 20,
        outputTokens: 8,
        costUsd: 0.002,
        recordedAt: "2026-10-15T11:00:00.000Z",
      },
      () => NOW,
    );
    const raw = await db.usage.toArray();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ jobId: JOB_A, month: NOW_MONTH });
    // A second writer later folds another expired row into the same rollup.
    await appendUsage(
      {
        jobId: JOB_A,
        model: "jev-1",
        inputTokens: 30,
        outputTokens: 12,
        recordedAt: "2026-09-16T00:00:00.000Z",
      },
      () => NOW,
    );
    const roll = await db.usageMonths.get(`${JOB_A}|2026-09`);
    expect(roll).toMatchObject({
      requests: 2,
      inputTokens: 40,
      outputTokens: 17,
      unpricedRequests: 2,
    });
    // jobUsageRollup folds raw + rollup so a job's totals never degrade.
    const totals = await jobUsageRollup(JOB_A);
    expect(totals).toMatchObject({
      requests: 3,
      inputTokens: 60,
      outputTokens: 25,
      costUsd: 0.002,
    });
  });
});

describe("appendLlmUsage monthly compaction", () => {
  const row = (overrides: Record<string, unknown>) => ({
    providerId: PROVIDER_ID,
    feature: "llm_explain",
    model: MODEL,
    configuredModel: MODEL,
    inputTokens: 100,
    outputTokens: 50,
    recordedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  });

  it("classifies reported/estimated/unknown/not-billed costs like the snapshot", async () => {
    await appendLlmUsage(row({ costUsd: 0.5 }), () => NOW);
    await appendLlmUsage(row({ estimatedCostUsd: 0.25 }), () => NOW);
    await appendLlmUsage(row({}), () => NOW); // unknown cost
    await appendLlmUsage(row({ notBilled: true }), () => NOW);
    expect(await db.llmUsage.count()).toBe(0);
    const roll = await db.llmUsageMonths.get(`${PROVIDER_ID}|2026-09`);
    expect(roll).toMatchObject({
      providerId: PROVIDER_ID,
      month: "2026-09",
      requests: 4,
      inputTokens: 400,
      outputTokens: 200,
      reportedCostUsd: 0.5,
      estimatedCostUsd: 0.25,
      unknownCostRequests: 1,
      // Snapshot-mirror read: unknown + notBilled reproduces the raw read.
      notBilledRequests: 1,
    });
  });
});

describe("reservation retention", () => {
  const reservation = (
    id: string,
    status: BudgetReservation["status"],
    month: string,
  ): BudgetReservation => ({
    id,
    providerId: PROVIDER_ID,
    model: MODEL,
    month,
    reservedUsd: 0.01,
    maxInputTokens: 100,
    maxOutputTokens: 50,
    kind: "manual",
    status,
    createdAt: `${month}-01T00:00:00.000Z`,
  });

  it("prunes settled/released rows outside the cap window, keeps the rest", async () => {
    await db.llmReservations.bulkAdd([
      reservation("res-old-settled", "settled", "2026-08"),
      reservation("res-old-released", "released", "2026-09"),
      reservation("res-cur-settled", "settled", NOW_MONTH),
      reservation("res-old-active", "active", "2026-08"),
    ]);
    const removed = await db.transaction("rw", db.llmReservations, () =>
      pruneExpiredReservationsLocked(NOW_MONTH),
    );
    expect(removed).toBe(2);
    const remaining = (await db.llmReservations.toArray())
      .map((row) => row.id)
      .sort();
    expect(remaining).toEqual(["res-cur-settled", "res-old-active"]);
  });
});

describe("jobs terminal cap", () => {
  it(`holds at ${JOB_RETENTION_CAP} terminal rows through N enqueues`, async () => {
    for (let i = 0; i < JOB_RETENTION_CAP + 5; i += 1) {
      const kind: "analyze_selection" | "library_scan" =
        i % 2 === 0 ? "analyze_selection" : "library_scan";
      const job = await enqueueJob({
        kind,
        bookmarkIds: [`bm-${i}`],
      });
      // Drive the REAL transition path — terminal transitions prune in the
      // same transaction, so the cap holds continuously, not just at enqueue.
      // (pending→canceled is the only terminal edge out of pending.)
      await setJobStatus(job.id, "canceled");
    }
    // One more job stays live — the sweep never reaps non-terminal rows.
    await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-live"] });
    const terminal = await db.jobs
      .where("status")
      .anyOf("completed", "failed", "canceled")
      .count();
    expect(terminal).toBe(JOB_RETENTION_CAP);
    expect(await db.jobs.where("status").equals("pending").count()).toBe(1);
    expect(await db.jobs.count()).toBe(JOB_RETENTION_CAP + 1);
  });
});

describe("audit cap", () => {
  it(`holds at ${AUDIT_RETENTION_CAP} rows across transitions`, async () => {
    const seed = Array.from({ length: AUDIT_RETENTION_CAP - 1 }, (_, i) => ({
      decisionId: crypto.randomUUID(),
      from: "pending" as const,
      to: "approved" as const,
      actor: "user" as const,
      changedAt: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    }));
    await db.audit.bulkAdd(seed);
    const decision = Decision.parse({ ...validDecisionShape(), status: "pending" });
    await db.decisions.add(decision);
    await transitionStatus(decision.id, "applied", "user");
    expect(await db.audit.count()).toBe(AUDIT_RETENTION_CAP);
    await transitionStatus(decision.id, "reverted", "user");
    // 1001st write pruned the oldest row — count never exceeds the cap.
    expect(await db.audit.count()).toBe(AUDIT_RETENTION_CAP);
    const newest = await db.audit.orderBy(":id").last();
    expect(newest).toMatchObject({ decisionId: decision.id, to: "reverted" });
  });
});

function validDecisionShape() {
  return {
    id: crypto.randomUUID(),
    bookmarkIds: ["bm-real-1"],
    confidence: 0.9,
    source: {
      engine: "jev" as const,
      providerId: "typesafe",
      model: "jev-1",
      questionSetVersion: "qs-1",
    },
    createdAt: "2026-10-01T00:00:00.000Z",
    kind: "set_category" as const,
    category: "article" as const,
  };
}

describe("prunePopupDecisions", () => {
  it("reads through the status index and caps terminal non-popup rows", async () => {
    const popupRow = (index: number) => ({
      ...validDecisionShape(),
      bookmarkIds: [`popup:${crypto.randomUUID()}`],
      status: "pending" as const,
      createdAt: `2026-09-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    });
    const terminalRow = (index: number) => ({
      ...validDecisionShape(),
      status: "rejected" as const,
      createdAt: `2026-08-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    });
    await db.decisions.bulkAdd([
      ...Array.from({ length: POPUP_DECISION_LIMIT + 40 }, (_, i) => popupRow(i)),
      ...Array.from(
        { length: DECISION_TERMINAL_RETENTION_CAP + 7 },
        (_, i) => terminalRow(i),
      ),
      { ...validDecisionShape(), status: "approved" as const },
      { ...validDecisionShape(), status: "pending" as const },
    ]);

    // The sweep must never materialize the table.
    const toArraySpy = vi.spyOn(db.decisions, "toArray");

    const removed = await prunePopupDecisions();
    expect(removed).toBe(40);
    expect(toArraySpy).not.toHaveBeenCalled();

    expect(
      await db.decisions.where("status").equals("pending").count(),
    ).toBe(POPUP_DECISION_LIMIT + 1); // 300 synthetic + the real pending row
    expect(
      await db.decisions.where("status").equals("rejected").count(),
    ).toBe(DECISION_TERMINAL_RETENTION_CAP);
    expect(
      await db.decisions.where("status").equals("approved").count(),
    ).toBe(1);
    // Oldest-first: the surviving terminal rows are the newest by createdAt.
    const oldestKept = await db.decisions
      .where("status")
      .equals("rejected")
      .toArray();
    const minCreatedAt = Math.min(
      ...oldestKept.map((row) => Date.parse(row.createdAt)),
    );
    expect(new Date(minCreatedAt).toISOString()).toBe(
      `2026-08-01T00:${String(Math.floor(7 / 60)).padStart(2, "0")}:${String(7 % 60).padStart(2, "0")}.000Z`,
    );
  });
});

describe("budget transaction indexed reads", () => {
  function providerRecord(): LlmProviderRecord {
    return {
      providerId: PROVIDER_ID,
      provider: { kind: "preset", preset: "openai", model: MODEL },
      configuredAt: "2026-10-01T00:00:00.000Z",
      monthlyBudgetUsd: 5,
    };
  }

  it("reads only the current month through [providerId+month] and prunes expired reservations", async () => {
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_explain", ORIGIN);
    await saveCredential(PROVIDER_ID, "sk-test-1234");
    // History the cap must neither read nor keep: an old month's usage row
    // and an old terminal reservation.
    await db.llmUsage.add({
      providerId: PROVIDER_ID,
      feature: "llm_explain",
      model: MODEL,
      configuredModel: MODEL,
      inputTokens: 9000,
      outputTokens: 9000,
      costUsd: 4.99,
      recordedAt: "2026-09-20T00:00:00.000Z",
      month: "2026-09",
    });
    await db.llmReservations.add({
      id: "res-old-terminal",
      providerId: PROVIDER_ID,
      model: MODEL,
      month: "2026-09",
      reservedUsd: 4.99,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      kind: "manual",
      status: "settled",
      createdAt: "2026-09-20T00:00:00.000Z",
      settledAt: "2026-09-20T00:00:05.000Z",
    });

    const llmUsageWhere = vi.spyOn(db.llmUsage, "where");
    const reservationWhere = vi.spyOn(db.llmReservations, "where");

    const server = makeOpenAiServer();
    const { response } = await sendLlmForTest(
      {
        providerId: PROVIDER_ID,
        scope: "llm_explain",
        request: scopeRequest("llm_explain", MODEL),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      {
        now: () => NOW,
        fetchImpl: server.fetch,
        unknownCostConfirmed: true,
      },
    );

    expect(response.status).toBe(200);
    // Both reads hit the compound index with exactly [provider, month].
    expect(llmUsageWhere).toHaveBeenCalledWith("[providerId+month]");
    expect(reservationWhere).toHaveBeenCalledWith("[providerId+month]");
    // The single-month read means the old usage row never entered the cap
    // math — the send stayed inside the $5 budget despite $4.99 of history.
    const reservations = await db.llmReservations.toArray();
    expect(
      reservations.some((row) => row.id === "res-old-terminal"),
    ).toBe(false); // pruned on write
    expect(
      reservations.filter((row) => row.month === NOW_MONTH),
    ).toHaveLength(1); // this send's reservation
  });
});
