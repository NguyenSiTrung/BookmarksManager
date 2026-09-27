import "fake-indexeddb/auto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { productionHandlers } from "../../src/entrypoints/background";
import { db } from "../../src/db/database";
import { enqueueJob, pauseJob } from "../../src/jobs/queue";
import { handleDecisionsMessage } from "../../src/messages/decisions";

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
 */

const EXTENSION_ID = "test-extension-id";
const SIDEPANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  vi.stubGlobal("chrome", {
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
});
