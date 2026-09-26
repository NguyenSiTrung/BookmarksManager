import "fake-indexeddb/auto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
import { db } from "../../src/db/database";
import { createTag, getMeta, getTag, putMeta } from "../../src/db/meta";
import { flattenTree } from "../../src/sync/tree";
import { App } from "../../src/entrypoints/sidepanel/App";
import { EditDialog } from "../../src/entrypoints/sidepanel/EditDialog";
import {
  UndoToast,
  useUndoToastController,
} from "../../src/entrypoints/sidepanel/UndoToast";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Task 3 — item and folder actions.
 *
 * Layers under test:
 *  - `EditDialog`    one dialog for bookmarks AND folders: title, url
 *                    (bookmarks only), parent folder picker, tag chips
 *                    (defs created on demand through tag-ops), category,
 *                    notes → `updateBookmark`/`renameFolder` + `moveNode` +
 *                    `patchMeta`.
 *  - `BulkBar`       appears with ≥1 selected id; Move to…, Delete (with a
 *                    `delete` snapshot first), Add/Remove tag, Set category,
 *                    Clear selection.
 *  - `MoveToDialog`  folder-destination list; deny-listed: the moved node's
 *                    own subtree and managed folders; moves bookmarks AND
 *                    folders via `moveNode` behind a `bulk_move` snapshot.
 *  - `FolderActions` kebab + right-click entries: New folder inside, Rename,
 *                    Move to…, Delete (confirm with the descendant bookmark
 *                    count); everything disabled on fixed roots/managed.
 *  - `UndoToast`     bottom toast with Undo + dismiss, ~8s auto-hide, typed
 *                    failure message on `{ok:false}` (and Undo stays
 *                    available because failed restores remain retryable).
 *
 * Assertions run against the in-memory bookmarks FAKE after each action (all
 * mutations go through the guarded service onto the fake) and against the
 * Dexie `bookmarkMeta`/`tags`/`undo` tables through repository reads.
 */

let fake: FakeBookmarksApi;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreElementRects();
});

beforeEach(async () => {
  await db.open();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  let tick = 0;
  fake = createFakeBookmarks({
    now: () => (tick += 100),
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [
          { id: "b1", title: "Alpha", url: "https://a.example/1" },
          {
            id: "f10",
            title: "Nested",
            children: [{ id: "b2", title: "Beta", url: "https://b.example/" }],
          },
        ],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
      {
        id: "m1",
        title: "Managed",
        unmodifiable: "managed",
        children: [{ id: "mb1", title: "Hosted", url: "https://m.example/" }],
      },
    ],
    otherBookmarks: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
  });
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: {
      getURL: (path: string) =>
        `chrome-extension://test-extension-id/${path}`,
    },
  });
  stubElementRects();
});

/**
 * jsdom reports 0 for every element's offsetHeight/offsetWidth, which makes
 * @tanstack/react-virtual render nothing. The scroll container
 * (data-testid="bookmark-scroll") gets a fixed 600x400 rect so rows mount.
 */
const SCROLL_TESTID = "bookmark-scroll";
let savedRectDescriptors: [string, PropertyDescriptor | undefined][] = [];

function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  savedRectDescriptors = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      prop,
    );
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID
          ? value
          : 0;
      },
    });
    return [prop, prior];
  });
}

function restoreElementRects(): void {
  for (const [prop, prior] of savedRectDescriptors) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  savedRectDescriptors = [];
}

