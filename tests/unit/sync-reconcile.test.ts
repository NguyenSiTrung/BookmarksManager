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
import { getMeta, listMeta, putMeta } from "../../src/db/meta";
import { reconcileMetadata } from "../../src/sync/reconcile";
import { Decision } from "../../src/schemas/decision";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

const ISO = "2026-09-26T10:00:00.000Z";

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.decisions.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

describe("reconcileMetadata", () => {
  it("preserves metadata created while the initial tree snapshot is held", async () => {
    const api = installBookmarksFake();
    await putMeta("ghost", { notes: "dead" });
    const snapshot = await api.getTree();
    const held = Promise.withResolvers<typeof snapshot>();
    const treeRead = vi.spyOn(api, "getTree").mockReturnValueOnce(held.promise);
    const cleanup = reconcileMetadata();
    await vi.waitFor(() => expect(treeRead).toHaveBeenCalledTimes(1));
    const created = await api.create({
      parentId: "1", title: "Concurrent", url: "https://concurrent.dev/",
    });
    await putMeta(created.id, { tags: [], summary: "Keep me." });
    held.resolve(snapshot);

    expect(await cleanup).toBe(1);
    expect((await getMeta(created.id))?.summary).toBe("Keep me.");
    expect(await getMeta("ghost")).toBeUndefined();
  });

  it("confirms old candidates against a current native tree before deleting", async () => {
    const api = installBookmarksFake({
      bookmarksBar: [{ id: "live", title: "Live", url: "https://live.dev/" }],
    });
    await putMeta("live", { tags: [], summary: "Still live." });
    await putMeta("ghost", { notes: "dead" });
    // The first response is an outdated but otherwise valid roots-only tree.
    const staleApi = installBookmarksFake();
    const stale = await staleApi.getTree();
    api.install();
    vi.spyOn(api, "getTree").mockResolvedValueOnce(stale);

    expect(await reconcileMetadata()).toBe(1);
    expect((await getMeta("live"))?.summary).toBe("Still live.");
    expect(await getMeta("ghost")).toBeUndefined();
  });

  it("preserves a candidate created while the confirming read is held", async () => {
    const api = installBookmarksFake();
    const stale = await api.getTree();
    await putMeta("1000", { tags: [], summary: "Retain during confirmation." });
    const held = Promise.withResolvers<typeof stale>();
    const read = vi.spyOn(api, "getTree")
      .mockResolvedValueOnce(stale)
      .mockReturnValueOnce(held.promise);
    const cleanup = reconcileMetadata();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const created = await api.create({
      parentId: "1", title: "Concurrent", url: "https://live.dev/",
    });
    expect(created.id).toBe("1000");
    held.resolve(await api.getTree());

    expect(await cleanup).toBe(0);
    expect((await getMeta(created.id))?.summary).toBe("Retain during confirmation.");
  });

  it("defers deletion on a rejecting or empty confirming read", async () => {
    for (const outcome of ["reject", "empty"] as const) {
      const api = installBookmarksFake();
      const tree = await api.getTree();
      await putMeta("ghost", { summary: "Preserve ambiguous state." });
      const read = vi.spyOn(api, "getTree").mockResolvedValueOnce(tree);
      if (outcome === "reject") read.mockRejectedValueOnce(new Error("Native read failed"));
      else read.mockResolvedValueOnce([]);

      expect(await reconcileMetadata(), outcome).toBe(0);
      expect((await getMeta("ghost"))?.summary, outcome).toBe("Preserve ambiguous state.");
    }
  });

  it("deletes rows whose ids are absent from the tree, keeps live rows", async () => {
    installBookmarksFake({
      bookmarksBar: [
        { id: "live-1", title: "L1", url: "https://l1.example/" },
        {
          id: "folder",
          title: "F",
          children: [
            { id: "live-2", title: "L2", url: "https://l2.example/" },
          ],
        },
      ],
      otherBookmarks: [
        { id: "live-3", title: "L3", url: "https://l3.example/" },
      ],
    });
    await putMeta("live-1", { notes: "1" });
    await putMeta("live-2", { tags: ["t"] });
    await putMeta("live-3", { category: "docs" });
    // Folder nodes may carry metadata too — "folder" is a live id.
    await putMeta("folder", { notes: "folder meta" });
    await putMeta("ghost-1", { notes: "dead" });
    await putMeta("ghost-2", { tags: ["dead"] });

    expect(await reconcileMetadata()).toBe(2);

    expect((await listMeta()).map((m) => m.id)).toEqual([
      "folder",
      "live-1",
      "live-2",
      "live-3",
    ]);
  });

  it("returns 0 when every meta row is backed by a live node", async () => {
    installBookmarksFake({
      bookmarksBar: [{ id: "a", title: "a", url: "https://a.example/" }],
    });
    await putMeta("a", { notes: "x" });

    expect(await reconcileMetadata()).toBe(0);
    expect(await getMeta("a")).toMatchObject({ id: "a", notes: "x" });
  });

  it("returns 0 on an empty metadata table", async () => {
    installBookmarksFake();
    expect(await reconcileMetadata()).toBe(0);
  });

  it("refuses to delete when the tree resolves completely empty", async () => {
    // A getTree() result with zero ids while rows are stored can only be a
    // failed/restricted read — a real mass delete still leaves the roots.
    vi.stubGlobal("chrome", {
      bookmarks: { getTree: vi.fn(async () => []) },
    });
    await putMeta("live-1", { notes: "keep" });
    await putMeta("live-2", { tags: ["keep"] });

    expect(await reconcileMetadata()).toBe(0);
    expect((await listMeta()).map((m) => m.id)).toEqual([
      "live-1",
      "live-2",
    ]);
  });

  it("still deletes orphans when the tree has roots but no live bookmarks", async () => {
    // Root-only tree = the user genuinely removed every bookmark — the
    // guard must NOT suppress this reconcile.
    installBookmarksFake();
    await putMeta("ghost", { notes: "dead" });

    expect(await reconcileMetadata()).toBe(1);
    expect(await listMeta()).toEqual([]);
  });

  it("reaps schema-invalid stored rows whose ids are dead", async () => {
    installBookmarksFake({
      bookmarksBar: [{ id: "live", title: "l", url: "https://l.example/" }],
    });
    await putMeta("live", { notes: "keep" });
    // Bypass the repo: a row that fails BookmarkMeta validation. Reads treat
    // it as absent, but its id is still dead weight reconcile should remove.
    await db.bookmarkMeta.put({
      id: "ghost",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });

    expect(await reconcileMetadata()).toBe(1);
    expect(await db.bookmarkMeta.get("ghost")).toBeUndefined();
    expect(await getMeta("live")).toMatchObject({ id: "live" });
  });

  it("keeps a schema-invalid row while its id is still live", async () => {
    installBookmarksFake({
      bookmarksBar: [{ id: "live", title: "l", url: "https://l.example/" }],
    });
    await db.bookmarkMeta.put({
      id: "live",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });

    // The bookmark still exists — only absent ids are reaped. Reads already
    // treat the corrupt row as absent, so keeping it is harmless.
    expect(await reconcileMetadata()).toBe(0);
    expect(await db.bookmarkMeta.get("live")).not.toBeUndefined();
  });

  it("sweeps reviewable decisions whose real ids are dead — even with no meta orphans (J14)", async () => {
    installBookmarksFake({
      bookmarksBar: [
        { id: "live", title: "Live", url: "https://live.dev/" },
      ],
    });
    const row = (status: Decision["status"], bookmarkIds: string[]): Decision =>
      Decision.parse({
        id: crypto.randomUUID(),
        bookmarkIds,
        confidence: 0.9,
        status,
        source: {
          engine: "jev",
          providerId: "typesafe",
          model: "jev-1",
          questionSetVersion: "v1",
        },
        createdAt: "2026-10-05T00:00:00.000Z",
        kind: "set_category",
        category: "article",
      });
    await db.decisions.bulkAdd([
      // Dead id with NO meta row — meta-orphan gating must not skip this.
      row("pending", ["ghost"]),
      row("approved", ["ghost", "live"]), // one dead member is enough
      row("applied", ["ghost"]),          // decided → history stays
      row("pending", ["popup:dead"]),     // synthetic → never a tree id
      row("pending", ["live"]),
    ]);

    expect(await reconcileMetadata()).toBe(2);

    const remaining = await db.decisions.toArray();
    expect(remaining).toHaveLength(3);
    expect(remaining.map((r) => r.status).sort()).toEqual([
      "applied",
      "pending",
      "pending",
    ]);
    // The `applied` history row legitimately keeps "ghost" (audit trail);
    // no reviewable row may still reference it.
    const reviewable = remaining.filter((r) =>
      ["pending", "unsure", "approved"].includes(r.status),
    );
    expect(reviewable.every((r) => !r.bookmarkIds.includes("ghost"))).toBe(
      true,
    );
  });

  it("never touches the network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called from reconcile");
    });
    vi.stubGlobal("fetch", fetchSpy);
    installBookmarksFake();
    await putMeta("ghost", { notes: "x" });

    expect(await reconcileMetadata()).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
