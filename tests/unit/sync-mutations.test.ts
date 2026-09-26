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
import {
  BOOKMARKS_BAR_ID,
  FIXED_ROOT_IDS,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  ROOT_NODE_ID,
} from "../../src/sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import {
  createBookmark,
  createFolder,
  moveNode,
  MutationError,
  removeNode,
  removeTree,
  renameFolder,
  updateBookmark,
} from "../../src/sync/mutations";
import type { MutationErrorCode } from "../../src/sync/mutations";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Seeded tree for every test:
 *
 * ```
 * 0 root
 * ├─ 1 Bookmarks bar
 * │  ├─ folder-a            folder
 * │  │  ├─ bm-a1            https://a1.example/
 * │  │  └─ sub-a            folder
 * │  │     └─ bm-a2         https://a2.example/
 * │  └─ bm-b                https://b.example/
 * ├─ 2 Other bookmarks
 * │  └─ managed             folder, unmodifiable: "managed"
 * │     ├─ managed-child    https://mc.example/
 * │     └─ managed-sub      folder
 * │        └─ managed-leaf  https://ml.example/
 * └─ 3 Mobile bookmarks
 * ```
 */
let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
    bookmarksBar: [
      {
        id: "folder-a",
        title: "Folder A",
        children: [
          { id: "bm-a1", title: "A1", url: "https://a1.example/" },
          {
            id: "sub-a",
            title: "Sub A",
            children: [
              { id: "bm-a2", title: "A2", url: "https://a2.example/" },
            ],
          },
        ],
      },
      { id: "bm-b", title: "B", url: "https://b.example/" },
    ],
    otherBookmarks: [
      {
        id: "managed",
        title: "Policy",
        unmodifiable: "managed",
        children: [
          {
            id: "managed-child",
            title: "MC",
            url: "https://mc.example/",
          },
          {
            id: "managed-sub",
            title: "MSub",
            children: [
              {
                id: "managed-leaf",
                title: "ML",
                url: "https://ml.example/",
              },
            ],
          },
        ],
      },
    ],
  });
  await db.bookmarkMeta.clear();
  await db.tags.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/** Assert a rejection is a MutationError carrying exactly `code`. */
async function expectMutationError(
  promise: Promise<unknown>,
  code: MutationErrorCode,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(MutationError);
  await expect(promise).rejects.toMatchObject({
    name: "MutationError",
    code,
  });
}

async function childIds(parentId: string): Promise<string[]> {
  return (await fake.getChildren(parentId)).map((node) => node.id);
}

async function node(id: string): Promise<BookmarksTreeNode> {
  const [found] = await fake.get(id);
  expect(found).toBeDefined();
  return found as BookmarksTreeNode;
}

