import { act, cleanup, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
  ROOT_NODE_ID,
} from "../../src/sync/chrome-bookmarks";
import type { OnCreatedListener } from "../../src/sync/chrome-bookmarks";
import type { FlattenedTree } from "../../src/sync/tree";
import { useBookmarkTree } from "../../src/ui/hooks/useBookmarkTree";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Hook coverage: `useBookmarkTree` loads `getTree()` immediately on mount,
 * then refreshes through a 50 ms coalescing window on any of the five
 * bookmark events. Bursts collapse to a single trailing read, while a read is
 * already in flight only one dirty trailing read is queued, and a failed read
 * waits for a fresh event instead of spinning. Timers are faked so the window
 * is advanced deterministically; the in-memory fake emits synchronously, so
 * `act()` boundaries observe the exact render after each refresh resolves.
 */
const COALESCE_MS = 50;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

let fake: FakeBookmarksApi;
let latest: FlattenedTree | undefined;
let renders: number;

/** Renders the hook result both to the DOM and to test-visible captures. */
function Probe() {
  const tree = useBookmarkTree();
  latest = tree;
  renders += 1;
  return (
    <output data-testid="probe">
      {JSON.stringify({
        folders: tree.folders.size,
        bookmarks: tree.bookmarks.size,
        barChildIds: tree.folders.get(BOOKMARKS_BAR_ID)?.childIds ?? [],
      })}
    </output>
  );
}

/** Drains the microtasks behind the immediate initial `getTree()` read. */
async function flushInitialRead(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderProbe(): Promise<ReturnType<typeof render>> {
  const view = render(<Probe />);
  // First paint shows the empty model; the immediate initial read is not
  // coalesced, so only its microtasks need to drain.
  await flushInitialRead();
  expect(latest?.folders.size).toBeGreaterThan(0);
  return view;
}

/**
 * Emit an event (or a synchronous burst) and let the intentional coalescing
 * window elapse so the resulting refresh lands.
 */
async function emitAndSettle(emit: () => unknown): Promise<void> {
  await act(async () => {
    await emit();
    await vi.advanceTimersByTimeAsync(COALESCE_MS);
  });
}

/** 100 synchronous `onCreated` events from the installed event fake. */
function emitOneHundredBookmarkEvents(): void {
  for (let index = 0; index < 100; index += 1) {
    void fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: `burst-${index}`,
      url: `https://burst-${index}.example/`,
    });
  }
}

function barChildIds(): string[] {
  return latest?.folders.get(BOOKMARKS_BAR_ID)?.childIds ?? [];
}

