import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../../src/db/database";
import { estimateJobCost } from "../../src/jobs/estimate";
import {
  cancelJob,
  enqueueJob,
  pauseJob,
  resumeJob,
  setJobStatus,
} from "../../src/jobs/queue";
import { ScanPanel } from "../../src/entrypoints/sidepanel/ScanPanel";
import type { ScanBookmark } from "../../src/entrypoints/sidepanel/ScanPanel";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import { Job } from "../../src/schemas/job";
import type { Job as JobDocument, JobKind } from "../../src/schemas/job";

/**
 * Phase 4 Task 4 — the library-scan launcher (spec FR10/FR7).
 *
 * Layers under test:
 *  - `ScanPanel`  the pre-start cost/token estimate (from `estimateJobCost`,
 *                 a pure lower bound over the minimized `{title, url}` rows),
 *                 a distinct Start action sending `JOB_START`
 *                 (`kind:"library_scan"` + the id set), the live status card
 *                 (progress, running token/cost totals, Pause/Resume/Cancel),
 *                 terminal states with a reset, and `{ok:false}` messages
 *                 rendered verbatim.
 *  - Dexie        the `jobs` row is the source of truth: `useLiveQuery`
 *                 streams it, so a seeded `running`/`paused` row renders on a
 *                 FRESH mount (the reopened-panel case) with no local state.
 *
 * The worker is a stub: `chrome.runtime.sendMessage` answers canned
 * `DecisionMessageResult` payloads and, for job intents, performs the REAL
 * queue transitions (`enqueueJob` + `setJobStatus`/`pauseJob`/`resumeJob`/
 * `cancelJob`) so the panel's `useLiveQuery` refires — exactly what the real
 * worker's side effects look like from the panel. Job rows are seeded into
 * `db.jobs` directly.
 */

/** Fixed uuid for seeded rows (the Job schema requires uuid ids). */
const JOB_ID = "1e6df9b2-8a1c-4b7e-9d3f-3c2b1a0d5e4f";

/** 12 minimized rows → 3 batches at the default batch size of 5. */
const SCAN_BOOKMARKS: readonly ScanBookmark[] = Array.from(
  { length: 12 },
  (_, index) => ({
    id: `bm-${index + 1}`,
    title: `Bookmark ${index + 1}`,
    url: `https://example.com/page-${index + 1}`,
  }),
);
const SCAN_IDS = SCAN_BOOKMARKS.map((bookmark) => bookmark.id);

/** The estimate the launcher must show — computed by the same pure module. */
const ESTIMATE = estimateJobCost({ bookmarks: SCAN_BOOKMARKS });

/** Pinned locale so comma grouping is deterministic in every environment. */
const FORMAT = new Intl.NumberFormat("en-US");

/**
 * A valid `library_scan` job row. Defaults are a mid-run scan: 2 of 4 batches
 * committed (10 bookmarks processed) and a usage roll-up that reports a cost.
 */
function seedJob(over: Partial<JobDocument>): JobDocument {
  return Job.parse({
    id: JOB_ID,
    kind: "library_scan",
    status: "running",
    progress: { totalBatches: 4, committedBatches: 2, processedCount: 10 },
    batchSize: 5,
    bookmarkIds: [...SCAN_IDS],
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0123,
      requests: 2,
    },
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:02:00.000Z",
    ...over,
  });
}

/** Seed one job row and return the parsed document that was persisted. */
async function seed(over: Partial<JobDocument> = {}): Promise<JobDocument> {
  const job = seedJob(over);
  await db.jobs.put(job);
  return job;
}

/**
 * The canned worker. Job intents perform the real queue writes (the same
 * bookkeeping the worker's runner performs) so the panel observes them
 * through the Dexie live query; a started job is flipped `pending → running`
 * the way the runner does before its first batch. Anything unhandled answers
 * a protocol-shaped `{ok:false}`.
 */
async function defaultWorker(raw: unknown): Promise<DecisionMessageResult> {
  const message = raw as {
    type?: string;
    kind?: JobKind;
    bookmarkIds?: string[];
    jobId?: string;
  };
  switch (message.type) {
    case "JOB_START": {
      const enqueued = await enqueueJob({
        kind: message.kind === "analyze_selection" ? "analyze_selection" : "library_scan",
        bookmarkIds: message.bookmarkIds ?? [],
      });
      const job = await setJobStatus(enqueued.id, "running");
      return { ok: true, code: "job_ok", job };
    }
    case "JOB_PAUSE":
      return {
        ok: true,
        code: "job_ok",
        job: await pauseJob(message.jobId ?? ""),
      };
    case "JOB_RESUME":
      return {
        ok: true,
        code: "job_ok",
        job: await resumeJob(message.jobId ?? ""),
      };
    case "JOB_CANCEL":
      return {
        ok: true,
        code: "job_ok",
        job: await cancelJob(message.jobId ?? ""),
      };
    default:
      return {
        ok: false,
        code: "internal_error",
        message: "unhandled intent",
      };
  }
}

const sendMessage = vi.fn(defaultWorker);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.open();
  await db.jobs.clear();
  await db.usage.clear();
  sendMessage.mockClear();
  sendMessage.mockImplementation(defaultWorker);
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) =>
        `chrome-extension://test-extension-id/${path}`,
      sendMessage,
    },
  });
});

