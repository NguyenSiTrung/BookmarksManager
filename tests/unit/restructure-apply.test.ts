import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { deleteMetaByIds, getMeta, putMeta } from "../../src/db/meta";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import {
  enqueueJob,
  mergeRestructureAssignments,
  setJobStatus,
} from "../../src/jobs/queue";
import {
  applyRestructurePlan,
  undoRestructurePlan,
} from "../../src/restructure/apply";
import { buildRestructureDiff } from "../../src/restructure/diff";
import type { RestructureProposal } from "../../src/schemas/restructure";
import { listSnapshots } from "../../src/undo/snapshot";

/**
 * `buildRestructureDiff` + `applyRestructurePlan` + `undoRestructurePlan`
 * (spec FR8.6–8.9): the diff marks resolved/unresolved/stale rows in stable
 * bookmarkId order; the apply revalidates the live tree, creates folders
 * parents-first (reusing existing same-path folders), moves resolved rows
 * only, writes one `restructure` undo snapshot, and rolls back on failure.
 * Undo replays moves and removes now-empty created folders.
 */

const NOW = "2026-09-28T00:00:00.000Z";
const now = () => NOW;

let api: FakeBookmarksApi;

const PROPOSAL: RestructureProposal = {
  folders: [
    { path: "dev/tools", description: "Developer utilities." },
    { path: "dev", description: "" },
    { path: "news", description: "Press." },
  ],
};

