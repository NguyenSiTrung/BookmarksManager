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
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

const ISO = "2026-09-26T10:00:00.000Z";

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

describe("reconcileMetadata", () => {
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
