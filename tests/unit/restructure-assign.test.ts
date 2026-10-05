import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  assignProposedFolder,
  createRestructureAssigner,
} from "../../src/restructure/assign";
import {
  restructure,
  restructureChoiceOptions,
  keyForIndex,
  indexForKey,
  KEEP_FOLDER_KEY,
} from "../../src/jev/tasks/restructure";
import { enqueueJob, getJob, restructurePlanFor } from "../../src/jobs/queue";
import type { Job } from "../../src/schemas/job";
import type { RestructureProposal } from "../../src/schemas/restructure";
import type { JevTransport } from "../../src/jev/client";
import type { AnalysisBookmark } from "../../src/decisions/pipeline";

/**
 * `assignProposedFolder` runs the Jev `restructure` choice per bookmark:
 * option keys `p0`…`pN` map back to proposal paths, `none`/low confidence
 * stays unresolved, and the committed assignment lands on the job row BEFORE
 * the runner advances its cursor.
 */

const NOW = "2026-09-28T00:00:00.000Z";

const PROPOSAL: RestructureProposal = {
  folders: [
    { path: "dev/tools", description: "Developer utilities." },
    { path: "news", description: "News and press." },
  ],
};

const BOOKMARK: AnalysisBookmark = {
  id: "bm-1",
  title: "A dev utility",
  url: "https://devtools.io/",
};

/** A transport answering `folder` with `key` at `confidence`. */
function transportFor(key: string, confidence: number) {
  return vi.fn<JevTransport>(async (_scope, _preset, _model, request) => {
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([name, question]) => {
        if (question.type !== "choice") {
          throw new Error("restructure must be a choice question");
        }
        const options = Object.keys(question.criteria);
        expect(options).toContain(key);
        return [
          name,
          {
            type: "choice",
            choice: key,
            probabilities: { [key]: confidence },
            confidence,
          },
        ];
      }),
    );
    return new Response(
      JSON.stringify({
        model: request.model,
        answers,
        usage: { input_tokens: 25, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

async function seedJob(): Promise<Job> {
  const job = await enqueueJob({
    kind: "restructure",
    bookmarkIds: [BOOKMARK.id],
    restructureProposal: PROPOSAL,
    now: () => NOW,
  });
  return job;
}

const OPTS = { providerId: "typesafe", model: "jev-latest" };

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
});

describe("restructure question set", () => {
  it("keys options p0…pN plus the none sentinel", () => {
    const options = restructureChoiceOptions(PROPOSAL.folders);
    expect(options.p0).toContain("dev/tools");
    expect(options.p1).toContain("news");
    expect(options[KEEP_FOLDER_KEY]).toMatch(/current folder/i);
  });

  it("round-trips proposal indices through key helpers", () => {
    expect(indexForKey(keyForIndex(0))).toBe(0);
    expect(indexForKey(keyForIndex(9))).toBe(9);
    expect(indexForKey("none")).toBeNull();
    expect(indexForKey("px")).toBeNull();
  });

  it("declares the proposed folders in DecisionState shape", () => {
    const set = restructure({
      bookmark: { title: "T", url: "https://a.example/", domain: "a.example" },
      folders: PROPOSAL.folders,
    });
    expect(set.questionSetVersion).toBe("restructure-v1");
    expect(set.state.candidateFolders).toHaveLength(2);
    expect(set.state.candidateFolders?.[0]).toEqual({
      id: "p0",
      path: ["dev", "tools"],
    });
  });
});

describe("assignProposedFolder", () => {
  it("maps a confident p-key answer to its proposal path", async () => {
    const job = await seedJob();
    const transport = transportFor("p1", 0.9);
    const result = await assignProposedFolder(
      { bookmark: BOOKMARK, job, checks: [] },
      { ...OPTS, transport },
    );
    expect(result.sent).toBe(true);

    const updated = (await getJob(job.id))!;
    expect((await restructurePlanFor(updated))!.assignments).toEqual([
      { bookmarkId: BOOKMARK.id, proposedPath: "news", confidence: 0.9 },
    ]);
    expect(await db.usage.count()).toBe(1);
  });

  it("leaves a low-confidence answer unresolved", async () => {
    const job = await seedJob();
    await assignProposedFolder(
      { bookmark: BOOKMARK, job, checks: [] },
      { ...OPTS, transport: transportFor("p0", 0.4) },
    );
    const updated = (await getJob(job.id))!;
    expect((await restructurePlanFor(updated))!.assignments).toEqual([
      { bookmarkId: BOOKMARK.id, proposedPath: null, confidence: null },
    ]);
  });

  it("leaves the `none` answer unresolved", async () => {
    const job = await seedJob();
    await assignProposedFolder(
      { bookmark: BOOKMARK, job, checks: [] },
      { ...OPTS, transport: transportFor(KEEP_FOLDER_KEY, 0.95) },
    );
    const updated = (await getJob(job.id))!;
    expect((await restructurePlanFor(updated))!.assignments[0]?.proposedPath).toBeNull();
  });

  it("skips a blocklisted bookmark without egress", async () => {
    const job = await seedJob();
    const transport = transportFor("p0", 0.9);
    const result = await assignProposedFolder(
      {
        bookmark: { ...BOOKMARK, url: "https://chase.com/login" },
        job,
        checks: [],
      },
      { ...OPTS, transport },
    );
    expect(result).toEqual({ sent: false, reason: "blocklisted" });
    expect(transport).not.toHaveBeenCalled();
    const updated = (await getJob(job.id))!;
    expect((await restructurePlanFor(updated))!.assignments).toEqual([]);
  });

  it("rejects a non-restructure job", async () => {
    const other = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: [BOOKMARK.id],
      now: () => NOW,
    });
    await expect(
      assignProposedFolder(
        { bookmark: BOOKMARK, job: other, checks: [] },
        { ...OPTS, transport: transportFor("p0", 0.9) },
      ),
    ).rejects.toMatchObject({ code: "invalid_job" });
  });

  it("createRestructureAssigner adapts to the runner's JobAnalyzeFn", async () => {
    const job = await seedJob();
    const analyze = createRestructureAssigner({
      ...OPTS,
      transport: transportFor("p0", 0.8),
    });
    const result = await analyze({ bookmark: BOOKMARK, job, checks: [] });
    expect(result.sent).toBe(true);
    const updated = (await getJob(job.id))!;
    expect((await restructurePlanFor(updated))!.assignments[0]?.proposedPath).toBe("dev/tools");
  });
});