async function completedJob(
  bookmarkIds: string[] = ["11", "21"],
  assignments: Array<{ bookmarkId: string; proposedPath: string | null; confidence: number | null }> = [
    { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
    { bookmarkId: "21", proposedPath: "dev", confidence: 0.9 },
  ],
  proposal: RestructureProposal = PROPOSAL,
) {
  const job = await enqueueJob({
    kind: "restructure",
    bookmarkIds,
    restructureProposal: proposal,
    batchSize: 10,
    now,
  });
  await setJobStatus(job.id, "running", {}, now);
  await mergeRestructureAssignments(job.id, assignments);
  return setJobStatus(job.id, "completed", {}, now);
}

beforeEach(async () => {
  api = installBookmarksFake({
    bookmarksBar: [
      {
        id: "10",
        title: "Old",
        children: [
          { id: "11", title: "Article A", url: "https://a.io/x" },
          { id: "12", title: "Article B", url: "https://b.io/y" },
        ],
      },
      { id: "20", title: "News", children: [
        { id: "21", title: "Daily", url: "https://news.io/" },
      ]},
      { id: "30", title: "Loose", url: "https://loose.io/" },
      { id: "40", title: "Policy", unmodifiable: "managed", children: [
        { id: "41", title: "Managed", url: "https://policy.io/" },
      ]},
    ],
  });
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("buildRestructureDiff", () => {
  it("marks resolved/unresolved/stale rows in stable order", async () => {
    const job = await completedJob(
      ["11", "12", "21", "gone"],
      [
        { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
        { bookmarkId: "12", proposedPath: null, confidence: null },
        { bookmarkId: "gone", proposedPath: "news", confidence: 0.8 },
        { bookmarkId: "21", proposedPath: "news", confidence: 0.95 },
      ],
    );
    const tree = await api.getSubTree("1");
    const diff = buildRestructureDiff(tree, job.restructure!);
    expect(diff.rows.map((r) => r.bookmarkId)).toEqual([
      "11",
      "12",
      "21",
      "gone",
    ]);
    expect(diff.resolved).toBe(2);
    expect(diff.unresolved).toBe(1);
    expect(diff.stale).toBe(1);
    const byId = Object.fromEntries(diff.rows.map((r) => [r.bookmarkId, r]));
    expect(byId["11"]).toMatchObject({
      fromPath: "Bookmarks bar/Old",
      toPath: "dev/tools",
      status: "resolved",
    });
    expect(byId["21"]).toMatchObject({
      fromPath: "Bookmarks bar/News",
      toPath: "news",
      status: "resolved",
    });
  });
});

describe("applyRestructurePlan", () => {
  it("creates folders parents-first, reuses existing ones, moves resolved only", async () => {
    const job = await completedJob(
      ["11", "12", "21"],
      [
        { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
        { bookmarkId: "12", proposedPath: null, confidence: null },
        { bookmarkId: "21", proposedPath: "dev", confidence: 0.8 },
      ],
    );
    const result = await applyRestructurePlan(job.id);
    expect(result.moved).toBe(2);

    const bar = await api.getSubTree("1");
    const dev = bar[0]!.children!.find((c) => c.title === "dev")!;
    const tools = dev.children!.find((c) => c.title === "tools")!;
    // `dev` was created under the bar; `tools` under `dev`; `news` reused the
    // pre-existing "News" folder? No — case-sensitive path match, so a NEW
    // lowercase "news" is created.
    expect(tools.children!.map((c) => c.id)).toEqual(["11"]);
    expect(dev.children!.map((c) => c.id)).toEqual(["21", tools.id].sort());
    // Unresolved row untouched — still under "Old".
    const old = bar[0]!.children!.find((c) => c.title === "Old")!;
    expect(old.children!.map((c) => c.id)).toEqual(["12"]);
    // One undo snapshot with the captured pre-move positions + created ids.
    const snapshots = await listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.kind).toBe("restructure");
    expect(snapshots[0]!.createdFolderIds).toContain(tools.id);
  });

  it("skips moving bookmarks already in their proposed folder", async () => {
    const job = await completedJob(
      ["11", "21"],
      [
        { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
        // "21" is already inside "News" ("20")
        { bookmarkId: "21", proposedPath: "News", confidence: 0.95 },
      ],
      {
        folders: [
          { path: "dev/tools", description: "Developer utilities." },
          { path: "News", description: "Press." },
        ],
      },
    );
    const moveSpy = vi.spyOn(api, "move");
    const result = await applyRestructurePlan(job.id);
    // Only "11" was actually moved; "21" was already in "News".
    expect(result.moved).toBe(1);
    expect(moveSpy).toHaveBeenCalledTimes(1);
    expect(moveSpy).toHaveBeenCalledWith("11", expect.anything());
    moveSpy.mockRestore();
  });

  it("reuses the bookmarks bar root when proposal paths include the root folder prefix", async () => {
    const job = await completedJob(
      ["11"],
      [{ bookmarkId: "11", proposedPath: "Bookmarks bar/Tools", confidence: 0.9 }],
      {
        folders: [{ path: "Bookmarks bar/Tools", description: "Tools" }],
      },
    );
    const result = await applyRestructurePlan(job.id);
    expect(result.moved).toBe(1);
    const bar = await api.getSubTree("1");
    // "Tools" was created directly under Bookmarks bar ("1"), not under a nested "Bookmarks bar" folder
    expect(bar[0]!.children!.some((c) => c.title === "Tools")).toBe(true);
    expect(bar[0]!.children!.some((c) => c.title === "Bookmarks bar")).toBe(false);
  });

  it("applies only the specified subset of bookmarkIds when acceptedBookmarkIds is provided", async () => {
    const job = await completedJob(
      ["11", "21"],
      [
        { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
        { bookmarkId: "21", proposedPath: "dev", confidence: 0.8 },
      ],
    );
    // Apply only "11", leave "21" unapplied
    const result = await applyRestructurePlan(job.id, ["11"]);
    expect(result.moved).toBe(1);

    const bar = await api.getSubTree("1");
    const dev = bar[0]!.children!.find((c) => c.title === "dev")!;
    const tools = dev.children!.find((c) => c.title === "tools")!;
    expect(tools.children!.map((c) => c.id)).toEqual(["11"]);
    // "21" was NOT moved into "dev" — still under "News"
    const news = bar[0]!.children!.find((c) => c.title === "News")!;
    expect(news.children!.map((c) => c.id)).toContain("21");
  });

  it("rejects a job that is not completed", async () => {
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: ["11"],
      restructureProposal: PROPOSAL,
      now,
    });
    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  it("rejects a non-restructure job", async () => {
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["11"],
      now,
    });
    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({
      code: "invalid_job",
    });
  });

  it("rolls back created folders when a move fails", async () => {
    const job = await completedJob(
      ["11", "21"],
      [
        { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
        { bookmarkId: "21", proposedPath: "dev", confidence: 0.9 },
      ],
    );
    // Force the second move to fail — the first move + folder creates must
    // be compensated. Other calls (including the compensating replays) pass
    // through to the real fake.
    const originalMove = api.move.bind(api);
    let calls = 0;
    const spy = vi.spyOn(api, "move").mockImplementation(async (id, dest) => {
      calls += 1;
      if (calls === 2) throw new Error("forced move failure");
      return originalMove(id, dest);
    });
    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({
      code: "mutation_failed",
    });
    spy.mockRestore();
    const bar = await api.getSubTree("1");
    // "dev" (and its children) was rolled back — no leftover created folder.
    expect(bar[0]!.children!.some((c) => c.title === "dev")).toBe(false);
    // The first moved bookmark was moved back under "Old".
    const old = bar[0]!.children!.find((c) => c.title === "Old")!;
    expect(old.children!.map((c) => c.id)).toContain("11");
  });

  it("keeps occupied created folders and a retryable snapshot when the inverse move fails", async () => {
    const job = await completedJob();
    const originalMove = api.move.bind(api);
    let calls = 0;
    vi.spyOn(api, "move").mockImplementation(async (id, dest) => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error("controlled move failure");
      return originalMove(id, dest);
    });

    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({
      code: "mutation_failed",
    });
    await expect(api.get(["11", "12", "21", "30", "41"])).resolves.toHaveLength(5);
    const originals = await api.get(["11", "12", "21", "30", "41"]);
    expect(originals.map((node) => node.id)).toEqual(["11", "12", "21", "30", "41"]);
    const toolsId = originals[0]!.parentId!;
    expect((await api.get(toolsId))[0]?.title).toBe("tools");
    const devId = (await api.get(toolsId))[0]!.parentId!;
    expect((await api.get(devId))[0]?.title).toBe("dev");
    const [snapshot] = await listSnapshots();
    expect(snapshot?.nodes.map((node) => node.id)).toEqual(["11", "21"]);
    expect(snapshot?.createdFolderIds).toContain(toolsId);

    vi.restoreAllMocks();
    expect(await undoRestructurePlan()).toMatchObject({ ok: true, idMap: {} });
    expect((await api.get("11"))[0]?.parentId).toBe("10");
    expect((await api.getChildren("1")).some((node) => node.id === devId)).toBe(false);
    expect(await listSnapshots()).toEqual([]);
  });

  it("does not delete a created folder when its cleanup child lookup fails", async () => {
    const job = await completedJob();
    const originalMove = api.move.bind(api);
    const originalChildren = api.getChildren.bind(api);
    let toolsId = "";
    let filedId = "";
    let failedForward = false;
    vi.spyOn(api, "move").mockImplementation(async (id, dest) => {
      if (id === "11" && !failedForward) toolsId = dest.parentId!;
      if (id === "21") {
        filedId = (await api.create({
          parentId: toolsId,
          title: "Filed during apply",
          url: "https://filed.io/",
        })).id;
        failedForward = true;
        throw new Error("controlled forward failure");
      }
      return originalMove(id, dest);
    });
    vi.spyOn(api, "getChildren").mockImplementation(async (id) => {
      if (failedForward && id === toolsId) throw new Error("controlled child lookup failure");
      return originalChildren(id);
    });

    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({
      code: "mutation_failed",
    });
    expect((await api.get(["11", "12", "21", "30", "41"])).map((node) => node.id))
      .toEqual(["11", "12", "21", "30", "41"]);
    await expect(api.get(filedId)).resolves.toMatchObject([{ parentId: toolsId }]);
    expect((await api.get(toolsId))[0]?.title).toBe("tools");
    expect(await listSnapshots()).toHaveLength(1);
    vi.restoreAllMocks();
    expect(await undoRestructurePlan()).toMatchObject({ ok: true });
    await expect(api.get(filedId)).resolves.toMatchObject([{ parentId: toolsId }]);
  });

  it("preserves a child inserted at the native folder removal boundary during compensation", async () => {
    const job = await completedJob();
    const originalMove = api.move.bind(api);
    const originalRemove = api.remove.bind(api);
    const originalRemoveTree = api.removeTree.bind(api);
    let toolsId = "";
    let filedId = "";
    vi.spyOn(api, "move").mockImplementation(async (id, dest) => {
      if (id === "11" && toolsId === "") toolsId = dest.parentId!;
      if (id === "21") throw new Error("controlled forward failure");
      return originalMove(id, dest);
    });
    const insertRacingChild = async (id: string) => {
      if (id === toolsId) {
        filedId = (await api.create({
          parentId: id, title: "Racing child", url: "https://racing.io/",
        })).id;
      }
    };
    vi.spyOn(api, "remove").mockImplementation(async (id) => {
      await insertRacingChild(id);
      return originalRemove(id);
    });
    vi.spyOn(api, "removeTree").mockImplementation(async (id) => {
      await insertRacingChild(id);
      return originalRemoveTree(id);
    });

    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({
      code: "mutation_failed",
    });
    expect((await api.get(["11", "12", "21", "30", "41"])).map((node) => node.id))
      .toEqual(["11", "12", "21", "30", "41"]);
    await expect(api.get(filedId)).resolves.toMatchObject([{ parentId: toolsId }]);
    expect((await api.get(toolsId))[0]?.title).toBe("tools");
    expect(await listSnapshots()).toHaveLength(1);
  });

  it.each([
    ["1", "stale"],
    ["41", "mutation_failed"],
  ])("never moves a fixed root or managed bookmark (%s)", async (id, code) => {
    const job = await completedJob(
      [id!],
      [{ bookmarkId: id!, proposedPath: "dev/tools", confidence: 0.9 }],
    );
    const before = (await api.getChildren("1")).map((node) => node.id);
    await expect(applyRestructurePlan(job.id)).rejects.toMatchObject({ code });
    expect((await api.getChildren("1")).map((node) => node.id)).toEqual(before);
    expect((await api.get("41"))[0]?.parentId).toBe("40");
  });
});

describe("undoRestructurePlan", () => {
  it("recreates a deleted captured bookmark under a new id with its metadata", async () => {
    await putMeta("11", { tags: ["docs"], category: "docs", notes: "captured note" });
    const job = await completedJob();
    const result = await applyRestructurePlan(job.id);
    await api.removeTree("11");
    await deleteMetaByIds(["11"]);
    const undone = await undoRestructurePlan();
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      expect(undone.idMap["11"]).toBeDefined();
      expect((await api.get(undone.idMap["11"]!))[0]).toMatchObject({
        url: "https://a.io/x", parentId: "10", index: 0,
      });
      expect(await getMeta(undone.idMap["11"]!)).toMatchObject({
        tags: ["docs"], category: "docs", notes: "captured note",
      });
    }
    expect(result.snapshotId).toBeGreaterThan(0);
    expect(await listSnapshots()).toEqual([]);
  });

  it("replays moves and removes empty created folders", async () => {
    const job = await completedJob(
      ["11", "21"],
      [
        { bookmarkId: "11", proposedPath: "dev/tools", confidence: 0.9 },
        { bookmarkId: "21", proposedPath: "dev", confidence: 0.8 },
      ],
    );
    await applyRestructurePlan(job.id);
    const undone = await undoRestructurePlan();
    expect(undone.ok).toBe(true);
    const bar = await api.getSubTree("1");
    // Bookmarks back under "Old" / "News".
    const old = bar[0]!.children!.find((c) => c.title === "Old")!;
    const news = bar[0]!.children!.find((c) => c.title === "News")!;
    expect(old.children!.map((c) => c.id)).toContain("11");
    expect(news.children!.map((c) => c.id)).toContain("21");
    // Created folders removed.
    expect(bar[0]!.children!.some((c) => c.title === "dev")).toBe(false);
  });
});
