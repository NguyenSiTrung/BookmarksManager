import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  countInvalidMetaRows,
  getMeta,
  getMetaIntegrity,
  listMeta,
  putMeta,
} from "../../src/db/meta";
import {
  pruneTombstones,
  reattachTombstone,
  TOMBSTONE_ROW_CAP,
} from "../../src/db/tombstones";
import { reconcileMetadata } from "../../src/sync/reconcile";
import { registerBookmarkListeners } from "../../src/sync/listeners";
import { OTHER_BOOKMARKS_ID } from "../../src/sync/chrome-bookmarks";
import { pushSnapshot } from "../../src/undo/snapshot";
import { restoreById } from "../../src/undo/restore";
import { createFakeBookmarks, type FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * D12 tombstones + D13 schema-version coverage.
 *
 * Tombstone path: `onRemoved` keys each removed leaf's meta row under its
 * URL; `onCreated` (or the startup reconcile for slept creates) re-attaches
 * it inside the 30-day window. Undo `nodeExists` verifies id AND url so a
 * re-used id pointing at a different bookmark counts as dead.
 *
 * Integrity path: writes stamp `schemaVersion: 1`; rows failing the schema
 * are counted + surfaced under `metaIntegrity`, and an unreadable row is
 * retained to `corruptMeta` before any overwrite/delete touches it.
 */

let fake: FakeBookmarksApi;

function install(options: Parameters<typeof createFakeBookmarks>[0] = {}) {
  fake = createFakeBookmarks(options);
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: { sendMessage: vi.fn(() => Promise.resolve(undefined)) },
  });
  return fake;
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.metaTombstones.clear();
  await db.corruptMeta.clear();
  await db.metadata.clear();
  await db.decisions.clear();
  await db.undo.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

const ISO = "2026-10-04T10:00:00.000Z";

