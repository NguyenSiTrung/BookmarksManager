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
 * On mount the hook fetches `getTree()` once immediately. After that, ANY of
 * the five bookmark events (`onCreated`, `onChanged`, `onMoved`,
 * `onChildrenReordered`, `onRemoved`) implies "the tree may have changed", so
 * a refresh is scheduled through a short coalescing window
 * (`REFRESH_WINDOW_MS`). A burst of synchronous events — Chrome can emit one
 * per imported/sorted bookmark — therefore collapses to a single trailing
 * read instead of one full-tree fetch per event.
 *
 * Concurrency rules:
 *  - Only one `getTree()` read is ever in flight.
 *  - An event that arrives during a read does not start a second read; it
 *    marks a single dirty trailing read, which runs after the in-flight read
 *    settles. Further events during that window stay collapsed into the same
 *    dirty flag.
 *  - A failed read keeps the previous model and waits for a new event to
 *    retry (no unbounded retry loop).
 *
 * All five subscriptions come from the Task 1 helpers and are torn down on
 * unmount, along with any pending coalescing timer.
 *
 * Before the first fetch resolves, the returned model is an empty
 * `FlattenedTree` (two empty maps). A real Chrome tree always contains the
 * root "0", so `folders.size === 0` doubles as a still-loading signal.
 *
 * A generation counter keeps stale resolutions from committing (e.g. a read
 * superseded before it settles). The wrappers in `chrome-bookmarks.ts` resolve
 * `chrome.bookmarks` lazily at call time, so an absent surface throws
 * *synchronously*, not as a rejection. `read` is therefore `async` (a sync
 * throw inside becomes a caught rejection) and the subscriptions sit behind
 * their own try/catch — either way the hook settles on the empty model
 * instead of crashing the component.
 */
const REFRESH_WINDOW_MS = 50;

export function useBookmarkTree(): FlattenedTree {
  const [model, setModel] = useState<FlattenedTree>(() => ({
    folders: new Map(),
    bookmarks: new Map(),
  }));

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribers: Array<() => void> = [];

    async function read(): Promise<void> {
      inFlight = true;
      const request = ++generation;
      try {
        const tree = await getTree();
        if (!cancelled && request === generation) {
          setModel(flattenTree(tree));
        }
      } catch {
        // Keep the previous model; only a new event retries.
      } finally {
        inFlight = false;
        if (dirty) {
          dirty = false;
          if (!cancelled) schedule();
        }
      }
    }

    function schedule(): void {
      if (cancelled) return;
      if (inFlight) {
        // One read is already running; remember a single trailing read.
        dirty = true;
        return;
      }
      if (timer !== undefined) {
        // Already inside the coalescing window.
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, REFRESH_WINDOW_MS);
    }

    // The initial read is issued immediately, outside the window.
    void read();

    try {
      unsubscribers.push(onCreated(schedule));
      unsubscribers.push(onChanged(schedule));
      unsubscribers.push(onMoved(schedule));
      unsubscribers.push(onChildrenReordered(schedule));
      unsubscribers.push(onRemoved(schedule));
    } catch {
      // Part or all of the event surface is missing. Whatever subscribed
      // stays in `unsubscribers` and is still removed on unmount.
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, []);

  return model;
}
