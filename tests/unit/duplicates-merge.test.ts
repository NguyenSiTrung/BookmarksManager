import "fake-indexeddb/auto";
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
import { getMeta, putMeta } from "../../src/db/meta";
import type { DuplicateGroup } from "../../src/duplicates/group";
import { MERGE_NOTES_SEPARATOR, mergeGroup } from "../../src/duplicates/merge";
import type { MergeResult, MergeSuccess } from "../../src/duplicates/merge";
import { BOOKMARKS_BAR_ID, get, getChildren } from "../../src/sync/chrome-bookmarks";
import { createFolder } from "../../src/sync/mutations";
import { undoLatest } from "../../src/undo/restore";
import type { UndoResult, UndoSuccess } from "../../src/undo/restore";
import { listSnapshots, peekLatest } from "../../src/undo/snapshot";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Seeded tree for every test:
 *
 * ```
 * 0 root
 * ├─ 1 Bookmarks bar
 * │  ├─ bm-k                https://example.com/page   (merge "keep" target)
 * │  ├─ bm-l1               https://example.com/page   (loser)
 * │  ├─ bm-l2               https://example.com/page   (loser)
 * │  └─ bm-solo             https://solo.example/      (unrelated)
 * ├─ 2 Other bookmarks
 * │  └─ managed             folder, unmodifiable: "managed"
 * │     └─ bm-managed       https://managed.example/   (writable guard victim)
 * └─ 3 Mobile bookmarks
 * ```
 */
const URLS: Record<string, string> = {
  "bm-k": "https://example.com/page",
  "bm-l1": "https://example.com/page",
  "bm-l2": "https://example.com/page",
  "bm-solo": "https://solo.example/",
  "bm-managed": "https://managed.example/",
};

/** Build the group object a Duplicates view would hand to mergeGroup. */
function groupOf(...ids: string[]): DuplicateGroup {
  return {
    key: "example.com/page",
    kind: "exact",
    items: ids.map((id) => ({ id, url: URLS[id] ?? `https://${id}.example/` })),
  };
}

let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
    bookmarksBar: [
      { id: "bm-k", title: "Keep", url: "https://example.com/page" },
      { id: "bm-l1", title: "L1", url: "https://example.com/page" },
      { id: "bm-l2", title: "L2", url: "https://example.com/page" },
      { id: "bm-solo", title: "Solo", url: "https://solo.example/" },
    ],
    otherBookmarks: [
      {
        id: "managed",
        title: "Policy",
        unmodifiable: "managed",
        children: [
          { id: "bm-managed", title: "MG", url: "https://managed.example/" },
        ],
      },
    ],
  });
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/** Narrow a merge result to its success arm (fails the test otherwise). */
function expectMergeOk(result: MergeResult): MergeSuccess {
  if (!result.ok) {
    throw new Error(`merge failed: ${result.code}: ${result.message}`);
  }
  return result;
}

/** Narrow an undo result to its success arm (fails the test otherwise). */
function expectUndoOk(result: UndoResult): UndoSuccess {
  if (!result.ok) {
    throw new Error(`undo failed: ${result.code}: ${result.message}`);
  }
  return result;
}

async function barChildIds(): Promise<string[]> {
  return (await getChildren(BOOKMARKS_BAR_ID)).map((node) => node.id);
}

// ---------------------------------------------------------------------------
// Merged metadata
// ---------------------------------------------------------------------------

