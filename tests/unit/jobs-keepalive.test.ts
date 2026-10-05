import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { enqueueJob, pauseInterruptedJobs, setJobStatus } from "../../src/jobs/queue";
import {
  drainSessionJobs,
  KEEPALIVE_ALARM_NAME,
  markSessionJob,
  readSessionJobIds,
  unmarkSessionJob,
} from "../../src/jobs/keepalive";
import { MAX_IN_WORKER_SLEEP_MS, sleepCapped } from "../../src/jev/retry";

/**
 * J03 keepalive (spec J03 + P06): a job started in THIS browser session is
 * marked in `chrome.storage.session` and re-driven after worker eviction —
 * by the periodic `chrome.alarms` tick and once eagerly at worker start —
 * while a cold start (empty session area) still pauses interrupted rows
 * for explicit Resume.
 */

const NOW = "2026-10-05T10:00:00.000Z";
const now = () => NOW;

/** In-memory `chrome.storage.session` + `chrome.alarms` fakes. */
function installChromeFakes() {
  const sessionStore = new Map<string, unknown>();
  const alarms = {
    created: [] as { name: string; periodInMinutes?: number }[],
    cleared: [] as string[],
    create(name: string, info: { periodInMinutes?: number }) {
      this.created.push({ name, periodInMinutes: info.periodInMinutes });
      return Promise.resolve();
    },
    clear(name: string) {
      this.cleared.push(name);
      return Promise.resolve(true);
    },
  };
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        async get(key: string) {
          return { [key]: sessionStore.get(key) };
        },
        async set(items: Record<string, unknown>) {
          for (const [key, value] of Object.entries(items)) {
            sessionStore.set(key, value);
          }
        },
      },
    },
    alarms,
  });
  return { sessionStore, alarms };
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.jobs.clear();
});

afterAll(() => {
  db.close();
});

describe("session job markers", () => {
  it("mark → read → unmark round-trips and arms/clears the alarm", async () => {
    const { alarms } = installChromeFakes();
    await markSessionJob("job-1");
    expect(await readSessionJobIds()).toEqual(["job-1"]);
    expect(alarms.created).toEqual([
      { name: KEEPALIVE_ALARM_NAME, periodInMinutes: 0.5 },
    ]);
    await markSessionJob("job-1"); // idempotent — no duplicate
    await markSessionJob("job-2");
    expect(await readSessionJobIds()).toEqual(["job-1", "job-2"]);
    await unmarkSessionJob("job-1");
    expect(alarms.cleared).toEqual([]); // still one marker — alarm stays
    await unmarkSessionJob("job-2");
    expect(await readSessionJobIds()).toEqual([]);
    expect(alarms.cleared).toEqual([KEEPALIVE_ALARM_NAME]);
  });

  it("degrades to an empty marker set when storage is missing or corrupt", async () => {
    vi.stubGlobal("chrome", {}); // no storage at all
    expect(await readSessionJobIds()).toEqual([]);
    await markSessionJob("job-1"); // no-op, no throw
    expect(await readSessionJobIds()).toEqual([]);

    const { sessionStore } = installChromeFakes();
    sessionStore.set("jobs:sessionKeepalive", { not: "an array" });
    expect(await readSessionJobIds()).toEqual([]);
    sessionStore.set("jobs:sessionKeepalive", ["job-1", 42, "job-2"]);
    expect(await readSessionJobIds()).toEqual(["job-1", "job-2"]);
  });
});

describe("drainSessionJobs", () => {
  it("relaunches marked pending/running jobs and prunes settled markers", async () => {
    installChromeFakes();
    // A07's one-live-job-per-kind rule means each concurrent live row needs
    // its own kind; terminal rows don't hold a lane, so the completed one is
    // settled before the next same-kind enqueue.
    const completed = await enqueueJob({
      kind: "analyze_selection", bookmarkIds: ["b7"], batchSize: 2, now,
    });
    await setJobStatus(completed.id, "running", undefined, now);
    await setJobStatus(completed.id, "completed", undefined, now);
    const pending = await enqueueJob({
      kind: "analyze_selection", bookmarkIds: ["b1", "b2"], batchSize: 2, now,
    });
    const running = await enqueueJob({
      kind: "library_scan", bookmarkIds: ["b3", "b4"], batchSize: 2, now,
    });
    await setJobStatus(running.id, "running", undefined, now);
    const paused = await enqueueJob({
      kind: "restructure", bookmarkIds: ["b5", "b6"], batchSize: 2, now,
      restructureProposal: { folders: [{ path: "news", description: "News." }] },
    });
    await setJobStatus(paused.id, "paused", undefined, now);
    for (const job of [pending, running, paused, completed]) {
      await markSessionJob(job.id);
    }
    await markSessionJob("deleted-job-id");

    const relaunched: string[] = [];
    await drainSessionJobs(async (id) => {
      relaunched.push(id);
    });

    expect(relaunched.sort()).toEqual([pending.id, running.id].sort());
    // Paused stays user-held, completed/deleted markers are pruned.
    expect((await readSessionJobIds()).sort()).toEqual(
      [pending.id, running.id].sort(),
    );
  });

  it("keeps the marker when a relaunch throws", async () => {
    installChromeFakes();
    const job = await enqueueJob({
      kind: "analyze_selection", bookmarkIds: ["b1"], batchSize: 1, now,
    });
    await markSessionJob(job.id);
    await drainSessionJobs(async () => {
      throw new Error("drive exploded");
    });
    expect(await readSessionJobIds()).toEqual([job.id]);
  });
});

describe("pauseInterruptedJobs exclusion", () => {
  it("skips keepalive-marked rows and pauses the rest", async () => {
    const marked = await enqueueJob({
      kind: "analyze_selection", bookmarkIds: ["b1"], batchSize: 1, now,
    });
    await setJobStatus(marked.id, "running", undefined, now);
    const unmarked = await enqueueJob({
      kind: "library_scan", bookmarkIds: ["b2"], batchSize: 1, now,
    });
    await setJobStatus(unmarked.id, "running", undefined, now);

    await pauseInterruptedJobs(now, new Set([marked.id]));
    expect((await db.jobs.get(marked.id))?.status).toBe("running");
    expect((await db.jobs.get(unmarked.id))?.status).toBe("paused");
  });
});

describe("sleepCapped", () => {
  it("splits a long wait into sub-idle-limit chunks", async () => {
    const waits: number[] = [];
    await sleepCapped(37_000, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([15_000, 15_000, 7_000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(MAX_IN_WORKER_SLEEP_MS);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(37_000);
    const short: number[] = [];
    await sleepCapped(2_000, async (ms) => {
      short.push(ms);
    });
    expect(short).toEqual([2_000]);
  });
});
