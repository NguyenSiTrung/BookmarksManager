import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { get } from "../../src/sync/chrome-bookmarks";
import { removeTree } from "../../src/sync/mutations";
import { discardById, discardLatest, undoLatest } from "../../src/undo/restore";
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
