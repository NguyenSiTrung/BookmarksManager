import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/database";
import { DecisionPipelineError } from "../../src/decisions/pipeline";
import { LlmGateError } from "../../src/net/llm-send";
import type { AnalysisBookmark } from "../../src/decisions/pipeline";
import { UsageRecord } from "../../src/schemas/usage";
import type { AnalyzeBookmarkResult } from "../../src/decisions/pipeline";
import {
  JobRunner,
  JobRunnerError,
  createDuplicateScanner,
  createPipelineAnalyzer,
  type JobAnalyzeFn,
  type JobScanDuplicatesFn,
} from "../../src/jobs/runner";
import { cancelJob, claimJobOwner, enqueueJob, getJob, pauseJob, resumeJob, setJobStatus } from "../../src/jobs/queue";
import type { NearDuplicatePair, NearDuplicateSide } from "../../src/decisions/candidates";
import type { NearDuplicatePlan } from "../../src/decisions/near-duplicate-plan";
import { planNearDuplicates } from "../../src/decisions/near-duplicate-plan";
import { flattenTree } from "../../src/sync/tree";

/**
 * Job runner (spec FR7): a persisted, resumable batch job is processed one
 * batch at a time; each batch's results are committed durably before the
 * progress counter advances, so a fresh runner resumes from the last
 * committed batch without re-sending it. Pause/cancel stop at a batch
 * boundary; a failure marks the job `failed` with a redacted error.
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
  await db.decisions.clear();
});

afterAll(() => {
  db.close();
});

function bookmarks(count: number): AnalysisBookmark[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `bm-${index}`,
    title: `Bookmark ${index}`,
    url: `https://example.com/${index}`,
    parentId: "f-dev",
  }));
}

interface AnalyzerOptions {
  readonly inputTokens?: number;
  readonly onCall?: (bookmark: AnalysisBookmark) => Promise<void> | void;
}

/**
 * A stand-in for `analyzeBookmark` that persists one `usage` row per call
 * (without a `jobId` — the runner attaches it) and records the call order.
 */
function makeAnalyzer(options: AnalyzerOptions = {}): {
  analyze: JobAnalyzeFn;
  calls: string[];
} {
  const calls: string[] = [];
  const analyze: JobAnalyzeFn = async ({ bookmark }): Promise<AnalyzeBookmarkResult> => {
    calls.push(bookmark.id);
    await options.onCall?.(bookmark);
    const record = UsageRecord.parse({
      model: "jev-1",
      inputTokens: options.inputTokens ?? 10,
      outputTokens: 2,
      recordedAt: NOW,
    });
    const id = await db.usage.add(record);
    return { sent: true, model: "jev-1", decisions: [], usage: { ...record, id } };
  };
  return { analyze, calls };
}

async function runningJob(ids: readonly string[], batchSize = 2) {
  const job = await enqueueJob({
    kind: "analyze_selection",
    bookmarkIds: ids,
    batchSize,
    now,
  });
  return job;
}

