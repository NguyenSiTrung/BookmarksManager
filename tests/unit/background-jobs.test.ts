import "fake-indexeddb/auto";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { productionHandlers, resumeJobs, runPersistedJob } from "../../src/entrypoints/background";
import { grantConsent, grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { assertJobAuthority, cancelJob, claimJobOwner, enqueueJob, getJob, pauseJob, restructurePlanFor, setJobStatus } from "../../src/jobs/queue";
import { readSessionJobIds } from "../../src/jobs/keepalive";
import { handleDecisionsMessage } from "../../src/messages/decisions";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import * as network from "../../src/net/send";
import type { SystemOneRequest } from "../../src/jev/wire";
import * as providerSettings from "../../src/jev/settings";
import * as coordinator from "../../src/jobs/coordinator";
import { handleRestructureMessage } from "../../src/messages/restructure";
import { createJevClient, resetJevClientPools } from "../../src/jev/client";
import { saveLlmProvider } from "../../src/llm/settings";
import { writeLlmEscalationSettings } from "../../src/llm/escalate";
import { makeOpenAiServer } from "../mock-servers/openai";

declare const chrome: Record<string, unknown>;

// Only encrypted-key storage is replaced; new authority tests exercise the
// real consent, permission, blocklist, client and final network gate.
vi.mock("../../src/security/keys", async (original) => ({
  ...await original<typeof import("../../src/security/keys")>(),
  readProviderKey: vi.fn(async () => "synthetic-job-key"),
}));

/**
 * Phase 4 fix round (T4 review): the production JOB_START/JOB_RESUME wiring.
 *
 *  - `JOB_START` with no active provider must REFUSE with the same redacted
 *    typed error every other decisions handler returns — never enqueue a
 *    row that would sit "Queued" forever with no error surfaced (the panel
 *    renders the refusal verbatim).
 *  - `JOB_RESUME` must RELAUNCH the runner after flipping the row to
 *    `running`: the paused job's loop already returned at its batch
 *    boundary, so without a relaunch the row would say "Running" while
 *    nothing drives it until the next worker restart. The relaunch seam is
 *    injectable (`ResumeJobsDeps` style) so the wiring is testable without
 *    a live provider.
 *
 * Follow-up round (re-review): the resume path itself is gated the same way
 * `JOB_START` is (no provider → refuse, row stays `paused`), and
 * `runPersistedJob` never re-drives a row the user moved on from
 * (`paused`/terminal) and surfaces a caller-error strand as a `failed` row
 * instead of swallowing it silently.
 */

const EXTENSION_ID = "test-extension-id";
const SIDEPANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;

beforeAll(async () => {
  await db.open();
});

const resetEnv = async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetJevClientPools();
  const bookmarks = installBookmarksFake({
    bookmarksBar: [{ id: "b1", title: "B1", url: "https://b1.example/" }],
    otherBookmarks: [],
  });
  vi.stubGlobal("chrome", {
    bookmarks,
    runtime: {
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    },
  });
  await db.consents.clear();
  await db.metadata.clear();
  await db.jobs.clear();
  await db.restructureAssignments.clear();
  await db.usage.clear();
  await db.decisions.clear();
  await db.llmUsage.clear();
  await db.llmReservations.clear();
  await db.sentLog.clear();
};

beforeEach(resetEnv);

afterEach(() => { vi.restoreAllMocks(); });

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

/**
 * A fully-enabled `typesafe` provider (current consent grant + settings
 * row) — enough for `activeProvider()`; nothing here egresses because the
 * paths under test fail before any request is built.
 */
async function seedProvider(): Promise<void> {
  await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
  await db.metadata.put({
    key: "typesafe",
    value: { preset: "typesafe", model: "jev-latest", keySuffix: "test" },
  });
}

