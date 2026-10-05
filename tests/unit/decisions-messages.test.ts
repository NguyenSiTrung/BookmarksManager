import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeJobs } from "../../src/entrypoints/background";
import { db } from "../../src/db/database";
import { enqueueJob, pauseJob, setJobStatus } from "../../src/jobs/queue";
import type { AnalysisBookmark, AnalyzeBookmarkResult } from "../../src/decisions/pipeline";
import { DecisionSettings } from "../../src/decisions/policy";
import type { RerankSearchResult } from "../../src/decisions/rerank";
import type { BulkApproveResult, RevertBatchResult } from "../../src/decisions/apply";
import type { DecisionRow } from "../../src/decisions/store";
import {
  DECISION_MESSAGE_TYPES,
  DecisionMessageResult,
  handleDecisionsMessage,
  type DecisionsHandlers,
  type SettingsSnapshot,
} from "../../src/messages/decisions";
import type { Job } from "../../src/schemas/job";
import { Job as JobSchema, MAX_JOB_BOOKMARK_IDS } from "../../src/schemas/job";
import type { UsageRecord } from "../../src/schemas/usage";

/**
 * The worker-side decisions protocol (spec FR9/FR10): a Zod-validated,
 * total `runtime.onMessage` handler set that dispatches UI intents to the
 * decision services. Keys and the Jev client stay in the worker; results
 * are redacted (no key material, no bookmark content).
 *
 * `handleDecisionsMessage` is total: every path resolves to a
 * `DecisionMessageResult`, or `undefined` for a message this module does not
 * own (so the provider handler still answers). It never throws.
 */

const EXTENSION_ID = "test-extension-id";
const SIDEPANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;
const OPTIONS_URL = `chrome-extension://${EXTENSION_ID}/options.html`;
const CONTENT_URL = "https://example.com/page";

const NOW = "2026-09-27T10:00:00.000Z";

const SECRET_KEY = "sk-live-DEADBEEF";
const SECRET_TITLE = "SECRET BOOKMARK TITLE";
const SECRET_URL = "https://secret.example.com/private";

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    },
  });
  await db.jobs.clear();
  await db.usage.clear();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

