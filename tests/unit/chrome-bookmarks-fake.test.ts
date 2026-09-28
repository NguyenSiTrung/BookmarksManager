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
  it("exposes the Chrome root node with children 1/2/3 in order and marks fixed root ids", async () => {
    const tree = await fake.getTree();
    expect(tree).toHaveLength(1);
    const root = tree[0];
    expect(root?.id).toBe(ROOT_NODE_ID);
    expect(root?.parentId).toBeUndefined();
    expect(root?.index).toBeUndefined();
    expect(isFolder(root as BookmarksTreeNode)).toBe(true);
    expect(root?.children?.map((node) => node.id)).toEqual([
      BOOKMARKS_BAR_ID,
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID,
    ]);
    expect(FIXED_ROOT_IDS).toEqual(["0", "1", "2", "3"]);
    for (const id of FIXED_ROOT_IDS) {
      expect(isFixedRoot(id)).toBe(true);
    }
    expect(isFixedRoot("42")).toBe(false);
  });

  it("rejects mutating fixed roots and permits creating under fixed root folders", async () => {
    for (const id of FIXED_ROOT_IDS) {
      await expect(fake.update(id, { title: "x" })).rejects.toThrow(/root bookmark folders/);
      await expect(fake.move(id, { index: 0 })).rejects.toThrow(/root bookmark folders/);
      await expect(fake.remove(id)).rejects.toThrow(/root bookmark folders/);
      await expect(fake.removeTree(id)).rejects.toThrow(/root bookmark folders/);
    }
    await expect(fake.create({ parentId: ROOT_NODE_ID, title: "nope" })).rejects.toThrow(/root bookmark folders/);

    for (const parentId of [BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID, MOBILE_BOOKMARKS_ID]) {
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

  it("handles get, getSubTree, and getChildren accurately", async () => {
    const [node] = await fake.get(BOOKMARKS_BAR_ID);
    expect(node?.id).toBe(BOOKMARKS_BAR_ID);
    expect(node?.children).toBeUndefined();

    const list = await fake.get([OTHER_BOOKMARKS_ID, BOOKMARKS_BAR_ID]);
    expect(list.map((n) => n.id)).toEqual([OTHER_BOOKMARKS_ID, BOOKMARKS_BAR_ID]);

    const [bar] = await fake.getSubTree(BOOKMARKS_BAR_ID);
    expect(bar?.children).toHaveLength(2);

    const children = await childrenOf(BOOKMARKS_BAR_ID);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.children).toBeUndefined();
    }
  });

  it("rejects unknown reads and preserves immutability of tree nodes", async () => {
    await expect(fake.get("missing")).rejects.toThrow(/Can't find bookmark/);
    await expect(fake.getSubTree("missing")).rejects.toThrow(/Can't find bookmark/);
    await expect(fake.getChildren("missing")).rejects.toThrow(/Can't find bookmark/);

    const [bar] = await fake.getSubTree(BOOKMARKS_BAR_ID);
    bar?.children?.push({ id: "injected", title: "bogus" });
    expect(await childIds(BOOKMARKS_BAR_ID)).not.toContain("injected");
  });
});

describe("create", () => {
  it("defaults parent to OTHER_BOOKMARKS_ID and manages indices densely", async () => {
    const first = await fake.create({ title: "a", url: "https://a.example/" });
    const second = await fake.create({ title: "b" });
    expect(first.parentId).toBe(OTHER_BOOKMARKS_ID);
    expect(second.parentId).toBe(OTHER_BOOKMARKS_ID);
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);

    const a = await fake.create({ parentId: "1", title: "a" });
    const b = await fake.create({ parentId: "1", title: "b" });
    const c = await fake.create({ parentId: "1", title: "c", index: 1 });
    expect(await childIds("1")).toEqual([a.id, c.id, b.id]);
  });

  it("validates indices and rejects invalid parents", async () => {
    await fake.create({ parentId: "1", title: "a" });
    await expect(fake.create({ parentId: "1", title: "b", index: 2 })).rejects.toThrow(/Invalid index/);
    await expect(fake.create({ parentId: "1", title: "b", index: -1 })).rejects.toThrow(/Invalid index/);

    const leaf = await fake.create({ parentId: "1", title: "leaf", url: "https://a.example/" });
    await expect(fake.create({ parentId: leaf.id, title: "x" })).rejects.toThrow(/folder/);
    await expect(fake.create({ parentId: "missing", title: "x" })).rejects.toThrow(/Can't find bookmark/);
  });

  it("emits onCreated synchronously before the promise resolves", async () => {
    const listener = vi.fn();
    fake.onCreated.addListener(listener);
    const node = await fake.create({ title: "sync", url: "https://s.example/" });
    expect(listener).toHaveBeenCalledWith(
      node.id,
      expect.objectContaining({ id: node.id, title: "sync" }),
    );
  });
});

describe("update", () => {
  it("updates title and url for bookmarks and folders, emitting onChanged", async () => {
    const node = await fake.create({
      parentId: "1",
      title: "old",
      url: "https://old.example/",
    });
    const infos: BookmarkChangeInfo[] = [];
    fake.onChanged.addListener((_id, info) => infos.push(info));

    const updated = await fake.update(node.id, { title: "new", url: "https://new.example/" });
    expect(updated.title).toBe("new");
    expect(updated.url).toBe("https://new.example/");
    expect(infos[0]).toEqual({ title: "new", url: "https://new.example/" });

    const folder = await fake.create({ parentId: "1", title: "folder" });
    const updatedFolder = await fake.update(folder.id, { title: "renamed" });
    expect(updatedFolder.title).toBe("renamed");
    expect(infos[1]).toEqual({ title: "renamed" });
    expect("url" in (infos[1] ?? {})).toBe(false);
  });

  it("rejects invalid updates (setting url on folder, missing node)", async () => {
    const folder = await fake.create({ parentId: "1", title: "folder" });
    await expect(fake.update(folder.id, { url: "https://x.example/" })).rejects.toThrow(/folder/);
    await expect(fake.update("missing", { title: "x" })).rejects.toThrow(/Can't find bookmark/);
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

  it("reorders within a parent and moves across parents", async () => {
    const moves: BookmarkMoveInfo[] = [];
    fake.onMoved.addListener((_id, info) => moves.push(info));

    const moved = await fake.move(a.id, { index: 2 });
    expect(await childIds("1")).toEqual([b.id, c.id, a.id]);
    expect(moved.index).toBe(2);
    expect(moves[0]).toEqual({
      parentId: "1",
      index: 2,
      oldParentId: "1",
      oldIndex: 0,
    });

    const folder = await fake.create({ parentId: "2", title: "target" });
    const movedCross = await fake.move(b.id, { parentId: folder.id });
    expect(movedCross.parentId).toBe(folder.id);
    expect(await childIds("1")).toEqual([c.id, a.id]);
    expect(await childIds(folder.id)).toEqual([b.id]);
  });

  it("rejects invalid moves (empty destination, out of range, cycle, missing)", async () => {
    await expect(fake.move(a.id, {})).rejects.toThrow();
    await expect(fake.move(a.id, { index: 3 })).rejects.toThrow(/Invalid index/);
    await expect(fake.move(a.id, { parentId: "missing" })).rejects.toThrow(/Can't find bookmark/);
    await expect(fake.move(a.id, { parentId: ROOT_NODE_ID })).rejects.toThrow(/root bookmark folders/);

    const outer = await fake.create({ parentId: "2", title: "outer" });
    const inner = await fake.create({ parentId: outer.id, title: "inner" });
    await expect(fake.move(outer.id, { parentId: outer.id, index: 0 })).rejects.toThrow(/descendant|itself/);
    await expect(fake.move(outer.id, { parentId: inner.id })).rejects.toThrow(/descendant|itself/);
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
    expect(removals[0]?.[0]).toBe(a.id);
  });

  it("removes empty folder with remove() but rejects non-empty; removeTree deletes whole subtree", async () => {
    const empty = await fake.create({ parentId: "1", title: "empty" });
    await fake.remove(empty.id);
    expect(await allIds()).not.toContain(empty.id);

    const full = await fake.create({ parentId: "1", title: "full" });
    await fake.create({ parentId: full.id, title: "child" });
    await expect(fake.remove(full.id)).rejects.toThrow(/non-empty/);

    await fake.removeTree(full.id);
    expect(await allIds()).not.toContain(full.id);

    await expect(fake.remove("missing")).rejects.toThrow(/Can't find bookmark/);
  });
});

describe("onChildrenReordered simulation", () => {
  it("applies permutation and emits event or rejects non-permutations", async () => {
    const a = await fake.create({ parentId: "1", title: "a" });
    const b = await fake.create({ parentId: "1", title: "b" });
    const c = await fake.create({ parentId: "1", title: "c" });
    const events: string[][] = [];
    fake.onChildrenReordered.addListener((_id, info) => events.push(info.childIds));

    fake.simulateChildrenReordered("1", [c.id, a.id, b.id]);
    expect(await childIds("1")).toEqual([c.id, a.id, b.id]);
    expect(events).toEqual([[c.id, a.id, b.id]]);

    expect(() => fake.simulateChildrenReordered("1", [a.id])).toThrow(/permutation/);
  });
});

describe("managed subtree and events", () => {
  it("protects managed subtrees against mutation", async () => {
    const managedFake = createFakeBookmarks({
      bookmarksBar: [
        {
          id: "managed-folder",
          title: "Policy bookmarks",
          unmodifiable: "managed",
          children: [{ id: "managed-child", title: "Required", url: "https://policy.example/" }],
        },
      ],
    });

    const [node] = await managedFake.get("managed-folder");
    expect(node?.unmodifiable).toBe("managed");

    await expect(managedFake.create({ parentId: "managed-folder", title: "x" })).rejects.toThrow(/managed/);
    await expect(managedFake.update("managed-folder", { title: "x" })).rejects.toThrow(/managed/);
    await expect(managedFake.update("managed-child", { title: "x" })).rejects.toThrow(/managed/);
    await expect(managedFake.removeTree("managed-folder")).rejects.toThrow(/managed/);
    await expect(managedFake.remove("managed-child")).rejects.toThrow(/managed/);
  });

  it("supports listener subscription lifecycles and clock injection", async () => {
    const first = vi.fn();
    fake.onCreated.addListener(first);
    expect(fake.onCreated.hasListener(first)).toBe(true);
    await fake.create({ title: "x" });
    expect(first).toHaveBeenCalledTimes(1);
    fake.onCreated.removeListener(first);
    expect(fake.onCreated.hasListener(first)).toBe(false);

    let tick = 1_000;
    const clock = createFakeBookmarks({ now: () => ++tick });
    const timedNode = await clock.create({ title: "timed" });
    expect(timedNode.dateAdded).toBeGreaterThan(1_000);
  });

  it("typed slice wrappers delegate to chrome.bookmarks", async () => {
    installBookmarksFake();
    const listener = vi.fn();
    const unsubscribe = onCreated(listener);
    const node = await apiCreate({ title: "via wrapper" });
    expect(listener).toHaveBeenCalledWith(node.id, expect.objectContaining({ title: "via wrapper" }));
    const tree = await apiGetTree();
    expect(tree[0]?.id).toBe(ROOT_NODE_ID);
    unsubscribe();
  });
});