function option(name: string | RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

function treeitem(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

function selectionBar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selection actions" });
}

function toast(): HTMLElement {
  return screen.getByTestId("undo-toast");
}

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

/** Opens a bookmark row's kebab menu (Radix triggers on pointerdown). */
async function openItemMenu(name: string): Promise<void> {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Actions for ${name}` }),
  );
  await screen.findByRole("menuitem", { name: "Edit…" });
}

/** Opens a folder row's kebab menu. */
async function openFolderMenu(name: string): Promise<void> {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: `Folder actions for ${name}` }),
  );
  await screen.findByRole("menuitem", { name: "New folder inside" });
}

// ---------------------------------------------------------------------------
// Edit dialog
// ---------------------------------------------------------------------------

describe("EditDialog", () => {
  it("edits title, url, folder, tags, category and notes on a bookmark", async () => {
    await renderApp();

    await openItemMenu("Alpha");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit…" }));
    const dialog = await screen.findByRole("dialog");

    const title = within(dialog).getByLabelText("Title") as HTMLInputElement;
    const url = within(dialog).getByLabelText("URL") as HTMLInputElement;
    const folder = within(dialog).getByLabelText("Folder") as HTMLSelectElement;
    expect(title.value).toBe("Alpha");
    expect(url.value).toBe("https://a.example/1");
    expect(folder.value).toBe("10");

    fireEvent.change(title, { target: { value: "Alpha 2" } });
    fireEvent.change(url, { target: { value: "https://a.example/2" } });
    fireEvent.change(folder, { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText("New tag name"), {
      target: { value: "Urgent" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tag" }));
    expect(within(dialog).getByText("Urgent")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Category"), {
      target: { value: "docs" },
    });
    fireEvent.change(within(dialog).getByLabelText("Notes"), {
      target: { value: "hello" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const node = (await fake.get("b1"))[0];
    expect(node?.title).toBe("Alpha 2");
    expect(node?.url).toBe("https://a.example/2");
    expect(node?.parentId).toBe("2");

    const meta = await getMeta("b1");
    expect(meta?.tags).toEqual(["urgent"]);
    expect(meta?.category).toBe("docs");
    expect(meta?.notes).toBe("hello");
    // The tag definition was created on demand through tag-ops.
    expect(await getTag("urgent")).toBeDefined();
  });

  it("edits a folder: rename, move and meta, denying its own subtree", async () => {
    const tree = flattenTree(await fake.getTree());
    const node = tree.folders.get("10");
    expect(node).toBeDefined();
    if (node === undefined) return;

    render(
      <EditDialog target={node} open onOpenChange={() => {}} tree={tree} />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("URL")).toBeNull();

    const folder = within(dialog).getByLabelText("Folder") as HTMLSelectElement;
    expect(
      (folder.querySelector('option[value="10"]') as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    expect(
      (folder.querySelector('option[value="f10"]') as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    expect(
      (folder.querySelector('option[value="m1"]') as HTMLOptionElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Dev 2" },
    });
    fireEvent.change(folder, { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText("Notes"), {
      target: { value: "folder notes" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect((await fake.get("10"))[0]?.title).toBe("Dev 2");
    });
    expect((await fake.get("10"))[0]?.parentId).toBe("2");
    expect((await getMeta("10"))?.notes).toBe("folder notes");
  });
});

// ---------------------------------------------------------------------------
// Bulk bar
// ---------------------------------------------------------------------------

describe("BulkBar", () => {
  it("appears with the selected count and clears the selection", async () => {
    await renderApp();
    expect(
      screen.queryByRole("toolbar", { name: "Selection actions" }),
    ).toBeNull();

    fireEvent.click(option(/Alpha/));
    expect(selectionBar().textContent).toContain("1 selected");

    fireEvent.click(
      within(selectionBar()).getByRole("button", { name: "Clear selection" }),
    );
    expect(
      screen.queryByRole("toolbar", { name: "Selection actions" }),
    ).toBeNull();
  });

  it("bulk deletes with a snapshot and restores everything on Undo", async () => {
    await putMeta("b1", { tags: ["dev"], notes: "keep me" });
    await createTag("Dev");
    await renderApp();

    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Beta/), { ctrlKey: true });
    const bar = selectionBar();
    expect(bar.textContent).toContain("2 selected");

    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(toast().textContent).toContain("Deleted 2 bookmarks"),
    );
    await expect(fake.get("b1")).rejects.toThrow();
    await expect(fake.get("b2")).rejects.toThrow();
    // Snapshot pushed BEFORE the removals; meta rows cascaded away.
    expect(await db.undo.count()).toBe(1);
    expect(await getMeta("b1")).toBeUndefined();

    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(toast().textContent).toContain("Undone"));

    const dev = await fake.getChildren("10");
    expect(dev.some((n) => n.title === "Alpha")).toBe(true);
    const nested = await fake.getChildren("f10");
    expect(nested.some((n) => n.title === "Beta")).toBe(true);
    // Meta rows were remapped onto the fresh Chrome ids.
    const metas = await db.bookmarkMeta.toArray();
    expect(metas.some((m) => m.notes === "keep me")).toBe(true);
  });

  it("bulk moves the selection via Move to… and undoes the move", async () => {
    await renderApp();

    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Gamma/), { ctrlKey: true });
    fireEvent.click(
      within(selectionBar()).getByRole("button", { name: "Move to…" }),
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Other bookmarks" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));

    await waitFor(async () => {
      expect((await fake.get("b1"))[0]?.parentId).toBe("2");
    });
    expect((await fake.get("b3"))[0]?.parentId).toBe("2");
    await waitFor(() =>
      expect(toast().textContent).toContain("Moved 2 items"),
    );
    // Successful move clears the selection.
    expect(
      screen.queryByRole("toolbar", { name: "Selection actions" }),
    ).toBeNull();

    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(toast().textContent).toContain("Undone"));
    expect((await fake.get("b1"))[0]?.parentId).toBe("10");
    expect((await fake.get("b3"))[0]?.parentId).toBe("1");
  });

  it("adds and removes a tag across the selection, preserving it", async () => {
    await renderApp();

    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Gamma/), { ctrlKey: true });
    fireEvent.click(
      within(selectionBar()).getByRole("button", { name: "Add tag" }),
    );

    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Tag name"), {
      target: { value: "Urgent" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tag" }));

    await waitFor(async () => {
      expect((await getMeta("b1"))?.tags).toEqual(["urgent"]);
    });
    expect((await getMeta("b3"))?.tags).toEqual(["urgent"]);
    expect(await getTag("urgent")).toBeDefined();
    await waitFor(() =>
      expect(toast().textContent).toContain(
        "Added tag “Urgent” to 2 bookmarks",
      ),
    );
    expect(selectionBar().textContent).toContain("2 selected");

    fireEvent.click(
      within(selectionBar()).getByRole("button", { name: "Remove tag" }),
    );
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Tag name"), {
      target: { value: "urgent" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove tag" }),
    );

    await waitFor(async () => {
      expect(await getMeta("b1")).toBeUndefined();
    });
    expect(await getMeta("b3")).toBeUndefined();
    await waitFor(() =>
      expect(toast().textContent).toContain(
        "Removed tag “urgent” from 2 bookmarks",
      ),
    );
  });

  it("sets and clears the category in bulk", async () => {
    await renderApp();

    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Delta/), { ctrlKey: true });
    fireEvent.pointerDown(
      within(selectionBar()).getByRole("button", { name: "Set category" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Docs" }));

    await waitFor(async () => {
      expect((await getMeta("b1"))?.category).toBe("docs");
    });
    expect((await getMeta("b4"))?.category).toBe("docs");
    await waitFor(() =>
      expect(toast().textContent).toContain("Set category to docs on 2 bookmarks"),
    );

    fireEvent.pointerDown(
      within(selectionBar()).getByRole("button", { name: "Set category" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "No category" }));
    await waitFor(async () => {
      expect(await getMeta("b1")).toBeUndefined();
    });
    await waitFor(() =>
      expect(toast().textContent).toContain("Cleared category on 2 bookmarks"),
    );
  });
});

// ---------------------------------------------------------------------------
// Folder actions
// ---------------------------------------------------------------------------

describe("FolderActions", () => {
  it("creates, renames and deletes a folder with a descendant count and undo", async () => {
    await renderApp();

    await openFolderMenu("Dev");
    fireEvent.click(screen.getByRole("menuitem", { name: "New folder inside" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Folder name"), {
      target: { value: "Sub" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create folder" }),
    );
    await waitFor(async () => {
      expect((await fake.getChildren("10")).some((n) => n.title === "Sub")).toBe(
        true,
      );
    });
    await waitFor(() =>
      expect(toast().textContent).toContain("Created folder “Sub”"),
    );

    await openFolderMenu("Dev");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    dialog = await screen.findByRole("dialog");
    const nameField = within(dialog).getByLabelText(
      "Folder name",
    ) as HTMLInputElement;
    expect(nameField.value).toBe("Dev");
    fireEvent.change(nameField, { target: { value: "Dev Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(async () => {
      expect((await fake.get("10"))[0]?.title).toBe("Dev Renamed");
    });
    await waitFor(() =>
      expect(toast().textContent).toContain("Renamed folder to “Dev Renamed”"),
    );

    await openFolderMenu("Dev Renamed");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("2 bookmarks");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete folder" }),
    );
    await waitFor(() =>
      expect(toast().textContent).toContain("Deleted folder “Dev Renamed”"),
    );
    await expect(fake.get("10")).rejects.toThrow();
    await expect(fake.get("b1")).rejects.toThrow();
    await expect(fake.get("b2")).rejects.toThrow();

    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(toast().textContent).toContain("Undone"));
    const restored = (await fake.getChildren("1")).find(
      (n) => n.title === "Dev Renamed",
    );
    expect(restored).toBeDefined();
    if (restored === undefined) return;
    const subtree = (await fake.getSubTree(restored.id))[0];
    expect(subtree?.children?.some((n) => n.title === "Alpha")).toBe(true);
  });

  it("moves a folder and denies its own subtree and managed destinations", async () => {
    await renderApp();

    await openFolderMenu("Dev");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const dialog = await screen.findByRole("dialog");

    expect(
      (
        within(dialog).getByRole("button", {
          name: "Bookmarks bar / Dev",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Bookmarks bar / Dev / Nested",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Bookmarks bar / Managed",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Other bookmarks" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(async () => {
      expect((await fake.get("10"))[0]?.parentId).toBe("2");
    });
    // The subtree travelled with the folder.
    expect((await fake.get("f10"))[0]?.parentId).toBe("10");
    await waitFor(() => expect(toast().textContent).toContain("Moved 1 item"));
  });

  it("disables folder actions on fixed roots and managed folders", async () => {
    await renderApp();

    const barActions = screen.getByRole("button", {
      name: "Folder actions for Bookmarks bar",
    });
    expect(barActions.hasAttribute("disabled")).toBe(true);
    expect(barActions.getAttribute("title")).toMatch(/built-in/);

    const managedActions = screen.getByRole("button", {
      name: "Folder actions for Managed",
    });
    expect(managedActions.hasAttribute("disabled")).toBe(true);
    expect(managedActions.getAttribute("title")).toMatch(/managed/i);

    fireEvent.contextMenu(treeitem(/Bookmarks bar/));
    const del = await screen.findByRole("menuitem", { name: "Delete…" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.getAttribute("title")).toMatch(/built-in/);
  });
});

// ---------------------------------------------------------------------------
// Item row actions
// ---------------------------------------------------------------------------

describe("item actions", () => {
  it("deletes the selection with the Delete key", async () => {
    await renderApp();

    fireEvent.click(option(/Gamma/));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Delete" });

    await waitFor(() =>
      expect(toast().textContent).toContain("Deleted 1 bookmark"),
    );
    await expect(fake.get("b3")).rejects.toThrow();
  });

  it("offers row actions from a right-click context menu", async () => {
    await renderApp();

    fireEvent.contextMenu(option(/Gamma/));
    expect(await screen.findByRole("menuitem", { name: "Open" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Move to");
  });

  it("disables destructive item actions on managed bookmarks", async () => {
    await renderApp();

    await openItemMenu("Hosted");
    expect(
      screen.getByRole("menuitem", { name: "Edit…" }).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("menuitem", { name: "Move to…" }).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("menuitem", { name: "Delete" }).getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    expect(
      screen.getByRole("menuitem", { name: "Open" }).getAttribute(
        "aria-disabled",
      ),
    ).not.toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Undo toast
// ---------------------------------------------------------------------------

describe("UndoToast", () => {
  it("reports a typed undo failure and keeps Undo available to retry", async () => {
    await renderApp();

    fireEvent.click(option(/Gamma/));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Delete" });
    await waitFor(() =>
      expect(toast().textContent).toContain("Deleted 1 bookmark"),
    );

    const spy = vi
      .spyOn(fake, "create")
      .mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(toast().textContent).toContain(
        "Undo failed: chrome.bookmarks create failed: boom",
      ),
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // Failed restores stay on the stack — Undo is offered again.
    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(toast().textContent).toContain("Undone"));
    const bar = await fake.getChildren("1");
    expect(bar.some((n) => n.title === "Gamma")).toBe(true);
  });

  function Harness() {
    const controller = useUndoToastController();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            controller.showToast({ message: "Did a thing", undoable: true })
          }
        >
          show
        </button>
        <UndoToast
          toast={controller.toast}
          onUndo={() => void controller.undo()}
          onDismiss={controller.dismiss}
        />
      </>
    );
  }

  it("auto-hides after ~8s and dismisses on demand", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "show" }));
      expect(toast().textContent).toContain("Did a thing");

      act(() => {
        vi.advanceTimersByTime(8_500);
      });
      expect(screen.queryByTestId("undo-toast")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "show" }));
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByTestId("undo-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