function usage(): UsageRecord {
  return {
    model: "jev-1",
    inputTokens: 10,
    outputTokens: 2,
    recordedAt: NOW,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return JobSchema.parse({
    id: crypto.randomUUID(),
    kind: "analyze_selection",
    status: "running",
    progress: { totalBatches: 1, committedBatches: 0, processedCount: 0 },
    batchSize: 5,
    bookmarkIds: ["bm-1"],
    usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function decisionRow(id: string, status = "applied"): DecisionRow {
  return { id, status } as unknown as DecisionRow;
}

const SETTINGS: DecisionSettings = DecisionSettings.parse({});

interface Recorded {
  analyzeById: string[];
  saveSuggest: AnalysisBookmark[];
  rerank: string[];
  approve: string[];
  reject: string[];
  revert: string[];
  bulkApprove: (readonly string[])[];
  revertBatch: (readonly string[])[];
  startJob: { kind: string; ids: readonly string[] }[];
  pause: string[];
  resume: string[];
  cancel: string[];
  getSettings: number;
  setSettings: DecisionSettings[];
  setBlocklist: (readonly string[])[];
}

function makeHandlers(over: Partial<DecisionsHandlers> = {}): {
  handlers: DecisionsHandlers;
  calls: Recorded;
} {
  const calls: Recorded = {
    analyzeById: [],
    saveSuggest: [],
    rerank: [],
    approve: [],
    reject: [],
    revert: [],
    bulkApprove: [],
    revertBatch: [],
    startJob: [],
    pause: [],
    resume: [],
    cancel: [],
    getSettings: 0,
    setSettings: [],
    setBlocklist: [],
  };
  const snapshot: SettingsSnapshot = { settings: SETTINGS, blocklist: ["bank.example"] };
  const handlers: DecisionsHandlers = {
    async analyzeById(id) {
      calls.analyzeById.push(id);
      const result: AnalyzeBookmarkResult = {
        sent: true,
        model: "jev-1",
        decisions: [decisionRow("d-1")],
        usage: usage(),
      };
      return result;
    },
    async saveSuggest(bookmark) {
      calls.saveSuggest.push(bookmark);
      return { sent: false, reason: "blocklisted" };
    },
    async rerank(query) {
      calls.rerank.push(query);
      const result: RerankSearchResult = {
        sent: true,
        model: "jev-1",
        results: [
          { id: "bm-2", probability: 0.9 },
          { id: "bm-1", probability: 0.2 },
        ],
        noMatch: false,
        usage: usage(),
      };
      return result;
    },
    async approve(id) {
      calls.approve.push(id);
      return decisionRow(id, "applied");
    },
    async reject(id) {
      calls.reject.push(id);
      return decisionRow(id, "rejected");
    },
    async revert(id) {
      calls.revert.push(id);
      return decisionRow(id, "reverted");
    },
    async bulkApprove(ids): Promise<BulkApproveResult> {
      calls.bulkApprove.push(ids);
      return {
        ok: true,
        applied: [decisionRow("d-1"), decisionRow("d-2")],
        failed: [{ id: "d-3", code: "stale", message: "stale decision" }],
      };
    },
    async revertBatch(ids): Promise<RevertBatchResult> {
      calls.revertBatch.push(ids);
      return {
        ok: true,
        reverted: ["d-1", "d-2"],
        failed: [{ id: "d-3", code: "undo_conflict", message: "snapshot gone" }],
      };
    },
    async startJob(kind, bookmarkIds) {
      calls.startJob.push({ kind, ids: bookmarkIds });
      return {
        job: job({ kind }),
        estimate: {
          totalBatches: 1,
          inputTokens: 10,
          batches: [{ batchIndex: 0, inputTokens: 10 }],
          requests: bookmarkIds.length,
          pairs: 0,
          comparisons: 0,
          truncated: false,
          pairLimit: 500,
        },
      };
    },
    async pauseJob(id) {
      calls.pause.push(id);
      return job({ status: "paused" });
    },
    async resumeJob(id) {
      calls.resume.push(id);
      return job({ status: "running" });
    },
    async cancelJob(id) {
      calls.cancel.push(id);
      return job({ status: "canceled" });
    },
    async getSettings() {
      calls.getSettings += 1;
      return snapshot;
    },
    async setSettings(settings) {
      calls.setSettings.push(settings);
      return { settings, blocklist: snapshot.blocklist };
    },
    async setBlocklist(blocklist) {
      calls.setBlocklist.push(blocklist);
      return { settings: snapshot.settings, blocklist };
    },
    ...over,
  };
  return { handlers, calls };
}

const sender = { url: SIDEPANEL_URL };

describe("fall-through and totality", () => {
  it("returns undefined for a message this module does not own", async () => {
    const { handlers } = makeHandlers();
    const result = await handleDecisionsMessage(
      { type: "ENABLE_PROVIDER", preset: "typesafe", model: "x", key: "k" },
      sender,
      handlers,
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for a non-object or typeless message", async () => {
    const { handlers } = makeHandlers();
    expect(await handleDecisionsMessage(null, sender, handlers)).toBeUndefined();
    expect(await handleDecisionsMessage("hi", sender, handlers)).toBeUndefined();
    expect(await handleDecisionsMessage({}, sender, handlers)).toBeUndefined();
    expect(
      await handleDecisionsMessage({ type: "NOT_OURS" }, sender, handlers),
    ).toBeUndefined();
  });

  it("answers malformed_message for an owned type that fails validation", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      { type: "ANALYZE_BOOKMARK", bookmarkId: 42 },
      sender,
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(calls.analyzeById).toEqual([]);
  });

  // A07: JOB_START bounds its id set — an over-cap payload never reaches
  // the handler, let alone the queue.
  it("answers malformed_message when JOB_START exceeds the id cap", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      {
        type: "JOB_START",
        kind: "analyze_selection",
        bookmarkIds: Array.from(
          { length: MAX_JOB_BOOKMARK_IDS + 1 },
          (_, index) => `bm-${index}`,
        ),
      },
      sender,
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(calls.startJob).toEqual([]);
  });

  it("never throws when a handler rejects, mapping its .code", async () => {
    const pipelineError = Object.assign(new Error("redacted"), {
      code: "answer_mismatch",
    });
    const { handlers } = makeHandlers({
      async rerank() {
        throw pipelineError;
      },
    });
    const result = await handleDecisionsMessage(
      { type: "RERANK", query: "rust" },
      sender,
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "answer_mismatch" });
  });

  it("maps a RerankError by .code even though it is not a DecisionPipelineError", async () => {
    // Mirrors the real RerankError shape: a plain Error subclass with `code`.
    class RerankError extends Error {
      readonly code: string;
      constructor(code: string, message: string) {
        super(message);
        this.name = "RerankError";
        this.code = code;
      }
    }
    const { handlers } = makeHandlers({
      async rerank() {
        throw new RerankError("provider", "The rerank request failed.");
      },
    });
    const result = await handleDecisionsMessage(
      { type: "RERANK", query: "rust" },
      sender,
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "provider" });
  });

  it("collapses a bare throw to a static internal_error", async () => {
    const { handlers } = makeHandlers({
      async approve() {
        throw new Error(`boom ${SECRET_KEY}`);
      },
    });
    const result = await handleDecisionsMessage(
      { type: "APPROVE_DECISION", decisionId: "d-1" },
      sender,
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "internal_error" });
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(result)).not.toContain("boom");
  });
});

