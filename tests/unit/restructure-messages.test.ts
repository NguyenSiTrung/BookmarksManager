import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { handleRestructureMessage } from "../../src/messages/restructure";
import type { RestructureDeps } from "../../src/messages/restructure";
import { enqueueJob } from "../../src/jobs/queue";
import type { RestructureProposal } from "../../src/schemas/restructure";

/**
 * `handleRestructureMessage` (spec FR8): the sidepanel-facing protocol —
 * START (propose→enqueue→fire the runner), STATUS, PAUSE/RESUME/CANCEL,
 * CONFIRM (guarded apply), UNDO. Every reply resolves to
 * `RestructureMessageResult`; untrusted senders and malformed payloads are
 * refused at the boundary.
 */

const SENDER = { url: "chrome-extension://test-id/sidepanel.html" };
const NOW = "2026-09-28T00:00:00.000Z";
const now = () => NOW;

const PROPOSAL: RestructureProposal = {
  folders: [{ path: "dev", description: "" }],
};

let runJobCalls: string[];
const deps: RestructureDeps = {
  runJob: (jobId) => {
    runJobCalls.push(jobId);
    return Promise.resolve();
  },
};

beforeEach(async () => {
  const api = installBookmarksFake({
    bookmarksBar: [
      { id: "10", title: "Old", children: [
        { id: "11", title: "A", url: "https://a.io/" },
      ]},
    ],
  });
  // The protocol's sender check needs runtime.getURL — the bookmarks fake
  // installs only `chrome.bookmarks`, so extend the stub.
  vi.stubGlobal("chrome", {
    ...api,
    bookmarks: api,
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      sendMessage: vi.fn(),
    },
  });
  runJobCalls = [];
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => db.close());

describe("handleRestructureMessage boundary", () => {
  it("returns undefined for messages outside the protocol", async () => {
    expect(
      await handleRestructureMessage({ type: "OTHER" }, SENDER, deps),
    ).toBeUndefined();
    expect(await handleRestructureMessage("nope", SENDER, deps)).toBeUndefined();
  });

  it("refuses untrusted senders and malformed payloads", async () => {
    const bad = await handleRestructureMessage(
      { type: "RESTRUCTURE_UNDO" },
      { url: "https://evil.example/" },
      deps,
    );
    expect(bad).toMatchObject({ ok: false, code: "untrusted_sender" });
    const malformed = await handleRestructureMessage(
      { type: "RESTRUCTURE_PAUSE" },
      SENDER,
      deps,
    );
    expect(malformed).toMatchObject({ ok: false, code: "malformed_message" });
  });
});

describe("RESTRUCTURE_STATUS", () => {
  it("reports not_found when no restructure job exists", async () => {
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "not_found" });
  });

  it("returns the latest restructure job's state", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "job_state" });
  });

  it("attaches the live diff once the job completes", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const { setJobStatus, mergeRestructureAssignments } = await import(
      "../../src/jobs/queue"
    );
    await setJobStatus(job.id, "running", {}, now);
    await mergeRestructureAssignments(job.id, [
      { bookmarkId: "11", proposedPath: "dev", confidence: 0.9 },
    ]);
    await setJobStatus(job.id, "completed", {}, now);
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_STATUS", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "job_state" });
    const result = (reply as { result: { diff?: { resolved: number } } })
      .result;
    expect(result.diff?.resolved).toBe(1);
  });
});

describe("RESTRUCTURE_PAUSE/RESUME/CANCEL", () => {
  it("pauses, resumes (re-driving the runner), and cancels", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const { setJobStatus } = await import("../../src/jobs/queue");
    await setJobStatus(job.id, "running", {}, now);

    const paused = await handleRestructureMessage(
      { type: "RESTRUCTURE_PAUSE", jobId: job.id },
      SENDER,
      deps,
    );
    expect(paused).toMatchObject({ ok: true });
    expect((paused as { job: { status: string } }).job.status).toBe("paused");

    const resumed = await handleRestructureMessage(
      { type: "RESTRUCTURE_RESUME", jobId: job.id },
      SENDER,
      deps,
    );
    expect(resumed).toMatchObject({ ok: true });
    expect(runJobCalls).toEqual([job.id]);

    const canceled = await handleRestructureMessage(
      { type: "RESTRUCTURE_CANCEL", jobId: job.id },
      SENDER,
      deps,
    );
    expect((canceled as { job: { status: string } }).job.status).toBe(
      "canceled",
    );
  });
});

describe("RESTRUCTURE_CONFIRM", () => {
  it("applies a completed job's plan as one batch", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const { setJobStatus, mergeRestructureAssignments } = await import(
      "../../src/jobs/queue"
    );
    await setJobStatus(job.id, "running", {}, now);
    await mergeRestructureAssignments(job.id, [
      { bookmarkId: "11", proposedPath: "dev", confidence: 0.9 },
    ]);
    await setJobStatus(job.id, "completed", {}, now);

    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_CONFIRM", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: true, code: "applied", moved: 1 });
    const bar = await chrome.bookmarks.getSubTree("1");
    const dev = bar[0]!.children!.find((c) => c.title === "dev");
    expect(dev).toBeDefined();
    expect(dev!.children!.map((c) => c.id)).toEqual(["11"]);
  });

  it("refuses a still-running job (never applies early)", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_CONFIRM", jobId: job.id },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "not_ready" });
  });
});

describe("RESTRUCTURE_UNDO", () => {
  it("reports empty when nothing was applied", async () => {
    const reply = await handleRestructureMessage(
      { type: "RESTRUCTURE_UNDO" },
      SENDER,
      deps,
    );
    expect(reply).toMatchObject({ ok: false, code: "empty" });
  });
});
