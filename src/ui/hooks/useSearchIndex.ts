import { useEffect, useState } from "react";
import type { BookmarkMeta, TagDef } from "../../schemas/meta";
import { createLiveSearchCache } from "../../search/live-cache";
import type { SearchIndexHandle } from "../../search/run";
import type { FlattenedTree } from "../../sync/tree";

export type { SearchIndexHandle } from "../../search/run";

/**
 * Live MiniSearch index over the flattened bookmark tree plus extension
 * metadata.
 *
 * The index is built once inside an effect (after mount, off the first
 * paint) and then kept warm by SELECTIVE INVALIDATION: the work lives in the
 * pure {@link createLiveSearchCache}, which reuses every bookmark's
 * {@link SearchDocument} whose inputs (node fields, meta row, ancestor folder
 * chain, resolved tag names) are unchanged and remaps only the invalidated
 * ones. The returned `SearchIndex` instance is therefore stable across input
 * changes, which is what callers rely on for "no full rebuild" behaviour.
 *
 * Returns `null` until the first build lands (callers show an "Indexing…"
 * affordance). On unmount the cache is cleared, releasing the index and
 * every cached document.
 *
 * `ctx` carries the per-query context `runQuery` needs: `treeOrder` from the
 * current bookmarks map (filter-only queries keep library order) and
 * `duplicateIds` recomputed only when the corpus's id/url set changes — never
 * per keystroke or on a metadata-only edit.
 */
export function useSearchIndex(
  tree: FlattenedTree,
  metas: readonly BookmarkMeta[],
  tagDefs: readonly TagDef[],
): SearchIndexHandle | null {
  const [cache] = useState(createLiveSearchCache);
  const [handle, setHandle] = useState<SearchIndexHandle | null>(null);

  useEffect(() => {
    let alive = true;
    const next = cache.update(tree, metas, tagDefs);
    // The MiniSearch index is an external system built from props after
    // mount; publishing its handle is the point of the effect (until it
    // lands the hook returns null so callers can render "Indexing…").
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external index sync, not render-derived state
    if (alive) setHandle(next);
    return () => {
      alive = false;
    };
  }, [cache, tree, metas, tagDefs]);

  // Release the cached index/docs as soon as the component unmounts — the
  // maps hold every document, so keeping them past unmount leaks the corpus.
  useEffect(() => () => cache.clear(), [cache]);

  return handle;
}