// ---------------------------------------------------------------------------
// Launcher — estimate before start, Start intent
// ---------------------------------------------------------------------------

describe("ScanPanel launcher", () => {
  it("shows the bookmark count and the estimateJobCost lower bound before start", async () => {
    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);

    const section = screen.getByRole("region", { name: "Library scan" });
    expect(section.textContent).toContain("12 bookmarks");
    // The estimate comes from the same pure module, formatted en-US.
    expect(section.textContent).toContain(
      `at least ~${FORMAT.format(ESTIMATE.inputTokens)} tokens`,
    );
    expect(section.textContent).toContain("across 3 batches");
    expect(ESTIMATE.totalBatches).toBe(3);
    // No live status card before anything starts.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Start sends JOB_START with the library_scan kind and the id set", async () => {
    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);

    fireEvent.click(screen.getByRole("button", { name: "Start scan" }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "JOB_START",
        kind: "library_scan",
        bookmarkIds: SCAN_IDS,
      });
    });
    // The worker's row lands in Dexie → the live status card appears. The
    // double enqueues `pending` then flips to `running` (the runner's own
    // order), so the card may briefly show "Queued" before Running.
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status.textContent).toMatch(/running/i),
    );
    expect(status.textContent).toContain("0 / 3");
  });

  it("disables Start and explains when there is nothing to scan", async () => {
    render(<ScanPanel bookmarks={[]} />);

    const start = screen.getByRole("button", {
      name: "Start scan",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByRole("region", { name: "Library scan" }).textContent)
      .toMatch(/empty/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("renders the worker's {ok:false} message verbatim and stays on the launcher", async () => {
    sendMessage.mockImplementation(async () => ({
      ok: false,
      code: "no_consent",
      message: "Consent has not been granted for decisions.",
    }));

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    fireEvent.click(screen.getByRole("button", { name: "Start scan" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Consent has not been granted for decisions.",
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Start scan" })).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Live status — running/paused rows, progress, running cost, controls
// ---------------------------------------------------------------------------

describe("ScanPanel live status", () => {
  it("renders a running row straight from Dexie: progress, tokens, cost, requests", async () => {
    // Seeding BEFORE the first mount is the reopened-panel case: no local
    // state survives, the row itself must drive the render.
    await seed();

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/running/i);

    // Progress carries an accessible value (native progressbar).
    const bar = screen.getByRole("progressbar", { name: "Scan progress" });
    expect(bar.getAttribute("max")).toBe("4");
    expect(bar.getAttribute("value")).toBe("2");
    expect(status.textContent).toContain("2 / 4");
    expect(status.textContent).toContain("10 bookmarks processed");

    // Running cost from the job's usage roll-up: summed tokens and requests,
    // the USD figure only because this row reported one.
    expect(status.textContent).toContain("1,200");
    expect(status.textContent).toContain("340");
    expect(status.textContent).toContain("2 requests");
    expect(status.textContent).toContain("$0.0123");
  });

  it("Pause sends JOB_PAUSE for the live row and the card flips to paused", async () => {
    await seed();

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "JOB_PAUSE",
        jobId: JOB_ID,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/paused/i),
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("a paused row reopens paused and Resume sends JOB_RESUME", async () => {
    await seed({ status: "paused" });

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/paused/i);
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "JOB_RESUME",
        jobId: JOB_ID,
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/running/i),
    );
  });

  it("Cancel sends JOB_CANCEL and the canceled terminal card offers a reset", async () => {
    await seed();

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "JOB_CANCEL",
        jobId: JOB_ID,
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/canceled/i),
    );

    // Reset returns to the launcher (estimate + a fresh Start).
    fireEvent.click(screen.getByRole("button", { name: "New scan" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Start scan" }),
    ).toBeTruthy();
  });

  it("omits the dollar figure when the job's usage reported no cost", async () => {
    await seed({
      usage: { inputTokens: 500, outputTokens: 50, requests: 1 },
    });

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("500");
    expect(status.textContent).toContain("1 request");
    expect(status.textContent).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

describe("ScanPanel terminal states", () => {
  it("a completed row shows the final state and View results routes via the callback", async () => {
    const onOpenReview = vi.fn();
    await seed({
      status: "completed",
      progress: { totalBatches: 3, committedBatches: 3, processedCount: 12 },
    });

    render(
      <ScanPanel bookmarks={SCAN_BOOKMARKS} onOpenReview={onOpenReview} />,
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/completed/i);
    expect(status.textContent).toContain("3 / 3");
    expect(status.textContent).toContain("$0.0123");

    fireEvent.click(screen.getByRole("button", { name: "View results" }));
    expect(onOpenReview).toHaveBeenCalledTimes(1);

    // Terminal cards offer the reset too.
    fireEvent.click(screen.getByRole("button", { name: "New scan" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("a failed row renders job.error verbatim and offers a reset", async () => {
    await seed({
      status: "failed",
      error: "The provider refused the request.",
    });

    render(<ScanPanel bookmarks={SCAN_BOOKMARKS} />);
    const status = await screen.findByRole("status");
    expect(status.textContent).toMatch(/failed/i);
    expect(screen.getByRole("alert").textContent).toContain(
      "The provider refused the request.",
    );
    expect(
      screen.getByRole("button", { name: "New scan" }),
    ).toBeTruthy();
  });
});
