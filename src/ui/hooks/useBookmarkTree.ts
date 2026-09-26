import { useEffect, useState } from "react";
import {
  getTree,
  onChanged,
  onChildrenReordered,
  onCreated,
  onMoved,
  onRemoved,
} from "../../sync/chrome-bookmarks";
import { flattenTree } from "../../sync/tree";
import type { FlattenedTree } from "../../sync/tree";

/**
 * Live flattened bookmark tree.
 *
 * On mount the hook fetches `getTree()` once, then refetches on ANY of the
 * five bookmark events (`onCreated`, `onChanged`, `onMoved`,
 * `onChildrenReordered`, `onRemoved`) — every event implies "the tree may have
 * changed", so refetching the whole tree and re-flattening is the simplest
 * correct approach (no per-event patching, no debounce). All five
 * subscriptions come from the Task 1 helpers and are torn down on unmount.
 *
 * Before the first fetch resolves, the returned model is an empty
 * `FlattenedTree` (two empty maps). A real Chrome tree always contains the
 * root "0", so `folders.size === 0` doubles as a still-loading signal.
 *
 * A `getTree()` rejection (e.g. the API is unreachable) keeps the previous
 * model — the next event retries. A generation counter makes out-of-order
 * resolutions harmless: only the most recently issued fetch may commit.
 */
export function useBookmarkTree(): FlattenedTree {
  const [model, setModel] = useState<FlattenedTree>(() => ({
    folders: new Map(),
    bookmarks: new Map(),
  }));

  useEffect(() => {
    let cancelled = false;
    let generation = 0;

    const refresh = (): void => {
      const request = ++generation;
      void getTree()
        .then((tree) => {
          if (!cancelled && request === generation) {
            setModel(flattenTree(tree));
          }
        })
        .catch(() => {
          // Keep the previous model; the next event refetches.
        });
    };

    refresh();
    const unsubscribers = [
      onCreated(refresh),
      onChanged(refresh),
      onMoved(refresh),
      onChildrenReordered(refresh),
      onRemoved(refresh),
    ];

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, []);

  return model;
}