describe("mergeGroup — merged metadata", () => {
  it("unions all members' tags onto the kept bookmark — kept first, then group order, deduped", async () => {
    // tagNameKey normalization: stored rows carry lowercase nameKeys.
    await putMeta("bm-k", { tags: ["Keep", "shared"] });
    await putMeta("bm-l1", { tags: ["l1", "Shared"] });
    await putMeta("bm-l2", { tags: ["l2"] });
    // The kept item is deliberately NOT first in group order, so the result
    // proves kept-first ordering rather than positional luck.
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-l1", "bm-k", "bm-l2"), "bm-k"),
    );
    expect(result.keptId).toBe("bm-k");
    expect(result.mergedMeta.tags).toEqual(["keep", "shared", "l1", "l2"]);
    expect(await getMeta("bm-k")).toMatchObject({
      tags: ["keep", "shared", "l1", "l2"],
    });
  });

  it("joins non-empty notes with MERGE_NOTES_SEPARATOR — kept first, then group order", async () => {
    await putMeta("bm-l1", { notes: "l1 note" });
    await putMeta("bm-k", { notes: "kept note" });
    await putMeta("bm-l2", { notes: "l2 note" });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-l1", "bm-k", "bm-l2"), "bm-k"),
    );
    const expected = ["kept note", "l1 note", "l2 note"].join(
      MERGE_NOTES_SEPARATOR,
    );
    expect(result.mergedMeta.notes).toBe(expected);
    expect(await getMeta("bm-k")).toMatchObject({ notes: expected });
  });

  it("skips members with no meta row and members without notes in the join", async () => {
    await putMeta("bm-k", { notes: "kept note" });
    // bm-l1 has a meta row but no notes; bm-solo has no row at all. Neither
    // contributes a segment — stored rows can't carry "" (the repo normalizes
    // it to absent), so a notes-less row IS the empty-notes case.
    await putMeta("bm-l1", { tags: ["l1"] });
    await putMeta("bm-l2", { notes: "l2 note" });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-k", "bm-l1", "bm-solo", "bm-l2"), "bm-k"),
    );
    expect(result.mergedMeta.notes).toBe(
      ["kept note", "l2 note"].join(MERGE_NOTES_SEPARATOR),
    );
    expect(result.mergedMeta.tags).toEqual(["l1"]);
  });

  it("keeps the kept item's category when it has one", async () => {
    await putMeta("bm-k", { category: "video" });
    await putMeta("bm-l1", { category: "docs" });
    await putMeta("bm-l2", { category: "tool" });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-k", "bm-l1", "bm-l2"), "bm-k"),
    );
    expect(result.mergedMeta.category).toBe("video");
    expect(await getMeta("bm-k")).toMatchObject({ category: "video" });
  });

  it("falls back to the first category found among the others, in group order", async () => {
    // Kept has no meta row at all; l2 precedes l1 in the group so its
    // category — not the alphabetically/numerically first one — wins.
    await putMeta("bm-l1", { category: "docs" });
    await putMeta("bm-l2", { category: "tool" });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-k", "bm-l2", "bm-l1"), "bm-k"),
    );
    expect(result.mergedMeta.category).toBe("tool");
    expect(await getMeta("bm-k")).toMatchObject({ category: "tool" });
  });

  it("writes the merged row even when the kept bookmark had no meta", async () => {
    await putMeta("bm-l1", { tags: ["a", "b"] });
    await putMeta("bm-l2", { tags: ["b", "c"], notes: "l2 note" });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-k", "bm-l1", "bm-l2"), "bm-k"),
    );
    expect(result.mergedMeta).toEqual({
      tags: ["a", "b", "c"],
      notes: "l2 note",
    });
    expect(await getMeta("bm-k")).toMatchObject({
      tags: ["a", "b", "c"],
      notes: "l2 note",
    });
  });
});

// ---------------------------------------------------------------------------
// Tree effects and the merge snapshot
// ---------------------------------------------------------------------------

