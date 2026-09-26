import { describe, expect, it } from "vitest";
import {
  BOOKMARKS_BAR_ID,
  MOBILE_BOOKMARKS_ID,
  OTHER_BOOKMARKS_ID,
  ROOT_NODE_ID,
} from "../../src/sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";

/**
 * Coverage for the pure read model in `src/sync/tree.ts`. All trees are
 * hand-built `BookmarksTreeNode[]` literals — `flattenTree` takes the shape
 * `chrome.bookmarks.getTree()`/`getSubTree()` return, so no fake or `chrome`
 * global is involved here.
 */

/** The shape `getTree()` returns: a one-element array rooted at "0". */
function chromeTree(): BookmarksTreeNode[] {
  return [
    {
      id: ROOT_NODE_ID,
      title: "",
      children: [
        {
          id: BOOKMARKS_BAR_ID,
          parentId: ROOT_NODE_ID,
          index: 0,
          title: "Bookmarks bar",
          children: [
            {
              id: "10",
              parentId: BOOKMARKS_BAR_ID,
              index: 0,
              title: "Work",
              children: [
                {
                  id: "11",
                  parentId: "10",
                  index: 0,
                  title: "A",
                  url: "https://a.example/",
                },
                {
                  id: "12",
                  parentId: "10",
                  index: 1,
                  title: "B",
                  url: "https://b.example/",
                },
              ],
            },
            {
              id: "13",
              parentId: BOOKMARKS_BAR_ID,
              index: 1,
              title: "Direct",
              url: "https://d.example/",
            },
          ],
        },
        {
          id: OTHER_BOOKMARKS_ID,
          parentId: ROOT_NODE_ID,
          index: 1,
          title: "Other bookmarks",
          children: [],
        },
        {
          id: MOBILE_BOOKMARKS_ID,
          parentId: ROOT_NODE_ID,
          index: 2,
          title: "Mobile bookmarks",
          children: [
            {
              id: "20",
              parentId: MOBILE_BOOKMARKS_ID,
              index: 0,
              title: "M",
              url: "https://m.example/",
            },
          ],
        },
      ],
    },
  ];
}

/** A tree with a managed (policy-controlled) branch on the bookmarks bar. */
function managedTree(): BookmarksTreeNode[] {
  return [
    {
      id: ROOT_NODE_ID,
      title: "",
      children: [
        {
          id: BOOKMARKS_BAR_ID,
          parentId: ROOT_NODE_ID,
          index: 0,
          title: "Bookmarks bar",
          children: [
            {
              id: "managed-folder",
              parentId: BOOKMARKS_BAR_ID,
              index: 0,
              title: "Policy bookmarks",
              unmodifiable: "managed",
              children: [
                {
                  id: "managed-child",
                  parentId: "managed-folder",
                  index: 0,
                  title: "Required",
                  url: "https://policy.example/",
                },
                {
                  id: "managed-sub",
                  parentId: "managed-folder",
                  index: 1,
                  title: "Sub",
                  children: [
                    {
                      id: "managed-grandchild",
                      parentId: "managed-sub",
                      index: 0,
                      title: "Deep",
                      url: "https://deep.example/",
                    },
                  ],
                },
              ],
            },
            {
              id: "free",
              parentId: BOOKMARKS_BAR_ID,
              index: 1,
              title: "Free",
              url: "https://free.example/",
            },
          ],
        },
      ],
    },
  ];
}

describe("flattenTree folders/bookmarks split", () => {
  it("returns empty maps for an empty forest", () => {
    const model = flattenTree([]);
    expect(model.folders.size).toBe(0);
    expect(model.bookmarks.size).toBe(0);
  });

  it("puts folders in `folders` and url-bearing nodes in `bookmarks`", () => {
    const model = flattenTree(chromeTree());
    expect([...model.folders.keys()].sort()).toEqual(
      [ROOT_NODE_ID, BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID, MOBILE_BOOKMARKS_ID, "10"].sort(),
    );
    expect([...model.bookmarks.keys()].sort()).toEqual(["11", "12", "13", "20"].sort());
  });

  it("gives bookmarks their url and no childIds; folders get childIds and no url", () => {
    const model = flattenTree(chromeTree());
    const leaf = model.bookmarks.get("11");
    expect(leaf?.url).toBe("https://a.example/");
    expect(leaf && "childIds" in leaf).toBe(false);
    const folder = model.folders.get("10");
    expect(folder?.childIds).toBeDefined();
    expect(folder && "url" in folder).toBe(false);
  });
});

