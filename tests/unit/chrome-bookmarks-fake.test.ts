import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOKMARKS_BAR_ID,
  FIXED_ROOT_IDS,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  ROOT_NODE_ID,
  create as apiCreate,
  getTree as apiGetTree,
  isFixedRoot,
  isFolder,
  onCreated,
  onRemoved,
} from "../../src/sync/chrome-bookmarks";
import type {
  BookmarkChangeInfo,
  BookmarkMoveInfo,
  BookmarkRemoveInfo,
  BookmarksTreeNode,
} from "../../src/sync/chrome-bookmarks";
import {
  createFakeBookmarks,
  installBookmarksFake,
} from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

let fake: FakeBookmarksApi;

beforeEach(() => {
  fake = createFakeBookmarks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** All ids present anywhere in the tree (helper for assertions). */
async function allIds(): Promise<string[]> {
  const ids: string[] = [];
  const walk = (nodes: BookmarksTreeNode[]): void => {
    for (const node of nodes) {
      ids.push(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(await fake.getTree());
  return ids;
}

async function childrenOf(parentId: string): Promise<BookmarksTreeNode[]> {
  return fake.getChildren(parentId);
}

async function childIds(parentId: string): Promise<string[]> {
  return (await childrenOf(parentId)).map((node) => node.id);
}

describe("fixed roots", () => {
  it("exposes the Chrome root node with children 1/2/3 in order", async () => {
    const tree = await fake.getTree();
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root).toBeDefined();
    expect(root?.id).toBe(ROOT_NODE_ID);
    expect(root?.parentId).toBeUndefined();
    expect(root?.index).toBeUndefined();
    expect(isFolder(root as BookmarksTreeNode)).toBe(true);
    expect(root?.children?.map((node) => node.id)).toEqual([
      BOOKMARKS_BAR_ID,
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID,
    ]);
    for (const child of root?.children ?? []) {
      expect(child.parentId).toBe(ROOT_NODE_ID);
      expect(child.url).toBeUndefined();
      expect(child.children).toEqual([]);
    }
    expect(root?.children?.map((node) => node.index)).toEqual([0, 1, 2]);
  });

  it("marks every fixed root id", () => {
    expect(FIXED_ROOT_IDS).toEqual(["0", "1", "2", "3"]);
    for (const id of FIXED_ROOT_IDS) {
      expect(isFixedRoot(id)).toBe(true);
    }
    expect(isFixedRoot("42")).toBe(false);
  });

  it.each(FIXED_ROOT_IDS)("rejects update on root %s", async (id) => {
    await expect(fake.update(id, { title: "x" })).rejects.toThrow(
      /root bookmark folders/,
    );
  });

  it.each(FIXED_ROOT_IDS)("rejects move on root %s", async (id) => {
    await expect(fake.move(id, { index: 0 })).rejects.toThrow(
      /root bookmark folders/,
    );
  });

  it.each(FIXED_ROOT_IDS)("rejects remove on root %s", async (id) => {
    await expect(fake.remove(id)).rejects.toThrow(/root bookmark folders/);
    await expect(fake.removeTree(id)).rejects.toThrow(/root bookmark folders/);
  });

  it("rejects creating directly under the root node", async () => {
    await expect(
      fake.create({ parentId: ROOT_NODE_ID, title: "nope" }),
    ).rejects.toThrow(/root bookmark folders/);
  });

  it("allows creating under the fixed root folders", async () => {
    for (const parentId of [
      BOOKMARKS_BAR_ID,
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID,
    ]) {
      const node = await fake.create({ parentId, title: `in ${parentId}` });
      expect(node.parentId).toBe(parentId);
      expect(node.index).toBe(0);
    }
  });
});

describe("reads", () => {
  beforeEach(async () => {
    const folder = await fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: "folder",
    });
    await fake.create({
      parentId: folder.id,
      title: "leaf",
      url: "https://a.example/",
    });
    await fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: "bar-leaf",
      url: "https://b.example/",
    });
  });

  it("get returns the node without populated children", async () => {
    const [node] = await fake.get(BOOKMARKS_BAR_ID);
    expect(node?.id).toBe(BOOKMARKS_BAR_ID);
    expect(node?.children).toBeUndefined();
  });

  it("get accepts a single id or an id list and preserves order", async () => {
    const single = await fake.get(OTHER_BOOKMARKS_ID);
    expect(single).toHaveLength(1);
    expect(single[0]?.id).toBe(OTHER_BOOKMARKS_ID);

    const list = await fake.get([OTHER_BOOKMARKS_ID, BOOKMARKS_BAR_ID]);
    expect(list.map((node) => node.id)).toEqual([
      OTHER_BOOKMARKS_ID,
      BOOKMARKS_BAR_ID,
    ]);

    await expect(fake.get([])).resolves.toEqual([]);
  });

  it("getSubTree returns the node with the full descendant tree", async () => {
    const [bar] = await fake.getSubTree(BOOKMARKS_BAR_ID);
    expect(bar?.children).toHaveLength(2);
    const folder = bar?.children?.[0];
    expect(folder?.children).toHaveLength(1);
    expect(folder?.children?.[0]?.url).toBe("https://a.example/");

    const [leaf] = await fake.getSubTree(folder?.children?.[0]?.id ?? "");
    expect(leaf?.children).toBeUndefined();
  });

  it("getChildren returns one level, shallow", async () => {
    const children = await childrenOf(BOOKMARKS_BAR_ID);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.children).toBeUndefined();
    }
  });

  it("rejects reads for unknown ids", async () => {
    await expect(fake.get("missing")).rejects.toThrow(/Can't find bookmark/);
    await expect(fake.get(["1", "missing"])).rejects.toThrow(
      /Can't find bookmark/,
    );
    await expect(fake.getSubTree("missing")).rejects.toThrow(
      /Can't find bookmark/,
    );
    await expect(fake.getChildren("missing")).rejects.toThrow(
      /Can't find bookmark/,
    );
  });

  it("returns fresh copies; mutating a result does not corrupt the tree", async () => {
    const [bar] = await fake.getSubTree(BOOKMARKS_BAR_ID);
    bar?.children?.push({
      id: "injected",
      title: "bogus",
    });
    expect(await childIds(BOOKMARKS_BAR_ID)).not.toContain("injected");
    const [again] = await fake.getSubTree(BOOKMARKS_BAR_ID);
    expect(again?.children).toHaveLength(2);
  });
});