describe("useBookmarkTree", () => {
  it("loads the initial tree via getTree", async () => {
    fake = installBookmarksFake({
      bookmarksBar: [
        {
          id: "seeded-folder",
          title: "Seeded",
          children: [
            { id: "seeded-leaf", title: "Leaf", url: "https://l.example/" },
          ],
        },
      ],
      otherBookmarks: [
        { id: "other-leaf", title: "Other", url: "https://o.example/" },
      ],
    });
    renders = 0;

    await renderProbe();

    // Root + 3 fixed folders + seeded folder = 5 folders.
    expect(latest?.folders.size).toBe(5);
    expect(latest?.bookmarks.size).toBe(2);
    expect(latest?.folders.get(ROOT_NODE_ID)?.isRoot).toBe(true);
    expect(latest?.bookmarks.get("seeded-leaf")?.path).toEqual([
      "Bookmarks bar",
      "Seeded",
    ]);
    expect(barChildIds()).toEqual(["seeded-folder"]);
  });

  it("re-renders when a node is created", async () => {
    fake = installBookmarksFake();
    renders = 0;
    await renderProbe();
    const rendersBefore = renders;

    let createdId = "";
    await emitAndSettle(async () => {
      const node = await fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "New",
        url: "https://n.example/",
      });
      createdId = node.id;
    });

    expect(renders).toBeGreaterThan(rendersBefore);
    expect(barChildIds()).toEqual([createdId]);
    expect(latest?.bookmarks.get(createdId)?.title).toBe("New");
    expect(latest?.bookmarks.get(createdId)?.path).toEqual(["Bookmarks bar"]);
  });

  it("re-renders on change, move, reorder, and remove events", async () => {
    fake = installBookmarksFake({
      bookmarksBar: [
        { id: "a", title: "a", url: "https://a.example/" },
        { id: "b", title: "b", url: "https://b.example/" },
        { id: "folder", title: "Folder", children: [] },
      ],
    });
    renders = 0;
    await renderProbe();
    expect(barChildIds()).toEqual(["a", "b", "folder"]);

    // onChanged: title updates flow through a fresh flatten.
    await emitAndSettle(() => fake.update("a", { title: "renamed" }));
    expect(latest?.bookmarks.get("a")?.title).toBe("renamed");

    // onMoved: the node lands in the destination folder's childIds.
    await emitAndSettle(() => fake.move("b", { parentId: "folder" }));
    expect(barChildIds()).toEqual(["a", "folder"]);
    expect(latest?.folders.get("folder")?.childIds).toEqual(["b"]);
    expect(latest?.bookmarks.get("b")?.path).toEqual([
      "Bookmarks bar",
      "Folder",
    ]);

    // onChildrenReordered: childIds reflect the new order.
    await emitAndSettle(() =>
      fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["folder", "a"]),
    );
    expect(barChildIds()).toEqual(["folder", "a"]);

    // onRemoved: the node leaves the model.
    await emitAndSettle(() => fake.remove("a"));
    expect(latest?.bookmarks.has("a")).toBe(false);
    expect(barChildIds()).toEqual(["folder"]);
  });

  it("re-renders when a whole subtree is removed", async () => {
    fake = installBookmarksFake({
      bookmarksBar: [
        {
          id: "parent",
          title: "Parent",
          children: [
            { id: "inner", title: "Inner", url: "https://i.example/" },
          ],
        },
      ],
    });
    renders = 0;
    await renderProbe();
    expect(latest?.folders.has("parent")).toBe(true);

    await emitAndSettle(() => fake.removeTree("parent"));

    expect(latest?.folders.has("parent")).toBe(false);
    expect(latest?.bookmarks.has("inner")).toBe(false);
    expect(barChildIds()).toEqual([]);
  });

  it("unsubscribes all five listeners on unmount", async () => {
    fake = installBookmarksFake();
    renders = 0;
    const events = [
      fake.onCreated,
      fake.onChanged,
      fake.onMoved,
      fake.onChildrenReordered,
      fake.onRemoved,
    ];
    const registered = new Map<
      (typeof events)[number],
      ReturnType<typeof vi.spyOn>
    >();
    for (const event of events) {
      registered.set(event, vi.spyOn(event, "addListener"));
    }

    const view = await renderProbe();
    for (const event of events) {
      expect(registered.get(event)).toHaveBeenCalledTimes(1);
    }

    view.unmount();

    // Every registered listener was removed: hasListener must be false.
    for (const event of events) {
      const spy = registered.get(event);
      for (const call of spy?.mock.calls ?? []) {
        const listener = call[0];
        expect(event.hasListener(listener)).toBe(false);
      }
    }

    // Mutations after unmount produce no renders and no updates.
    const rendersAtUnmount = renders;
    await act(async () => {
      await fake.create({ title: "late", url: "https://late.example/" });
      await fake.create({
        parentId: OTHER_BOOKMARKS_ID,
        title: "later",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });
    expect(renders).toBe(rendersAtUnmount);
    expect(latest?.bookmarks.size).toBe(0);
  });

  it("coalesces a 100-event burst into a single trailing refresh", async () => {
    fake = installBookmarksFake();
    const getTreeSpy = vi.spyOn(fake, "getTree");
    renders = 0;
    await renderProbe();

    // The initial read is immediate and uncompressed.
    expect(getTreeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitOneHundredBookmarkEvents();
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });

    // 100 synchronous events collapse into exactly one trailing read.
    expect(getTreeSpy).toHaveBeenCalledTimes(2);
    expect(latest?.bookmarks.size).toBe(100);
    expect(barChildIds()).toHaveLength(100);
  });

  it("bounds a sustained 1,000-event burst to a small refresh count", async () => {
    fake = installBookmarksFake();
    const getTreeSpy = vi.spyOn(fake, "getTree");
    renders = 0;
    await renderProbe();
    expect(getTreeSpy).toHaveBeenCalledTimes(1);

    // Writes in flight: one event every ~10 ms for ten seconds. Without
    // escalation this is ~200 full-tree reads (one per 50 ms window).
    await act(async () => {
      for (let index = 0; index < 1000; index += 1) {
        void fake.create({
          parentId: BOOKMARKS_BAR_ID,
          title: `burst-${index}`,
          url: `https://burst-${index}.example/`,
        });
        await vi.advanceTimersByTimeAsync(10);
      }
    });

    // Let the trailing read at the burst-cap window land.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Escalated windows (50→100→200→400→500 cap) bound a 10 s burst to
    // roughly 20 refreshes; the final state still lands exactly.
    expect(getTreeSpy.mock.calls.length).toBeLessThanOrEqual(30);
    expect(getTreeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(latest?.bookmarks.size).toBe(1000);
    expect(barChildIds()).toHaveLength(1000);
  });

  it("keeps the short window for an isolated write after a burst ends", async () => {
    fake = installBookmarksFake();
    const getTreeSpy = vi.spyOn(fake, "getTree");
    renders = 0;
    await renderProbe();

    // A burst escalates the window, then a quiet gap longer than the cap
    // resets it: the next isolated write refreshes at the short window.
    await act(async () => {
      emitOneHundredBookmarkEvents();
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
      await vi.advanceTimersByTimeAsync(600);
    });
    const callsAfterBurst = getTreeSpy.mock.calls.length;

    await act(async () => {
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "after",
        url: "https://after.example/",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });

    expect(getTreeSpy.mock.calls.length).toBe(callsAfterBurst + 1);
    expect(latest?.bookmarks.size).toBe(101);
  });

  it("queues exactly one trailing read when events arrive during a held read", async () => {
    fake = installBookmarksFake();
    renders = 0;
    await renderProbe();

    const realGetTree = fake.getTree.bind(fake);
    let release: (() => void) | undefined;
    const getTreeSpy = vi
      .spyOn(fake, "getTree")
      .mockImplementation(async () => {
        if (release === undefined) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return realGetTree();
      });

    // The first event opens the window; the read then blocks on `release`.
    await act(async () => {
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "first",
        url: "https://first.example/",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(1);

    // Two more events land while that read is still in flight: no new read
    // starts, only a single dirty trailing refresh is remembered.
    await act(async () => {
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "second",
        url: "https://second.example/",
      });
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "third",
        url: "https://third.example/",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(1);

    // Release the held read; the dirty flag yields one trailing refresh.
    await act(async () => {
      release?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(2);
    expect(latest?.bookmarks.size).toBe(3);
  });

  it("settles a burst to the final state and stays quiet afterwards", async () => {
    fake = installBookmarksFake();
    const getTreeSpy = vi.spyOn(fake, "getTree");
    renders = 0;
    await renderProbe();
    const rendersAfterInitial = renders;

    await act(async () => {
      emitOneHundredBookmarkEvents();
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(2);
    expect(latest?.bookmarks.size).toBe(100);
    const rendersAfterBurst = renders;
    expect(rendersAfterBurst).toBeGreaterThan(rendersAfterInitial);

    // Nothing is pending: more time adds neither reads nor renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COALESCE_MS * 4);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(2);
    expect(renders).toBe(rendersAfterBurst);
  });

  it("applies a read that resolves on later ticks exactly once", async () => {
    fake = installBookmarksFake();
    renders = 0;
    await renderProbe();

    const realGetTree = fake.getTree.bind(fake);
    const getTreeSpy = vi
      .spyOn(fake, "getTree")
      .mockImplementation(async () => {
        // A read that lands a few ticks later than the event that triggered it.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        return realGetTree();
      });

    await act(async () => {
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "delayed",
        url: "https://delayed.example/",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });

    expect(getTreeSpy).toHaveBeenCalledTimes(1);
    expect(latest?.bookmarks.size).toBe(1);
  });

  it("keeps the previous model on a failed read and waits for a new event", async () => {
    fake = installBookmarksFake({
      bookmarksBar: [
        { id: "seed", title: "Seed", url: "https://seed.example/" },
      ],
    });
    renders = 0;
    await renderProbe();
    expect(latest?.bookmarks.size).toBe(1);

    const getTreeSpy = vi
      .spyOn(fake, "getTree")
      .mockRejectedValueOnce(new Error("boom"));

    await act(async () => {
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "new",
        url: "https://new.example/",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });

    expect(getTreeSpy).toHaveBeenCalledTimes(1);
    // A failed read keeps the previous model.
    expect(latest?.bookmarks.size).toBe(1);

    // No event means no retry, even as the clock keeps moving.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COALESCE_MS * 4);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(1);

    // A fresh event retries; the tree now includes both created bookmarks.
    await act(async () => {
      void fake.create({
        parentId: BOOKMARKS_BAR_ID,
        title: "two",
        url: "https://two.example/",
      });
      await vi.advanceTimersByTimeAsync(COALESCE_MS);
    });
    expect(getTreeSpy).toHaveBeenCalledTimes(2);
    expect(latest?.bookmarks.size).toBe(3);
  });
});

describe("useBookmarkTree without a full chrome.bookmarks surface", () => {
  it("renders the empty model without crashing when chrome.bookmarks is absent", async () => {
    // The lazy slice resolves `chrome.bookmarks` at call time: `getTree()`
    // and every `onX()` helper throw *synchronously* here. The hook must
    // swallow that and settle on the empty model, not crash the component.
    vi.stubGlobal("chrome", {});
    renders = 0;

    const view = render(<Probe />);
    // Flush the swallowed getTree/subscription failures.
    await flushInitialRead();

    expect(latest?.folders.size).toBe(0);
    expect(latest?.bookmarks.size).toBe(0);
    expect(view.getByTestId("probe").textContent).toContain('"folders":0');
    // Cleanup must not throw either.
    view.unmount();
  });

  it("still shows the fetched tree when the event surface is missing, and cleans up what subscribed", async () => {
    const listeners = new Set<OnCreatedListener>();
    const onCreatedEvent = {
      addListener: (cb: OnCreatedListener) => {
        listeners.add(cb);
      },
      removeListener: (cb: OnCreatedListener) => {
        listeners.delete(cb);
      },
      hasListener: (cb: OnCreatedListener) => listeners.has(cb),
    };
    vi.stubGlobal("chrome", {
      bookmarks: {
        // getTree works; onCreated exists; the other four events are absent.
        getTree: async () => [
          { id: ROOT_NODE_ID, title: "", children: [] },
        ],
        onCreated: onCreatedEvent,
      },
    });
    renders = 0;

    const view = render(<Probe />);
    await flushInitialRead();
    expect(latest?.folders.size).toBe(1);
    expect(latest?.folders.get(ROOT_NODE_ID)?.isRoot).toBe(true);
    // The helper threw synchronously on the first missing event; onCreated
    // was already subscribed before that throw.
    expect(listeners.size).toBe(1);

    view.unmount();
    // Whatever subscribed before the throw is still removed on unmount.
    expect(listeners.size).toBe(0);
  });
});
