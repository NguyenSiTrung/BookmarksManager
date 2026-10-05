import MiniSearch from "minisearch";
import type { SearchResult } from "minisearch";
import type { Category } from "../schemas/bookmark";
import type { BookmarkMeta } from "../schemas/meta";
import { ROOT_NODE_ID } from "../sync/chrome-bookmarks";
import type { BookmarkItem, FlattenedTree } from "../sync/tree";

/**
 * Pure search-index layer: one MiniSearch document per bookmark, built from
 * plain data (`SearchSourceBookmark`) with no `chrome`, DOM, or React
 * dependencies. Callers resolve the tree node, its meta row, its ancestor
 * chain, and the tag definitions; this module maps them onto documents,
 * builds the index, and applies incremental diffs.
 *
 * Indexed (tokenized) fields: `title`, `tags` (display names), `domain`,
 * `url`, `notes`. Stored-only fields — returned on every `SearchResult` so
 * the executor can filter and render without a tree join: `folderIds`,
 * `folderTitles`, `dateAdded`, `category`, `tagKeys`. `title`, `url`, and
 * `domain` are indexed *and* stored, so hits are display-ready (the omnibox
 * needs title + domain + folder path straight off the result).
 *
 * Search defaults baked into every index: free-text terms ANDed, prefix
 * matching, fuzzy typo tolerance (20% of term length), and field boosts
 * `title > tags > domain > url > notes`. Per-call `search()` options merge
 * over these defaults key-by-key, so the executor can pass e.g. `filter`
 * without losing them.
 */

/** A folder on a bookmark's ancestor path. */
export interface SearchSourceAncestor {
  /** Chrome folder node id — stored for `folder:` filtering. */
  id: string;
  /** Folder title — stored for `folder:` filtering and path display. */
  title: string;
}

/**
 * Plain-data view of one bookmark plus everything the index needs from its
 * surroundings. Deliberately free of `chrome` types so this module stays
 * pure: the caller walks the flattened tree (`BookmarkItem`), reads the meta
 * row, and resolves the ancestor chain.
 */
export interface SearchSourceBookmark {
  /** Bookmark node id — becomes the document id. */
  id: string;
  title: string;
  url: string;
  /** Milliseconds since epoch; absent when the source node didn't carry one. */
  dateAdded?: number;
  /**
   * Ancestor folders, topmost first. Chrome's fixed roots ("Bookmarks bar"
   * etc.) are included — they are visible folders — but the synthetic root
   * "0" should be left out, matching `flattenTree`'s `path` semantics.
   */
  ancestors: readonly SearchSourceAncestor[];
  /** Tag nameKeys (the trim+lowercase forms) carried by the meta row. */
  tagKeys: readonly string[];
  category?: Category;
  notes?: string;
}

/** Minimal shape of a tag definition needed to resolve display names. */
export interface TagNameSource {
  /** The tag's display name. */
  name: string;
  /** Its case-insensitive uniqueness key (`tagNameKey(name)`). */
  nameKey: string;
}

/** `nameKey → display name` lookup consumed by document mapping. */
export type TagNameMap = ReadonlyMap<string, string>;

/**
 * One indexed document per bookmark. Searchable fields are strings; stored
 * fields keep their structured types for the executor's filters.
 */
export interface SearchDocument {
  id: string;
  title: string;
  url: string;
  /**
   * Hostname with a leading `www.` stripped; `""` for opaque-scheme
   * (`javascript:`, `data:`, …) or unparseable URLs.
   */
  domain: string;
  /** Resolved tag display names joined by spaces; `""` when untagged. */
  tags: string;
  notes: string;
  /** Ancestor folder ids, topmost first (stored). */
  folderIds: string[];
  /** Ancestor folder titles, positionally aligned with `folderIds` (stored). */
  folderTitles: string[];
  /** Stored verbatim; absent when the source didn't carry one. */
  dateAdded?: number;
  /** Stored verbatim; absent when the bookmark is uncategorized. */
  category?: Category;
  /** Stored copy of the source's tag nameKeys, for `tag:` filtering. */
  tagKeys: string[];
}

/**
 * A MiniSearch result for a `SearchDocument`: the library's `SearchResult`
 * plus the stored fields, redeclared so they type as `T` rather than `any`.
 */
export interface SearchHit extends SearchResult {
  title: string;
  url: string;
  domain: string;
  folderIds: string[];
  folderTitles: string[];
  tagKeys: string[];
  dateAdded?: number;
  category?: Category;
}

/** The configured index type produced by {@link buildIndex}. */
export type SearchIndex = MiniSearch<SearchDocument>;

/**
 * A batch of document changes to apply with MiniSearch
 * `add`/`discard`/`replace`. Diffs are tolerant: discarding an unknown id is
 * a no-op, and `add`/`replace` upsert — an `add` whose id already exists
 * replaces the document, a `replace` whose id is missing adds it.
 */
export interface SearchDocDiff {
  /** Documents to index; an id already present is replaced. */
  add?: readonly SearchDocument[];
  /** Ids to drop; unknown ids are skipped. */
  discard?: readonly string[];
  /** Documents to replace by id; an id not present is added. */
  replace?: readonly SearchDocument[];
}

/**
 * Field boosts implementing "title highest, then tags, then domain, then
 * url, then notes". A domain hit inevitably hits `url` too (the host is a
 * substring of the URL) and MiniSearch sums a term's per-field scores, so
 * `domain + url = 3` is kept below `tags = 4` to preserve the ordering.
 */
const FIELD_BOOSTS = { title: 5, tags: 4, domain: 2, url: 1, notes: 0.5 };

