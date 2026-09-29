import { Category } from "../../schemas/bookmark";
import type { BookmarkMeta } from "../../schemas/meta";
import type { FlattenedTree } from "../../sync/tree";
import type { SidePanelViewKind } from "./views";

/**
 * Pure helpers behind the side-panel shell: which categories are worth
 * listing, which AI entries a user without a provider should see, and which
 * views live behind the "More" chip. No React, no Dexie, no chrome.
 */

export interface CategoryCount {
  category: Category;
  count: number;
}

/**
 * Bookmarks per category, in schema order, omitting empty categories. Meta
 * rows for bookmarks that no longer exist are ignored — rows are lazy and
 * can outlive their node.
 */
export function categoryCounts(
  metas: readonly BookmarkMeta[],
  tree: FlattenedTree,
): CategoryCount[] {
  const counts = new Map<Category, number>();
  for (const meta of metas) {
    if (meta.category === undefined || !tree.bookmarks.has(meta.id)) continue;
    counts.set(meta.category, (counts.get(meta.category) ?? 0) + 1);
  }
  return Category.options.flatMap((category) => {
    const count = counts.get(category) ?? 0;
    return count > 0 ? [{ category, count }] : [];
  });
}

export interface AiVisibility {
  showReview: boolean;
  showRestructure: boolean;
  showScan: boolean;
  showSetUpAi: boolean;
}

/**
 * Review stays reachable while suggestions are pending even if the provider
 * was later disconnected; everything that starts new AI work needs a
 * connected provider. Without one, a single "Set up AI…" entry replaces them.
 */
export function aiVisibility(input: {
  aiConnected: boolean;
  pendingCount: number;
}): AiVisibility {
  const { aiConnected, pendingCount } = input;
  return {
    showReview: aiConnected || pendingCount > 0,
    showRestructure: aiConnected,
    showScan: aiConnected,
    showSetUpAi: !aiConnected,
  };
}

export type MoreViewKind = "duplicates" | "review" | "restructure";

export interface MoreView {
  kind: MoreViewKind;
  label: string;
}

const MORE_LABELS: Record<MoreViewKind, string> = {
  duplicates: "Duplicates",
  review: "Review suggestions",
  restructure: "Restructure",
};

/**
 * Views listed in the "More" menu. The active view is always listed so the
 * chip row can name where the user is, even if its visibility rule turned
 * off underneath them.
 */
export function moreViews(
  visibility: AiVisibility,
  activeKind: SidePanelViewKind,
): MoreView[] {
  const show: Record<MoreViewKind, boolean> = {
    duplicates: true,
    review: visibility.showReview,
    restructure: visibility.showRestructure,
  };
  return (Object.keys(MORE_LABELS) as MoreViewKind[])
    .filter((kind) => show[kind] || kind === activeKind)
    .map((kind) => ({ kind, label: MORE_LABELS[kind] }));
}

/** The always-visible chips. */
export const PRIMARY_CHIPS: readonly {
  kind: "all" | "recent" | "untagged";
  label: string;
}[] = [
  { kind: "all", label: "All" },
  { kind: "recent", label: "Recent" },
  { kind: "untagged", label: "Untagged" },
];