describe("mergeGroup — tree effects", () => {
  it("removes the non-kept members and their meta rows; the kept node is untouched", async () => {
    await putMeta("bm-l1", { tags: ["l1"] });
    await putMeta("bm-l2", { notes: "l2" });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-k", "bm-l1", "bm-l2"), "bm-k"),
    );
    expect(result.removedIds).toEqual(["bm-l1", "bm-l2"]);
    await expect(get("bm-l1")).rejects.toThrow('Can\'t find bookmark');
    await expect(get("bm-l2")).rejects.toThrow('Can\'t find bookmark');
    // merge cleans the losers' sidecar rows itself — no listener needed.
    expect(await getMeta("bm-l1")).toBeUndefined();
    expect(await getMeta("bm-l2")).toBeUndefined();
    // The kept bookmark sits exactly where it was.
    expect(await barChildIds()).toEqual(["bm-k", "bm-solo"]);
    expect((await get("bm-k"))[0]).toMatchObject({
      title: "Keep",
      url: "https://example.com/page",
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
    });
  });

  it("pushes a kind:'merge' snapshot holding the losers' nodes plus every touched meta row", async () => {
    await putMeta("bm-k", { tags: ["keep"], notes: "k note" });
    await putMeta("bm-l1", { tags: ["l1"] });
    // bm-l2 has no meta row — nothing captured for it.
    expectMergeOk(await mergeGroup(groupOf("bm-k", "bm-l1", "bm-l2"), "bm-k"));

    const snapshot = await peekLatest();
    expect(snapshot?.kind).toBe("merge");
    // Only the losers' nodes; the kept node rides in meta as a SURVIVOR row.
    expect(snapshot?.nodes.map((n) => n.id)).toEqual(["bm-l1", "bm-l2"]);
    expect(snapshot?.nodes[0]).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      index: 1,
      title: "L1",
      url: "https://example.com/page",
    });
    expect(snapshot?.nodes[1]).toMatchObject({
      parentId: BOOKMARKS_BAR_ID,
      index: 2,
      title: "L2",
    });
    const metaIds = (snapshot?.meta ?? []).map((m) => m.id).sort();
    expect(metaIds).toEqual(["bm-k", "bm-l1"]);
    // The survivor row carries the kept node's PRE-merge values.
    expect(snapshot?.meta.find((m) => m.id === "bm-k")).toMatchObject({
      tags: ["keep"],
      notes: "k note",
    });
  });
});

// ---------------------------------------------------------------------------
// Undo round-trips
// ---------------------------------------------------------------------------