export const INDEXED_FIELDS = ["title", "tags", "domain", "url", "notes"];
const STORED_FIELDS = [
  "title",
  "url",
  "domain",
  "folderIds",
  "folderTitles",
  "dateAdded",
  "category",
  "tagKeys",
];

/**
 * Build the `nameKey → display name` lookup used by {@link toSearchDocument}
 * and {@link buildIndex}. `tagDefs` is anything carrying `name`/`nameKey`
 * (the stored `TagDef` rows qualify); later defs win on duplicate keys.
 */
export function buildTagNameMap(tagDefs: readonly TagNameSource[]): TagNameMap {
  const map = new Map<string, string>();
  for (const def of tagDefs) {
    map.set(def.nameKey, def.name);
  }
  return map;
}

/**
 * Hostname of `url` minus a leading `www.`. Opaque schemes (`javascript:`,
 * `data:`, `mailto:`, …) and unparseable input yield `""` — total, never
 * throws.
 */
export function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.startsWith("www.")
      ? hostname.slice("www.".length)
      : hostname;
  } catch {
    return "";
  }
}

/**
 * Ancestor folders of `item`, topmost first, excluding the synthetic root
 * "0" — resolved through the folders map (item.path holds titles only, so
 * ids must be walked via `parentId`). Cycle-guarded against malformed trees.
 * Shared by the live hook and the omnibox session index so both surfaces
 * index identical `folder:` semantics.
 */
export function ancestorsOf(
  tree: FlattenedTree,
  item: BookmarkItem,
): SearchSourceAncestor[] {
  const out: SearchSourceAncestor[] = [];
  const seen = new Set<string>();
  let cursor = item.parentId;
  while (
    cursor !== undefined &&
    cursor !== ROOT_NODE_ID &&
    !seen.has(cursor)
  ) {
    seen.add(cursor);
    const folder = tree.folders.get(cursor);
    if (folder === undefined) break;
    out.push({ id: folder.id, title: folder.title });
    cursor = folder.parentId;
  }
  return out.reverse();
}

/**
 * Resolve one flattened bookmark + its meta row onto the plain
 * {@link SearchSourceBookmark} document source — the single mapping both
 * `useSearchIndex` (diff-based live index) and the omnibox session index
 * build from.
 */
export function toSourceBookmark(
  tree: FlattenedTree,
  item: BookmarkItem,
  meta: BookmarkMeta | undefined,
): SearchSourceBookmark {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    ...(item.dateAdded === undefined ? {} : { dateAdded: item.dateAdded }),
    ancestors: ancestorsOf(tree, item),
    tagKeys: meta?.tags ?? [],
    ...(meta?.category === undefined ? {} : { category: meta.category }),
    ...(meta?.notes === undefined ? {} : { notes: meta.notes }),
  };
}

/**
 * Map one resolved bookmark onto its index document. Tag nameKeys become
 * display names through `tagNames`; a key with no def falls back to the key
 * itself so the bookmark stays findable by it. `javascript:`/`data:` URLs
 * are mapped (and indexed) like any other — open-disabled is a UI concern.
 */
export function toSearchDocument(
  source: SearchSourceBookmark,
  tagNames: TagNameMap,
): SearchDocument {
  const tags = source.tagKeys
    .map((key) => tagNames.get(key) ?? key)
    .join(" ");
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    domain: extractDomain(source.url),
    tags,
    notes: source.notes ?? "",
    folderIds: source.ancestors.map((ancestor) => ancestor.id),
    folderTitles: source.ancestors.map((ancestor) => ancestor.title),
    tagKeys: [...source.tagKeys],
    ...(source.dateAdded === undefined ? {} : { dateAdded: source.dateAdded }),
    ...(source.category === undefined ? {} : { category: source.category }),
  };
}

/**
 * An empty index with the shared configuration: AND-combined free-text
 * terms, prefix matching, fuzzy typo tolerance, and the field boosts.
 * `fields` narrows the indexed field set — the omnibox session index
 * excludes `notes` (D14) while the panel's live index keeps every field.
 */
export function createSearchIndex(
  fields: readonly string[] = INDEXED_FIELDS,
): SearchIndex {
  return new MiniSearch<SearchDocument>({
    idField: "id",
    fields: fields as string[],
    storeFields: STORED_FIELDS,
    searchOptions: {
      combineWith: "AND",
      prefix: true,
      fuzzy: 0.2,
      boost: FIELD_BOOSTS,
    },
  });
}

/** Map every source and add it to a fresh configured index. */
export function buildIndex(
  sources: readonly SearchSourceBookmark[],
  tagNames: TagNameMap,
): SearchIndex {
  const index = createSearchIndex();
  index.addAll(sources.map((source) => toSearchDocument(source, tagNames)));
  return index;
}

function upsert(index: SearchIndex, doc: SearchDocument): void {
  if (index.has(doc.id)) {
    index.replace(doc);
  } else {
    index.add(doc);
  }
}

/**
 * Apply a batch of document changes to a live index. Discards run first so a
 * diff carrying `discard` + `add` for the same id lands correctly; `add` and
 * `replace` both upsert via MiniSearch `add`/`replace`/`discard`, and
 * unknown ids never throw. MiniSearch's auto-vacuum cleans up the discarded
 * postings on its own schedule.
 */
export function applyDocDiff(index: SearchIndex, diff: SearchDocDiff): void {
  for (const id of diff.discard ?? []) {
    if (index.has(id)) {
      index.discard(id);
    }
  }
  for (const doc of diff.replace ?? []) {
    upsert(index, doc);
  }
  for (const doc of diff.add ?? []) {
    upsert(index, doc);
  }
}
