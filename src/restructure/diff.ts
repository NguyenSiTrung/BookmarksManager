import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";
import type { RestructureJobPlan } from "../schemas/job";

/**
 * The before/after diff the confirmation view renders (spec FR8.6): one row
 * per assignment the job committed, in stable bookmarkId order — never
 * reordered by confidence or path so re-renders don't shuffle under the
 * user. Unresolved and stale rows are *shown* (marked) but the apply layer
 * excludes them.
 */

export type DiffRowStatus =
  /** Resolved: Jev mapped the bookmark to a proposed path. */
  | "resolved"
  /** Unresolved: `none` or low confidence — excluded from apply. */
  | "unresolved"
  /** The bookmark no longer exists in the live tree — excluded. */
  | "stale";

export interface DiffRow {
  readonly bookmarkId: string;
  readonly title: string;
  /** Current folder path, "/" joined; "" for a root-level bookmark. */
  readonly fromPath: string;
  /** Proposed path, `null` when unresolved. */
  readonly toPath: string | null;
  /** Jev's confidence, `null` when unresolved. */
  readonly confidence: number | null;
  readonly status: DiffRowStatus;
  /**
   * Present when the row is `unresolved` because the bookmark sits inside a
   * managed (administrator-controlled) subtree — such nodes reject every
   * write, so apply skips them before any mutation instead of failing
   * mid-way. The preview flags the row so it is never offered as movable.
   */
  readonly managed?: true;
}

export interface RestructureDiff {
  readonly rows: readonly DiffRow[];
  /** Counts for the header line. */
  readonly resolved: number;
  readonly unresolved: number;
  readonly stale: number;
}

interface FlatEntry {
  readonly node: BookmarksTreeNode;
  /** Parent folder path, e.g. "Dev/Tools"; "" for root-level. */
  readonly path: string;
  /** The node or any ancestor carries `unmodifiable: "managed"`. */
  readonly managed: boolean;
}

/**
 * Flatten the live tree into {id → {node, parent path, managed}} in
 * pre-order. `managed` propagates: Chrome marks the managed root and its
 * descendants, and a managed ancestor makes a child unwritable even when
 * the child's own flag is absent.
 */
function flatten(tree: readonly BookmarksTreeNode[]): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const stack: Array<{ node: BookmarksTreeNode; path: string; managed: boolean }> = tree
    .map((node) => ({
      node,
      path: "",
      managed: node.unmodifiable === "managed",
    }))
    .reverse();
  while (stack.length > 0) {
    const { node, path, managed } = stack.pop()!;
    if (node.url === undefined) {
      const folderPath = path === "" ? node.title : `${path}/${node.title}`;
      for (const child of [...(node.children ?? [])].reverse()) {
        stack.push({
          node: child,
          path: folderPath,
          managed: managed || child.unmodifiable === "managed",
        });
      }
      continue;
    }
    out.set(node.id, { node, path, managed });
  }
  return out;
}

/**
 * Build the diff for a job's committed plan. Rows are sorted by bookmarkId
 * (a stable order independent of commit order); unresolved assignments
 * (`proposedPath === null`) and bookmarks gone from the live tree are
 * included as marked rows — never dropped, so the user sees the full plan.
 */
export function buildRestructureDiff(
  tree: readonly BookmarksTreeNode[],
  plan: RestructureJobPlan,
): RestructureDiff {
  const live = flatten(tree);
  const rows: DiffRow[] = [];
  for (const assignment of [...plan.assignments].sort((a, b) =>
    a.bookmarkId.localeCompare(b.bookmarkId),
  )) {
    const entry = live.get(assignment.bookmarkId);
    if (assignment.proposedPath === null) {
      rows.push({
        bookmarkId: assignment.bookmarkId,
        title: entry?.node.title ?? "",
        fromPath: entry?.path ?? "",
        toPath: null,
        confidence: assignment.confidence,
        status: "unresolved",
      });
      continue;
    }
    if (entry === undefined) {
      rows.push({
        bookmarkId: assignment.bookmarkId,
        title: "",
        fromPath: "",
        toPath: assignment.proposedPath,
        confidence: assignment.confidence,
        status: "stale",
      });
      continue;
    }
    if (entry.managed) {
      // Managed/root-adjacent bookmarks reject every write — flag the row
      // as unresolved so apply skips it rather than failing mid-apply.
      rows.push({
        bookmarkId: assignment.bookmarkId,
        title: entry.node.title,
        fromPath: entry.path,
        toPath: assignment.proposedPath,
        confidence: assignment.confidence,
        status: "unresolved",
        managed: true,
      });
      continue;
    }
    rows.push({
      bookmarkId: assignment.bookmarkId,
      title: entry.node.title,
      fromPath: entry.path,
      toPath: assignment.proposedPath,
      confidence: assignment.confidence,
      status: "resolved",
    });
  }
  return {
    rows,
    resolved: rows.filter((r) => r.status === "resolved").length,
    unresolved: rows.filter((r) => r.status === "unresolved").length,
    stale: rows.filter((r) => r.status === "stale").length,
  };
}
