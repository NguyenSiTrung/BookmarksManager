import type { SidePanelView } from "./views";

/**
 * Copy and next step for each way the side panel can be empty. Pure: the
 * caller decides whether the list is empty and maps `action.kind` to a real
 * handler. The typed search query lives on the `search` view.
 */
export type EmptyActionKind = "import" | "clear-search" | "scan" | "set-up-ai";

export interface EmptyStateSpec {
  title: string;
  hint?: string;
  action?: { kind: EmptyActionKind; label: string };
}

export interface EmptyStateContext {
  aiConnected: boolean;
  /** The whole library has no bookmarks (not just this view). */
  libraryEmpty: boolean;
}

export function emptyStateFor(
  view: SidePanelView,
  ctx: EmptyStateContext,
): EmptyStateSpec {
  switch (view.kind) {
    case "all":
      return ctx.libraryEmpty
        ? {
            title: "No bookmarks yet",
            hint: "Import a file, or save pages with the toolbar button.",
            action: { kind: "import", label: "Import…" },
          }
        : { title: "No bookmarks here" };
    case "folder":
      return {
        title: "This folder is empty",
        hint: "Use “Move to…” on a bookmark to put it here.",
      };
    case "search":
      return {
        title: `No results for “${view.query}”`,
        hint: "Try fewer words or check the spelling.",
        action: { kind: "clear-search", label: "Clear search" },
      };
    case "untagged":
      return {
        title: "Everything is tagged",
        hint: "Bookmarks without tags would show up here.",
      };
    case "recent":
      return {
        title: "Nothing saved recently",
        hint: "Newly saved bookmarks appear here.",
      };
    case "tag":
      return {
        title: "No bookmarks with this tag",
        hint: "Tag bookmarks from their ⋯ menu.",
      };
    case "category":
      return {
        title: "No bookmarks in this category",
        hint: "Categories are set when you edit a bookmark.",
      };
    case "duplicates":
      return {
        title: "No duplicates found",
        hint: "Every bookmark URL is unique.",
      };
    case "review":
      return ctx.aiConnected
        ? {
            title: "Nothing to review",
            hint: "Suggestions from a scan appear here.",
            action: { kind: "scan", label: "Scan library…" },
          }
        : {
            title: "Nothing to review",
            hint: "Connect an AI provider to get suggestions.",
            action: { kind: "set-up-ai", label: "Set up AI…" },
          };
    case "restructure":
      return { title: "Nothing here yet" };
  }
}