describe("JobRunner.run", () => {
  it("stops a superseded owner after a held analysis resolves or rejects", async () => {
    for (const settlement of ["resolve", "reject"] as const) {
      const job = await runningJob(["bm-0", "bm-1"], 1);
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const analyzer = makeAnalyzer({ onCall: async () => {
        entered();
        await held;
        if (settlement === "reject") throw new Error("stale failure");
      } });
      const running = new JobRunner({ analyze: analyzer.analyze, now }).run(job.id, { bookmarks: bookmarks(2) });
      await started;
      const replacement = await claimJobOwner(job.id, now);
      release();
      await running;
      expect(analyzer.calls, settlement).toEqual(["bm-0"]);
      expect(await db.jobs.get(job.id), settlement).toEqual(replacement);
      // A07: the next iteration's enqueue needs this row terminal.
      await cancelJob(job.id, now);
    }
  });

  it("does not restart a paused row merely because a runner was scheduled before the pause", async () => {
    const job = await runningJob(["bm-0"], 1);
    await pauseJob(job.id, now);
    const analyzer = makeAnalyzer();
    const result = await new JobRunner({ analyze: analyzer.analyze, now }).run(job.id, { bookmarks: bookmarks(1) });
    expect(result.status).toBe("paused");
    expect(analyzer.calls).toEqual([]);
  });
  it("processes in batches and commits progress only after each batch is written", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3", "bm-4"];
    const job = await runningJob(ids, 2);
    const progressAtCall: number[] = [];
    const { analyze, calls } = makeAnalyzer({
      onCall: async () => {
        const current = await db.jobs.get(job.id);
        progressAtCall.push(current?.progress.committedBatches ?? -1);
      },
    });

    const finished = await new JobRunner({ analyze, now }).run(job.id, {
      bookmarks: bookmarks(5),
      batchSize: 2,
    });

    expect(calls).toEqual(ids);
    // Committed batches are visible to the NEXT batch, never the current one.
    expect(progressAtCall).toEqual([0, 0, 1, 1, 2]);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toEqual({
      totalBatches: 3,
      committedBatches: 3,
      processedCount: 5,
    });
    expect((await db.jobs.get(job.id))?.progress.committedBatches).toBe(3);

    // One usage row per request, each linked to the job.
    const usageRows = await db.usage.toArray();
    expect(usageRows).toHaveLength(5);
    expect(usageRows.every((row) => row.jobId === job.id)).toBe(true);
    expect(finished.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      requests: 5,
    });
  });

  it("resumes from the last committed batch without re-sending it", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3", "bm-4", "bm-5"];
    const job = await runningJob(ids, 2);

    // First run: pause once the second batch's writes have landed.
    const first = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-3") await pauseJob(job.id, now);
      },
    });
    const stopped = await new JobRunner({ analyze: first.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(6), batchSize: 2 },
    );

    expect(stopped.status).toBe("paused");
    expect(stopped.progress.committedBatches).toBe(2);
    expect(first.calls).toEqual(["bm-0", "bm-1", "bm-2", "bm-3"]);

    // Fresh runner over the same db state resumes from batch 2.
    const second = makeAnalyzer();
    await resumeJob(job.id, now);
    const finished = await new JobRunner({ analyze: second.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(6), batchSize: 2 },
    );

    // Already-committed batches are never re-sent.
    expect(second.calls).toEqual(["bm-4", "bm-5"]);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toEqual({
      totalBatches: 3,
      committedBatches: 3,
      processedCount: 6,
    });
    expect(await db.usage.count()).toBe(6);
  });

  it("rejects a resume whose batchSize differs, without skipping unprocessed work", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3", "bm-4", "bm-5"];
    // Enqueued at batchSize 2 → 3 batches: [0,1] [2,3] [4,5].
    const job = await runningJob(ids, 2);

    // Commit the first two batches, then pause at the batch boundary.
    const first = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-3") await pauseJob(job.id, now);
      },
    });
    const stopped = await new JobRunner({ analyze: first.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(6), batchSize: 2 },
    );
    expect(stopped.status).toBe("paused");
    expect(stopped.progress.committedBatches).toBe(2);
    expect(first.calls).toEqual(["bm-0", "bm-1", "bm-2", "bm-3"]);

    // Resume with a DIFFERENT batchSize (3). It must not silently re-slice,
    // which would mark the job completed while skipping bm-4/bm-5.
    const second = makeAnalyzer();
    await resumeJob(job.id, now);
    const error = await new JobRunner({ analyze: second.analyze, now })
      .run(job.id, { bookmarks: bookmarks(6), batchSize: 3 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobRunnerError);
    expect((error as JobRunnerError).code).toBe("invalid_input");
    // No work was sent, and the job was neither completed nor advanced.
    expect(second.calls).toEqual([]);
    const after = await db.jobs.get(job.id);
    expect(after?.status).toBe("running");
    expect(after?.progress).toEqual({
      totalBatches: 3,
      committedBatches: 2,
      processedCount: 4,
    });
  });

  it("does not re-send a committed batch when resumed with a smaller batchSize", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3", "bm-4", "bm-5"];
    // Enqueued at batchSize 3 → 2 batches: [0,1,2] [3,4,5].
    const job = await runningJob(ids, 3);

    // Commit the first batch, then pause at the boundary.
    const first = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-2") await pauseJob(job.id, now);
      },
    });
    const stopped = await new JobRunner({ analyze: first.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(6), batchSize: 3 },
    );
    expect(stopped.status).toBe("paused");
    expect(stopped.progress.committedBatches).toBe(1);
    expect(first.calls).toEqual(["bm-0", "bm-1", "bm-2"]);

    // Resume with batchSize 2 would re-slice batch 0 as [0,1] and re-send
    // bm-2 (already committed) — reject instead.
    const second = makeAnalyzer();
    await resumeJob(job.id, now);
    const error = await new JobRunner({ analyze: second.analyze, now })
      .run(job.id, { bookmarks: bookmarks(6), batchSize: 2 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobRunnerError);
    expect((error as JobRunnerError).code).toBe("invalid_input");
    // The already-committed batch is never re-sent.
    expect(second.calls).toEqual([]);
    expect((await db.jobs.get(job.id))?.progress.committedBatches).toBe(1);
  });

  it("resumes normally when the supplied batchSize matches the persisted one", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);

    const first = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-1") await pauseJob(job.id, now);
      },
    });
    const paused = await new JobRunner({ analyze: first.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(4), batchSize: 2 },
    );
    expect(paused.status).toBe("paused");
    expect(paused.progress.committedBatches).toBe(1);

    // A fresh runner that re-asserts the SAME persisted size resumes from the
    // last committed batch.
    const second = makeAnalyzer();
    await resumeJob(job.id, now);
    const finished = await new JobRunner({ analyze: second.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(4), batchSize: 2 },
    );
    expect(second.calls).toEqual(["bm-2", "bm-3"]);
    expect(finished.status).toBe("completed");
    expect(finished.progress.committedBatches).toBe(2);
  });

  it("observes cancel before the next bookmark request and keeps terminal progress frozen", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    const { analyze, calls } = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-0") await cancelJob(job.id, now);
      },
    });

    const finished = await new JobRunner({ analyze, now }).run(job.id, {
      bookmarks: bookmarks(4),
      batchSize: 2,
    });

    expect(finished.status).toBe("canceled");
    // Cancel is terminal: no new paid work, even within this batch.
    expect(calls).toEqual(["bm-0"]);
    expect(finished.progress.committedBatches).toBe(0);
    expect((await db.jobs.get(job.id))?.status).toBe("canceled");
  });

  it("resumes a paused job and continues to completion", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    const first = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-1") await pauseJob(job.id, now);
      },
    });
    const paused = await new JobRunner({ analyze: first.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(4), batchSize: 2 },
    );
    expect(paused.status).toBe("paused");
    expect(paused.progress.committedBatches).toBe(1);

    const second = makeAnalyzer();
    await resumeJob(job.id, now);
    const finished = await new JobRunner({ analyze: second.analyze, now }).run(
      job.id,
      { bookmarks: bookmarks(4), batchSize: 2 },
    );

    expect(second.calls).toEqual(["bm-2", "bm-3"]);
    expect(finished.status).toBe("completed");
    expect(finished.progress.committedBatches).toBe(2);
  });

  it("marks the job failed with a redacted error and never leaks content", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    const SECRET = "SECRET BOOKMARK TITLE";
    const analyze: JobAnalyzeFn = async ({ bookmark }) => {
      if (bookmark.id === "bm-2") {
        throw new DecisionPipelineError(
          "provider",
          `request failed for ${SECRET} at https://secret.example`,
        );
      }
      const record = UsageRecord.parse({
        model: "jev-1",
        inputTokens: 10,
        outputTokens: 2,
        recordedAt: NOW,
      });
      const id = await db.usage.add(record);
      return { sent: true, model: "jev-1", decisions: [], usage: { ...record, id } };
    };

    const finished = await new JobRunner({ analyze, now }).run(job.id, {
      bookmarks: bookmarks(4),
      batchSize: 2,
    });

    expect(finished.status).toBe("failed");
    expect(finished.error).toBeTruthy();
    expect(finished.error).not.toContain(SECRET);
    expect(finished.error).not.toContain("secret.example");
    expect(finished.error).toContain("provider");
    // The batch that failed was not committed.
    expect(finished.progress.committedBatches).toBe(1);
    expect((await db.jobs.get(job.id))?.status).toBe("failed");
  });

  it("does not throw illegal_transition when a pause lands during a failing batch", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    const analyze: JobAnalyzeFn = async ({ bookmark }) => {
      if (bookmark.id === "bm-2") {
        // A pause lands mid-batch, then the batch throws. Marking the job
        // `failed` would be an illegal paused→failed transition.
        await pauseJob(job.id, now);
        throw new DecisionPipelineError("provider", "boom");
      }
      const record = UsageRecord.parse({
        model: "jev-1",
        inputTokens: 10,
        outputTokens: 2,
        recordedAt: NOW,
      });
      const id = await db.usage.add(record);
      return { sent: true, model: "jev-1", decisions: [], usage: { ...record, id } };
    };

    const finished = await new JobRunner({ analyze, now }).run(job.id, {
      bookmarks: bookmarks(4),
      batchSize: 2,
    });

    // The pause wins; no failure is recorded and no error escapes run().
    expect(finished.status).toBe("paused");
    expect(finished.error).toBeUndefined();
    expect(finished.progress.committedBatches).toBe(1);
    expect((await db.jobs.get(job.id))?.status).toBe("paused");
  });

  it("accumulates per-job usage across batches with mixed costs", async () => {
    const ids = ["bm-0", "bm-1", "bm-2"];
    const job = await runningJob(ids, 1);
    const analyze: JobAnalyzeFn = async ({ bookmark }) => {
      const record = UsageRecord.parse({
        model: "jev-1",
        inputTokens: bookmark.id === "bm-0" ? 100 : 10,
        outputTokens: 1,
        ...(bookmark.id === "bm-1" ? { costUsd: 0.25 } : {}),
        recordedAt: NOW,
      });
      const id = await db.usage.add(record);
      return { sent: true, model: "jev-1", decisions: [], usage: { ...record, id } };
    };

    const finished = await new JobRunner({ analyze, now }).run(job.id, {
      bookmarks: bookmarks(3),
      batchSize: 1,
    });

    expect(finished.usage).toEqual({
      inputTokens: 120,
      outputTokens: 3,
      costUsd: 0.25,
      requests: 3,
    });
  });

  it("rejects a work set that does not match the persisted bookmarkIds", async () => {
    const job = await runningJob(["bm-0", "bm-1"], 2);
    const { analyze } = makeAnalyzer();

    await expect(
      new JobRunner({ analyze, now }).run(job.id, {
        bookmarks: bookmarks(2).map((bookmark) => ({
          ...bookmark,
          id: `${bookmark.id}-other`,
        })),
        batchSize: 2,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

/**
 * The near-duplicate pair phase of a `library_scan` (spec FR7): after the
 * per-bookmark batches the runner drives the library-wide pair scan in the
 * same snapshot-then-mutate discipline, observing pause/cancel at a batch
 * boundary. An `analyze_selection` never runs the pair phase.
 */

/** Four bookmarks forming two same-domain, identical-title pairs. */
function pairBookmarks(): AnalysisBookmark[] {
  return [
    {
      id: "bm-0",
      title: "Rust Async Guide",
      url: "https://docs.rs/async",
      parentId: "f-dev",
    },
    {
      id: "bm-1",
      title: "Rust Async Guide",
      url: "https://docs.rs/async-old",
      parentId: "f-dev",
    },
    {
      id: "bm-2",
      title: "Tokio Tutorial",
      url: "https://tokio.rs/tutorial",
      parentId: "f-dev",
    },
    {
      id: "bm-3",
      title: "Tokio Tutorial",
      url: "https://tokio.rs/tutorial-v1",
      parentId: "f-dev",
    },
  ];
}

interface ScannerOptions {
  readonly onCall?: (
    pairs: readonly NearDuplicatePair[],
  ) => Promise<void> | void;
}

/**
 * A stand-in for the near-duplicate scan service: records each pair batch it
 * receives and persists one `usage` row per pair (without a `jobId` — the
 * runner attaches it), mirroring the real service's one-row-per-egress.
 */
function makeScanner(options: ScannerOptions = {}): {
  scanDuplicates: JobScanDuplicatesFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const scanDuplicates: JobScanDuplicatesFn = async ({ pairs }) => {
    calls.push(pairs.map((pair) => `${pair.a.id}|${pair.b.id}`));
    await options.onCall?.(pairs);
    const usage: UsageRecord[] = [];
    for (let index = 0; index < pairs.length; index += 1) {
      const record = UsageRecord.parse({
        model: "jev-1",
        inputTokens: 3,
        outputTokens: 1,
        recordedAt: NOW,
      });
      const id = await db.usage.add(record);
      usage.push({ ...record, id });
    }
    return { sent: true, pairs: pairs.length, skipped: 0, results: [], usage };
  };
  return { scanDuplicates, calls };
}

function pairSide(id: string): NearDuplicateSide {
  return { id, title: `t-${id}`, url: `https://ex.com/${id}`, domain: "ex.com" };
}

describe("JobRunner library_scan pair phase", () => {
  it("runs the per-bookmark phase and then the near-duplicate pair phase", async () => {
    const bms = pairBookmarks();
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 2,
      now,
    });
    const events: string[] = [];
    const { analyze, calls } = makeAnalyzer({
      onCall: (bookmark) => {
        events.push(`analyze:${bookmark.id}`);
      },
    });
    const { scanDuplicates, calls: pairCalls } = makeScanner({
      onCall: (pairs) => {
        events.push(`scan:${pairs.length}`);
      },
    });

    const finished = await new JobRunner({ analyze, scanDuplicates, now }).run(
      job.id,
      { bookmarks: bms, batchSize: 2 },
    );

    expect(calls).toEqual(["bm-0", "bm-1", "bm-2", "bm-3"]);
    // One pair batch (2 pairs) after the two bookmark batches.
    expect(pairCalls).toEqual([["bm-0|bm-1", "bm-2|bm-3"]]);
    expect(events).toEqual([
      "analyze:bm-0",
      "analyze:bm-1",
      "analyze:bm-2",
      "analyze:bm-3",
      "scan:2",
    ]);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toEqual({
      totalBatches: 3,
      committedBatches: 3,
      processedCount: 4,
    });
    // One usage row per bookmark request plus one per pair egress.
    const rows = await db.usage.toArray();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.jobId === job.id)).toBe(true);
  });

  it("does not run the pair phase for an analyze_selection", async () => {
    const bms = pairBookmarks();
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 2,
      now,
    });
    const { analyze } = makeAnalyzer();
    const { scanDuplicates, calls: pairCalls } = makeScanner();

    const finished = await new JobRunner({ analyze, scanDuplicates, now }).run(
      job.id,
      { bookmarks: bms, batchSize: 2 },
    );

    expect(pairCalls).toEqual([]);
    expect(finished.status).toBe("completed");
    expect(finished.progress.totalBatches).toBe(2);
  });

  it("resumes the pair phase without re-sending committed pair batches", async () => {
    const bms = pairBookmarks();
    // batchSize 1 → 4 bookmark batches + 2 pair batches = 6.
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 1,
      now,
    });

    // Pause during the first pair batch; it commits, then the boundary stops.
    const first = makeAnalyzer();
    const firstScan = makeScanner({
      onCall: async () => {
        await pauseJob(job.id, now);
      },
    });
    const stopped = await new JobRunner({
      analyze: first.analyze,
      scanDuplicates: firstScan.scanDuplicates,
      now,
    }).run(job.id, { bookmarks: bms, batchSize: 1 });

    expect(stopped.status).toBe("paused");
    expect(stopped.progress.committedBatches).toBe(5); // 4 bookmark + 1 pair
    expect(first.calls).toEqual(["bm-0", "bm-1", "bm-2", "bm-3"]);
    expect(firstScan.calls).toEqual([["bm-0|bm-1"]]);

    // A fresh runner resumes at the uncommitted pair batch only.
    const second = makeAnalyzer();
    const secondScan = makeScanner();
    await resumeJob(job.id, now);
    const finished = await new JobRunner({
      analyze: second.analyze,
      scanDuplicates: secondScan.scanDuplicates,
      now,
    }).run(job.id, { bookmarks: bms, batchSize: 1 });

    // Committed bookmark batches are never re-sent, and the committed pair
    // batch is not re-sent either.
    expect(second.calls).toEqual([]);
    expect(secondScan.calls).toEqual([["bm-2|bm-3"]]);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toEqual({
      totalBatches: 6,
      committedBatches: 6,
      processedCount: 4,
    });
  });

  it("a deletion never shifts a live pair into a committed pair window", async () => {
    // bs1 → 4 bookmark batches + 3 one-pair batches = 7. The first pair
    // batch (bm-0|bm-1) is committed; bm-0 is then deleted, killing pair 1
    // (bm-0|bm-2) as well — but bm-1|bm-3 is still live work. Re-slicing a
    // filtered pair list would drop it into the committed window and skip
    // it; positional slicing scans it instead (J02).
    const bms = pairBookmarks();
    const plan: NearDuplicatePlan = {
      pairs: [
        { a: pairSide("bm-0"), b: pairSide("bm-1"), titleSimilarity: 0.9 },
        { a: pairSide("bm-0"), b: pairSide("bm-2"), titleSimilarity: 0.9 },
        { a: pairSide("bm-1"), b: pairSide("bm-3"), titleSimilarity: 0.9 },
      ],
      comparisons: 3,
      truncated: false,
    };
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 1,
      nearDuplicatePlan: plan,
      now,
    });
    await db.jobs.put({
      ...job,
      status: "running",
      ownerGeneration: 1,
      progress: { totalBatches: 7, committedBatches: 5, processedCount: 4 },
    });

    const { analyze, calls } = makeAnalyzer();
    const { scanDuplicates, calls: pairCalls } = makeScanner();
    const live = bms.filter((bookmark) => bookmark.id !== "bm-0");
    const finished = await new JobRunner({ analyze, scanDuplicates, now }).run(
      job.id,
      { bookmarks: live, batchSize: 1 },
    );

    expect(pairCalls).toEqual([["bm-1|bm-3"]]); // the only live pair, covered
    expect(calls).toEqual([]); // bookmark phase fully committed
    expect(finished.status).toBe("completed");
    expect(finished.progress.committedBatches).toBe(7);
  });

  it("fails closed when a library_scan has no scanner dependency", async () => {
    const bms = pairBookmarks();
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 2,
      now,
    });
    const { analyze, calls } = makeAnalyzer();

    // Without an injected scanner the runner could only compute zero pair
    // batches and complete as if the scan were whole — it must instead reject
    // before any status change or work is sent.
    const error = await new JobRunner({ analyze, now })
      .run(job.id, { bookmarks: bms, batchSize: 2 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobRunnerError);
    expect((error as JobRunnerError).code).toBe("invalid_input");
    expect((error as JobRunnerError).message).toContain("scanDuplicates");
    // No work was sent and the job was neither advanced nor marked failed.
    expect(calls).toEqual([]);
    const after = await db.jobs.get(job.id);
    expect(after?.status).toBe("pending");
    expect(after?.progress).toEqual({
      totalBatches: 2,
      committedBatches: 0,
      processedCount: 0,
    });
  });

  it("legacy uncommitted library_scan acquires exactly one durable plan", async () => {
    const bms = pairBookmarks();
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 2,
      now,
    });
    // Enqueued the legacy way: bookmark-only progress, no stored plan.
    expect(job.nearDuplicatePlan).toBeUndefined();
    expect(job.progress.totalBatches).toBe(2);

    const { analyze } = makeAnalyzer();
    const { scanDuplicates, calls } = makeScanner();
    const finished = await new JobRunner({ analyze, scanDuplicates, now }).run(
      job.id,
      { bookmarks: bms, batchSize: 2 },
    );

    const stored = await db.jobs.get(job.id);
    expect(stored?.nearDuplicatePlan?.pairs).toEqual([
      { a: "bm-0", b: "bm-1" },
      { a: "bm-2", b: "bm-3" },
    ]);
    expect(calls).toEqual([["bm-0|bm-1", "bm-2|bm-3"]]);
    // 2 bookmark batches + 1 pair batch.
    expect(finished.progress.totalBatches).toBe(3);
    expect(finished.status).toBe("completed");
    // The row is still a valid persisted job with the plan attached.
    expect(JSON.stringify(stored?.nearDuplicatePlan)).not.toContain("Rust");
  });

  it("resumes the stored pair work set even when titles changed since enqueue", async () => {
    const bms = pairBookmarks();
    const plan = planNearDuplicates(bms);
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 1,
      nearDuplicatePlan: plan,
      now,
    });

    // Pause inside the first pair batch (4 bookmark batches + 1 pair batch).
    const first = makeAnalyzer();
    const firstScan = makeScanner({
      onCall: async () => {
        await pauseJob(job.id, now);
      },
    });
    const stopped = await new JobRunner({
      analyze: first.analyze,
      scanDuplicates: firstScan.scanDuplicates,
      now,
    }).run(job.id, { bookmarks: bms, batchSize: 1 });
    expect(stopped.status).toBe("paused");
    expect(stopped.progress.committedBatches).toBe(5);
    expect(firstScan.calls).toEqual([["bm-0|bm-1"]]);

    // The titles change so a RECOMPUTED plan would find NO pairs at all: the
    // retitled sides share no token and the changed URLs also break the
    // same-domain precondition. The stored plan is the durable work set: the
    // resume must slice IT, never re-plan, so the committed bm-0|bm-1 batch is
    // not re-sent and bm-2|bm-3 still runs. (Mutation guard: hydrating from
    // `planNearDuplicates(bookmarks)` instead makes this resume complete after
    // the bookmark batches with zero pair calls.)
    const retitled = [
      {
        id: "bm-0",
        title: "alpha heading",
        url: "https://alpha.example/one",
        parentId: "f-dev",
      },
      {
        id: "bm-1",
        title: "beta heading",
        url: "https://beta.example/two",
        parentId: "f-dev",
      },
      {
        id: "bm-2",
        title: "gamma heading",
        url: "https://gamma.example/three",
        parentId: "f-dev",
      },
      {
        id: "bm-3",
        title: "delta heading",
        url: "https://delta.example/four",
        parentId: "f-dev",
      },
    ];
    // Pin the guard: the live recompute really would yield no pair work.
    expect(planNearDuplicates(retitled).pairs).toEqual([]);
    const second = makeAnalyzer();
    const secondScan = makeScanner();
    await resumeJob(job.id, now);
    const finished = await new JobRunner({
      analyze: second.analyze,
      scanDuplicates: secondScan.scanDuplicates,
      now,
    }).run(job.id, { bookmarks: retitled, batchSize: 1 });

    expect(second.calls).toEqual([]);
    expect(secondScan.calls).toEqual([["bm-2|bm-3"]]);
    expect(finished.status).toBe("completed");
    expect(finished.progress.totalBatches).toBe(6);
  });

  it("fails typed on a committed library_scan with no stored plan", async () => {
    const bms = pairBookmarks();
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 1,
      now,
    });
    // A pre-Task-5 row that already committed a batch: its committed offsets
    // could be bookmark or pair batches, so the pair work set cannot be
    // reinterpreted unambiguously.
    await setJobStatus(job.id, "running", {
      progress: { totalBatches: 4, committedBatches: 1, processedCount: 1 },
    });
    // Snapshot the row BEFORE the rejected run so we can prove the failure is
    // side-effect free (no claim, no status write, no progress write).
    const before = (await getJob(job.id))!;

    const { analyze, calls } = makeAnalyzer();
    const { scanDuplicates, calls: pairCalls } = makeScanner();
    const error = await new JobRunner({ analyze, scanDuplicates, now })
      .run(job.id, { bookmarks: bms, batchSize: 1 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobRunnerError);
    expect((error as JobRunnerError).code).toBe("invalid_input");
    expect(calls).toEqual([]);
    expect(pairCalls).toEqual([]);
    // The typed failure happens BEFORE the claim: the persisted row is byte
    // identical (no owner generation bump, no updatedAt, no status change,
    // no plan acquisition).
    const after = (await getJob(job.id))!;
    expect(after).toEqual(before);
    expect(after.ownerGeneration).toBe(before.ownerGeneration);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.status).toBe("running");
    expect(after.nearDuplicatePlan).toBeUndefined();
  });

  it("persists a truncated pair plan and resumes its STORED pairs after a title change", async () => {
    // 40 identical-title, distinct-URL same-domain rows → 780 candidate pairs,
    // capped by the planner to the 500-pair output limit, so the plan really
    // is truncated. batchSize 50 keeps the batch count small (1 bookmark batch
    // + 10 pair batches) so the test runs well under the default timeout,
    // while the 500-pair plan keeps the truncation and the stored-vs-recomputed
    // distinction sharp.
    const many: AnalysisBookmark[] = Array.from(
      { length: 40 },
      (_value, index) => ({
        id: `bm-${index}`,
        title: "Shared heading",
        url: `https://same.example/${index}`,
        parentId: "f-dev",
      }),
    );
    const plan = planNearDuplicates(many);
    expect(plan.truncated).toBe(true);
    expect(plan.pairs).toHaveLength(500);
    const pairIds = plan.pairs.map((pair) => ({ a: pair.a.id, b: pair.b.id }));
    const pairBatch = (index: number): string[] =>
      pairIds
        .slice(index * 50, (index + 1) * 50)
        .map((pair) => `${pair.a}|${pair.b}`);
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: many.map((bookmark) => bookmark.id),
      batchSize: 50,
      nearDuplicatePlan: plan,
      now,
    });

    // The durable plan carries the planner limits and the truncation state.
    expect(job.nearDuplicatePlan?.truncated).toBe(true);
    expect(job.nearDuplicatePlan?.pairLimit).toBe(500);
    expect(job.nearDuplicatePlan?.comparisonLimit).toBe(50_000);
    expect(job.nearDuplicatePlan?.pairs).toEqual(pairIds);
    expect(job.progress.totalBatches).toBe(
      Math.ceil(many.length / job.batchSize) +
        Math.ceil(plan.pairs.length / job.batchSize),
    );
    // 1 bookmark batch (40 rows) + 10 pair batches (500 pairs) = 11.
    expect(job.progress.totalBatches).toBe(11);

    // Pause inside the first pair batch (batch index 1); it commits, then the
    // boundary stops.
    const first = makeAnalyzer();
    const firstScan = makeScanner({
      onCall: async () => {
        await pauseJob(job.id, now);
      },
    });
    const stopped = await new JobRunner({
      analyze: first.analyze,
      scanDuplicates: firstScan.scanDuplicates,
      now,
    }).run(job.id, { bookmarks: many, batchSize: 50 });
    expect(stopped.status).toBe("paused");
    expect(stopped.progress.committedBatches).toBe(2);
    // Exactly the first 50 stored pairs, in stored order.
    expect(firstScan.calls).toEqual([pairBatch(0)]);

    // Titles change so a RECOMPUTED plan would be empty (no shared tokens):
    // the resume must slice the STORED pairs, never re-plan.
    const retitled = many.map((bookmark, index) => ({
      ...bookmark,
      title: `bm${index} heading`,
    }));
    expect(planNearDuplicates(retitled).pairs).toEqual([]);
    const second = makeAnalyzer();
    const secondScan = makeScanner();
    await resumeJob(job.id, now);
    const finished = await new JobRunner({
      analyze: second.analyze,
      scanDuplicates: secondScan.scanDuplicates,
      now,
    }).run(job.id, { bookmarks: retitled, batchSize: 50 });

    // The committed pair batch is not re-sent; the remaining 9 stored pair
    // batches run in order.
    expect(second.calls).toEqual([]);
    expect(secondScan.calls).toEqual([
      pairBatch(1),
      pairBatch(2),
      pairBatch(3),
      pairBatch(4),
      pairBatch(5),
      pairBatch(6),
      pairBatch(7),
      pairBatch(8),
      pairBatch(9),
    ]);
    expect(finished.status).toBe("completed");
    expect(finished.progress).toEqual({
      totalBatches: 11,
      committedBatches: 11,
      processedCount: 40,
    });
  });

  it("fails typed when the stored plan references a bookmark outside the work set", async () => {
    const bms = pairBookmarks();
    const plan = planNearDuplicates(bms);
    const first = plan.pairs[0]!;
    plan.pairs[0] = { ...first, a: { ...first.a, id: "bm-ghost" } };
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: bms.map((bookmark) => bookmark.id),
      batchSize: 1,
      nearDuplicatePlan: plan,
      now,
    });

    const { analyze, calls } = makeAnalyzer();
    const { scanDuplicates, calls: pairCalls } = makeScanner();
    const error = await new JobRunner({ analyze, scanDuplicates, now })
      .run(job.id, { bookmarks: bms, batchSize: 1 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobRunnerError);
    expect((error as JobRunnerError).code).toBe("invalid_input");
    expect(calls).toEqual([]);
    expect(pairCalls).toEqual([]);
  });
});