describe("tombstones (D12)", () => {
  it("removing then re-creating a bookmark with the same URL re-attaches tags/notes", async () => {
    const f = install({
      bookmarksBar: [{ id: "bm-1", title: "A", url: "https://a.example/" }],
    });
    registerBookmarkListeners();
    await putMeta("bm-1", { tags: ["docs"], notes: "keep me", url: "https://a.example/" });

    await f.remove("bm-1");
    await vi.waitFor(async () => {
      expect(await getMeta("bm-1")).toBeUndefined();
      expect(await db.metaTombstones.get("https://a.example/")).toBeDefined();
    });

    const created = await f.create({ parentId: "1", title: "A", url: "https://a.example/" });
    await vi.waitFor(async () => {
      const meta = await getMeta(created.id);
      expect(meta?.tags).toEqual(["docs"]);
      expect(meta?.notes).toBe("keep me");
    });
    // The tombstone is consumed and the new row carries the URL.
    expect(await db.metaTombstones.get("https://a.example/")).toBeUndefined();
    expect((await getMeta(created.id))?.url).toBe("https://a.example/");
    expect((await getMeta(created.id))?.schemaVersion).toBe(1);
  });

  it("cascades a removed folder subtree into tombstones for each leaf", async () => {
    const f = install({
      bookmarksBar: [
        {
          id: "fld",
          title: "F",
          children: [
            { id: "l1", title: "1", url: "https://1.example/" },
            { id: "l2", title: "2", url: "https://2.example/" },
          ],
        },
      ],
    });
    registerBookmarkListeners();
    await putMeta("l1", { tags: ["a"] });
    await putMeta("l2", { notes: "n2" });
    await putMeta("fld", { notes: "folder meta" }); // folder meta rows can exist

    await f.removeTree("fld");
    await vi.waitFor(async () => {
      expect(await db.metaTombstones.count()).toBe(2);
    });
    // Folder row (no URL to key under) is gone; leaf fields tombstoned.
    expect(await getMeta("fld")).toBeUndefined();
    expect((await db.metaTombstones.get("https://1.example/"))?.tags).toEqual(["a"]);
    expect((await db.metaTombstones.get("https://2.example/"))?.notes).toBe("n2");
  });

  it("prunes tombstones at the 30-day retention and refuses expired re-attach", async () => {
    install();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await db.metaTombstones.put({
      url: "https://old.example/",
      tags: ["x"],
      deadId: "dead-1",
      removedAt: old,
    });
    await db.metaTombstones.put({
      url: "https://fresh.example/",
      tags: ["y"],
      deadId: "dead-2",
      removedAt: ISO,
    });
    expect(await pruneTombstones()).toBe(1);
    expect(await db.metaTombstones.get("https://old.example/")).toBeUndefined();
    expect(await db.metaTombstones.get("https://fresh.example/")).toBeDefined();

    // A manually seeded expired row re-attaches nothing and is consumed.
    await db.metaTombstones.put({
      url: "https://stale.example/",
      tags: ["z"],
      deadId: "dead-3",
      removedAt: old,
    });
    expect(await reattachTombstone("new-id", "https://stale.example/")).toBe(false);
    expect(await getMeta("new-id")).toBeUndefined();
    expect(await db.metaTombstones.get("https://stale.example/")).toBeUndefined();
  });

  it("evicts the oldest rows beyond the row cap", async () => {
    install();
    const base = Date.now() - TOMBSTONE_ROW_CAP;
    const rows = Array.from({ length: TOMBSTONE_ROW_CAP + 2 }, (_, i) => ({
      url: `https://u${i}.example/`,
      tags: ["t"],
      deadId: `d${i}`,
      removedAt: new Date(base + i).toISOString(),
    }));
    await db.metaTombstones.bulkPut(rows);
    await pruneTombstones();
    expect(await db.metaTombstones.count()).toBe(TOMBSTONE_ROW_CAP);
    // The two oldest are gone; the newest survive.
    expect(await db.metaTombstones.get("https://u0.example/")).toBeUndefined();
    expect(await db.metaTombstones.get("https://u1.example/")).toBeUndefined();
    expect(await db.metaTombstones.get(`https://u${TOMBSTONE_ROW_CAP + 1}.example/`)).toBeDefined();
  });

  it("never clobbers a live meta row — the fresher row wins, tombstone consumed", async () => {
    install();
    await db.metaTombstones.put({
      url: "https://a.example/",
      tags: ["old"],
      deadId: "dead-1",
      removedAt: ISO,
    });
    await putMeta("live-9", { tags: ["fresh"] });
    expect(await reattachTombstone("live-9", "https://a.example/")).toBe(false);
    expect((await getMeta("live-9"))?.tags).toEqual(["fresh"]);
    expect(await db.metaTombstones.get("https://a.example/")).toBeUndefined();
  });

  it("attaches over an unreadable incumbent — invalid counts as absent (D13)", async () => {
    install();
    await db.metaTombstones.put({
      url: "https://a.example/",
      tags: ["kept"],
      deadId: "dead-1",
      removedAt: ISO,
    });
    // An unparseable incumbent is "absent" like every other read path —
    // the attach proceeds and its copy lands in corruptMeta on overwrite.
    await db.bookmarkMeta.put({
      id: "new-7",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    expect(await reattachTombstone("new-7", "https://a.example/")).toBe(true);
    expect((await getMeta("new-7"))?.tags).toEqual(["kept"]);
    const copies = await db.corruptMeta.toArray();
    expect(copies).toHaveLength(1);
    expect(copies[0]?.bookmarkId).toBe("new-7");
  });

  it("reconcile re-attaches a tombstone onto a node created while the worker slept", async () => {
    install({
      bookmarksBar: [{ id: "bm-new", title: "A", url: "https://a.example/" }],
    });
    await db.metaTombstones.put({
      url: "https://a.example/",
      tags: ["docs"],
      notes: "slept",
      deadId: "dead-1",
      removedAt: ISO,
    });
    // The live id has no meta row — reconcile closes the missed onCreated.
    await reconcileMetadata();
    const meta = await getMeta("bm-new");
    expect(meta?.tags).toEqual(["docs"]);
    expect(meta?.notes).toBe("slept");
    expect(await db.metaTombstones.get("https://a.example/")).toBeUndefined();
  });

  it("reconcile tombstones orphans carrying a url instead of dropping them", async () => {
    install({
      bookmarksBar: [{ id: "live", title: "L", url: "https://live.example/" }],
    });
    await putMeta("live", { tags: ["t"] });
    await putMeta("orphan", { tags: ["kept"], url: "https://gone.example/" });
    await putMeta("orphan-nourl", { tags: ["lost"] });

    expect(await reconcileMetadata()).toBe(2);
    expect(await getMeta("live")).toBeDefined();
    const tombstone = await db.metaTombstones.get("https://gone.example/");
    expect(tombstone?.tags).toEqual(["kept"]);
    expect(tombstone?.deadId).toBe("orphan");
    // No url to key under — the row is reaped without a tombstone.
    expect(await getMeta("orphan-nourl")).toBeUndefined();
    expect((await listMeta()).map((m) => m.id)).toEqual(["live"]);
  });

  it("undo nodeExists rejects a live id pointing at a different URL", async () => {
    install({
      otherBookmarks: [
        // The id survives but the bookmark behind it does not — Chrome
        // never reuses ids in practice, but a repointed/re-seeded id must
        // not absorb the snapshot's node or meta row.
        { id: "dead-1", title: "Other", url: "https://other.example/" },
      ],
    });
    const snapshotId = await pushSnapshot({
      kind: "delete",
      nodes: [
        {
          id: "dead-1",
          title: "Gone",
          url: "https://gone.example/",
          parentId: OTHER_BOOKMARKS_ID,
          index: 0,
        },
      ],
      meta: [
        {
          id: "dead-1",
          tags: ["x"],
          url: "https://gone.example/",
          updatedAt: ISO,
        },
      ],
    });
    const result = await restoreById(snapshotId);
    expect(result.ok).toBe(true);
    // The repointed id kept its own identity — no meta attached to it.
    expect(await getMeta("dead-1")).toBeUndefined();
    // The node was recreated fresh; its meta followed the new id.
    const node = (await fake.getChildren(OTHER_BOOKMARKS_ID)).find(
      (n) => n.url === "https://gone.example/",
    );
    expect(node).toBeDefined();
    expect(node?.id).not.toBe("dead-1");
    expect((await getMeta(node!.id))?.tags).toEqual(["x"]);
  });
});

describe("schemaVersion + corrupt retention (D13)", () => {
  it("stamps schemaVersion on writes and still reads rows without it", async () => {
    install();
    // A pre-D13 row shape: valid except no schemaVersion/url.
    await db.bookmarkMeta.put({
      id: "old-1",
      tags: ["t"],
      updatedAt: ISO,
    });
    const read = await getMeta("old-1");
    expect(read?.tags).toEqual(["t"]);
    expect(read?.schemaVersion).toBeUndefined();

    await putMeta("old-1", { tags: ["u"] });
    expect((await getMeta("old-1"))?.schemaVersion).toBe(1);
  });

  it("counts invalid rows and surfaces them under metaIntegrity", async () => {
    install({
      bookmarksBar: [{ id: "live", title: "L", url: "https://live.example/" }],
    });
    await putMeta("live", { tags: ["ok"] });
    // Corrupt the live row post-write (validate-on-write can't produce it).
    await db.bookmarkMeta.update("live", { tags: ["Not A Key"] });
    expect(await countInvalidMetaRows()).toBe(1);

    await reconcileMetadata();
    const integrity = await getMetaIntegrity();
    expect(integrity?.invalidRows).toBe(1);
    // Live invalid rows are kept — reads treat them as absent only.
    expect(await getMeta("live")).toBeUndefined();
  });

  it("retains a copy before overwriting an unparseable row", async () => {
    install();
    await db.bookmarkMeta.put({
      id: "bad",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    await putMeta("bad", { tags: ["fixed"] });
    const copies = await db.corruptMeta.toArray();
    expect(copies).toHaveLength(1);
    expect(copies[0]?.bookmarkId).toBe("bad");
    expect(copies[0]?.reason).toBe("overwrite");
    expect((copies[0]?.raw as { tags: unknown }).tags).toEqual(["Not A Key"]);
    expect((await getMeta("bad"))?.tags).toEqual(["fixed"]);
  });

  it("retains invalid orphans at reconcile instead of dropping them", async () => {
    install({
      bookmarksBar: [{ id: "live", title: "L", url: "https://live.example/" }],
    });
    await db.bookmarkMeta.put({
      id: "dead-bad",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    const reaped = await reconcileMetadata();
    expect(reaped).toBe(1);
    const copies = await db.corruptMeta.toArray();
    expect(copies).toHaveLength(1);
    expect(copies[0]?.reason).toBe("reconcile");
    const integrity = await getMetaIntegrity();
    expect(integrity?.invalidRows).toBe(0);
    expect(integrity?.corruptRows).toBe(1);
  });

  it("does not keep a row alive on url alone (lazy-row rule unchanged)", async () => {
    install();
    expect(await putMeta("lazy", { url: "https://only.example/" })).toBeUndefined();
    expect(await getMeta("lazy")).toBeUndefined();
    // url merges through patchMeta too — but never by itself.
    expect(await listMeta()).toEqual([]);
  });
});
