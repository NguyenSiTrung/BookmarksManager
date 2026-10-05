import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  BOOKMARKS_BAR_ID,
  get,
  getChildren,
  OTHER_BOOKMARKS_ID,
} from "../../src/sync/chrome-bookmarks";
import { moveNode, removeTree } from "../../src/sync/mutations";
import {
  discardById,
  discardLatest,
  restoreById,
  undoLatest,
} from "../../src/undo/restore";
import {
  captureSubtree,
  peekLatest,
  pushSnapshot,
} from "../../src/undo/snapshot";
import type { UndoNode } from "../../src/schemas/undo";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * P4 review fix #2 — `discardById`.
 *
 * The delete/move flows push a snapshot and, when the mutation turns out to
 * be a no-op, discard it again. `pushSnapshot` is NOT part of `restore.ts`'s
 * serialized stack queue, so a flow's `discardLatest()` can pop a snapshot a
 * CONCURRENT flow pushed on top. `discardById` drops the exact row
 * `pushSnapshot` returned instead, so interleaved flows never clobber each
 * other.
 */

let fake: FakeBookmarksApi;

beforeEach(async () => {
  await db.open();
  await db.undo.clear();
  fake = installBookmarksFake({
    bookmarksBar: [
      { id: "bm-a", title: "A", url: "https://a.example/" },
      { id: "bm-b", title: "B", url: "https://b.example/" },
    ],
    otherBookmarks: [
      { id: "bm-c", title: "C", url: "https://c.example/" },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

describe("discardById", () => {
  it("drops the specific row so an interleaved snapshot survives and is undoable", async () => {
    // Flow A pushes a delete snapshot for bm-a …
    const captureA = await captureSubtree("bm-a");
    expect(captureA).toBeDefined();
    const idA = await pushSnapshot({
      kind: "delete",
      nodes: [captureA!.node],
      meta: [],
    });

    // … then flow B pushes its own (unrelated) snapshot on top.
    const captureB = await captureSubtree("bm-c");
    expect(captureB).toBeDefined();
    const idB = await pushSnapshot({
      kind: "delete",
      nodes: [captureB!.node],
      meta: [],
    });
    expect(idB).not.toBe(idA);

    await removeTree("bm-a");
    await removeTree("bm-c");

    // A's cleanup discards BY ID — B's snapshot must stay.
    const discarded = await discardById(idA);
    expect(discarded).toMatchObject({ ok: true, discardedId: idA });
    expect((await peekLatest())?.id).toBe(idB);

    // B is still undoable: its node comes back (fresh Chrome id), A's stays
    // gone — only B's snapshot survived the by-id discard.
    const result = await undoLatest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.idMap["bm-c"]).toBeDefined();
    expect(result.idMap["bm-a"]).toBeUndefined();
    await expect(get("bm-a")).rejects.toThrow();
    expect(await peekLatest()).toBeUndefined();
  });

  it("reports empty for a row id that is not on the stack", async () => {
    expect(await discardById(999)).toMatchObject({ ok: false, code: "empty" });
  });

  it("leaves discardLatest intact (head-only escape hatch)", async () => {
    const capture = await captureSubtree("bm-a");
    await pushSnapshot({ kind: "delete", nodes: [capture!.node], meta: [] });
    const capture2 = await captureSubtree("bm-c");
    const idB = await pushSnapshot({
      kind: "delete",
      nodes: [capture2!.node],
      meta: [],
    });
    const result = await discardLatest();
    expect(result).toMatchObject({ ok: true, discardedId: idB });
  });
});

describe("restoreById (D07 — targeted undo)", () => {
  it("reverts the advertised delete while a newer move snapshot stays", async () => {
    // "Delete in panel A, move in panel B, Undo in A": A's toast carries
    // idA; B's move pushed on top. `undoLatest` would replay the move —
    // `restoreById` must revert exactly the delete it advertised.
    const captureA = await captureSubtree("bm-a");
    const idA = await pushSnapshot({
      kind: "delete",
      nodes: [captureA!.node],
      meta: [],
    });
    await removeTree("bm-a");

    const captureC = await captureSubtree("bm-c");
    const idB = await pushSnapshot({
      kind: "bulk_move",
      nodes: [
        { ...captureC!.node, movedToParentId: BOOKMARKS_BAR_ID },
      ],
      meta: [],
    });
    await moveNode("bm-c", { parentId: BOOKMARKS_BAR_ID });

    const result = await restoreById(idA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The delete reverted (fresh Chrome id); the move is untouched.
    const recreated = result.idMap["bm-a"];
    expect(recreated).toBeDefined();
    const restored = await get(recreated!);
    expect(restored[0]?.title).toBe("A");
    expect(await get("bm-c")).toMatchObject([
      { parentId: BOOKMARKS_BAR_ID },
    ]);

    // …and B's snapshot is still the head — its own undo replays it.
    expect((await peekLatest())?.id).toBe(idB);
    const undone = await undoLatest();
    expect(undone.ok).toBe(true);
    expect(await get("bm-c")).toMatchObject([
      { parentId: OTHER_BOOKMARKS_ID },
    ]);
  });

  it("reports empty for a row already consumed", async () => {
    const capture = await captureSubtree("bm-a");
    const id = await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: [],
    });
    await discardById(id);
    expect(await restoreById(id)).toMatchObject({
      ok: false,
      code: "empty",
    });
  });

  it("bulk_move undo skips a node moved AGAIN since the snapshot (D09)", async () => {
    // The snapshotted move sent bm-c to the bar; the user then dragged it
    // to Mobile bookmarks instead. Undoing the recorded move must NOT yank
    // it back to Other bookmarks — that would clobber the newer placement.
    const captureC = await captureSubtree("bm-c");
    const id = await pushSnapshot({
      kind: "bulk_move",
      nodes: [
        { ...captureC!.node, movedToParentId: BOOKMARKS_BAR_ID },
      ],
      meta: [],
    });
    await moveNode("bm-c", { parentId: BOOKMARKS_BAR_ID });
    await moveNode("bm-c", { parentId: "3" }); // moved again, off-target

    expect((await restoreById(id)).ok).toBe(true);
    expect(await get("bm-c")).toMatchObject([{ parentId: "3" }]);
    expect((await getChildren("3")).map((n) => n.id)).toContain("bm-c");
  });

  it("bulk_move undo still replays a node that stayed put (D09 back-compat)", async () => {
    const captureC = await captureSubtree("bm-c");
    const id = await pushSnapshot({
      kind: "bulk_move",
      nodes: [
        { ...captureC!.node, movedToParentId: BOOKMARKS_BAR_ID },
      ],
      meta: [],
    });
    await moveNode("bm-c", { parentId: BOOKMARKS_BAR_ID });

    expect((await restoreById(id)).ok).toBe(true);
    expect(await get("bm-c")).toMatchObject([
      { parentId: OTHER_BOOKMARKS_ID },
    ]);
  });

  it("rows without movedToParentId keep unconditional restore (older rows)", async () => {
    const captureC = await captureSubtree("bm-c");
    const id = await pushSnapshot({
      kind: "bulk_move",
      nodes: [captureC!.node],
      meta: [],
    });
    await moveNode("bm-c", { parentId: BOOKMARKS_BAR_ID });
    await moveNode("bm-c", { parentId: "3" });

    expect((await restoreById(id)).ok).toBe(true);
    // Absent marker = pre-D09 row: unconditional move-back semantics.
    expect(await get("bm-c")).toMatchObject([
      { parentId: OTHER_BOOKMARKS_ID },
    ]);
  });
});

// ---------------------------------------------------------------------------
// D08 — linear-time restore
// ---------------------------------------------------------------------------

/** 50 folders × 100 leaves under one root = 5051 nodes. */
function bigTree(): UndoNode {
  const folders: UndoNode[] = [];
  for (let f = 0; f < 50; f += 1) {
    const children: UndoNode[] = [];
    for (let i = 0; i < 100; i += 1) {
      children.push({
        id: `n-${f}-${i}`,
        parentId: `f-${f}`,
        index: i,
        title: `L${f}-${i}`,
        url: `https://l${f}-${i}.example/`,
      });
    }
    folders.push({
      id: `f-${f}`,
      parentId: "big-root",
      index: f,
      title: `F${f}`,
      children,
    });
  }
  return {
    id: "big-root",
    parentId: BOOKMARKS_BAR_ID,
    index: 0,
    title: "Big",
    children: folders,
  };
}
const BIG_TREE_NODES = 5051;

describe("linear-time restore (D08)", () => {
  it("a 5k-node subtree costs one getChildren per folder and batched idMap writes", async () => {
    const rowId = await pushSnapshot({
      kind: "delete",
      nodes: [bigTree()],
      meta: [],
    });
    const childrenSpy = vi.spyOn(fake, "getChildren");
    // `db.undo.where` is only reached by persistProgress's batched flush —
    // every other stack read in the replay path uses `get`/`toCollection`.
    const writeSpy = vi.spyOn(db.undo, "where");

    const result = await restoreById(rowId);
    expect(result.ok).toBe(true);
    expect((result as { restoredIds: string[] }).restoredIds).toHaveLength(
      BIG_TREE_NODES,
    );

    // One read for the recorded parent — recreated folders seed their own
    // count (a fresh folder is empty by construction), so the 51 internal
    // folders never hit the API at all.
    expect(childrenSpy).toHaveBeenCalledTimes(1);
    expect(childrenSpy).toHaveBeenLastCalledWith(BOOKMARKS_BAR_ID);
    // 5051 mappings / batch of 50 → 101 flushes, not 5051 writes (the
    // last partial batch rides pop-on-success, which deletes the row).
    expect(writeSpy).toHaveBeenCalledTimes(Math.floor(BIG_TREE_NODES / 50));

    await expect(get("big-root")).rejects.toThrow(); // old id is dead…
    const recreated = (await getChildren(BOOKMARKS_BAR_ID)).find(
      (node) => node.title === "Big",
    );
    expect(recreated).toBeDefined();
    expect((await getChildren(recreated!.id))).toHaveLength(50);
  });

  it("a failed 5k restore resumes with zero duplicated nodes", async () => {
    const rowId = await pushSnapshot({
      kind: "delete",
      nodes: [bigTree()],
      meta: [],
    });
    let attempts = 0;
    let created = 0;
    const realCreate = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) => {
      attempts += 1;
      if (attempts === 120) {
        throw new Error("controlled create failure");
      }
      created += 1;
      return realCreate(details);
    });

    const first = await restoreById(rowId);
    expect(first.ok).toBe(false);
    // The failure flushed buffered progress — every create before the
    // throw is on the resume anchor.
    const row = await db.undo.get(rowId);
    expect(Object.keys(row?.idMap ?? {})).toHaveLength(119);

    vi.restoreAllMocks();
    vi.spyOn(fake, "create").mockImplementation((details) => {
      created += 1;
      return realCreate(details);
    });
    const second = await restoreById(rowId);
    expect(second.ok).toBe(true);
    // 119 pre-failure + 4932 resumed = 5051 creates, exactly once each.
    expect(created).toBe(BIG_TREE_NODES);
  });
});