describe("job adapter user-blocklist threading", () => {
  function emptyContext() {
    return {
      tagDefs: [],
      corpus: { bookmarks: [], metas: [] },
      tree: flattenTree([]),
    };
  }

  it("createPipelineAnalyzer skips a user-blocklisted bookmark with no egress", async () => {
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-x"],
      now,
    });
    const analyze = createPipelineAnalyzer({
      context: emptyContext(),
      providerId: "typesafe",
      model: "jev-latest",
      userBlocklist: ["example.com"],
    });

    const result = await analyze({
      bookmark: { id: "bm-x", title: "Example", url: "https://example.com/x" },
      job,
      checks: ["categorize"],
    });

    expect(result).toEqual({ sent: false, reason: "blocklisted" });
  });

  it("createDuplicateScanner skips a pair with a user-blocklisted side with no egress", async () => {
    const job = await enqueueJob({
      kind: "library_scan",
      bookmarkIds: ["a", "b"],
      now,
    });
    const scan = createDuplicateScanner({
      providerId: "typesafe",
      model: "jev-latest",
      userBlocklist: ["example.com"],
    });

    const result = await scan({
      pairs: [
        {
          a: {
            id: "a",
            title: "Same",
            url: "https://example.com/a",
            domain: "example.com",
          },
          b: {
            id: "b",
            title: "Same",
            url: "https://example.com/b",
            domain: "example.com",
          },
          titleSimilarity: 1,
        },
      ],
      job,
    });

    expect(result).toEqual({ sent: false, reason: "blocklisted" });
  });
});


