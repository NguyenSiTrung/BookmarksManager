import { domainOf, isSensitiveUrl } from "../decisions/minimize";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";
import type { BookmarkMeta } from "../schemas/meta";
import {
  LibrarySynopsis,
  RESTRUCTURE_LIMITS,
} from "../schemas/restructure";

/**
 * The bounded library synopsis (spec FR8.2): folder paths, category/tag
 * counts, top domains, and a few capped representative titles per folder.
 * This is the ONLY shape the proposal prompt carries — no URLs, no notes,
 * no ids, no unbounded dumps. Everything is sorted deterministically so the
 * same library always produces byte-identical input.
 *
 * Total: unsendable nodes (sensitive/blocklisted/unparseable) are excluded,
 * never throw.
 */

export interface SynopsisLimits {
  /** Max existing folder paths listed (default RESTRUCTURE_LIMITS.folderPaths). */
  readonly folderPaths?: number;
  /** Max representative titles per folder (default RESTRUCTURE_LIMITS.representativeTitles). */
  readonly representativeTitles?: number;
  /** Max distinct domains (default RESTRUCTURE_LIMITS.domains). */
  readonly domains?: number;
  /** Max chars per representative title (default RESTRUCTURE_LIMITS.titleLength). */
  readonly titleLength?: number;
  /** Optional user blocklist consulted alongside the builtin sensitive sites. */
  readonly userBlocklist?: readonly string[];
}

interface MutableBucket {
  /** Representative titles, already capped. */
  titles: string[];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Build the bounded synopsis from the bookmark tree + metas. `metas` may be
 * a map keyed by bookmark id or an array — both normalize to a lookup.
 */
export function buildLibrarySynopsis(
  tree: readonly BookmarksTreeNode[],
  metas: ReadonlyMap<string, BookmarkMeta> | readonly BookmarkMeta[],
  limits: SynopsisLimits = {},
): LibrarySynopsis {
  const folderPathsCap = limits.folderPaths ?? RESTRUCTURE_LIMITS.folderPaths;
  const titlesCap =
    limits.representativeTitles ?? RESTRUCTURE_LIMITS.representativeTitles;
  const domainsCap = limits.domains ?? RESTRUCTURE_LIMITS.domains;
  const titleCap = limits.titleLength ?? RESTRUCTURE_LIMITS.titleLength;

  let metaById: ReadonlyMap<string, BookmarkMeta>;
  if (metas instanceof Map) {
    metaById = metas;
  } else if (Array.isArray(metas)) {
    metaById = new Map(metas.map((m: BookmarkMeta) => [m.id, m]));
  } else {
    metaById = metas;
  }

  const folderPaths: string[] = [];
  const titlesByFolder = new Map<string, MutableBucket>();
  const categories = new Map<string, number>();
  const tags = new Map<string, number>();
  const domains = new Map<string, number>();
  let bookmarkCount = 0;

  interface Frame {
    node: BookmarksTreeNode;
    /** Path from the root, "a/b" — empty for the root itself. */
    path: string;
  }

  // Deterministic walk: pre-order, children in index order. `path` is the
  // enclosing folder's path; for a folder its own path is `path/title`.
  const stack: Frame[] = tree.map((node) => ({ node, path: "" })).reverse();
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    const isFolder = node.url === undefined;
    if (isFolder) {
      const folderPath =
        path === "" ? (node.title ?? "") : `${path}/${node.title}`;
      if (node.parentId !== undefined) {
        // Skip the synthetic root "0" — it has no parentId.
        folderPaths.push(folderPath);
        titlesByFolder.set(folderPath, { titles: [] });
      }
      for (const child of [...(node.children ?? [])].reverse()) {
        stack.push({ node: child, path: folderPath });
      }
      continue;
    }
    // Bookmark node — include only if sendable.
    const cleaned = node.url;
    if (typeof cleaned !== "string" || isSensitiveUrl(cleaned, limits.userBlocklist)) {
      continue;
    }
    const domain = domainOf(cleaned);
    if (domain === null) continue;
    bookmarkCount += 1;
    domains.set(domain, (domains.get(domain) ?? 0) + 1);
    const meta = metaById.get(node.id);
    if (meta !== undefined) {
      if (meta.category !== undefined) {
        categories.set(meta.category, (categories.get(meta.category) ?? 0) + 1);
      }
      for (const tag of meta.tags) {
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }
    }
    const folderBucket = titlesByFolder.get(path);
    if (folderBucket !== undefined && folderBucket.titles.length < titlesCap) {
      const title = truncate(node.title.trim(), titleCap);
      if (title !== "") folderBucket.titles.push(title);
    }
  }

  // Deterministic ordering everywhere.
  folderPaths.sort();
  const sortedFolders = folderPaths.slice(0, folderPathsCap);
  const representativeTitles = Object.fromEntries(
    sortedFolders
      .filter((p) => (titlesByFolder.get(p)?.titles.length ?? 0) > 0)
      .map((p) => [p, titlesByFolder.get(p)!.titles]),
  );
  const sortedDomains = [...domains.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, domainsCap)
    .map(([domain, count]) => ({ domain, count }));

  return {
    folderPaths: sortedFolders,
    categories: Object.fromEntries(
      [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    tags: Object.fromEntries(
      [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    domains: sortedDomains,
    representativeTitles,
    bookmarkCount,
  };
}
