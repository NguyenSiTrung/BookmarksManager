import "fake-indexeddb/auto";
import {
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
import { MoveToDialog } from "../../src/entrypoints/sidepanel/MoveToDialog";
import { flattenTree } from "../../src/sync/tree";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

let fake: FakeBookmarksApi;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
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
        title: "Engineering",
        children: [
          { id: "b1", title: "Alpha", url: "https://a.example/1" },
          { id: "f10", title: "Frontend", children: [] },
        ],
      },
    ],
    otherBookmarks: [
      { id: "f20", title: "Reading List", children: [] },
    ],
  });
  vi.stubGlobal("chrome", {
    bookmarks: fake,
  });
});

describe("MoveToDialog (UX-03)", () => {
  it("filters destination folders case-insensitively by label", async () => {
    const tree = flattenTree(await fake.getTree());
    render(
      <MoveToDialog
        open
        onOpenChange={() => {}}
        tree={tree}
        ids={["b1"]}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    const filterInput = within(dialog).getByLabelText("Filter folders");
    expect(
      within(dialog).getByRole("button", { name: "Bookmarks bar / Engineering" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Other bookmarks / Reading List" }),
    ).toBeTruthy();

    fireEvent.change(filterInput, { target: { value: "read" } });

    expect(
      within(dialog).queryByRole("button", { name: "Bookmarks bar / Engineering" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Other bookmarks / Reading List" }),
    ).toBeTruthy();
  });

  it("creates an inline subfolder under the selected parent (or Bookmarks bar default), selects it, and moves items into it", async () => {
    const tree = flattenTree(await fake.getTree());
    const onMoved = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <MoveToDialog
        open
        onOpenChange={onOpenChange}
        tree={tree}
        ids={["b1"]}
        onMoved={onMoved}
      />,
    );

    const dialog = await screen.findByRole("dialog");

    // Select "Bookmarks bar / Engineering" as parent, then click "+ New folder"
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Bookmarks bar / Engineering" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "+ New folder" }),
    );

    const nameInput = within(dialog).getByLabelText("New folder name");
    fireEvent.change(nameInput, { target: { value: "Architecture" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create folder" }),
    );

    // Wait for the new folder to be created under "10" (Engineering) and selected
    const createdBtn = await within(dialog).findByRole("button", {
      name: "Bookmarks bar / Engineering / Architecture",
    });
    expect(createdBtn.getAttribute("aria-pressed")).toBe("true");

    // Click Move to complete the move into the newly created folder
    const moveBtn = within(dialog).getByRole("button", { name: "Move" });
    expect((moveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(moveBtn);

    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const childrenOfEng = await fake.getChildren("10");
    const archFolder = childrenOfEng.find((n) => n.title === "Architecture");
    expect(archFolder).toBeDefined();
    if (archFolder === undefined) return;
    const moveNode = (await fake.get("b1"))[0];
    expect(moveNode?.parentId).toBe(archFolder.id);
  });

  it("defaults inline subfolder creation to Bookmarks bar when no destination is selected yet", async () => {
    const tree = flattenTree(await fake.getTree());
    render(
      <MoveToDialog
        open
        onOpenChange={() => {}}
        tree={tree}
        ids={["b1"]}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "+ New folder" }),
    );
    const nameInput = within(dialog).getByLabelText("New folder name");
    fireEvent.change(nameInput, { target: { value: "Quick Inbox" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    const createdBtn = await within(dialog).findByRole("button", {
      name: "Bookmarks bar / Quick Inbox",
    });
    expect(createdBtn.getAttribute("aria-pressed")).toBe("true");
  });
});
