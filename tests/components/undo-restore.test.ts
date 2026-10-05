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

beforeEach(async () => {
  await db.open();
  await db.undo.clear();
  installBookmarksFake({
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