describe("trusted sender", () => {
  it("refuses a content-script sender for every intent", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      { type: "APPROVE_DECISION", decisionId: "d-1" },
      { url: CONTENT_URL },
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(calls.approve).toEqual([]);
  });

  it("refuses a sender with no url and another extension's page", async () => {
    const { handlers } = makeHandlers();
    expect(
      await handleDecisionsMessage(
        { type: "GET_SETTINGS" },
        {},
        handlers,
      ),
    ).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(
      await handleDecisionsMessage(
        { type: "GET_SETTINGS" },
        { url: "chrome-extension://someone-else/options.html" },
        handlers,
      ),
    ).toMatchObject({ ok: false, code: "untrusted_sender" });
  });

  it("accepts both the side panel and the Options page of this extension", async () => {
    const { handlers } = makeHandlers();
    for (const url of [SIDEPANEL_URL, OPTIONS_URL]) {
      const result = await handleDecisionsMessage(
        { type: "GET_SETTINGS" },
        { url },
        handlers,
      );
      expect(result).toMatchObject({ ok: true, code: "settings_ok" });
    }
  });
});

describe("intent dispatch", () => {
  it("covers every declared discriminator", () => {
    expect(DECISION_MESSAGE_TYPES).toEqual([
      "ANALYZE_BOOKMARK",
      "SAVE_SUGGEST",
      "RERANK",
      "JOB_START",
      "JOB_PAUSE",
      "JOB_RESUME",
      "JOB_CANCEL",
      "APPROVE_DECISION",
      "REJECT_DECISION",
      "REVERT_DECISION",
      "REVERT_BATCH",
      "BULK_APPROVE",
      "GET_SETTINGS",
      "SET_SETTINGS",
      "SET_BLOCKLIST",
    ]);
  });

  it("analyzes a bookmark by id and returns a redacted summary", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      { type: "ANALYZE_BOOKMARK", bookmarkId: "bm-1" },
      sender,
      handlers,
    );
    expect(calls.analyzeById).toEqual(["bm-1"]);
    expect(result).toMatchObject({
      ok: true,
      code: "analyze_ok",
      result: { sent: true, model: "jev-1", decisionCount: 1 },
    });
    // No bookmark content or key material crosses the boundary.
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain(SECRET_URL);
  });

  it("saves-suggest and reports the not-sent reason", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      {
        type: "SAVE_SUGGEST",
        bookmark: { id: "bm-1", title: SECRET_TITLE, url: SECRET_URL },
      },
      sender,
      handlers,
    );
    expect(calls.saveSuggest).toHaveLength(1);
    expect(result).toMatchObject({
      ok: true,
      code: "analyze_ok",
      result: { sent: false, reason: "blocklisted", decisionCount: 0 },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_TITLE);
  });

  it("reranks a query and returns only ids + probabilities", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      { type: "RERANK", query: "async rust" },
      sender,
      handlers,
    );
    expect(calls.rerank).toEqual(["async rust"]);
    expect(result).toMatchObject({
      ok: true,
      code: "rerank_ok",
      result: {
        sent: true,
        model: "jev-1",
        noMatch: false,
        results: [
          { id: "bm-2", probability: 0.9 },
          { id: "bm-1", probability: 0.2 },
        ],
      },
    });
  });

  it("dispatches the job lifecycle intents", async () => {
    const { handlers, calls } = makeHandlers();
    const start = await handleDecisionsMessage(
      { type: "JOB_START", kind: "library_scan", bookmarkIds: ["bm-1", "bm-2"] },
      sender,
      handlers,
    );
    expect(calls.startJob).toEqual([
      { kind: "library_scan", ids: ["bm-1", "bm-2"] },
    ]);
    // A07: a handler-supplied pre-run estimate rides the job_ok reply.
    expect(start).toMatchObject({
      ok: true,
      code: "job_ok",
      estimate: { requests: 2 },
    });

    const pause = await handleDecisionsMessage(
      { type: "JOB_PAUSE", jobId: "j-1" },
      sender,
      handlers,
    );
    expect(calls.pause).toEqual(["j-1"]);
    expect(pause).toMatchObject({ ok: true, code: "job_ok" });

    await handleDecisionsMessage({ type: "JOB_RESUME", jobId: "j-2" }, sender, handlers);
    expect(calls.resume).toEqual(["j-2"]);
    await handleDecisionsMessage({ type: "JOB_CANCEL", jobId: "j-3" }, sender, handlers);
    expect(calls.cancel).toEqual(["j-3"]);
  });

  it("dispatches the review/undo intents", async () => {
    const { handlers, calls } = makeHandlers();
    await handleDecisionsMessage(
      { type: "APPROVE_DECISION", decisionId: "d-1" },
      sender,
      handlers,
    );
    await handleDecisionsMessage(
      { type: "REJECT_DECISION", decisionId: "d-2" },
      sender,
      handlers,
    );
    await handleDecisionsMessage(
      { type: "REVERT_DECISION", decisionId: "d-3" },
      sender,
      handlers,
    );
    expect(calls.approve).toEqual(["d-1"]);
    expect(calls.reject).toEqual(["d-2"]);
    expect(calls.revert).toEqual(["d-3"]);

    const bulk = await handleDecisionsMessage(
      { type: "BULK_APPROVE", decisionIds: ["d-1", "d-2", "d-3"] },
      sender,
      handlers,
    );
    expect(calls.bulkApprove).toEqual([["d-1", "d-2", "d-3"]]);
    expect(bulk).toMatchObject({
      ok: true,
      code: "bulk_ok",
      applied: ["d-1", "d-2"],
      failed: [{ id: "d-3", code: "stale" }],
    });

    const batchRevert = await handleDecisionsMessage(
      { type: "REVERT_BATCH", decisionIds: ["d-1", "d-2", "d-3"] },
      sender,
      handlers,
    );
    expect(calls.revertBatch).toEqual([["d-1", "d-2", "d-3"]]);
    expect(batchRevert).toMatchObject({
      ok: true,
      code: "bulk_reverted",
      reverted: ["d-1", "d-2"],
      failed: [{ id: "d-3", code: "undo_conflict" }],
    });
  });

  it("reads and writes settings and the blocklist", async () => {
    const { handlers, calls } = makeHandlers();
    const read = await handleDecisionsMessage(
      { type: "GET_SETTINGS" },
      sender,
      handlers,
    );
    expect(calls.getSettings).toBe(1);
    expect(read).toMatchObject({
      ok: true,
      code: "settings_ok",
      blocklist: ["bank.example"],
    });
    expect(DecisionMessageResult.safeParse(read).success).toBe(true);

    const written = await handleDecisionsMessage(
      {
        type: "SET_SETTINGS",
        settings: { autoApply: { add_tags: true, set_category: false } },
      },
      sender,
      handlers,
    );
    expect(calls.setSettings).toHaveLength(1);
    expect(written).toMatchObject({ ok: true, code: "settings_ok" });

    const blocked = await handleDecisionsMessage(
      { type: "SET_BLOCKLIST", blocklist: ["bank.example", "health.example"] },
      sender,
      handlers,
    );
    expect(calls.setBlocklist).toEqual([["bank.example", "health.example"]]);
    expect(blocked).toMatchObject({
      ok: true,
      code: "settings_ok",
      blocklist: ["bank.example", "health.example"],
    });
  });

  it("rejects a settings write carrying key material", async () => {
    const { handlers, calls } = makeHandlers();
    const result = await handleDecisionsMessage(
      { type: "SET_SETTINGS", settings: { autoApply: {}, key: SECRET_KEY } },
      sender,
      handlers,
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(calls.setSettings).toEqual([]);
  });
});

