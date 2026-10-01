import type { BookmarkMeta, TagDef } from "../schemas/meta";
import type { FlattenedTree } from "../sync/tree";
import {
  applyDocDiff,
  buildTagNameMap,
  createSearchIndex,
  toSearchDocument,
  toSourceBookmark,
} from "./index";
import type { SearchDocument, SearchIndex } from "./index";
import { collectDuplicateIds } from "./run";
import type { SearchIndexHandle } from "./run";

/**
 * Pure, Chrome- and React-free state machine behind
 * {@link useSearchIndex}. It owns the live MiniSearch index and the
 * per-bookmark document cache, and on every `update` reuses each document
 * whose inputs are unchanged instead of remapping the whole corpus.
 *
 * A bookmark's {@link SearchDocument} is determined by:
 *  - its own node fields — `title`, `url`, `dateAdded`;
 *  - its meta row — `tags` (raw nameKeys *and* resolved display names),
 *    `category`, `notes`;
 *  - its ancestor folder chain — ids and titles, via `ancestorsOf`;
 *  - the `nameKey → name` tag lookup.
 *
 * The signature below captures all of those cheaply: the ancestor dependency
 * is a memoized per-folder path key (`id:title` through the whole chain), so
 * renaming or moving any ancestor invalidates exactly its descendants, and a
 * tag rename changes the resolved-names segment of every dependent document.
 * Fields the document does not carry (`summary`, folder `index`, child
 * ordering) are deliberately excluded.
 *
 * Duplicate grouping (`collectDuplicateIds`) is the other expensive pass. It
 * depends only on the corpus's `{id, url}` pairs, so it reruns only when that
 * map changes — never on a metadata edit or a pure reorder.
 *
 * `update` returns a fresh {@link SearchIndexHandle}, but the underlying
 * {@link SearchIndex} identity is stable across input changes: mutations go
 * through {@link applyDocDiff}. `clear` drops every cached reference so the
 * next `update` rebuilds from scratch (unmount cleanup).
 */

/** A live cache over one component's search index. */
export interface LiveSearchCache {
  /**
   * Reconcile the cache with the latest inputs and return the live handle.
   * Documents whose signature is unchanged are reused; only invalidated ones
   * are remapped. Safe to call repeatedly and after {@link clear}.
   */
  update(
    tree: FlattenedTree,
    metas: readonly BookmarkMeta[],
    tagDefs: readonly TagDef[],
  ): SearchIndexHandle;
  /** Drop the index, document map, signatures, and dup set (unmount). */
  clear(): void;
}

const SIG_SEP = "\u0000";
const KEY_SEP = "\u0001";

/** Shared empty tag list so absent meta rows allocate nothing. */
const NO_TAGS: readonly string[] = [];

/** `id:title` path key for every folder, memoized over the parent chain. */
function computeFolderKeys(tree: FlattenedTree): Map<string, string> {
  const keys = new Map<string, string>();
  const visiting = new Set<string>();
  const compute = (id: string): string => {
    const cached = keys.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return ""; // cycle guard, mirrors ancestorsOf
    visiting.add(id);
    const folder = tree.folders.get(id);
    let key = "";
    if (folder !== undefined) {
      const parentKey =
        folder.parentId === undefined ? "" : compute(folder.parentId);
      key = `${parentKey}${KEY_SEP}${folder.id}${KEY_SEP}${folder.title}`;
    }
    visiting.delete(id);
    keys.set(id, key);
    return key;
  };
  for (const id of tree.folders.keys()) compute(id);
  return keys;
}

/** Whether two `id → url` maps hold the same pairs (order-insensitive). */
function sameCorpus(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): boolean {
  if (prev.size !== next.size) return false;
  for (const [id, url] of next) {
    if (prev.get(id) !== url) return false;
  }
  return true;
}

/** Create an empty live cache; see {@link LiveSearchCache}. */
export function createLiveSearchCache(): LiveSearchCache {
  let index: SearchIndex | null = null;
  let docs = new Map<string, SearchDocument>();
  let signatures = new Map<string, string>();
  let corpus = new Map<string, string>();
  let duplicateIds: ReadonlySet<string> = new Set();

  return {
    update(tree, metas, tagDefs) {
      const folderKeys = computeFolderKeys(tree);
      const tagNames = buildTagNameMap(tagDefs);
      const metaById = new Map(metas.map((meta) => [meta.id, meta]));

      const nextDocs = new Map<string, SearchDocument>();
      const nextSignatures = new Map<string, string>();
      const nextCorpus = new Map<string, string>();

      for (const item of tree.bookmarks.values()) {
        const meta = metaById.get(item.id);
        const tagKeys = meta?.tags ?? NO_TAGS;
        const resolvedTags = tagKeys
          .map((key) => tagNames.get(key) ?? key)
          .join(" ");
        const parentKey =
          item.parentId === undefined
            ? ""
            : (folderKeys.get(item.parentId) ?? "");
        const signature = [
          item.title,
          item.url,
          item.dateAdded ?? "",
          tagKeys.join(","),
          resolvedTags,
          meta?.category ?? "",
          meta?.notes ?? "",
          item.parentId ?? "",
          parentKey,
        ].join(SIG_SEP);

        nextSignatures.set(item.id, signature);
        nextCorpus.set(item.id, item.url);

        const cached = docs.get(item.id);
        if (cached !== undefined && signatures.get(item.id) === signature) {
          nextDocs.set(item.id, cached);
        } else {
          nextDocs.set(
            item.id,
            toSearchDocument(toSourceBookmark(tree, item, meta), tagNames),
          );
        }
      }

      const discard: string[] = [];
      for (const id of docs.keys()) {
        if (!nextDocs.has(id)) discard.push(id);
      }
      const replace: SearchDocument[] = [];
      const add: SearchDocument[] = [];
      for (const [id, doc] of nextDocs) {
        const old = docs.get(id);
        if (old === undefined) add.push(doc);
        else if (old !== doc) replace.push(doc);
      }

      if (index === null) {
        index = createSearchIndex();
        index.addAll([...nextDocs.values()]);
      } else {
        applyDocDiff(index, { discard, replace, add });
      }

      docs = nextDocs;
      signatures = nextSignatures;

      if (!sameCorpus(corpus, nextCorpus)) {
        duplicateIds = collectDuplicateIds([...tree.bookmarks.values()]);
        corpus = nextCorpus;
      }

      return {
        index,
        ctx: {
          treeOrder: [...tree.bookmarks.keys()],
          duplicateIds,
        },
      };
    },

    clear() {
      index = null;
      docs = new Map();
      signatures = new Map();
      corpus = new Map();
      duplicateIds = new Set();
    },
  };
}