describe("mergeGroup — undo", () => {
  it("restores the removed bookmarks and the kept node's pre-merge meta", async () => {
    await putMeta("bm-k", { tags: ["keep"], notes: "kept note" });
    await putMeta("bm-l1", { tags: ["l1"], category: "docs" });
    await putMeta("bm-l2", { tags: ["l2"], notes: "l2 note" });
    expectMergeOk(await mergeGroup(groupOf("bm-k", "bm-l1", "bm-l2"), "bm-k"));
    // The merge applied: unioned tags/notes, first-found category.
    expect(await getMeta("bm-k")).toMatchObject({
      tags: ["keep", "l1", "l2"],
      notes: ["kept note", "l2 note"].join(MERGE_NOTES_SEPARATOR),
      category: "docs",
    });

    const undo = expectUndoOk(await undoLatest());
    const newL1 = undo.idMap["bm-l1"];
    const newL2 = undo.idMap["bm-l2"];
    expect(newL1).toBeDefined();
    expect(newL2).toBeDefined();
    // Losers recreated at their original parent+index positions.
    expect(await barChildIds()).toEqual([
      "bm-k",
      newL1,
      newL2,
      "bm-solo",
    ]);
    expect((await get(newL1 as string))[0]).toMatchObject({
      title: "L1",
      url: "https://example.com/page",
    });
    // Losers' own meta rows restored under their new ids.
    expect(await getMeta(newL1 as string)).toMatchObject({
      tags: ["l1"],
      category: "docs",
    });
    expect(await getMeta(newL2 as string)).toMatchObject({
      tags: ["l2"],
      notes: "l2 note",
    });
    // The kept node's pre-merge meta is restored under its unchanged id:
    // merged tags/notes are gone and the borrowed category is cleared.
    const kept = await getMeta("bm-k");
    expect(kept).toMatchObject({ tags: ["keep"], notes: "kept note" });
    expect(kept?.category).toBeUndefined();
    expect(await peekLatest()).toBeUndefined(); // popped on success
  });

  it("deletes the merged row on undo when the kept bookmark had no meta before", async () => {
    await putMeta("bm-l1", { tags: ["l1"] });
    expectMergeOk(await mergeGroup(groupOf("bm-k", "bm-l1"), "bm-k"));
    expect(await getMeta("bm-k")).toMatchObject({ tags: ["l1"] });
    // The empty survivor row is what lets undo delete the merged row.
    expect(
      (await listSnapshots())[0]?.meta.find((m) => m.id === "bm-k"),
    ).toMatchObject({ id: "bm-k", tags: [] });

    const undo = expectUndoOk(await undoLatest());
    const newL1 = undo.idMap["bm-l1"] as string;
    expect(await getMeta(newL1)).toMatchObject({ tags: ["l1"] });
    // Pre-merge state had no row for bm-k — undo removes the merged row.
    expect(await getMeta("bm-k")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("mergeGroup — failures", () => {
  it("rejects a keepId that is not a group member without mutating anything", async () => {
    await putMeta("bm-k", { tags: ["keep"] });
    const result = await mergeGroup(groupOf("bm-l1", "bm-l2"), "bm-k");
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(await listSnapshots()).toEqual([]);
    expect(await barChildIds()).toEqual([
      "bm-k",
      "bm-l1",
      "bm-l2",
      "bm-solo",
    ]);
    expect(await getMeta("bm-k")).toMatchObject({ tags: ["keep"] });
  });

  it("rejects a group of fewer than two members", async () => {
    const result = await mergeGroup(groupOf("bm-k"), "bm-k");
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(await listSnapshots()).toEqual([]);
    expect(await barChildIds()).toEqual([
      "bm-k",
      "bm-l1",
      "bm-l2",
      "bm-solo",
    ]);
  });

  it("reports not_found when the kept bookmark is gone — patchMeta would grow an orphan row", async () => {
    const result = await mergeGroup(groupOf("ghost", "bm-l1"), "ghost");
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(await listSnapshots()).toEqual([]);
    expect(await barChildIds()).toEqual([
      "bm-k",
      "bm-l1",
      "bm-l2",
      "bm-solo",
    ]);
  });

  it("fails typed when a loser sits in a managed subtree; the pushed snapshot covers the partial merge", async () => {
    await putMeta("bm-k", { tags: ["keep"], notes: "k note" });
    await putMeta("bm-l1", { tags: ["l1"] });
    // bm-l1 is removed before the managed loser rejects — the merge is
    // partial but fully snapshotted, so nothing is unrecoverable.
    const result = await mergeGroup(
      groupOf("bm-k", "bm-l1", "bm-managed"),
      "bm-k",
    );
    expect(result).toMatchObject({ ok: false, code: "managed" });
    await expect(get("bm-l1")).rejects.toThrow('Can\'t find bookmark');
    expect(await getMeta("bm-l1")).toBeUndefined(); // removed rows still cleaned
    expect((await get("bm-managed"))[0]).toBeDefined(); // managed loser intact
    expect(await getMeta("bm-k")).toMatchObject({ tags: ["keep", "l1"] });
    const snapshot = await peekLatest();
    expect(snapshot?.kind).toBe("merge");
    expect(snapshot?.nodes.map((n) => n.id)).toEqual([
      "bm-l1",
      "bm-managed",
    ]);

    // Undo: bm-managed was never deleted, so its live original id is skipped
    // — the managed destination is never touched — while bm-l1 IS recreated
    // under a fresh Chrome id, exactly once and at its recorded position.
    const undo = expectUndoOk(await undoLatest());
    const newL1 = undo.idMap["bm-l1"];
    expect(newL1).toBeDefined();
    expect(newL1).not.toBe("bm-l1");
    expect(undo.idMap["bm-managed"]).toBeUndefined();
    expect(await barChildIds()).toEqual(["bm-k", newL1, "bm-l2", "bm-solo"]);
    expect((await get("bm-managed"))[0]).toBeDefined(); // still itself
    // bm-l1's meta row rides the remap onto the new id; the kept node's
    // pre-merge row is restored too.
    expect(await getMeta(newL1 as string)).toMatchObject({ tags: ["l1"] });
    expect(await getMeta("bm-k")).toMatchObject({
      tags: ["keep"],
      notes: "k note",
    });
    expect(await peekLatest()).toBeUndefined(); // popped on success
  });

  it("rejects a folder loser before mutating anything — groups are leaf-only", async () => {
    // A folder in `others` would make removeTree delete its whole subtree
    // (possibly including the kept node) and leak descendant meta rows.
    const folder = await createFolder({
      parentId: BOOKMARKS_BAR_ID,
      title: "Folder loser",
    });
    await putMeta("bm-k", { tags: ["keep"] });
    const result = await mergeGroup(groupOf("bm-k", folder.id), "bm-k");
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    // Nothing mutated: no snapshot, no meta change, folder intact.
    expect(await listSnapshots()).toEqual([]);
    expect(await getMeta("bm-k")).toMatchObject({ tags: ["keep"] });
    expect((await get(folder.id))[0]).toBeDefined();
    expect(await barChildIds()).toEqual([
      "bm-k",
      "bm-l1",
      "bm-l2",
      "bm-solo",
      folder.id,
    ]);
  });

  it("does not union meta of members that vanished before the merge", async () => {
    // A stale meta row survives for a node that no longer exists — it must
    // not leak onto the kept bookmark.
    await putMeta("ghost-loser", {
      tags: ["ghosttag"],
      notes: "ghost note",
    });
    await putMeta("bm-l1", { tags: ["l1"] });
    const result = expectMergeOk(
      await mergeGroup(groupOf("bm-k", "bm-l1", "ghost-loser"), "bm-k"),
    );
    expect(result.mergedMeta.tags).toEqual(["l1"]);
    expect(result.mergedMeta.notes).toBeUndefined();
    expect(result.removedIds).toEqual(["bm-l1"]);
    expect(await getMeta("bm-k")).toMatchObject({ tags: ["l1"] });
  });

  it("leaves live losers untouched on undo when the merge failed before removals", async () => {
    // Joined notes exceed the 10k meta cap: patchMeta throws invalid_meta
    // AFTER the snapshot was pushed, so nothing was ever removed. Replaying
    // the snapshot must not duplicate the live losers.
    await putMeta("bm-l1", { notes: "x".repeat(6000) });
    await putMeta("bm-l2", { notes: "y".repeat(6000) });
    const result = await mergeGroup(
      groupOf("bm-k", "bm-l1", "bm-l2"),
      "bm-k",
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_meta" });
    expect(await barChildIds()).toEqual(["bm-k", "bm-l1", "bm-l2", "bm-solo"]);

    const undo = expectUndoOk(await undoLatest());
    expect(undo.idMap).toEqual({}); // nothing was recreated
    // Both losers still exist exactly once — replay created no duplicates.
    expect(await barChildIds()).toEqual(["bm-k", "bm-l1", "bm-l2", "bm-solo"]);
    expect(await peekLatest()).toBeUndefined();
  });

  it("does not duplicate a loser whose removeTree failed when the merge is undone", async () => {
    await putMeta("bm-l1", { tags: ["l1"] });
    const removeSpy = vi
      .spyOn(fake, "removeTree")
      .mockRejectedValueOnce(new Error("chrome boom"));
    const result = await mergeGroup(groupOf("bm-k", "bm-l1"), "bm-k");
    expect(result).toMatchObject({ ok: false, code: "api" });
    expect(removeSpy).toHaveBeenCalledTimes(1);
    // bm-l1 was never removed — the loser is still live.
    expect(await barChildIds()).toEqual(["bm-k", "bm-l1", "bm-l2", "bm-solo"]);
    removeSpy.mockRestore();

    const undo = expectUndoOk(await undoLatest());
    // The live loser is skipped — no duplicate is created for it.
    expect(undo.idMap["bm-l1"]).toBeUndefined();
    expect(await barChildIds()).toEqual(["bm-k", "bm-l1", "bm-l2", "bm-solo"]);
    expect(
      (await barChildIds()).filter((id) => id === "bm-l1"),
    ).toHaveLength(1);
    expect(await getMeta("bm-l1")).toMatchObject({ tags: ["l1"] });
    expect(await peekLatest()).toBeUndefined();
  });
});
