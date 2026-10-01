import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/database";
import { Job } from "../../src/schemas/job";
import { UsageRecord } from "../../src/schemas/usage";
import { estimateTokens } from "../../src/jev/budget";
import { estimateJobCost } from "../../src/jobs/estimate";
import {
  DEFAULT_BATCH_SIZE,
  JobQueueError,
  NEAR_DUPLICATE_CHECK,
  bookmarkChecks,
  cancelJob,
  claimJobOwner,
  commitJobProgress,
  computeTotalBatches,
  enqueueJob,
  getJob,
  jobChecks,
  jobRunsNearDuplicate,
  jobUsageRollup,
  pauseJob,
  resumeJob,
  setJobStatus,
  mergeRestructureAssignments,
} from "../../src/jobs/queue";

/**
 * Job queue (spec FR7/FR8): `enqueueJob` persists a valid, resumable `Job`
 * row; the lifecycle transitions (pause/resume/cancel) are legal and durable;
 * the cost estimate is derived purely from `estimateTokens`; and per-job
 * usage rolls up from the `usage` rows carrying that `jobId`.
 */

const NOW = "2026-09-27T10:00:00.000Z";
const now = () => NOW;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.jobs.clear();
  await db.usage.clear();
});

afterAll(() => {
  db.close();
});

describe("enqueueJob", () => {
  it("persists a pending analyze_selection job with a computed totalBatches", async () => {
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1", "bm-2", "bm-3"],
      batchSize: 2,
      now,
    });

    expect(job.status).toBe("pending");
    expect(job.kind).toBe("analyze_selection");
    expect(job.progress).toEqual({
      totalBatches: 2,
      committedBatches: 0,
      processedCount: 0,
    });
    expect(job.bookmarkIds).toEqual(["bm-1", "bm-2", "bm-3"]);
    // The resolved batch size is persisted on the row (the resume authority).
    expect(job.batchSize).toBe(2);
    expect(job.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });
    expect(job.createdAt).toBe(NOW);
    expect(job.updatedAt).toBe(NOW);
    // It is a valid Job row and is really persisted.
    expect(Job.safeParse(job).success).toBe(true);
    expect(await db.jobs.get(job.id)).toEqual(job);
  });

  it("persists the default batchSize when none is given", async () => {
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1", "bm-2", "bm-3"],
      now,
    });
    expect(job.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(await db.jobs.get(job.id)).toEqual(job);
  });

  it("persists a cursor-resumed library_scan job", async () => {
    const job = await enqueueJob({ kind: "library_scan", cursor: 0, now });

    expect(job.kind).toBe("library_scan");
    expect(job.cursor).toBe(0);
    expect(job.bookmarkIds).toBeUndefined();
    expect(job.progress.totalBatches).toBe(0);
    expect(Job.safeParse(job).success).toBe(true);
    expect(await db.jobs.get(job.id)).toEqual(job);
  });

  it("accepts a full-library id set for a library_scan", async () => {
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["bm-1", "bm-2"],
      batchSize: 5,
      now,
    });
    expect(job.progress.totalBatches).toBe(1);
    expect(job.kind).toBe("library_scan");
  });

  it("rejects a job with neither a bookmark id set nor a cursor", async () => {
    const error = await enqueueJob({ kind: "analyze_selection", now }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(JobQueueError);
    expect((error as JobQueueError).code).toBe("invalid_input");
  });

  it("rejects an empty bookmark id set and a non-positive batchSize", async () => {
    await expect(
      enqueueJob({ kind: "analyze_selection", bookmarkIds: [], now }),
    ).rejects.toBeInstanceOf(JobQueueError);
    await expect(
      enqueueJob({
        kind: "analyze_selection",
        bookmarkIds: ["bm-1"],
        batchSize: 0,
        now,
      }),
    ).rejects.toBeInstanceOf(JobQueueError);
  });
});

