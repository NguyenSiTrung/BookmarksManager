import { describe, expect, it } from "vitest";
import { emptyStateFor } from "../../src/entrypoints/sidepanel/empty-state";

const ctx = { aiConnected: false, libraryEmpty: false };

describe("emptyStateFor", () => {
  it("offers Import when the whole library is empty", () => {
    expect(
      emptyStateFor({ kind: "all" }, { ...ctx, libraryEmpty: true }),
    ).toEqual({
      title: "No bookmarks yet",
      hint: "Import a file, or save pages with the toolbar button.",
      action: { kind: "import", label: "Import…" },
    });
  });

  it("describes an empty folder without an action", () => {
    expect(emptyStateFor({ kind: "folder", folderId: "10" }, ctx)).toEqual({
      title: "This folder is empty",
      hint: "Use “Move to…” on a bookmark to put it here.",
    });
  });

  it("names the query and offers Clear search", () => {
    expect(emptyStateFor({ kind: "search", query: "sour" }, ctx)).toEqual({
      title: "No results for “sour”",
      hint: "Try fewer words or check the spelling.",
      action: { kind: "clear-search", label: "Clear search" },
    });
  });

  it("covers untagged, recent, tag, category and duplicates", () => {
    expect(emptyStateFor({ kind: "untagged" }, ctx).title).toBe(
      "Everything is tagged",
    );
    expect(emptyStateFor({ kind: "recent" }, ctx).title).toBe(
      "Nothing saved recently",
    );
    expect(emptyStateFor({ kind: "tag", nameKey: "dev" }, ctx).title).toBe(
      "No bookmarks with this tag",
    );
    expect(
      emptyStateFor({ kind: "category", category: "docs" }, ctx).title,
    ).toBe("No bookmarks in this category");
    expect(emptyStateFor({ kind: "duplicates" }, ctx)).toEqual({
      title: "No duplicates found",
      hint: "Every bookmark URL is unique.",
    });
  });

  it("offers Scan library when AI is connected and Set up AI when it is not", () => {
    expect(
      emptyStateFor({ kind: "review" }, { ...ctx, aiConnected: true }),
    ).toEqual({
      title: "Nothing to review",
      hint: "Suggestions from a scan appear here.",
      action: { kind: "scan", label: "Scan library…" },
    });
    expect(emptyStateFor({ kind: "review" }, ctx)).toEqual({
      title: "Nothing to review",
      hint: "Connect an AI provider to get suggestions.",
      action: { kind: "set-up-ai", label: "Set up AI…" },
    });
  });

  it("has a generic fallback for the all view with a non-empty library", () => {
    expect(emptyStateFor({ kind: "all" }, ctx).title).toBe("No bookmarks here");
  });
});
