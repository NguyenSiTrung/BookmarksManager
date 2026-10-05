import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { Job, MAX_JOB_BOOKMARK_IDS } from "../../src/schemas/job";
import { planNearDuplicates } from "../../src/decisions/near-duplicate-plan";
import { UsageRecord } from "../../src/schemas/usage";
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
  reDriveStaleJobs,
  resumeJob,
  restructurePlanFor,
  setJobStatus,
  mergeRestructureAssignments,
  STALE_RUNNING_JOB_MS,
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
  await db.restructureAssignments.clear();
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

  // A07: one non-terminal job per kind — the second start is a typed
  // rejection, checked atomically inside the enqueue transaction.
  describe("one-live-job-per-kind guard", () => {
    it.each(["pending", "running", "paused"] as const)(
      "rejects a second same-kind enqueue while one is %s",
      async (status) => {
        const live = await enqueueJob({
          kind: "analyze_selection",
          bookmarkIds: ["bm-1"],
          now,
        });
        if (status === "running") await setJobStatus(live.id, "running", {}, now);
        if (status === "paused") await pauseJob(live.id, now);
        const error = await enqueueJob({
          kind: "analyze_selection",
          bookmarkIds: ["bm-2"],
          now,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(JobQueueError);
        expect((error as JobQueueError).code).toBe("job_in_progress");
        expect((error as JobQueueError).message).toContain(live.id);
        // The first row is untouched and no stray row was written.
        expect((await db.jobs.toArray()).length).toBe(1);
      },
    );

    it("allows a different kind while one is non-terminal", async () => {
      await enqueueJob({
        kind: "analyze_selection",
        bookmarkIds: ["bm-1"],
        now,
      });
      const scan = await enqueueJob({ kind: "library_scan", cursor: 0, now });
      expect(scan.status).toBe("pending");
    });

    it.each(["completed", "failed", "canceled"] as const)(
      "allows a restart once the live row is %s",
      async (terminal) => {
        const first = await enqueueJob({
          kind: "analyze_selection",
          bookmarkIds: ["bm-1"],
          now,
        });
        if (terminal === "canceled") {
          await cancelJob(first.id, now);
        } else {
          await setJobStatus(first.id, "running", {}, now);
          await setJobStatus(
            first.id,
            terminal,
            terminal === "failed" ? { error: "provider 503" } : {},
            now,
          );
        }
        const second = await enqueueJob({
          kind: "analyze_selection",
          bookmarkIds: ["bm-2"],
          now,
        });
        expect(second.status).toBe("pending");
        expect(second.id).not.toBe(first.id);
      },
    );
  });

  it("rejects a bookmark id set over the cap with invalid_input", async () => {
    const ids = Array.from(
      { length: MAX_JOB_BOOKMARK_IDS + 1 },
      (_, index) => `bm-${index}`,
    );
    const error = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ids,
      now,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobQueueError);
    expect((error as JobQueueError).code).toBe("invalid_input");
  });

  it("accepts a bookmark id set at the cap", async () => {
    const ids = Array.from(
      { length: MAX_JOB_BOOKMARK_IDS },
      (_, index) => `bm-${index}`,
    );
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ids,
      now,
    });
    expect(job.bookmarkIds?.length).toBe(MAX_JOB_BOOKMARK_IDS);
  });
});