describe("lifecycle transitions", () => {
  it("defaults legacy owners to zero and claims monotonically in a transaction", async () => {
    const job = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
    const { ownerGeneration, controlRevision, ...legacy } = job;
    expect([ownerGeneration, controlRevision]).toEqual([0, 0]);
    await db.jobs.put(legacy as Job);
    expect((await getJob(job.id))?.ownerGeneration).toBe(0);
    const claims = await Promise.all([claimJobOwner(job.id, now), claimJobOwner(job.id, now)]);
    expect(claims.map((row) => row?.ownerGeneration)).toEqual([1, 2]);
    expect((await getJob(job.id))?.ownerGeneration).toBe(2);
  });

  it("rejects stale progress, completion, and failure writes without changing the newer owner", async () => {
    const job = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1", "bm-2"], batchSize: 1, now });
    const first = (await claimJobOwner(job.id, now))!;
    const second = (await claimJobOwner(job.id, now))!;
    const progress = { totalBatches: 2, committedBatches: 1, processedCount: 1 };
    const usage = { inputTokens: 10, outputTokens: 2, requests: 1 };
    await commitJobProgress(job.id, progress, usage, now, second.ownerGeneration);
    await commitJobProgress(job.id, job.progress, job.usage, now, first.ownerGeneration);
    await setJobStatus(job.id, "completed", {}, now, first.ownerGeneration);
    await setJobStatus(job.id, "failed", { error: "stale" }, now, first.ownerGeneration);
    expect(await getJob(job.id)).toEqual({ ...second, progress, usage });
    await commitJobProgress(job.id, job.progress, job.usage, now, second.ownerGeneration);
    expect((await getJob(job.id))?.progress).toEqual(progress);
  });

  it.each(["completed", "canceled", "failed"] as const)("keeps %s immutable against late owner writes", async (status) => {
    const job = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
    const owner = (await claimJobOwner(job.id, now))!;
    const terminal = await setJobStatus(job.id, status, {}, now);
    await commitJobProgress(job.id, { totalBatches: 1, committedBatches: 1, processedCount: 1 },
      { inputTokens: 10, outputTokens: 2, requests: 1 }, now, owner.ownerGeneration);
    await setJobStatus(job.id, "failed", { error: "late" }, now, owner.ownerGeneration);
    expect(await getJob(job.id)).toEqual(terminal);
    expect(await claimJobOwner(job.id, now)).toBeUndefined();
  });

  it("commits a settled paused batch but never changes its pause intent to completion or failure", async () => {
    const job = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
    const owner = (await claimJobOwner(job.id, now))!;
    await pauseJob(job.id, now);
    await commitJobProgress(job.id, { totalBatches: 1, committedBatches: 1, processedCount: 1 }, job.usage, now, owner.ownerGeneration);
    await setJobStatus(job.id, "completed", {}, now, owner.ownerGeneration);
    await setJobStatus(job.id, "failed", { error: "late" }, now, owner.ownerGeneration);
    expect((await getJob(job.id))?.status).toBe("paused");
    expect((await getJob(job.id))?.progress.committedBatches).toBe(1);
    expect(await claimJobOwner(job.id, now)).toBeUndefined();
  });

  it("does not merge stale or canceled restructure assignments", async () => {
    const job = await enqueueJob({ kind: "restructure", bookmarkIds: ["bm-1"], now,
      restructureProposal: { folders: [{ path: "news", description: "News." }] } });
    const first = (await claimJobOwner(job.id, now))!;
    const second = (await claimJobOwner(job.id, now))!;
    const rows = [{ bookmarkId: "bm-1", proposedPath: "news", confidence: 0.9 }];
    await mergeRestructureAssignments(job.id, rows, now, first.ownerGeneration);
    expect((await getJob(job.id))?.restructure?.assignments).toEqual([]);
    await cancelJob(job.id, now);
    await mergeRestructureAssignments(job.id, rows, now, second.ownerGeneration);
    expect((await getJob(job.id))?.restructure?.assignments).toEqual([]);
  });

  it("accepts the compatible generation-zero assignment interface on an unclaimed pending job", async () => {
    const job = await enqueueJob({ kind: "restructure", bookmarkIds: ["bm-1"], now,
      restructureProposal: { folders: [{ path: "news", description: "News." }] } });
    const rows = [{ bookmarkId: "bm-1", proposedPath: "news", confidence: 0.9 }];
    await mergeRestructureAssignments(job.id, rows, now, 0);
    expect((await getJob(job.id))?.restructure?.assignments).toEqual(rows);
  });

  it("pauses, resumes, and cancels a job, persisting each transition", async () => {
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      now,
    });

    const paused = await pauseJob(job.id, now);
    expect(paused.status).toBe("paused");
    expect((await getJob(job.id))?.status).toBe("paused");

    const resumed = await resumeJob(job.id, now);
    expect(resumed.status).toBe("running");
    expect((await getJob(job.id))?.status).toBe("running");

    const canceled = await cancelJob(job.id, now);
    expect(canceled.status).toBe("canceled");
    expect((await getJob(job.id))?.status).toBe("canceled");
  });

  it("rejects illegal transitions with a typed error", async () => {
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      now,
    });
    await cancelJob(job.id, now);

    const error = await resumeJob(job.id, now).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(JobQueueError);
    expect((error as JobQueueError).code).toBe("illegal_transition");
    expect((await getJob(job.id))?.status).toBe("canceled");
  });

  it("reports a typed not_found for an unknown job", async () => {
    const error = await pauseJob("missing", now).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(JobQueueError);
    expect((error as JobQueueError).code).toBe("not_found");
  });
});