describe("createBookmark", () => {
  it("creates a bookmark under a writable folder and returns the node", async () => {
    const created = await createBookmark({
      parentId: "folder-a",
      title: "New",
      url: "https://new.example/",
      index: 1,
    });
    expect(created.parentId).toBe("folder-a");
    expect(created.title).toBe("New");
    expect(created.url).toBe("https://new.example/");
    expect(created.index).toBe(1);
    expect(await childIds("folder-a")).toEqual(["bm-a1", created.id, "sub-a"]);
  });

  it("appends when index is omitted", async () => {
    const created = await createBookmark({
      parentId: BOOKMARKS_BAR_ID,
      title: "Tail",
      url: "https://tail.example/",
    });
    expect(created.index).toBe(2);
    expect((await childIds(BOOKMARKS_BAR_ID)).at(-1)).toBe(created.id);
  });

  it("creates under the fixed root folders 1/2/3 but not under root 0", async () => {
    for (const parentId of [
      BOOKMARKS_BAR_ID,
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID,
    ]) {
      const created = await createBookmark({
        parentId,
        title: `in ${parentId}`,
        url: "https://x.example/",
      });
      expect(created.parentId).toBe(parentId);
    }
    await expectMutationError(
      createBookmark({
        parentId: ROOT_NODE_ID,
        title: "nope",
        url: "https://x.example/",
      }),
      "root",
    );
  });

  it("rejects guard failures without touching the bookmarks API", async () => {
    const spy = vi.spyOn(fake, "create");
    await expectMutationError(
      createBookmark({
        parentId: ROOT_NODE_ID,
        title: "x",
        url: "https://x.example/",
      }),
      "root",
    );
    await expectMutationError(
      createBookmark({
        parentId: "managed",
        title: "x",
        url: "https://x.example/",
      }),
      "managed",
    );
    await expectMutationError(
      createBookmark({
        parentId: "missing",
        title: "x",
        url: "https://x.example/",
      }),
      "not_found",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a managed parent anywhere in its subtree", async () => {
    await expectMutationError(
      createBookmark({
        parentId: "managed-sub",
        title: "x",
        url: "https://x.example/",
      }),
      "managed",
    );
  });

  it("rejects a leaf bookmark as parent", async () => {
    await expectMutationError(
      createBookmark({
        parentId: "bm-b",
        title: "x",
        url: "https://x.example/",
      }),
      "invalid",
    );
  });

  it("rejects an out-of-range or fractional index before the write", async () => {
    const spy = vi.spyOn(fake, "create");
    for (const index of [-1, 3, 1.5]) {
      await expectMutationError(
        createBookmark({
          parentId: "folder-a",
          title: "x",
          url: "https://x.example/",
          index,
        }),
        "invalid",
      );
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await childIds("folder-a")).toEqual(["bm-a1", "sub-a"]);
  });
});

describe("createFolder", () => {
  it("creates a childless folder (no url)", async () => {
    const created = await createFolder({
      parentId: "folder-a",
      title: "Empty",
    });
    expect(created.url).toBeUndefined();
    expect(created.parentId).toBe("folder-a");
    expect((await node(created.id)).url).toBeUndefined();
  });

  it("applies the same parent guards as createBookmark", async () => {
    await expectMutationError(
      createFolder({ parentId: ROOT_NODE_ID, title: "x" }),
      "root",
    );
    await expectMutationError(
      createFolder({ parentId: "managed", title: "x" }),
      "managed",
    );
    await expectMutationError(
      createFolder({ parentId: "bm-b", title: "x" }),
      "invalid",
    );
    await expectMutationError(
      createFolder({ parentId: "missing", title: "x" }),
      "not_found",
    );
  });
});

describe("updateBookmark", () => {
  it("updates title and url", async () => {
    const updated = await updateBookmark("bm-a1", {
      title: "renamed",
      url: "https://renamed.example/",
    });
    expect(updated.title).toBe("renamed");
    expect(updated.url).toBe("https://renamed.example/");
    const stored = await node("bm-a1");
    expect(stored.title).toBe("renamed");
    expect(stored.url).toBe("https://renamed.example/");
  });

  it("updates a folder's title when no url is passed", async () => {
    const updated = await updateBookmark("folder-a", { title: "F" });
    expect(updated.title).toBe("F");
  });

  it("rejects setting a url on a folder", async () => {
    await expectMutationError(
      updateBookmark("folder-a", { url: "https://x.example/" }),
      "invalid",
    );
    expect((await node("folder-a")).url).toBeUndefined();
  });

  it.each(FIXED_ROOT_IDS)("rejects root %s before the API call", async (id) => {
    const spy = vi.spyOn(fake, "update");
    await expectMutationError(updateBookmark(id, { title: "x" }), "root");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects managed nodes and descendants of managed nodes", async () => {
    await expectMutationError(
      updateBookmark("managed", { title: "x" }),
      "managed",
    );
    await expectMutationError(
      updateBookmark("managed-child", { title: "x" }),
      "managed",
    );
    await expectMutationError(
      updateBookmark("managed-leaf", { title: "x" }),
      "managed",
    );
  });

  it("rejects a missing node", async () => {
    await expectMutationError(
      updateBookmark("missing", { title: "x" }),
      "not_found",
    );
  });
});

describe("renameFolder", () => {
  it("renames a folder", async () => {
    const renamed = await renameFolder("sub-a", "Sub renamed");
    expect(renamed.title).toBe("Sub renamed");
    expect((await node("sub-a")).title).toBe("Sub renamed");
  });

  it("rejects a leaf bookmark", async () => {
    await expectMutationError(renameFolder("bm-b", "x"), "invalid");
  });

  it.each(FIXED_ROOT_IDS)("rejects root %s", async (id) => {
    const spy = vi.spyOn(fake, "update");
    await expectMutationError(renameFolder(id, "x"), "root");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects managed folders and their descendants", async () => {
    await expectMutationError(renameFolder("managed", "x"), "managed");
    await expectMutationError(renameFolder("managed-sub", "x"), "managed");
  });

  it("rejects a missing folder", async () => {
    await expectMutationError(renameFolder("missing", "x"), "not_found");
  });
});

describe("moveNode", () => {
  it("reorders within a parent (post-removal index semantics)", async () => {
    const moved = await moveNode("bm-a1", { index: 1 });
    expect(moved.index).toBe(1);
    expect(await childIds("folder-a")).toEqual(["sub-a", "bm-a1"]);
  });

  it("moves across parents and appends by default", async () => {
    const moved = await moveNode("bm-b", { parentId: "folder-a" });
    expect(moved.parentId).toBe("folder-a");
    expect(moved.index).toBe(2);
    expect(await childIds(BOOKMARKS_BAR_ID)).toEqual(["folder-a"]);
    expect(await childIds("folder-a")).toEqual(["bm-a1", "sub-a", "bm-b"]);
  });

  it("moves to an explicit index in another parent", async () => {
    await moveNode("bm-b", { parentId: "folder-a", index: 0 });
    expect(await childIds("folder-a")).toEqual(["bm-b", "bm-a1", "sub-a"]);
  });

  it("moves into a fixed root folder (1/2/3 are writable parents)", async () => {
    const moved = await moveNode("bm-b", { parentId: OTHER_BOOKMARKS_ID });
    expect(moved.parentId).toBe(OTHER_BOOKMARKS_ID);
    expect(await childIds(OTHER_BOOKMARKS_ID)).toContain("bm-b");
  });

  it("rejects an empty destination", async () => {
    const spy = vi.spyOn(fake, "move");
    await expectMutationError(moveNode("bm-b", {}), "invalid");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(FIXED_ROOT_IDS)("rejects moving root %s", async (id) => {
    const spy = vi.spyOn(fake, "move");
    await expectMutationError(moveNode(id, { index: 0 }), "root");
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects moving managed nodes or their descendants", async () => {
    await expectMutationError(
      moveNode("managed", { parentId: BOOKMARKS_BAR_ID }),
      "managed",
    );
    await expectMutationError(
      moveNode("managed-child", { parentId: BOOKMARKS_BAR_ID }),
      "managed",
    );
    await expectMutationError(
      moveNode("managed-leaf", { parentId: BOOKMARKS_BAR_ID }),
      "managed",
    );
  });

  it("rejects moving INTO managed nodes or their descendants", async () => {
    await expectMutationError(
      moveNode("bm-b", { parentId: "managed" }),
      "managed",
    );
    await expectMutationError(
      moveNode("bm-b", { parentId: "managed-sub" }),
      "managed",
    );
  });

  it("rejects moving into the synthetic root, a leaf, or a missing parent", async () => {
    await expectMutationError(
      moveNode("bm-b", { parentId: ROOT_NODE_ID }),
      "root",
    );
    await expectMutationError(
      moveNode("bm-b", { parentId: "bm-a1" }),
      "invalid",
    );
    await expectMutationError(
      moveNode("bm-b", { parentId: "missing" }),
      "not_found",
    );
    await expectMutationError(
      moveNode("missing", { parentId: BOOKMARKS_BAR_ID }),
      "not_found",
    );
  });

  it("rejects moving a folder into itself or a descendant", async () => {
    const spy = vi.spyOn(fake, "move");
    await expectMutationError(
      moveNode("folder-a", { parentId: "folder-a" }),
      "invalid",
    );
    await expectMutationError(
      moveNode("folder-a", { parentId: "sub-a" }),
      "invalid",
    );
    expect(spy).not.toHaveBeenCalled();
    // The tree is untouched.
    expect(await childIds(BOOKMARKS_BAR_ID)).toEqual(["folder-a", "bm-b"]);
  });

  it("rejects out-of-range indexes with post-removal bounds", async () => {
    const spy = vi.spyOn(fake, "move");
    // folder-a has 2 children: same-parent capacity is 1.
    await expectMutationError(moveNode("bm-a1", { index: 2 }), "invalid");
    // Cross-parent capacity is the destination's full child count.
    await expectMutationError(
      moveNode("bm-b", { parentId: "folder-a", index: 3 }),
      "invalid",
    );
    await expectMutationError(
      moveNode("bm-b", { parentId: "folder-a", index: -1 }),
      "invalid",
    );
    await expectMutationError(moveNode("bm-b", { index: 1.5 }), "invalid");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("removeNode / removeTree", () => {
  it("removeNode deletes a leaf bookmark", async () => {
    await removeNode("bm-a1");
    expect(await childIds("folder-a")).toEqual(["sub-a"]);
    await expect(fake.get("bm-a1")).rejects.toThrow(/Can't find bookmark/);
  });

  it("removeNode deletes an empty folder but rejects a non-empty one", async () => {
    const empty = await fake.create({ parentId: BOOKMARKS_BAR_ID, title: "e" });
    await removeNode(empty.id);
    await expect(fake.get(empty.id)).rejects.toThrow(/Can't find bookmark/);

    const spy = vi.spyOn(fake, "remove");
    await expectMutationError(removeNode("folder-a"), "invalid");
    expect(spy).not.toHaveBeenCalled();
    expect((await node("folder-a")).title).toBe("Folder A");
  });

  it("removeTree deletes a folder with its whole subtree", async () => {
    await removeTree("folder-a");
    for (const id of ["folder-a", "bm-a1", "sub-a", "bm-a2"]) {
      await expect(fake.get(id)).rejects.toThrow(/Can't find bookmark/);
    }
    expect(await childIds(BOOKMARKS_BAR_ID)).toEqual(["bm-b"]);
  });

  it("removeTree also deletes a leaf bookmark", async () => {
    await removeTree("bm-b");
    await expect(fake.get("bm-b")).rejects.toThrow(/Can't find bookmark/);
  });

  it.each(FIXED_ROOT_IDS)("rejects removing root %s", async (id) => {
    const removeSpy = vi.spyOn(fake, "remove");
    const removeTreeSpy = vi.spyOn(fake, "removeTree");
    await expectMutationError(removeNode(id), "root");
    await expectMutationError(removeTree(id), "root");
    expect(removeSpy).not.toHaveBeenCalled();
    expect(removeTreeSpy).not.toHaveBeenCalled();
  });

  it("rejects managed nodes and descendants of managed nodes", async () => {
    await expectMutationError(removeNode("managed"), "managed");
    await expectMutationError(removeTree("managed"), "managed");
    await expectMutationError(removeNode("managed-child"), "managed");
    await expectMutationError(removeTree("managed-leaf"), "managed");
  });

  it("rejects a missing node", async () => {
    await expectMutationError(removeNode("missing"), "not_found");
    await expectMutationError(removeTree("missing"), "not_found");
  });
});

describe("metadata sidecar", () => {
  it("writes meta keyed by the new node id after createBookmark", async () => {
    const created = await createBookmark({
      parentId: BOOKMARKS_BAR_ID,
      title: "Tagged",
      url: "https://tagged.example/",
      meta: { tags: ["Docs", " Reading List "], category: "docs", notes: "n" },
    });
    const meta = await getMeta(created.id);
    expect(meta).toMatchObject({
      id: created.id,
      tags: ["docs", "reading list"],
      category: "docs",
      notes: "n",
    });
  });

  it("writes meta for createFolder", async () => {
    const created = await createFolder({
      parentId: BOOKMARKS_BAR_ID,
      title: "Folder meta",
      meta: { tags: ["x"] },
    });
    expect((await getMeta(created.id))?.tags).toEqual(["x"]);
  });

  it("leaves no meta row when meta is not given", async () => {
    const created = await createBookmark({
      parentId: BOOKMARKS_BAR_ID,
      title: "Bare",
      url: "https://bare.example/",
    });
    expect(await getMeta(created.id)).toBeUndefined();
  });

  it("merges meta on updateBookmark (patch semantics)", async () => {
    await putMeta("bm-a1", { tags: ["keep"], notes: "stay" });
    await updateBookmark("bm-a1", { title: "t" }, { category: "docs" });
    expect(await getMeta("bm-a1")).toMatchObject({
      id: "bm-a1",
      tags: ["keep"],
      notes: "stay",
      category: "docs",
    });
  });

  it("merges meta on renameFolder", async () => {
    await renameFolder("folder-a", "F", { notes: "folder note" });
    expect((await getMeta("folder-a"))?.notes).toBe("folder note");
  });

  it("surfaces meta schema violations as MutationError after the write", async () => {
    const promise = createBookmark({
      parentId: BOOKMARKS_BAR_ID,
      title: "Bad meta",
      url: "https://bad.example/",
      meta: { notes: "n".repeat(10_001) },
    });
    await expectMutationError(promise, "invalid");
    // The chrome mutation is not rolled back: the bookmark exists anyway.
    const children = await childIds(BOOKMARKS_BAR_ID);
    expect(children).toHaveLength(3);
  });
});