describe("enqueueJob near-duplicate plan", () => {
  const bookmarks = [
    { id: "bm-1", title: "Rust Async Guide", url: "https://docs.rs/async" },
    {
      id: "bm-2",
      title: "Rust Async Guide",
      url: "https://docs.rs/async-old",
    },
    { id: "bm-3", title: "Tokio Tutorial", url: "https://tokio.rs/tutorial" },
    {
      id: "bm-4",
      title: "Tokio Tutorial",
      url: "https://tokio.rs/tutorial-v1",
    },
  ];

  it("persists the selected pair IDs and a pair-inclusive totalBatches", async () => {
    const plan = planNearDuplicates(bookmarks);
    const pairIds = plan.pairs.map((pair) => ({ a: pair.a.id, b: pair.b.id }));
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bookmarks.map((bookmark) => bookmark.id),
      batchSize: 2,
      nearDuplicatePlan: plan,
      now,
    });

    // The exact spec expectation: queued totals include each selected pair.
    expect(job.progress.totalBatches).toBe(
      Math.ceil(bookmarks.length / job.batchSize) +
        Math.ceil(plan.pairs.length / job.batchSize),
    );
    expect(job.nearDuplicatePlan?.pairs).toEqual(pairIds);
    expect(job.nearDuplicatePlan?.truncated).toBe(plan.truncated);
    expect(job.nearDuplicatePlan?.comparisons).toBe(plan.comparisons);
    expect(job.nearDuplicatePlan?.version).toBe(1);
    expect(job.nearDuplicatePlan?.pairLimit).toBe(500);
    expect(job.nearDuplicatePlan?.comparisonLimit).toBe(50_000);
    expect(Job.safeParse(job).success).toBe(true);
    expect(await db.jobs.get(job.id)).toEqual(job);
  });

  it("persists only pair IDs, limits, and truncation — never raw metadata", async () => {
    const plan = planNearDuplicates(bookmarks);
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bookmarks.map((bookmark) => bookmark.id),
      nearDuplicatePlan: plan,
      now,
    });

    const serialized = JSON.stringify(job.nearDuplicatePlan);
    expect(serialized).toContain("bm-1");
    // No raw titles, URLs, or notes ever land in the persisted plan.
    expect(serialized).not.toContain("Rust Async Guide");
    expect(serialized).not.toContain("docs.rs");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("notes");
  });

  it("keeps an analyze_selection free of any pair plan", async () => {
    await expect(
      enqueueJob({
        kind: "analyze_selection",
        bookmarkIds: ["bm-1"],
        nearDuplicatePlan: planNearDuplicates(bookmarks),
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("leaves a legacy job without a plan valid and bookmark-only in totalBatches", async () => {
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["bm-1", "bm-2", "bm-3"],
      batchSize: 2,
      now,
    });
    expect(job.nearDuplicatePlan).toBeUndefined();
    expect(job.progress.totalBatches).toBe(2);
    expect(Job.safeParse(job).success).toBe(true);
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

  it("keeps completed/canceled immutable but lets a fresh owner claim failed work (J01)", async () => {
    for (const status of ["completed", "canceled"] as const) {
      const job = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
      const owner = (await claimJobOwner(job.id, now))!;
      const terminal = await setJobStatus(job.id, status, {}, now);
      await commitJobProgress(job.id, { totalBatches: 1, committedBatches: 1, processedCount: 1 },
        { inputTokens: 10, outputTokens: 2, requests: 1 }, now, owner.ownerGeneration);
      await setJobStatus(job.id, "failed", { error: "late" }, now, owner.ownerGeneration);
      expect(await getJob(job.id), status).toEqual(terminal);
      expect(await claimJobOwner(job.id, now), status).toBeUndefined();
    }

    // `failed` is resumable (J01): a late owner's writes are still fenced
    // out, but a FRESH claim revives the row to `running` so the runner can
    // resume from its committed batches.
    const job = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
    const owner = (await claimJobOwner(job.id, now))!;
    const failed = await setJobStatus(job.id, "failed", { error: "boom" }, now);
    await commitJobProgress(job.id, { totalBatches: 1, committedBatches: 1, processedCount: 1 },
      { inputTokens: 10, outputTokens: 2, requests: 1 }, now, owner.ownerGeneration);
    expect(await getJob(job.id)).toEqual(failed);
    const revived = await claimJobOwner(job.id, now);
    expect(revived?.status).toBe("running");
    expect(revived?.ownerGeneration).toBe(failed.ownerGeneration + 1);
  });

  it("refuses a failed resume while another live same-kind job owns the lane (A07)", async () => {
    const failed = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
    await claimJobOwner(failed.id, now);
    await setJobStatus(failed.id, "failed", { error: "boom" }, now);
    // `failed` isn't live, so a replacement same-kind job can coexist —
    // resuming the failed row into that lane must refuse typed.
    const replacement = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-2"], now });

    await expect(resumeJob(failed.id, now)).rejects.toMatchObject({ code: "job_in_progress" });
    expect(await claimJobOwner(failed.id, now)).toBeUndefined();
    expect((await getJob(failed.id))?.status).toBe("failed");

    // Once the lane clears, the failed row resumes normally.
    await cancelJob(replacement.id, now);
    expect((await resumeJob(failed.id, now)).status).toBe("running");
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
    const stored = (await getJob(job.id))!;
    expect((await restructurePlanFor(stored))!.assignments).toEqual([]);
    await cancelJob(job.id, now);
    await mergeRestructureAssignments(job.id, rows, now, second.ownerGeneration);
    expect((await restructurePlanFor(stored))!.assignments).toEqual([]);
    expect(await db.restructureAssignments.where("jobId").equals(job.id).count()).toBe(0);
  });

  it("accepts the compatible generation-zero assignment interface on an unclaimed pending job", async () => {
    const job = await enqueueJob({ kind: "restructure", bookmarkIds: ["bm-1"], now,
      restructureProposal: { folders: [{ path: "news", description: "News." }] } });
    const rows = [{ bookmarkId: "bm-1", proposedPath: "news", confidence: 0.9 }];
    await mergeRestructureAssignments(job.id, rows, now, 0);
    const stored = (await getJob(job.id))!;
    // J13: rows land in `restructureAssignments`, not on the job row; the
    // merged plan is what status/apply reads.
    expect(stored.restructure?.assignments).toEqual([]);
    expect((await restructurePlanFor(stored))!.assignments).toEqual(rows);
  });

  it("merges committed assignments without touching the job row (J13)", async () => {
    const job = await enqueueJob({ kind: "restructure", now,
      bookmarkIds: Array.from({ length: 250 }, (_, i) => `bm-${i}`),
      restructureProposal: { folders: [{ path: "news", description: "News." }] } });
    const puts = vi.spyOn(db.jobs, "put");
    for (let i = 0; i < 250; i += 1) {
      await mergeRestructureAssignments(job.id, [
        { bookmarkId: `bm-${i}`, proposedPath: "news", confidence: 0.9 },
      ]);
    }
    // Per-item merges are constant-cost table upserts — zero job-row writes,
    // so a large library's assignment phase is O(batches), not O(N²).
    expect(puts).not.toHaveBeenCalled();
    const stored = (await getJob(job.id))!;
    expect((await restructurePlanFor(stored))!.assignments).toHaveLength(250);
    expect(await db.restructureAssignments.where("jobId").equals(job.id).count()).toBe(250);
    // Last write wins per bookmarkId — a re-sent item upserts, never dupes.
    await mergeRestructureAssignments(job.id, [
      { bookmarkId: "bm-0", proposedPath: "news", confidence: 0.5 },
    ]);
    const merged = (await restructurePlanFor(stored))!;
    expect(merged.assignments).toHaveLength(250);
    expect(merged.assignments.find((a) => a.bookmarkId === "bm-0")?.confidence).toBe(0.5);
  });

  it("merges legacy inline assignments with table rows, table wins", async () => {
    const job = await enqueueJob({ kind: "restructure", bookmarkIds: ["bm-1", "bm-2"], now,
      restructureProposal: { folders: [{ path: "news", description: "News." }] } });
    // A pre-J13 row: assignments inline on the job, no table rows.
    const stored = (await getJob(job.id))!;
    await db.jobs.update(job.id, {
      restructure: {
        ...stored.restructure!,
        assignments: [
          { bookmarkId: "bm-1", proposedPath: "news", confidence: 0.7 },
          { bookmarkId: "bm-2", proposedPath: "news", confidence: 0.8 },
        ],
      },
    });
    // Newer table writes override the shared bookmarkId.
    await db.restructureAssignments.put({
      jobId: job.id, bookmarkId: "bm-2", proposedPath: null, confidence: null,
    });
    const merged = (await restructurePlanFor((await getJob(job.id))!))!;
    expect(merged.assignments).toHaveLength(2);
    expect(merged.assignments.find((a) => a.bookmarkId === "bm-1")?.confidence).toBe(0.7);
    expect(merged.assignments.find((a) => a.bookmarkId === "bm-2")?.proposedPath).toBeNull();
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

describe("J02 stale-running watchdog", () => {
  it("re-drives running rows silent past the stale window and ignores fresh or non-running rows", async () => {
    const stale = await enqueueJob({ kind: "analyze_selection", bookmarkIds: ["bm-1"], now });
    const fresh = await enqueueJob({ kind: "library_scan", bookmarkIds: ["bm-2"], now });
    const paused = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["bm-3"],
      restructureProposal: { folders: [{ path: "news", description: "News." }] },
      now,
    });
    // Stale: a `running` row whose updatedAt is older than the window.
    await db.jobs.put({
      ...stale,
      status: "running",
      ownerGeneration: 1,
      updatedAt: new Date(Date.parse(NOW) - STALE_RUNNING_JOB_MS - 1).toISOString(),
    });
    // Fresh: running but stamped now.
    await db.jobs.put({ ...fresh, status: "running", ownerGeneration: 1, updatedAt: NOW });
    await pauseJob(paused.id, now);

    const driven: string[] = [];
    const reDriven = await reDriveStaleJobs(async (id) => { driven.push(id); }, now);

    expect(reDriven).toEqual([stale.id]);
    expect(driven).toEqual([stale.id]);
  });
});