describe("jobChecks", () => {
  it("maps analyze_selection to categorize + tags", () => {
    expect(jobChecks("analyze_selection")).toEqual(["categorize", "tags"]);
  });

  it("maps library_scan to categorize + tags + misfiled + near-duplicate", () => {
    expect(jobChecks("library_scan")).toEqual([
      "categorize",
      "tags",
      "misfiled",
      NEAR_DUPLICATE_CHECK,
    ]);
  });

  it("drops the library-wide near-duplicate marker from the per-bookmark checks", () => {
    expect(bookmarkChecks(jobChecks("library_scan"))).toEqual([
      "categorize",
      "tags",
      "misfiled",
    ]);
    expect(bookmarkChecks(jobChecks("analyze_selection"))).toEqual([
      "categorize",
      "tags",
    ]);
  });

  it("reports which kinds run the near-duplicate pair phase", () => {
    expect(jobRunsNearDuplicate("library_scan")).toBe(true);
    expect(jobRunsNearDuplicate("analyze_selection")).toBe(false);
  });
});

describe("computeTotalBatches", () => {
  it("rounds up", () => {
    expect(computeTotalBatches(0, 5)).toBe(0);
    expect(computeTotalBatches(1, 5)).toBe(1);
    expect(computeTotalBatches(5, 5)).toBe(1);
    expect(computeTotalBatches(6, 5)).toBe(2);
  });
});

describe("estimateJobCost", () => {
  it("derives the estimate purely from estimateTokens over the batch payload", () => {
    const bookmark = { title: "t", url: "https://x.co" };
    const estimate = estimateJobCost({ bookmarks: [bookmark], batchSize: 1 });

    // One bookmark, one batch — the payload is the minimized bookmark array.
    const payload = [{ title: bookmark.title, url: bookmark.url }];
    expect(estimate.totalBatches).toBe(1);
    expect(estimate.batches).toHaveLength(1);
    expect(estimate.batches[0]?.inputTokens).toBe(estimateTokens(payload));
    expect(estimate.inputTokens).toBe(estimateTokens(payload));
    // Exact derived value for this known input (see the assertion above).
    expect(estimate.inputTokens).toBe(12);
  });

  it("sums per-batch estimates across batches", () => {
    const bookmarks = [
      { title: "a", url: "https://a.example" },
      { title: "b", url: "https://b.example" },
      { title: "c", url: "https://c.example" },
    ];
    const estimate = estimateJobCost({ bookmarks, batchSize: 2 });
    expect(estimate.totalBatches).toBe(2);
    expect(estimate.batches.map((batch) => batch.batchIndex)).toEqual([0, 1]);
    const expected =
      estimateTokens([bookmarks[0], bookmarks[1]]) +
      estimateTokens([bookmarks[2]]);
    expect(estimate.inputTokens).toBe(expected);
  });

  it("returns an empty estimate for no bookmarks", () => {
    const estimate = estimateJobCost({ bookmarks: [] });
    expect(estimate).toEqual({ totalBatches: 0, inputTokens: 0, batches: [] });
  });
});

describe("jobUsageRollup", () => {
  it("sums the usage rows carrying the jobId and counts requests", async () => {
    const jobId = crypto.randomUUID();
    await db.usage.bulkAdd([
      UsageRecord.parse({
        jobId,
        model: "jev-1",
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.5,
        recordedAt: NOW,
      }),
      UsageRecord.parse({
        jobId,
        model: "jev-1",
        inputTokens: 50,
        outputTokens: 5,
        recordedAt: NOW,
      }),
      // A standalone request for another job — never counted here.
      UsageRecord.parse({
        model: "jev-1",
        inputTokens: 999,
        outputTokens: 0,
        recordedAt: NOW,
      }),
    ]);

    expect(await jobUsageRollup(jobId)).toEqual({
      inputTokens: 150,
      outputTokens: 15,
      costUsd: 0.5,
      requests: 2,
    });
  });

  it("omits costUsd when no response reported a cost", async () => {
    const jobId = crypto.randomUUID();
    await db.usage.bulkAdd([
      UsageRecord.parse({
        jobId,
        model: "jev-1",
        inputTokens: 10,
        outputTokens: 1,
        recordedAt: NOW,
      }),
      UsageRecord.parse({
        jobId,
        model: "jev-1",
        inputTokens: 20,
        outputTokens: 2,
        recordedAt: NOW,
      }),
    ]);

    const usage = await jobUsageRollup(jobId);
    expect(usage).toEqual({ inputTokens: 30, outputTokens: 3, requests: 2 });
    expect(usage.costUsd).toBeUndefined();
  });

  it("returns zeroed totals for a job with no usage rows", async () => {
    expect(await jobUsageRollup(crypto.randomUUID())).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
    });
  });
});