describe("production job handlers", () => {
  it("JOB_START without an active provider refuses and persists no job row", async () => {
    // No consent rows and no provider settings: activeProvider() is null.
    const result = await handleDecisionsMessage(
      { type: "JOB_START", kind: "library_scan", bookmarkIds: ["b1"] },
      { url: SIDEPANEL_URL },
      productionHandlers(),
    );
    expect(result).toEqual({
      ok: false,
      code: "invalid_input",
      message: "No provider is enabled for decisions; enable one in Options first.",
    });
    expect(await db.jobs.count()).toBe(0);
  });

  it("JOB_START enqueues a library_scan with a bounded pair plan and pair-inclusive totals", async () => {
    await seedProvider();
    const native = installBookmarksFake({
      bookmarksBar: [
        { id: "a", title: "Async guide", url: "https://docs.guides.dev/guide-a" },
        { id: "b", title: "Async guide", url: "https://docs.guides.dev/guide-b" },
      ],
      otherBookmarks: [],
    });
    vi.stubGlobal("chrome", { ...chrome, bookmarks: native });
    // The fire-and-forget runner must not reach the network here.
    vi.spyOn(network, "sendConsented").mockRejectedValue(new Error("no network"));

    const { job, estimate } = await productionHandlers().startJob("library_scan", ["a", "b"]);

    // 1 bookmark batch + 1 pair batch at the default batch size of 5.
    expect(job.progress.totalBatches).toBe(2);
    expect(job.nearDuplicatePlan?.pairs).toEqual([{ a: "a", b: "b" }]);
    // A07: the start reply carries the same pre-run estimate the panel
    // shows, with totalBatches mirroring the persisted progress counter
    // (bookmark batches + pair batches).
    expect(estimate?.requests).toBe(3); // 2 bookmarks + 1 pair
    expect(estimate?.totalBatches).toBe(2);
    expect(estimate?.inputTokens).toBeGreaterThan(0);
    const stored = await getJob(job.id);
    expect(stored?.nearDuplicatePlan?.truncated).toBe(false);
    // Pair IDs only — no raw titles or URLs in the persisted plan.
    const serialized = JSON.stringify(stored?.nearDuplicatePlan);
    expect(serialized).toContain("\"a\"");
    expect(serialized).not.toContain("Async guide");
    expect(serialized).not.toContain("guides.dev");
  });

  it("JOB_START still enqueues a legacy row when plan resolution fails, and the runner acquires one", async () => {
    await seedProvider();
    const native = installBookmarksFake({
      bookmarksBar: [
        { id: "a", title: "Async guide", url: "https://docs.guides.dev/guide-a" },
        { id: "b", title: "Async guide", url: "https://docs.guides.dev/guide-b" },
      ],
      otherBookmarks: [],
    });
    // The tree read throws (a transient Chrome API failure) — plan resolution
    // is best-effort and must not block the start.
    vi.spyOn(native, "getTree").mockRejectedValue(new Error("tree unavailable"));
    vi.stubGlobal("chrome", { ...chrome, bookmarks: native });
    // The fire-and-forget runner must not reach the network here.
    vi.spyOn(network, "sendConsented").mockRejectedValue(new Error("no network"));

    const { job, estimate } = await productionHandlers().startJob("library_scan", ["a", "b"]);
    // The work-set read failed, so no estimate could be folded — the start
    // still succeeds and simply omits it.
    expect(estimate).toBeUndefined();
    const stored = await getJob(job.id);
    // Legacy row: no plan, bookmark-only batch total.
    expect(stored?.nearDuplicatePlan).toBeUndefined();
    expect(stored?.progress.totalBatches).toBe(1);

    // The runner acquires exactly one plan on its first uncommitted run.
    vi.restoreAllMocks();
    await runPersistedJob(job.id);
    const acquired = await getJob(job.id);
    expect(acquired?.nearDuplicatePlan?.pairs).toEqual([{ a: "a", b: "b" }]);
    // The acquired plan is durable and is not re-acquired on a later drive.
    const plan = acquired?.nearDuplicatePlan;
    await runPersistedJob(job.id);
    expect((await getJob(job.id))?.nearDuplicatePlan).toEqual(plan);
  });

  it("JOB_RESUME flips the row to running and relaunches the runner", async () => {
    await seedProvider();
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1", "b2"],
    });
    await pauseJob(enqueued.id);

    const relaunch = vi.fn(async (): Promise<void> => {});
    const job = await productionHandlers({ relaunchJob: relaunch }).resumeJob(
      enqueued.id,
    );

    expect(job.status).toBe("running");
    expect(relaunch).toHaveBeenCalledWith(enqueued.id);
  });

  it("JOB_RESUME through the message protocol reports the running row", async () => {
    await seedProvider();
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1"],
    });
    await pauseJob(enqueued.id);

    const result = await handleDecisionsMessage(
      { type: "JOB_RESUME", jobId: enqueued.id },
      { url: SIDEPANEL_URL },
      productionHandlers({ relaunchJob: vi.fn(async () => {}) }),
    );
    expect(result).toEqual({
      ok: true,
      code: "job_ok",
      job: expect.objectContaining({ id: enqueued.id, status: "running" }),
    });
  });

  it("JOB_RESUME without an active provider refuses and leaves the row paused", async () => {
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1"],
    });
    await pauseJob(enqueued.id);

    const relaunch = vi.fn(async (): Promise<void> => {});
    const result = await handleDecisionsMessage(
      { type: "JOB_RESUME", jobId: enqueued.id },
      { url: SIDEPANEL_URL },
      productionHandlers({ relaunchJob: relaunch }),
    );

    expect(result).toEqual({
      ok: false,
      code: "invalid_input",
      message: "No provider is enabled for decisions; enable one in Options first.",
    });
    expect(relaunch).not.toHaveBeenCalled();
    expect((await getJob(enqueued.id))?.status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// runPersistedJob — the default relaunch/start drive
// ---------------------------------------------------------------------------

describe("runPersistedJob guards", () => {
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  /** External provider only: the real client, analyzers, queue and native resolver still run. */
  function providerResponse(request: SystemOneRequest): Response {
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
      if (question.type === "noul") return [name, { type: "noul", noul: 0.9 }];
      if (question.type === "score") return [name, { type: "score", score: 3,
        legend: Object.fromEntries(question.criteria.map((value, index) => [String(index + 1), value])),
        probabilities: { "3": 1 }, confidence: 0.9 }];
      if (question.type !== "choice") throw new Error("unexpected test question");
      const choice = Object.keys(question.criteria).find((key) => key !== "none")!;
      return [name, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.9 }];
    }));
    return new Response(JSON.stringify({ model: request.model, answers,
      usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
  }

  async function seedWork(kind: "analyze_selection" | "restructure", batchSize = 1) {
    const native = installBookmarksFake({ bookmarksBar: [
      { id: "b1", title: "B1", url: "https://b11-one.com/" },
      { id: "b3", title: "B3", url: "https://b11-three.com/" },
      { id: "b4", title: "B4", url: "https://b11-four.com/" },
    ] });
    vi.stubGlobal("chrome", { bookmarks: native, runtime: { getURL: (path: string) =>
      `chrome-extension://${EXTENSION_ID}/${path}` } });
    await seedProvider();
    return enqueueJob({ kind, bookmarkIds: ["b1", "b3", "b4"], batchSize,
      ...(kind === "restructure" ? { restructureProposal: {
        folders: [{ path: "news", description: "News." }],
      } } : {}) });
  }

  function installWire(
    send: (request: SystemOneRequest) => Promise<Response>,
    preflight: () => Promise<boolean> = async () => true,
  ) {
    vi.stubGlobal("chrome", { ...chrome, permissions: { contains: preflight } });
    const wire = vi.fn(async (_url: unknown, init?: RequestInit) =>
      send(JSON.parse(String(init?.body)) as SystemOneRequest));
    vi.stubGlobal("fetch", wire);
    return wire;
  }

  it("library_scan honors cancel, replace, and pause during the first real pair request", async () => {
    for (const control of ["cancel", "replace", "pause"] as const) {
      await resetEnv();
      await seedProvider();
    const native = installBookmarksFake({ bookmarksBar: [
      { id: "a", title: "Async guide", url: "https://docs.guides.dev/guide-a" },
      { id: "b", title: "Async guide", url: "https://docs.guides.dev/guide-b" },
      { id: "c", title: "News guide", url: "https://news.guides.dev/news-a" },
      { id: "d", title: "News guide", url: "https://news.guides.dev/news-b" },
    ] });
    vi.stubGlobal("chrome", { ...chrome, bookmarks: native });
    const job = await enqueueJob({ kind: "library_scan", bookmarkIds: ["a", "b", "c", "d"], batchSize: 4 });
    const entered = deferred();
    const held = deferred();
    const pairs: string[] = [];
    const wire = installWire(async (request) => {
      const state = request.state as { bookmark: { url: string }; pairPartner?: unknown };
      if (state.pairPartner !== undefined) {
        pairs.push(state.bookmark.url);
        if (pairs.length === 1) { entered.release(); await held.promise; }
      }
      return providerResponse(request);
    });
    const running = runPersistedJob(job.id);
    await entered.promise;
    if (control === "cancel") await cancelJob(job.id);
    else if (control === "replace") await claimJobOwner(job.id);
    else await pauseJob(job.id);
    held.release();
    await running;
    const spent = control === "pause" ? 6 : 5;
    expect(pairs, control).toHaveLength(control === "pause" ? 2 : 1);
    expect(wire, control).toHaveBeenCalledTimes(spent); // same-owner pause drains both pairs
    expect(await db.usage.where("jobId").equals(job.id).count(), control).toBe(spent);
    expect(await db.sentLog.count(), control).toBe(spent);
    expect((await getJob(job.id))?.progress.committedBatches, control).toBe(control === "pause" ? 2 : 1);
    if (control === "pause") {
      expect((await getJob(job.id))?.status).toBe("paused");
      await productionHandlers().resumeJob(job.id);
      await runPersistedJob(job.id);
      expect((await getJob(job.id))?.status).toBe("completed");
      expect(wire).toHaveBeenCalledTimes(6);
    }
    }
  });

  it("a canceled low-confidence production analysis cannot start a new LLM second opinion", async () => {
    const job = await seedWork("analyze_selection");
    const llmId = "custom:https://job-opinion.dev/v1";
    await saveLlmProvider({ providerId: llmId, provider: { kind: "custom",
      baseUrl: "https://job-opinion.dev/v1", model: "opinion", auth: "none",
      pricing: { inputPerMillion: 1, outputPerMillion: 2 } },
    monthlyBudgetUsd: 5, configuredAt: "2026-10-01T00:00:00.000Z" });
    await grantConsentAtOrigin("llm_escalate", "https://job-opinion.dev");
    await writeLlmEscalationSettings({ enabled: true, providerId: llmId });
    const entered = deferred();
    const held = deferred();
    const llm = makeOpenAiServer();
    vi.stubGlobal("chrome", { ...chrome, permissions: { contains: async () => true } });
    let jevRequests = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://job-opinion.dev")) return llm.fetch(url, init);
      jevRequests += 1;
      const request = JSON.parse(String(init?.body)) as SystemOneRequest;
      const response = await providerResponse(request).json();
      for (const answer of Object.values(response.answers) as { confidence: number }[]) answer.confidence = 0.3;
      entered.release();
      await held.promise;
      return new Response(JSON.stringify(response), { status: 200 });
    });
    const running = runPersistedJob(job.id);
    await entered.promise;
    await cancelJob(job.id);
    held.release();
    await running;
    expect(jevRequests).toBe(1);
    expect(llm.requests).toHaveLength(0);
    expect(await db.usage.where("jobId").equals(job.id).count()).toBe(1);
    expect(await db.llmUsage.count()).toBe(0);
  });

  it("cancel during real Jev permission preflight prevents its first fetch", async () => {
    const job = await seedWork("analyze_selection");
    const entered = deferred();
    const held = deferred();
    const wire = installWire(async (request) => providerResponse(request), async () => {
      entered.release();
      await held.promise;
      return true;
    });
    const running = runPersistedJob(job.id);
    await entered.promise;
    await cancelJob(job.id);
    held.release();
    await running;
    expect(wire).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("cancel while a real production request waits for a shared Jev slot prevents its fetch", async () => {
    const job = await seedWork("analyze_selection");
    const entered = deferred();
    const held = deferred();
    const wire = installWire(async (request) => {
      entered.release();
      await held.promise;
      return providerResponse(request);
    });
    const blocker = createJevClient({ providerId: "typesafe", model: "jev-latest",
      scope: "jev_decisions", maxConcurrency: 1 }).run({ model: "jev-latest",
      state: { bookmark: { title: "Independent", url: "https://independent.dev/", domain: "independent.dev" } },
      questions: { category: { type: "choice", instructions: "Pick.", criteria: { docs: "Docs", other: "Other" } } } });
    await entered.promise;
    const running = runPersistedJob(job.id);
    await vi.waitFor(async () => expect((await getJob(job.id))?.status).toBe("running"));
    await cancelJob(job.id);
    held.release();
    await Promise.all([blocker, running]);
    expect(wire).toHaveBeenCalledTimes(1);
    expect(await db.usage.where("jobId").equals(job.id).count()).toBe(0);
  });

  it("analyze_selection and restructure keep one owner through a held request and two resumes, then commit monotonic batches", async () => {
    for (const kind of ["analyze_selection", "restructure"] as const) {
      await resetEnv();
      const job = await seedWork(kind, 2);
      const entered = deferred();
      const held = deferred();
      const requests: string[] = [];
      const committedAtSend: number[] = [];
      let active = 0;
      let maxActive = 0;
      vi.spyOn(network, "sendConsented").mockImplementation(async (_scope, _provider, _model, request) => {
        const body = request as SystemOneRequest;
        requests.push((body.state as { bookmark: { title: string } }).bookmark.title);
        committedAtSend.push((await getJob(job.id))!.progress.committedBatches);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (requests.length === 1) {
            entered.release();
            await held.promise;
          }
          return providerResponse(body);
        } finally { active -= 1; }
      });
      const running = runPersistedJob(job.id);
      await entered.promise;
      await pauseJob(job.id);
      const handlers = productionHandlers();
      const waiting = deferred();
      const waitForJob = coordinator.waitForJob;
      let waits = 0;
      vi.spyOn(coordinator, "waitForJob").mockImplementation((id) => {
        waits += 1;
        if (waits === 2) waiting.release();
        return waitForJob(id);
      });
      const resume = () => kind === "restructure"
        ? handleRestructureMessage({ type: "RESTRUCTURE_RESUME", jobId: job.id },
          { url: SIDEPANEL_URL }, { runJob: runPersistedJob })
        : handlers.resumeJob(job.id);
      const first = resume();
      const second = resume();
      try {
        expect(await Promise.race([waiting.promise.then(() => "waiting"),
          Promise.all([first, second]).then(() => "settled")])).toBe("waiting");
        expect(runPersistedJob(job.id)).toBe(running);
        expect(requests).toEqual(["B1"]);
        expect((await getJob(job.id))?.status).toBe("paused");
      } finally {
        held.release();
        await running;
        await Promise.all([first, second]);
      }
      await runPersistedJob(job.id);
      const finished = (await getJob(job.id))!;
      expect(maxActive).toBe(1);
      // J02: pause is honored per item — B1 completes and the runner exits
      // before B3, leaving batch 1 UNCOMMITTED. The waiting resumes relaunch
      // from `committedBatches` and replay the batch at least once (B1 is
      // sent twice; durable per-item rows merge idempotently by bookmarkId).
      expect(requests).toEqual(["B1", "B1", "B3", "B4"]);
      expect(committedAtSend).toEqual([0, 0, 0, 1]);
      expect(finished.status).toBe("completed");
      expect(finished.progress).toEqual({ totalBatches: 2, committedBatches: 2, processedCount: 3 });
      expect(finished.usage.requests).toBe(4);
      if (kind === "restructure") {
        expect(finished.restructure?.proposal).toEqual(job.restructure?.proposal);
        // J13: committed rows live in `restructureAssignments`.
        const plan = (await restructurePlanFor(finished))!;
        expect(plan.assignments.map((row) => row.bookmarkId)).toEqual(["b1", "b3", "b4"]);
      }

      // A later startup/manual drive and terminal resume may not restart completed work.
      await runPersistedJob(job.id);
      expect((await handlers.resumeJob(job.id)).status).toBe("completed");
      expect(requests).toHaveLength(4);
    }
  });

  it("a newer paused or canceled intent wins over a resume waiting for the batch", async () => {
    for (const intent of ["paused", "canceled"] as const) {
      await resetEnv();
      const job = await seedWork("analyze_selection");
    const entered = deferred();
    const held = deferred();
    let requests = 0;
    vi.spyOn(network, "sendConsented").mockImplementation(async (_scope, _provider, _model, request) => {
      requests += 1;
      entered.release();
      await held.promise;
      return providerResponse(request as SystemOneRequest);
    });
    const running = runPersistedJob(job.id);
    await entered.promise;
    await pauseJob(job.id);
    const resumeEntered = deferred();
    const readProvider = providerSettings.readActiveJevProvider;
    vi.spyOn(providerSettings, "readActiveJevProvider").mockImplementation(async () => {
      const result = await readProvider();
      resumeEntered.release();
      return result;
    });
    const waiting = productionHandlers().resumeJob(job.id);
    await resumeEntered.promise;
    if (intent === "canceled") await cancelJob(job.id);
    else await pauseJob(job.id);
    held.release();
    await Promise.all([running, waiting]);
    await runPersistedJob(job.id);
    expect((await getJob(job.id))?.status, intent).toBe(intent);
    expect(requests, intent).toBe(1);
    }
  });

  it("cold startup pauses analyze_selection and restructure without egress; explicit Resume uses committed progress", async () => {
    for (const kind of ["analyze_selection", "restructure"] as const) {
      await resetEnv();
      const job = await seedWork(kind);
    await setJobStatus(job.id, "running", {
      progress: { totalBatches: 3, committedBatches: 1, processedCount: 1 },
    });
    const requests: string[] = [];
    const wire = installWire(async (request) => {
      requests.push((request.state as { bookmark: { title: string } }).bookmark.title);
      return providerResponse(request);
    });
    await resumeJobs();
    expect((await getJob(job.id))?.status, kind).toBe("paused");
    expect((await getJob(job.id))?.progress.committedBatches, kind).toBe(1);
    expect(wire, kind).not.toHaveBeenCalled();
    expect(await db.sentLog.count(), kind).toBe(0);
    await runPersistedJob(job.id);
    expect(wire, kind).not.toHaveBeenCalled();

    await productionHandlers().resumeJob(job.id);
    await runPersistedJob(job.id);
    expect(requests).toEqual(["B3", "B4"]);
    expect((await getJob(job.id))?.status).toBe("completed");
    expect((await getJob(job.id))?.progress.committedBatches).toBe(3);
    const paused = await seedWork(kind);
    await pauseJob(paused.id);
    await resumeJobs();
    expect((await getJob(paused.id))?.status, kind).toBe("paused");
    expect(requests, kind).toEqual(["B3", "B4"]);
    }
  });

  it("same-session restart re-drives a keepalive-marked job instead of pausing it (J03)", async () => {
    const job = await seedWork("analyze_selection");
    await setJobStatus(job.id, "running", {
      progress: { totalBatches: 3, committedBatches: 1, processedCount: 1 },
    });
    // Simulate the marker a live drive wrote before the worker was evicted:
    // `chrome.storage.session` survives the restart, so it is still there.
    const sessionStore = new Map<string, unknown>();
    sessionStore.set("jobs:sessionKeepalive", [job.id]);
    vi.stubGlobal("chrome", {
      ...chrome,
      storage: {
        session: {
          get: async (key: string) => ({ [key]: sessionStore.get(key) }),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) sessionStore.set(key, value);
          },
        },
      },
    });
    const requests: string[] = [];
    installWire(async (request) => {
      requests.push((request.state as { bookmark: { title: string } }).bookmark.title);
      return providerResponse(request);
    });

    await resumeJobs();
    // The drain launches the drive fire-and-forget (it must not hold the
    // startup message barrier); wait on the coordinated owner for it.
    await coordinator.waitForJob(job.id);

    // P06's pause sweep skipped the marked row; the keepalive drain then
    // re-drove it live through the normal claim path — from committedBatches.
    expect((await getJob(job.id))?.status).toBe("completed");
    expect((await getJob(job.id))?.progress.committedBatches).toBe(3);
    expect(requests).toEqual(["B3", "B4"]);
    // The marker self-pruned once the row left pending/running.
    expect(await readSessionJobIds()).toEqual([]);
  });

  it("cold start pauses an unmarked running job even when the session area exists (P06)", async () => {
    const job = await seedWork("analyze_selection");
    await setJobStatus(job.id, "running", {
      progress: { totalBatches: 3, committedBatches: 1, processedCount: 1 },
    });
    // Session storage exists but holds no marker — a browser restart cleared
    // it, so this is a cold start and P06's pause rule still applies.
    const sessionStore = new Map<string, unknown>();
    vi.stubGlobal("chrome", {
      ...chrome,
      storage: {
        session: {
          get: async (key: string) => ({ [key]: sessionStore.get(key) }),
          set: async (items: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(items)) sessionStore.set(key, value);
          },
        },
      },
    });
    const wire = installWire(async (request) => providerResponse(request));

    await resumeJobs();

    expect((await getJob(job.id))?.status).toBe("paused");
    expect(wire).not.toHaveBeenCalled();
  });

  it("releases a failed production drive and does not automatically retry a failed batch", async () => {
    const job = await seedWork("analyze_selection");
    vi.spyOn(network, "sendConsented").mockResolvedValue(new Response("", { status: 401 }));
    await runPersistedJob(job.id);
    const failed = await getJob(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.progress.committedBatches).toBe(0);
    const again = runPersistedJob(job.id);
    await again;
    expect(await getJob(job.id)).toEqual(failed);
    const next = await seedWork("analyze_selection");
    vi.mocked(network.sendConsented).mockImplementation(async (_scope, _provider, _model, request) =>
      providerResponse(request as SystemOneRequest));
    await runPersistedJob(next.id);
    expect((await getJob(next.id))?.status).toBe("completed");
  });

  it("cold-start pause invalidates an interrupted owner's queued outbound authority", async () => {
    const job = await seedWork("analyze_selection");
    const interruptedOwner = (await claimJobOwner(job.id))!;
    await resumeJobs();
    await expect(assertJobAuthority(interruptedOwner)).rejects.toMatchObject({
      code: "illegal_transition",
    });
    expect((await getJob(job.id))?.status).toBe("paused");
  });

  it("analyze_selection and restructure release a paused failing batch before two waiting resumes retry its uncommitted offset", async () => {
    for (const kind of ["analyze_selection", "restructure"] as const) {
      await resetEnv();
      const job = await seedWork(kind, 2);
      const entered = deferred();
      const held = deferred();
      const waiting = deferred();
      const waitForJob = coordinator.waitForJob;
      let waits = 0;
      vi.spyOn(coordinator, "waitForJob").mockImplementation((id) => {
        if (++waits === 2) waiting.release();
        return waitForJob(id);
      });
      const requests: string[] = [];
      let active = 0;
      let maxActive = 0;
      vi.spyOn(network, "sendConsented").mockImplementation(async (_scope, _provider, _model, request) => {
        requests.push(((request as SystemOneRequest).state as { bookmark: { title: string } }).bookmark.title);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (requests.length === 1) {
            entered.release();
            await held.promise;
            return new Response("", { status: 401 });
          }
          return providerResponse(request as SystemOneRequest);
        } finally { active -= 1; }
      });
      const running = runPersistedJob(job.id);
      await entered.promise;
      await pauseJob(job.id);
      const handlers = productionHandlers();
      const first = handlers.resumeJob(job.id);
      const second = handlers.resumeJob(job.id);
      try {
        expect(await Promise.race([waiting.promise.then(() => "waiting"),
          Promise.all([first, second]).then(() => "settled")])).toBe("waiting");
        expect(requests).toEqual(["B1"]);
      } finally {
        held.release();
        await Promise.all([running, first, second]);
      }
      await runPersistedJob(job.id);
      expect(requests).toEqual(["B1", "B1", "B3", "B4"]);
      expect(maxActive).toBe(1);
      const finished = (await getJob(job.id))!;
      expect(finished.status).toBe("completed");
      expect(finished.progress.committedBatches).toBe(2);
      expect(finished.usage.requests).toBe(3);
    }
  });

  it("does not persist a stale restructure callback after its owner was superseded", async () => {
    const job = await seedWork("restructure");
    const entered = deferred();
    const held = deferred();
    vi.spyOn(network, "sendConsented").mockImplementation(async (_scope, _provider, _model, request) => {
      entered.release();
      await held.promise;
      return providerResponse(request as SystemOneRequest);
    });
    const running = runPersistedJob(job.id);
    await entered.promise;
    const replacement = (await claimJobOwner(job.id))!;
    held.release();
    await running;
    const row = (await getJob(job.id))!;
    expect(row.ownerGeneration).toBe(replacement.ownerGeneration);
    expect(row.status).toBe("running");
    expect(row.progress.committedBatches).toBe(0);
    // The real assigner must pass the captured owner's fence when persisting.
    expect(row.restructure?.assignments).toEqual([]);
    expect(await db.restructureAssignments.where("jobId").equals(job.id).count()).toBe(0);
    // Already-sent usage is still retained; fencing is not free billing.
    expect(await db.usage.where("jobId").equals(job.id).count()).toBe(1);
  });

  it("never re-drives a row the user paused mid-relaunch", async () => {
    await seedProvider();
    // The work set is deliberately mismatched (b2 vanished while paused):
    // without the status guard this call would enter the runner path (and
    // with the strand fix below, mark the row failed) — a pause that won
    // the race must keep the row paused.
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1", "b2"],
    });
    await pauseJob(enqueued.id);

    await runPersistedJob(enqueued.id);

    expect((await getJob(enqueued.id))?.status).toBe("paused");
  });

  it("completes a stranded running row whose whole work set was deleted (J02)", async () => {
    await seedProvider();
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1", "b2"],
    });
    await setJobStatus(enqueued.id, "running");

    // b1/b2 resolve to nothing — every remaining id is gone, so the job
    // ends terminal, never an immortal `running`.
    await runPersistedJob(enqueued.id);

    const row = await getJob(enqueued.id);
    expect(row?.status).toBe("completed");
  });

  it("completes a deleted pending work set too (the startJob race window)", async () => {
    await seedProvider();
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1", "b2"],
    });

    await runPersistedJob(enqueued.id);

    const row = await getJob(enqueued.id);
    expect(row?.status).toBe("completed");
  });

  it("an unexpected drive error marks the job failed with a redacted code (J02)", async () => {
    const job = await seedWork("analyze_selection");
    // Work-set resolution blows up — an untyped infrastructure error that
    // must never leave an immortal `running` row or leak its message.
    vi.spyOn(
      chrome.bookmarks as { getTree: () => Promise<unknown> },
      "getTree",
    ).mockRejectedValue(
      new TypeError("bookmarks backend gone: /home/secret/path"),
    );

    // The caller's typed error still propagates (the egress surface needs
    // it for its refusal) — but the ROW stores only the redacted code.
    await expect(runPersistedJob(job.id)).rejects.toThrow(TypeError);

    const row = await getJob(job.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("The job failed while analyzing a bookmark.");
    expect(row?.error).not.toContain("bookmarks backend gone");
  });

  it("skips a bookmark edited mid-scan instead of failing the job (J05)", async () => {
    const job = await seedWork("analyze_selection", 1); // one item per batch
    // Auto-apply must run for the staleness guard to refuse the write.
    await db.metadata.put({
      key: "decisions:settings",
      value: {
        autoApply: { add_tags: true, set_category: true },
      },
    });
    // b1 changes after its request is built (the sent snapshot) but before
    // the guarded apply runs — the edit lands inside the send itself.
    let edited = false;
    vi.spyOn(network, "sendConsented").mockImplementation(
      async (_scope, _provider, _model, request) => {
        const state = (request as SystemOneRequest).state as {
          bookmark?: { url?: string };
        };
        if (!edited && state.bookmark?.url?.includes("b11-one.com")) {
          edited = true;
          await (chrome.bookmarks as { update: (id: string, changes: { title: string }) => Promise<unknown> })
            .update("b1", { title: "B1 edited mid-scan" });
        }
        return providerResponse(request as SystemOneRequest);
      },
    );

    await runPersistedJob(job.id);

    const row = (await getJob(job.id))!;
    expect(row.status).toBe("completed");
    // The edited item is a per-item skip with the honest code — not a
    // job failure and never an applied write.
    expect(row.itemFailures).toEqual([
      expect.objectContaining({ item: "b1", code: "stale" }),
    ]);
    const b1Rows = (await db.decisions.toArray()).filter((d) =>
      d.bookmarkIds.includes("b1"),
    );
    expect(b1Rows.every((d) => d.status === "pending")).toBe(true);
    // b3/b4 analyzed and auto-applied undisturbed (no tagDefs seeded, so
    // each item yields exactly the set_category decision).
    expect(
      (await db.decisions.toArray()).filter((d) => d.status === "auto_applied"),
    ).toHaveLength(2);
    expect(row.progress.processedCount).toBe(3);
  });
});