describe("restructure jobs", () => {
  const proposal = {
    folders: [
      { path: "dev/tools", description: "Developer utilities." },
      { path: "news", description: "News." },
    ],
  };
  const work: AnalysisBookmark[] = [
    { id: "bm-1", title: "A", url: "https://a-site.io/" },
    { id: "bm-2", title: "B", url: "https://b-site.io/" },
    { id: "bm-3", title: "C", url: "https://c-site.io/" },
  ];

  /** An analyzer that records calls and writes a resolved assignment. */
  function assigner(seen: string[]) {
    return async ({ bookmark }: { bookmark: AnalysisBookmark }) => {
      seen.push(bookmark.id);
      const { mergeRestructureAssignments } = await import(
        "../../src/jobs/queue"
      );
      await mergeRestructureAssignments(jobFor(bookmark.id).id, [
        { bookmarkId: bookmark.id, proposedPath: "news", confidence: 0.9 },
      ]);
      return { sent: true, model: "jev-latest", decisions: [], usage: null } as const;
    };
  }
  // The analyzer needs the job id; captured per test via this holder.
  let jobForId: Record<string, string> = {};
  function jobFor(bookmarkId: string): { id: string } {
    return { id: jobForId[bookmarkId]! };
  }

  it("enqueues with the vetted proposal and completes with assignments", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: work.map((b) => b.id),
      batchSize: 2,
      restructureProposal: proposal,
      now,
    });
    jobForId = Object.fromEntries(work.map((b) => [b.id, job.id]));
    const seen: string[] = [];
    const runner = new JobRunner({ analyze: assigner(seen) });
    const done = await runner.run(job.id, { bookmarks: work });
    expect(done.status).toBe("completed");
    expect(seen).toEqual(["bm-1", "bm-2", "bm-3"]);
    const { getJob, restructurePlanFor } = await import("../../src/jobs/queue");
    const stored = (await getJob(job.id))!;
    expect(stored.restructure?.proposal).toEqual(proposal);
    // J13: committed rows live in `restructureAssignments`; the merged plan
    // is what status/apply reads — the inline field stays empty.
    expect(stored.restructure?.assignments).toHaveLength(0);
    expect((await restructurePlanFor(stored))!.assignments).toHaveLength(3);
  });

  it("resumes without re-sending committed batches", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: work.map((b) => b.id),
      batchSize: 2,
      restructureProposal: proposal,
      now,
    });
    jobForId = Object.fromEntries(work.map((b) => [b.id, job.id]));
    const seen: string[] = [];
    const analyze = async ({ bookmark }: { bookmark: AnalysisBookmark }) => {
      seen.push(bookmark.id);
      if (bookmark.id === "bm-2") await pauseJob(job.id);
      const { mergeRestructureAssignments } = await import(
        "../../src/jobs/queue"
      );
      await mergeRestructureAssignments(job.id, [
        { bookmarkId: bookmark.id, proposedPath: "news", confidence: 0.9 },
      ]);
      return { sent: true, model: "jev-latest", decisions: [], usage: null } as const;
    };
    const runner = new JobRunner({ analyze });
    const paused = await runner.run(job.id, { bookmarks: work });
    expect(paused.status).toBe("paused");
    expect(seen).toEqual(["bm-1", "bm-2"]);
    expect(paused.progress.committedBatches).toBe(1);

    // Fresh runner instance over the same Dexie state — the restart.
    await resumeJob(job.id);
    const runner2 = new JobRunner({ analyze });
    const done = await runner2.run(job.id, { bookmarks: work });
    expect(done.status).toBe("completed");
    // bm-1/bm-2's committed batch is not re-sent; only bm-3's batch ran.
    expect(seen).toEqual(["bm-1", "bm-2", "bm-3"]);
    const { getJob, restructurePlanFor } = await import("../../src/jobs/queue");
    const stored = (await getJob(job.id))!;
    expect((await restructurePlanFor(stored))!.assignments).toHaveLength(3);
  });

  it("rejects enqueue of a restructure job without a proposal", async () => {
    await expect(
      enqueueJob({
        kind: "restructure",
        bookmarkIds: ["bm-1"],
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a restructure plan on a non-restructure job", async () => {
    await expect(
      enqueueJob({
        kind: "analyze_selection",
        bookmarkIds: ["bm-1"],
        restructureProposal: proposal,
        now,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("J01/J02/J09 job resilience", () => {
  it("records a throwing item and skips it, completing the rest", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    const analyzer = makeAnalyzer({
      onCall: (bookmark) => {
        if (bookmark.id === "bm-2") {
          throw new DecisionPipelineError("http_error", "upstream said 500");
        }
      },
    });

    const result = await new JobRunner({ analyze: analyzer.analyze, now })
      .run(job.id, { bookmarks: bookmarks(4) });

    expect(result.status).toBe("completed");
    expect(analyzer.calls).toEqual(ids);
    const row = (await getJob(job.id))!;
    expect(row.itemFailures).toEqual([
      { item: "bm-2", code: "http_error", at: NOW },
    ]);
    // Skipped items still count as processed work — the batch committed.
    expect(row.progress).toEqual({
      totalBatches: 2,
      committedBatches: 2,
      processedCount: 4,
    });
  });

  it("a budget_exceeded refusal fails the job instead of item-skipping everything", async () => {
    const job = await runningJob(["bm-0", "bm-1"], 2);
    const analyzer = makeAnalyzer({
      onCall: () => {
        throw new LlmGateError("budget_exceeded", "monthly cap reached");
      },
    });

    const result = await new JobRunner({ analyze: analyzer.analyze, now })
      .run(job.id, { bookmarks: bookmarks(2) });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("budget_exceeded");
    expect(result.itemFailures ?? []).toEqual([]);
  });

  it("a job-fatal code fails the job, and `failed` resumes from committedBatches", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    let healthy = false;
    const first = makeAnalyzer({
      onCall: () => {
        // `provider` is job-fatal: throw it at batch 2's first item so
        // batch 1 stays committed — the resume then covers only bm-2/bm-3.
        if (!healthy && first.calls.length === 3) {
          throw new DecisionPipelineError("provider", "no provider configured");
        }
      },
    });

    const crashed = await new JobRunner({ analyze: first.analyze, now })
      .run(job.id, { bookmarks: bookmarks(4) });
    expect(crashed.status).toBe("failed");
    expect(crashed.progress.committedBatches).toBe(1); // batch 1 committed
    expect(first.calls).toEqual(["bm-0", "bm-1", "bm-2"]);

    // Explicit resume: `failed` claims a fresh owner and continues from
    // `committedBatches` — committed items are never re-sent (J01).
    healthy = true;
    const second = makeAnalyzer();
    const resumed = await resumeJob(job.id, now);
    expect(resumed.status).toBe("running");
    const done = await new JobRunner({ analyze: second.analyze, now })
      .run(job.id, { bookmarks: bookmarks(4) });

    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined(); // stale failure message is stripped
    expect(second.calls).toEqual(["bm-2", "bm-3"]);
  });

  it("filters deleted ids on resume and still completes", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    // Simulate the mid-run state: batch 1 committed, then bm-2 was deleted.
    await db.jobs.put({
      ...job,
      status: "running",
      ownerGeneration: 1,
      progress: { totalBatches: 2, committedBatches: 1, processedCount: 2 },
    });
    const second = makeAnalyzer();
    const live = bookmarks(4).filter((b) => b.id !== "bm-2");
    const result = await new JobRunner({ analyze: second.analyze, now })
      .run(job.id, { bookmarks: live });

    expect(result.status).toBe("completed");
    expect(second.calls).toEqual(["bm-3"]); // bm-2 filtered, never analyzed
  });

  it("a deletion inside the committed window never skips a live bookmark", async () => {
    // committed batch 0 covered the ORIGINAL positions [bm-0, bm-1]; bm-0
    // was deleted since. Re-slicing the whole filtered list would shift
    // bm-2 into a committed position and skip it — the committed window
    // stays positional in the original ids instead (J02).
    const job = await runningJob(["bm-0", "bm-1", "bm-2", "bm-3"], 2);
    await db.jobs.put({
      ...job,
      status: "running",
      ownerGeneration: 1,
      progress: { totalBatches: 2, committedBatches: 1, processedCount: 2 },
    });
    const analyzer = makeAnalyzer();
    const live = bookmarks(4).filter((b) => b.id !== "bm-0");
    const result = await new JobRunner({ analyze: analyzer.analyze, now })
      .run(job.id, { bookmarks: live });

    expect(result.status).toBe("completed");
    expect(analyzer.calls).toEqual(["bm-2", "bm-3"]); // bm-2 covered, never skipped
  });

  it("an empty filtered work set ends terminal, never an immortal running", async () => {
    const job = await runningJob(["bm-0", "bm-1"], 2);
    const analyzer = makeAnalyzer();
    const result = await new JobRunner({ analyze: analyzer.analyze, now })
      .run(job.id, { bookmarks: [] }); // every persisted id was deleted

    expect(result.status).toBe("completed");
    expect(analyzer.calls).toEqual([]);
  });

  it("pause is honored at the next ITEM boundary, not the batch boundary", async () => {
    const job = await runningJob(["bm-0", "bm-1"], 2);
    const analyzer = makeAnalyzer({
      onCall: async (bookmark) => {
        if (bookmark.id === "bm-0") await pauseJob(job.id, now);
      },
    });

    const result = await new JobRunner({ analyze: analyzer.analyze, now })
      .run(job.id, { bookmarks: bookmarks(2) });

    expect(result.status).toBe("paused");
    expect(analyzer.calls).toEqual(["bm-0"]); // bm-1 never sent
    expect((await getJob(job.id))?.progress.committedBatches).toBe(0);
  });

  it("a retry_later burst opens the breaker, delays the next item, and resumes", async () => {
    const ids = ["bm-0", "bm-1", "bm-2", "bm-3"];
    const job = await runningJob(ids, 2);
    let nowMs = Date.parse(NOW);
    const tick = () => new Date(nowMs).toISOString();
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); nowMs += ms; };
    const analyzer = makeAnalyzer({
      onCall: (bookmark) => {
        if (bookmark.id !== "bm-3") {
          throw new DecisionPipelineError("retry_later", "429");
        }
      },
    });

    const result = await new JobRunner({ analyze: analyzer.analyze, now: tick, sleep })
      .run(job.id, { bookmarks: bookmarks(4) });

    expect(result.status).toBe("completed");
    // Three consecutive throttles opened the breaker: the persisted row
    // gained `breaker.openUntil` and the runner slept before the next item.
    const row = (await getJob(job.id))!;
    expect(row.itemFailures?.map((f) => [f.item, f.code])).toEqual([
      ["bm-0", "retry_later"],
      ["bm-1", "retry_later"],
      ["bm-2", "retry_later"],
    ]);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...waits)).toBeLessThanOrEqual(15_000); // MV3-safe chunks
    expect(row.breaker).toBeUndefined(); // lapsed breaker is cleared on commit
    expect(analyzer.calls).toEqual(ids); // items after the burst still ran
  });
});