describe("flattenTree node fields", () => {
  it("marks the synthetic root and fixed root folders as isRoot", () => {
    const model = flattenTree(chromeTree());
    for (const id of [ROOT_NODE_ID, BOOKMARKS_BAR_ID, OTHER_BOOKMARKS_ID, MOBILE_BOOKMARKS_ID]) {
      expect(model.folders.get(id)?.isRoot, `isRoot ${id}`).toBe(true);
    }
    expect(model.folders.get("10")?.isRoot).toBe(false);
    expect(model.bookmarks.get("11")?.isRoot).toBe(false);
  });

  it("leaves parentId and index undefined only on the root", () => {
    const model = flattenTree(chromeTree());
    const root = model.folders.get(ROOT_NODE_ID);
    expect(root?.parentId).toBeUndefined();
    expect(root?.index).toBeUndefined();
    const bar = model.folders.get(BOOKMARKS_BAR_ID);
    expect(bar?.parentId).toBe(ROOT_NODE_ID);
    expect(bar?.index).toBe(0);
    const leaf = model.bookmarks.get("13");
    expect(leaf?.parentId).toBe(BOOKMARKS_BAR_ID);
    expect(leaf?.index).toBe(1);
  });

  it("computes depth as distance below the supplied tree roots", () => {
    const model = flattenTree(chromeTree());
    expect(model.folders.get(ROOT_NODE_ID)?.depth).toBe(0);
    expect(model.folders.get(BOOKMARKS_BAR_ID)?.depth).toBe(1);
    expect(model.folders.get("10")?.depth).toBe(2);
    expect(model.bookmarks.get("11")?.depth).toBe(3);
    expect(model.bookmarks.get("20")?.depth).toBe(2);
  });

  it("records ancestor titles as path, excluding the synthetic root", () => {
    const model = flattenTree(chromeTree());
    expect(model.folders.get(ROOT_NODE_ID)?.path).toEqual([]);
    expect(model.folders.get(BOOKMARKS_BAR_ID)?.path).toEqual([]);
    expect(model.folders.get("10")?.path).toEqual(["Bookmarks bar"]);
    expect(model.bookmarks.get("11")?.path).toEqual([
      "Bookmarks bar",
      "Work",
    ]);
    expect(model.bookmarks.get("20")?.path).toEqual(["Mobile bookmarks"]);
  });
});

describe("flattenTree ordering", () => {
  it("childIds preserves Chrome's index order", () => {
    const model = flattenTree(chromeTree());
    expect(model.folders.get(ROOT_NODE_ID)?.childIds).toEqual([
      BOOKMARKS_BAR_ID,
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID,
    ]);
    expect(model.folders.get(BOOKMARKS_BAR_ID)?.childIds).toEqual([
      "10",
      "13",
    ]);
    expect(model.folders.get("10")?.childIds).toEqual(["11", "12"]);
    expect(model.folders.get(OTHER_BOOKMARKS_ID)?.childIds).toEqual([]);
  });

  it("sorts childIds by index even when the children array is shuffled", () => {
    const tree: BookmarksTreeNode[] = [
      {
        id: ROOT_NODE_ID,
        title: "",
        children: [
          {
            id: BOOKMARKS_BAR_ID,
            parentId: ROOT_NODE_ID,
            index: 0,
            title: "Bookmarks bar",
            children: [
              { id: "b", parentId: BOOKMARKS_BAR_ID, index: 1, title: "b", url: "https://b/" },
              { id: "a", parentId: BOOKMARKS_BAR_ID, index: 0, title: "a", url: "https://a/" },
              { id: "c", parentId: BOOKMARKS_BAR_ID, index: 2, title: "c", url: "https://c/" },
            ],
          },
        ],
      },
    ];
    const model = flattenTree(tree);
    expect(model.folders.get(BOOKMARKS_BAR_ID)?.childIds).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("iterates both maps in deterministic depth-first pre-order", () => {
    const model = flattenTree(chromeTree());
    expect([...model.folders.keys()]).toEqual([
      ROOT_NODE_ID,
      BOOKMARKS_BAR_ID,
      "10",
      OTHER_BOOKMARKS_ID,
      MOBILE_BOOKMARKS_ID,
    ]);
    expect([...model.bookmarks.keys()]).toEqual(["11", "12", "13", "20"]);
  });
});

describe("flattenTree managed flags", () => {
  it("flags an unmodifiable node and every descendant as isManaged", () => {
    const model = flattenTree(managedTree());
    expect(model.folders.get("managed-folder")?.isManaged).toBe(true);
    expect(model.bookmarks.get("managed-child")?.isManaged).toBe(true);
    expect(model.folders.get("managed-sub")?.isManaged).toBe(true);
    expect(model.bookmarks.get("managed-grandchild")?.isManaged).toBe(true);
  });

  it("does not flag roots, siblings, or unmanaged nodes", () => {
    const model = flattenTree(managedTree());
    expect(model.folders.get(ROOT_NODE_ID)?.isManaged).toBe(false);
    expect(model.folders.get(BOOKMARKS_BAR_ID)?.isManaged).toBe(false);
    expect(model.bookmarks.get("free")?.isManaged).toBe(false);
  });
});

describe("flattenTree subtree input", () => {
  it("treats the supplied forest's top level as depth 0 with empty paths", () => {
    // getSubTree("10")-style input: a subtree root still carries parentId.
    const subtree: BookmarksTreeNode[] = [
      {
        id: "10",
        parentId: BOOKMARKS_BAR_ID,
        index: 0,
        title: "Work",
        children: [
          { id: "11", parentId: "10", index: 0, title: "A", url: "https://a/" },
        ],
      },
    ];
    const model = flattenTree(subtree);
    const root = model.folders.get("10");
    expect(root?.depth).toBe(0);
    expect(root?.path).toEqual([]);
    expect(root?.parentId).toBe(BOOKMARKS_BAR_ID);
    expect(model.bookmarks.get("11")?.path).toEqual(["Work"]);
    expect(model.bookmarks.get("11")?.depth).toBe(1);
  });
});