describe("create", () => {
  it("defaults to the Other Bookmarks folder and appends", async () => {
    const first = await fake.create({ title: "a", url: "https://a.example/" });
    const second = await fake.create({ title: "b" });
    expect(first.parentId).toBe(OTHER_BOOKMARKS_ID);
    expect(second.parentId).toBe(OTHER_BOOKMARKS_ID);
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(first.id).not.toBe(second.id);
    expect(typeof first.dateAdded).toBe("number");
    expect(first.children).toBeUndefined();
    expect(second.url).toBeUndefined(); // no url ⇒ folder
  });

  it("inserts at an explicit index and renumbers siblings densely", async () => {
    const a = await fake.create({ parentId: "1", title: "a" });
    const b = await fake.create({ parentId: "1", title: "b" });
    const c = await fake.create({ parentId: "1", title: "c", index: 1 });
    const ids = await childIds("1");
    expect(ids).toEqual([a.id, c.id, b.id]);
    expect((await childrenOf("1")).map((node) => node.index)).toEqual([
      0, 1, 2,
    ]);
  });

  it("accepts index 0 and index == length", async () => {
    await fake.create({ parentId: "1", title: "a" });
    const head = await fake.create({ parentId: "1", title: "head", index: 0 });
    const tail = await fake.create({ parentId: "1", title: "tail", index: 2 });
    expect(head.index).toBe(0);
    expect(tail.index).toBe(2);
  });

  it("rejects an out-of-range index", async () => {
    await fake.create({ parentId: "1", title: "a" });
    await expect(
      fake.create({ parentId: "1", title: "b", index: 2 }),
    ).rejects.toThrow(/Invalid index/);
    await expect(
      fake.create({ parentId: "1", title: "b", index: -1 }),
    ).rejects.toThrow(/Invalid index/);
    // Nothing was inserted.
    expect(await childIds("1")).toHaveLength(1);
  });

  it("rejects creating under a leaf bookmark or a missing parent", async () => {
    const leaf = await fake.create({
      parentId: "1",
      title: "leaf",
      url: "https://a.example/",
    });
    await expect(
      fake.create({ parentId: leaf.id, title: "x" }),
    ).rejects.toThrow(/folder/);
    await expect(
      fake.create({ parentId: "missing", title: "x" }),
    ).rejects.toThrow(/Can't find bookmark/);
  });

  it("emits onCreated synchronously before the promise resolves", async () => {
    const listener = vi.fn();
    fake.onCreated.addListener(listener);
    const promise = fake.create({ title: "sync", url: "https://s.example/" });
    // Events are synchronous: the listener has already run.
    expect(listener).toHaveBeenCalledTimes(1);
    const node = await promise;
    expect(listener).toHaveBeenCalledWith(
      node.id,
      expect.objectContaining({ id: node.id, title: "sync" }),
    );
    expect((await allIds()).length).toBeGreaterThan(0);
  });
});

describe("update", () => {
  it("updates title and url and emits onChanged with both fields for bookmarks", async () => {
    const node = await fake.create({
      parentId: "1",
      title: "old",
      url: "https://old.example/",
    });
    const infos: BookmarkChangeInfo[] = [];
    fake.onChanged.addListener((_id, info) => infos.push(info));

    const updated = await fake.update(node.id, {
      title: "new",
      url: "https://new.example/",
    });
    expect(updated.title).toBe("new");
    expect(updated.url).toBe("https://new.example/");
    expect(infos).toHaveLength(1);
    expect(infos[0]).toEqual({
      title: "new",
      url: "https://new.example/",
    });
  });

  it("omits url in changeInfo for folders and keeps unspecified fields", async () => {
    const folder = await fake.create({ parentId: "1", title: "folder" });
    const infos: BookmarkChangeInfo[] = [];
    fake.onChanged.addListener((_id, info) => infos.push(info));

    const updated = await fake.update(folder.id, { title: "renamed" });
    expect(updated.title).toBe("renamed");
    expect(infos[0]).toEqual({ title: "renamed" });
    expect(infos[0] && "url" in infos[0]).toBe(false);
  });

  it("keeps the title when only url changes", async () => {
    const node = await fake.create({
      parentId: "1",
      title: "keep",
      url: "https://old.example/",
    });
    const infos: BookmarkChangeInfo[] = [];
    fake.onChanged.addListener((_id, info) => infos.push(info));
    await fake.update(node.id, { url: "https://new.example/" });
    expect(infos[0]?.title).toBe("keep");
    expect(infos[0]?.url).toBe("https://new.example/");
  });

  it("rejects setting a url on a folder", async () => {
    const folder = await fake.create({ parentId: "1", title: "folder" });
    await expect(
      fake.update(folder.id, { url: "https://x.example/" }),
    ).rejects.toThrow(/folder/);
  });

  it("rejects updates on missing nodes", async () => {
    await expect(
      fake.update("missing", { title: "x" }),
    ).rejects.toThrow(/Can't find bookmark/);
  });
});

describe("move", () => {
  let a: BookmarksTreeNode;
  let b: BookmarksTreeNode;
  let c: BookmarksTreeNode;

  beforeEach(async () => {
    a = await fake.create({ parentId: "1", title: "a" });
    b = await fake.create({ parentId: "1", title: "b" });
    c = await fake.create({ parentId: "1", title: "c" });
  });

  it("reorders within a parent using post-removal index semantics", async () => {
    const moves: BookmarkMoveInfo[] = [];
    fake.onMoved.addListener((_id, info) => moves.push(info));

    const moved = await fake.move(a.id, { index: 2 });
    expect(await childIds("1")).toEqual([b.id, c.id, a.id]);
    expect(moved.index).toBe(2);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({
      parentId: "1",
      index: 2,
      oldParentId: "1",
      oldIndex: 0,
    });
    expect((await childrenOf("1")).map((node) => node.index)).toEqual([
      0, 1, 2,
    ]);
  });

  it("moves across parents and renumbers both sibling lists", async () => {
    const folder = await fake.create({ parentId: "2", title: "target" });
    const moved = await fake.move(b.id, { parentId: folder.id });
    expect(moved.parentId).toBe(folder.id);
    expect(moved.index).toBe(0); // default index: append to destination
    expect(await childIds("1")).toEqual([a.id, c.id]);
    expect(await childIds(folder.id)).toEqual([b.id]);
    expect((await childrenOf("1")).map((node) => node.index)).toEqual([0, 1]);
  });

  it("moves to an explicit index in a different parent", async () => {
    const folder = await fake.create({ parentId: "2", title: "target" });
    const x = await fake.create({ parentId: folder.id, title: "x" });
    await fake.move(c.id, { parentId: folder.id, index: 0 });
    expect(await childIds(folder.id)).toEqual([c.id, x.id]);
  });

  it("rejects a destination with neither parentId nor index", async () => {
    await expect(fake.move(a.id, {})).rejects.toThrow();
    expect(await childIds("1")).toEqual([a.id, b.id, c.id]);
  });

  it("rejects out-of-range destination indexes", async () => {
    await expect(fake.move(a.id, { index: 3 })).rejects.toThrow(
      /Invalid index/,
    );
    await expect(fake.move(a.id, { index: -1 })).rejects.toThrow(
      /Invalid index/,
    );
    expect(await childIds("1")).toEqual([a.id, b.id, c.id]);
  });

  it("rejects moving into a leaf, a missing parent, or the root node", async () => {
    const leaf = await fake.create({
      parentId: "1",
      title: "leaf",
      url: "https://a.example/",
    });
    await expect(
      fake.move(a.id, { parentId: leaf.id }),
    ).rejects.toThrow(/folder/);
    await expect(
      fake.move(a.id, { parentId: "missing" }),
    ).rejects.toThrow(/Can't find bookmark/);
    await expect(
      fake.move(a.id, { parentId: ROOT_NODE_ID }),
    ).rejects.toThrow(/root bookmark folders/);
  });

  it("rejects moving a folder into itself or a descendant", async () => {
    const outer = await fake.create({ parentId: "2", title: "outer" });
    const inner = await fake.create({ parentId: outer.id, title: "inner" });
    await expect(
      fake.move(outer.id, { parentId: outer.id, index: 0 }),
    ).rejects.toThrow(/descendant|itself/);
    await expect(
      fake.move(outer.id, { parentId: inner.id }),
    ).rejects.toThrow(/descendant|itself/);
  });

  it("does not fire onChildrenReordered for move()", async () => {
    const reordered = vi.fn();
    fake.onChildrenReordered.addListener(reordered);
    await fake.move(a.id, { index: 2 });
    expect(reordered).not.toHaveBeenCalled();
  });
});

describe("remove and removeTree", () => {
  it("removes a leaf, renumbers siblings, and fires onRemoved", async () => {
    const a = await fake.create({ parentId: "1", title: "a" });
    const b = await fake.create({ parentId: "1", title: "b" });
    const removals: Array<[string, BookmarkRemoveInfo]> = [];
    fake.onRemoved.addListener((id, info) => removals.push([id, info]));

    await fake.remove(a.id);
    expect(await childIds("1")).toEqual([b.id]);
    expect((await childrenOf("1")).map((node) => node.index)).toEqual([0]);
    expect(removals).toHaveLength(1);
    expect(removals[0]?.[0]).toBe(a.id);
    expect(removals[0]?.[1].parentId).toBe("1");
    expect(removals[0]?.[1].index).toBe(0);
    expect(removals[0]?.[1].node.id).toBe(a.id);
    expect(removals[0]?.[1].node.title).toBe("a");
  });

  it("removes an empty folder with remove() but rejects a non-empty folder", async () => {
    const empty = await fake.create({ parentId: "1", title: "empty" });
    await fake.remove(empty.id);
    expect(await allIds()).not.toContain(empty.id);

    const full = await fake.create({ parentId: "1", title: "full" });
    await fake.create({ parentId: full.id, title: "child" });
    await expect(fake.remove(full.id)).rejects.toThrow(/non-empty/);
    expect(await allIds()).toContain(full.id);
  });

  it("removeTree deletes a whole subtree and fires a single onRemoved with the removed node incl. children", async () => {
    const folder = await fake.create({ parentId: "1", title: "folder" });
    const inner = await fake.create({ parentId: folder.id, title: "inner" });
    const leaf = await fake.create({
      parentId: inner.id,
      title: "leaf",
      url: "https://a.example/",
    });
    const sibling = await fake.create({ parentId: "1", title: "sibling" });
    const removals: Array<[string, BookmarkRemoveInfo]> = [];
    fake.onRemoved.addListener((id, info) => removals.push([id, info]));

    await fake.removeTree(folder.id);

    const ids = await allIds();
    for (const gone of [folder.id, inner.id, leaf.id]) {
      expect(ids).not.toContain(gone);
    }
    // One notification for the folder, none for descendants.
    expect(removals).toHaveLength(1);
    const [removedId, info] = removals[0] as [string, BookmarkRemoveInfo];
    expect(removedId).toBe(folder.id);
    expect(info.node.id).toBe(folder.id);
    expect(info.node.children).toHaveLength(1);
    expect(info.node.children?.[0]?.id).toBe(inner.id);
    expect(info.node.children?.[0]?.children?.[0]?.id).toBe(leaf.id);
    expect(info.parentId).toBe("1");
    expect(info.index).toBe(0);
    expect(await childIds("1")).toEqual([sibling.id]);
  });

  it("removeTree also works on leaf bookmarks", async () => {
    const leaf = await fake.create({
      parentId: "1",
      title: "leaf",
      url: "https://a.example/",
    });
    await fake.removeTree(leaf.id);
    expect(await allIds()).not.toContain(leaf.id);
  });

  it("rejects removing a missing node", async () => {
    await expect(fake.remove("missing")).rejects.toThrow(
      /Can't find bookmark/,
    );
    await expect(fake.removeTree("missing")).rejects.toThrow(
      /Can't find bookmark/,
    );
  });
});

describe("onChildrenReordered simulation", () => {
  it("applies the permutation and emits childIds in the new order", async () => {
    const a = await fake.create({ parentId: "1", title: "a" });
    const b = await fake.create({ parentId: "1", title: "b" });
    const c = await fake.create({ parentId: "1", title: "c" });
    const events: string[][] = [];
    fake.onChildrenReordered.addListener((_id, info) =>
      events.push(info.childIds),
    );

    fake.simulateChildrenReordered("1", [c.id, a.id, b.id]);

    expect(await childIds("1")).toEqual([c.id, a.id, b.id]);
    expect((await childrenOf("1")).map((node) => node.index)).toEqual([
      0, 1, 2,
    ]);
    expect(events).toEqual([[c.id, a.id, b.id]]);
  });

  it("rejects a childIds list that is not a permutation of the children", async () => {
    const a = await fake.create({ parentId: "1", title: "a" });
    await fake.create({ parentId: "1", title: "b" });
    expect(() => fake.simulateChildrenReordered("1", [a.id])).toThrow(
      /permutation/,
    );
    expect(() =>
      fake.simulateChildrenReordered("1", [a.id, "bogus"]),
    ).toThrow(/permutation/);
    expect(() => fake.simulateChildrenReordered("missing", [])).toThrow(
      /Can't find bookmark/,
    );
  });
});

describe("managed (unmodifiable) subtree", () => {
  let managedFolderId: string;
  let managedChildId: string;

  beforeEach(async () => {
    fake = createFakeBookmarks({
      bookmarksBar: [
        {
          id: "managed-folder",
          title: "Policy bookmarks",
          unmodifiable: "managed",
          children: [
            {
              id: "managed-child",
              title: "Required",
              url: "https://policy.example/",
            },
          ],
        },
      ],
    });
    managedFolderId = "managed-folder";
    managedChildId = "managed-child";
  });

  it("exposes unmodifiable: managed on the seeded folder", async () => {
    const [node] = await fake.get(managedFolderId);
    expect(node?.unmodifiable).toBe("managed");
    const [subtree] = await fake.getSubTree(managedFolderId);
    expect(subtree?.children?.[0]?.id).toBe(managedChildId);
  });

  it.each([
    ["create under the managed folder", () =>
      fake.create({ parentId: managedFolderId, title: "x" })],
    ["update the managed folder", () =>
      fake.update(managedFolderId, { title: "x" })],
    ["update a managed descendant", () =>
      fake.update(managedChildId, { title: "x" })],
    ["move the managed folder", () =>
      fake.move(managedFolderId, { index: 0 })],
    ["move a managed descendant out", () =>
      fake.move(managedChildId, { parentId: OTHER_BOOKMARKS_ID })],
    ["remove the managed folder", () => fake.removeTree(managedFolderId)],
    ["remove a managed descendant", () => fake.remove(managedChildId)],
  ])("rejects %s", async (_label, act) => {
    await expect(act()).rejects.toThrow(/managed/);
  });

  it("rejects moving a normal node into a managed folder", async () => {
    const free = await fake.create({ parentId: "2", title: "free" });
    await expect(
      fake.move(free.id, { parentId: managedFolderId }),
    ).rejects.toThrow(/managed/);
  });

  it("rejects reordering children of a managed folder", () => {
    expect(() =>
      fake.simulateChildrenReordered(managedFolderId, [managedChildId]),
    ).toThrow(/managed/);
  });
});

describe("events", () => {
  it("supports multiple listeners and removeListener/hasListener", async () => {
    const first = vi.fn();
    const second = vi.fn();
    fake.onCreated.addListener(first);
    fake.onCreated.addListener(second);
    expect(fake.onCreated.hasListener(first)).toBe(true);
    await fake.create({ title: "x" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    fake.onCreated.removeListener(first);
    expect(fake.onCreated.hasListener(first)).toBe(false);
    await fake.create({ title: "y" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe("typed slice wrappers", () => {
  it("wrapper functions delegate to chrome.bookmarks (the stubbed fake)", async () => {
    installBookmarksFake();
    const listener = vi.fn();
    const unsubscribe = onCreated(listener);
    const node = await apiCreate({ title: "via wrapper" });
    expect(listener).toHaveBeenCalledWith(
      node.id,
      expect.objectContaining({ title: "via wrapper" }),
    );
    const tree = await apiGetTree();
    expect(tree[0]?.id).toBe(ROOT_NODE_ID);
    unsubscribe();
    await apiCreate({ title: "after unsubscribe" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("onRemoved wrapper delivers the removed node for cascade deletes", async () => {
    installBookmarksFake();
    const folder = await apiCreate({ parentId: "1", title: "folder" });
    const child = await apiCreate({ parentId: folder.id, title: "child" });
    const removed: BookmarksTreeNode[] = [];
    const off = onRemoved((_id, info) => removed.push(info.node));
    const { removeTree } = await import("../../src/sync/chrome-bookmarks");
    await removeTree(folder.id);
    expect(removed[0]?.children?.[0]?.id).toBe(child.id);
    off();
  });
});

describe("clock injection", () => {
  it("uses the injected clock for dateAdded and dateGroupModified", async () => {
    let tick = 1_000;
    const clock = createFakeBookmarks({ now: () => ++tick });
    const node = await clock.create({ title: "timed" });
    expect(node.dateAdded).toBeGreaterThan(1_000);
    const [parent] = await clock.get(OTHER_BOOKMARKS_ID);
    expect(parent?.dateGroupModified).toBeGreaterThan(1_000);
    // A pure title change does not touch the parent's group-modified time.
    const before = parent?.dateGroupModified;
    await clock.update(node.id, { title: "renamed" });
    const [parentAfter] = await clock.get(OTHER_BOOKMARKS_ID);
    expect(parentAfter?.dateGroupModified).toBe(before);
    // But adding another child bumps it.
    await clock.create({ parentId: OTHER_BOOKMARKS_ID, title: "more" });
    const [parentLatest] = await clock.get(OTHER_BOOKMARKS_ID);
    expect(parentLatest?.dateGroupModified).toBeGreaterThan(before ?? 0);
  });
});
