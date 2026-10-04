import { describe, expect, it } from "vitest";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { buildLibrarySynopsis } from "../../src/restructure/synopsis";
import { RESTRUCTURE_LIMITS } from "../../src/schemas/restructure";
import { SummaryVerificationState } from "../../src/schemas/summary-verification";

/**
 * Phase 6 Task 2 — the LLM layer's payload bounds are gates, not hopes:
 * the library synopsis and the summary-verification state are the two
 * bodies an LLM/Jev request can carry, and each field must stay under its
 * documented cap no matter how big the user's library or page is.
 */

type TreeNode = BookmarksTreeNode;

/** A folder node whose children are `count` bookmarks on distinct hosts. */
function folder(id: string, title: string, count: number): TreeNode {
  const children: TreeNode[] = [];
  for (let i = 0; i < count; i += 1) {
    children.push({
      id: `${id}-b${i}`,
      title: `T${i} `.repeat(40), // ~120+ chars to exercise truncation
      url: `https://site-${id}-${i}.example.io/page`,
      parentId: id,
    });
  }
  return { id, title, children };
}

describe("buildLibrarySynopsis bounds", () => {
  it("caps folder paths, per-folder titles, domains, and title length", () => {
    // 150 folders → over the folderPaths cap; each with 6 bookmarks on
    // distinct hosts → over the representativeTitles and domains caps.
    const tree: TreeNode[] = [
      {
        id: "1",
        title: "Bookmarks bar",
        children: Array.from({ length: 150 }, (_, i) =>
          folder(`f${i}`, `Folder ${i}`, 6),
        ),
      },
    ];
    const synopsis = buildLibrarySynopsis(tree, []);

    expect(synopsis.folderPaths.length).toBeLessThanOrEqual(
      RESTRUCTURE_LIMITS.folderPaths,
    );
    for (const titles of Object.values(synopsis.representativeTitles)) {
      expect(titles.length).toBeLessThanOrEqual(
        RESTRUCTURE_LIMITS.representativeTitles,
      );
      for (const title of titles) {
        expect(title.length).toBeLessThanOrEqual(
          RESTRUCTURE_LIMITS.titleLength,
        );
      }
    }
    expect(synopsis.domains.length).toBeLessThanOrEqual(
      RESTRUCTURE_LIMITS.domains,
    );
    for (const entry of synopsis.domains) {
      expect(entry.count).toBeGreaterThanOrEqual(1);
    }
    expect(synopsis.bookmarkCount).toBeGreaterThan(0);
  });

  it("respects tighter per-call limits", () => {
    const tree: TreeNode[] = [
      {
        id: "1",
        title: "Bookmarks bar",
        children: Array.from({ length: 10 }, (_, i) =>
          folder(`f${i}`, `Folder ${i}`, 6),
        ),
      },
    ];
    const synopsis = buildLibrarySynopsis(tree, [], {
      folderPaths: 2,
      representativeTitles: 1,
      domains: 3,
      titleLength: 10,
    });
    expect(synopsis.folderPaths.length).toBeLessThanOrEqual(2);
    expect(synopsis.domains.length).toBeLessThanOrEqual(3);
    for (const titles of Object.values(synopsis.representativeTitles)) {
      expect(titles.length).toBeLessThanOrEqual(1);
      for (const title of titles) {
        expect(title.length).toBeLessThanOrEqual(10);
      }
    }
  });
});

describe("summary-verification state bounds", () => {
  const valid = {
    bookmark: { title: "T", url: "https://a.io/", domain: "a.io" },
    excerpt: "Some page text.",
    headings: ["h1"],
    summary: "A summary.",
  };

  it("accepts a bounded state", () => {
    expect(SummaryVerificationState.safeParse(valid).success).toBe(true);
  });

  it("rejects over-limit fields", () => {
    for (const [label, over] of [
      ["excerpt > 20_000", { excerpt: "x".repeat(20_001) }],
      ["headings > 50", { headings: Array.from({ length: 51 }, () => "h") }],
      ["a heading > 200", { headings: ["x".repeat(201)] }],
      ["summary > 2_000", { summary: "x".repeat(2_001) }],
      [
        "bookmark title > 500",
        {
          bookmark: {
            title: "x".repeat(501),
            url: "https://a.io/",
            domain: "a.io",
          },
        },
      ],
    ] as const) {
      expect(
        SummaryVerificationState.safeParse({ ...valid, ...over }).success,
        label,
      ).toBe(false);
    }
  });
});
