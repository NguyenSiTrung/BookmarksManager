import "fake-indexeddb/auto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { productionHandlers, runPersistedJob } from "../../src/entrypoints/background";
import { grantConsent } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { enqueueJob, getJob, pauseJob, setJobStatus } from "../../src/jobs/queue";
import { handleDecisionsMessage } from "../../src/messages/decisions";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

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

beforeEach(async () => {
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
});

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

  it("marks a stranded running row failed on a work-set mismatch", async () => {
    await seedProvider();
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1", "b2"],
    });
    await setJobStatus(enqueued.id, "running");

    await runPersistedJob(enqueued.id);

    const row = await getJob(enqueued.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(
      "The supplied bookmarks do not match the job's persisted bookmarkIds.",
    );
  });

  it("fails a mismatched pending row visibly too (the startJob race window)", async () => {
    await seedProvider();
    const enqueued = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["b1", "b2"],
    });

    await runPersistedJob(enqueued.id);

    const row = await getJob(enqueued.id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(
      "The supplied bookmarks do not match the job's persisted bookmarkIds.",
    );
  });
});