describe("job recovery on cold worker startup", () => {
  it("pauses running and pending jobs without driving them; preserves paused and terminal rows", async () => {
    const running = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      now: () => NOW,
    });
    await setJobStatus(running.id, "running", {}, () => NOW);
    // A job evicted between `enqueueJob` and the first `setJobStatus("running")`
    // is still `pending` — it must also require an explicit Resume. The A07
    // one-live-job-per-kind guard is an enqueue-time check: rows that
    // predate it (or were written by an older version) still surface, so the
    // remaining same-kind rows are seeded directly to simulate them.
    const pending = job({ bookmarkIds: ["bm-2"], status: "pending" });
    await db.jobs.put(pending);
    // A `paused` job only reaches that status via an explicit user action; it
    // must stay paused until the user resumes it, so startup must NOT restart
    // the egress/cost the user halted.
    const paused = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["bm-3"],
      now: () => NOW,
    });
    await pauseJob(paused.id, () => NOW);
    const completed = job({ bookmarkIds: ["bm-4"], status: "completed" });
    await db.jobs.put(completed);

    await resumeJobs();
    expect((await db.jobs.get(running.id))?.status).toBe("paused");
    expect((await db.jobs.get(pending.id))?.status).toBe("paused");
    expect((await db.jobs.get(paused.id))?.status).toBe("paused");
    expect((await db.jobs.get(completed.id))?.status).toBe("completed");
  });

  it("pauses interrupted jobs without resolving native work sets", async () => {
    const first = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      now: () => NOW,
    });
    await setJobStatus(first.id, "running", {}, () => NOW);
    // A second same-kind live row can only predate the A07 enqueue guard —
    // seed it directly to simulate that legacy state.
    const second = job({ bookmarkIds: ["bm-2"], status: "running" });
    await db.jobs.put(second);

    await expect(resumeJobs()).resolves.toBeUndefined();
    expect((await db.jobs.get(first.id))?.status).toBe("paused");
    expect((await db.jobs.get(second.id))?.status).toBe("paused");
  });

  it("requires explicit Resume even when a saved work set is now empty", async () => {
    const only = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      now: () => NOW,
    });
    await setJobStatus(only.id, "running", {}, () => NOW);
    await resumeJobs();
    expect((await db.jobs.get(only.id))?.status).toBe("paused");
  });
});
