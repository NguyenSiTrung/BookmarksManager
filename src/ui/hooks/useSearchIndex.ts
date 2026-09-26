import { useEffect, useRef, useState } from "react";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import {
  applyDocDiff,
  buildTagNameMap,
  createSearchIndex,
  toSearchDocument,
} from "../../search/index";
import type {
  SearchDocument,
  SearchIndex,
  SearchSourceAncestor,
  SearchSourceBookmark,
} from "../../search/index";
import { collectDuplicateIds } from "../../search/run";
import type { RunQueryContext } from "../../search/run";
import { ROOT_NODE_ID } from "../../sync/chrome-bookmarks";
import type { BookmarkItem, FlattenedTree } from "../../sync/tree";

/**
 * Live MiniSearch index over the flattened bookmark tree plus extension
 * metadata.
 *
 * The index is built once inside an effect (after mount, off the first
 * paint) and then kept warm by DIFFS: whenever `tree`, `metas`, or `tagDefs`
 * change, every bookmark's {@link SearchDocument} is recomputed and compared
 * against the previous map, and only the add/discard/replace delta is
 * applied via {@link applyDocDiff} — the returned `SearchIndex` instance is
 * therefore stable across input changes, which is what callers rely on for
 * "no full rebuild" behaviour. Recomputing 10k document shapes to find the
 * delta is far cheaper than re-indexing them.
 *
 * Returns `null` until the first build lands (callers show an "Indexing…"
 * affordance). On unmount the cache ref is dropped and the in-flight effect
 * generation is cancelled, so a post-unmount input change is a no-op.
 *
 * `ctx` carries the per-query context `runQuery` needs: `treeOrder` from the
 * current bookmarks map (filter-only queries keep library order) and
 * `duplicateIds` recomputed only when the corpus changes — never per
 * keystroke.
 */
export interface SearchIndexHandle {
  /** The live index; the same instance across diff updates. */
  index: SearchIndex;
  /** Per-query context for `runQuery`. */
  ctx: RunQueryContext;
}

/**
 * Ancestor folders of `item`, topmost first, excluding the synthetic root
 * "0" — resolved through the folders map (item.path holds titles only).
 * Cycle-guarded against malformed trees.
 */
function ancestorsOf(
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

/** Map one flattened bookmark + its meta row onto a source document. */
function toSource(
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
 * Structural diff between the previous and next document maps.
 * `JSON.stringify` equality is sufficient: document fields are plain
 * JSON-safe values in a fixed key order (toSearchDocument's literal).
 */
function diffDocs(
  prev: ReadonlyMap<string, SearchDocument>,
  next: ReadonlyMap<string, SearchDocument>,
): { discard: string[]; replace: SearchDocument[]; add: SearchDocument[] } {
  const discard: string[] = [];
  const replace: SearchDocument[] = [];
  const add: SearchDocument[] = [];
  for (const id of prev.keys()) {
    if (!next.has(id)) discard.push(id);
  }
  for (const [id, doc] of next) {
    const old = prev.get(id);
    if (old === undefined) {
      add.push(doc);
    } else if (JSON.stringify(old) !== JSON.stringify(doc)) {
      replace.push(doc);
    }
  }
  return { discard, replace, add };
}

export function useSearchIndex(
  tree: FlattenedTree,
  metas: readonly BookmarkMeta[],
  tagDefs: readonly TagDef[],
): SearchIndexHandle | null {
  const cache = useRef<{
    index: SearchIndex;
    docs: Map<string, SearchDocument>;
  } | null>(null);
  const [handle, setHandle] = useState<SearchIndexHandle | null>(null);

  useEffect(() => {
    let alive = true;
    const tagNames = buildTagNameMap(tagDefs);
    const metaById = new Map(metas.map((meta) => [meta.id, meta]));

    const next = new Map<string, SearchDocument>();
    for (const item of tree.bookmarks.values()) {
      next.set(
        item.id,
        toSearchDocument(toSource(tree, item, metaById.get(item.id)), tagNames),
      );
    }

    if (cache.current === null) {
      const index = createSearchIndex();
      index.addAll([...next.values()]);
      cache.current = { index, docs: next };
    } else {
      const diff = diffDocs(cache.current.docs, next);
      applyDocDiff(cache.current.index, diff);
      cache.current.docs = next;
    }

    const bookmarks = [...tree.bookmarks.values()];
    const nextHandle: SearchIndexHandle = {
      index: cache.current.index,
      ctx: {
        treeOrder: bookmarks.map((item) => item.id),
        duplicateIds: collectDuplicateIds(bookmarks),
      },
    };
    if (alive) setHandle(nextHandle);
    return () => {
      alive = false;
    };
  }, [tree, metas, tagDefs]);

  // Release the cached index/docs as soon as the component unmounts — the
  // maps hold every document, so keeping them past unmount leaks the corpus.
  useEffect(
    () => () => {
      cache.current = null;
    },
    [],
  );

  return handle;
}
