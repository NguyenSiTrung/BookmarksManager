import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
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
 * Hook coverage: `useBookmarkTree` loads `getTree()` on mount, re-flattens on
 * every one of the five bookmark events, and unsubscribes on unmount. The
 * in-memory fake emits synchronously, so `act()` boundaries observe the exact
 * render after each mutation's refetch resolves.
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
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

async function renderProbe(): Promise<ReturnType<typeof render>> {
  const view = render(<Probe />);
  // First paint shows the empty model; wait for the initial getTree to land.
  await waitFor(() => expect(latest?.folders.size).toBeGreaterThan(0));
  return view;
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
    await act(async () => {
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
    await act(async () => {
      await fake.update("a", { title: "renamed" });
    });
    expect(latest?.bookmarks.get("a")?.title).toBe("renamed");

    // onMoved: the node lands in the destination folder's childIds.
    await act(async () => {
      await fake.move("b", { parentId: "folder" });
    });
    expect(barChildIds()).toEqual(["a", "folder"]);
    expect(latest?.folders.get("folder")?.childIds).toEqual(["b"]);
    expect(latest?.bookmarks.get("b")?.path).toEqual([
      "Bookmarks bar",
      "Folder",
    ]);

    // onChildrenReordered: childIds reflect the new order.
    await act(async () => {
      fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["folder", "a"]);
    });
    expect(barChildIds()).toEqual(["folder", "a"]);

    // onRemoved: the node leaves the model.
    await act(async () => {
      await fake.remove("a");
    });
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

    await act(async () => {
      await fake.removeTree("parent");
    });

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
    });
    expect(renders).toBe(rendersAtUnmount);
    expect(latest?.bookmarks.size).toBe(0);
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
    await act(async () => {});

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
    await waitFor(() => expect(latest?.folders.size).toBe(1));
    expect(latest?.folders.get(ROOT_NODE_ID)?.isRoot).toBe(true);
    // The helper threw synchronously on the first missing event; onCreated
    // was already subscribed before that throw.
    expect(listeners.size).toBe(1);

    view.unmount();
    // Whatever subscribed before the throw is still removed on unmount.
    expect(listeners.size).toBe(0);
  });
});
