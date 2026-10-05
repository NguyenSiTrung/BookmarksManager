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
 *
 * Sustained bursts (U11): an isolated change still refreshes after the
 * short window, but while events KEEP arriving — a write burst in flight —
 * each cycle that saw contention escalates the next window (50 → 100 →
 * 200 → 400 → `BURST_WINDOW_CAP_MS`), and a cycle that fires with no
 * contention decays one step. A long import/apply storm therefore
 * produces a bounded stream of refreshes instead of one full-tree read
 * per quiet-luck window, and the trailing read still lands the final
 * tree once the burst ends.
 */
const REFRESH_WINDOW_MS = 50;
/** Largest coalescing window during a sustained write burst. */
const BURST_WINDOW_CAP_MS = 500;
/** Escalation ladder cap: 50 → 100 → 200 → 400 → BURST_WINDOW_CAP_MS. */
const MAX_BURST_LEVEL = 4;

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
    // Burst throttle (U11): contention = an event arrived while a refresh
    // cycle was already pending (armed timer or in-flight read). Each
    // contended cycle escalates the next window; an uncontended cycle
    // decays it. An event after a full-cap quiet gap means the burst is
    // over — reset outright so an isolated write keeps the short window.
    let burstLevel = 0;
    let contended = false;
    let lastEventAt = Number.NEGATIVE_INFINITY;

    function windowMs(): number {
      return Math.min(
        REFRESH_WINDOW_MS << burstLevel,
        BURST_WINDOW_CAP_MS,
      );
    }

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
      const now = Date.now();
      if (now - lastEventAt > BURST_WINDOW_CAP_MS) {
        // A quiet gap longer than the cap ended the previous burst.
        burstLevel = 0;
      }
      lastEventAt = now;
      if (inFlight) {
        // One read is already running; remember a single trailing read.
        dirty = true;
        contended = true;
        return;
      }
      if (timer !== undefined) {
        // Already inside the coalescing window: the burst continues.
        contended = true;
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        burstLevel = contended
          ? Math.min(burstLevel + 1, MAX_BURST_LEVEL)
          : Math.max(burstLevel - 1, 0);
        contended = false;
        void read();
      }, windowMs());
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
