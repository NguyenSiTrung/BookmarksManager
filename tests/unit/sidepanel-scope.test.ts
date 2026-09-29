import { describe, expect, it } from "vitest";
import {
  PRIMARY_CHIPS,
  aiVisibility,
  categoryCounts,
  moreViews,
} from "../../src/entrypoints/sidepanel/scope";
import type { BookmarkMeta } from "../../src/schemas/meta";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";

const ISO = "2026-09-29T10:00:00.000Z";

const nodes: BookmarksTreeNode[] = [
  {
    id: "0",
    title: "",
    children: [
      {
        id: "1",
        parentId: "0",
        index: 0,
        title: "Bookmarks bar",
        children: [
          { id: "b1", parentId: "1", index: 0, title: "A", url: "https://a.example/" },
          { id: "b2", parentId: "1", index: 1, title: "B", url: "https://b.example/" },
          { id: "b3", parentId: "1", index: 2, title: "C", url: "https://c.example/" },
        ],
      },
    ],
  },
];
const tree = flattenTree(nodes);

function meta(id: string, category?: BookmarkMeta["category"]): BookmarkMeta {
  return { id, tags: [], category, updatedAt: ISO };
}

describe("categoryCounts", () => {
  it("counts only categories with at least one bookmark, in schema order", () => {
    const counts = categoryCounts(
      [meta("b1", "docs"), meta("b2", "docs"), meta("b3", "article")],
      tree,
    );
    expect(counts).toEqual([
      { category: "article", count: 1 },
      { category: "docs", count: 2 },
    ]);
  });

  it("ignores rows without a category and rows for bookmarks that no longer exist", () => {
    expect(
      categoryCounts([meta("b1"), meta("gone", "video")], tree),
    ).toEqual([]);
  });
});

describe("aiVisibility", () => {
  it("hides every AI entry and offers setup when no provider is connected", () => {
    expect(aiVisibility({ aiConnected: false, pendingCount: 0 })).toEqual({
      showReview: false,
      showRestructure: false,
      showScan: false,
      showSetUpAi: true,
    });
  });

  it("still shows Review when suggestions are pending without a provider", () => {
    const vis = aiVisibility({ aiConnected: false, pendingCount: 2 });
    expect(vis.showReview).toBe(true);
    expect(vis.showScan).toBe(false);
  });

  it("shows every AI entry and no setup prompt when connected", () => {
    expect(aiVisibility({ aiConnected: true, pendingCount: 0 })).toEqual({
      showReview: true,
      showRestructure: true,
      showScan: true,
      showSetUpAi: false,
    });
  });
});

describe("moreViews", () => {
  const off = aiVisibility({ aiConnected: false, pendingCount: 0 });
  const on = aiVisibility({ aiConnected: true, pendingCount: 0 });

  it("always lists Duplicates and hides AI views without a provider", () => {
    expect(moreViews(off, "all").map((v) => v.kind)).toEqual(["duplicates"]);
  });

  it("lists Duplicates, Review and Restructure when connected", () => {
    expect(moreViews(on, "all")).toEqual([
      { kind: "duplicates", label: "Duplicates" },
      { kind: "review", label: "Review suggestions" },
      { kind: "restructure", label: "Restructure" },
    ]);
  });

  it("keeps the active view listed even when its visibility rule is off", () => {
    expect(moreViews(off, "review").map((v) => v.kind)).toEqual([
      "duplicates",
      "review",
    ]);
  });
});

describe("PRIMARY_CHIPS", () => {
  it("is All, Recent, Untagged", () => {
    expect(PRIMARY_CHIPS.map((c) => c.label)).toEqual([
      "All",
      "Recent",
      "Untagged",
    ]);
  });
});
