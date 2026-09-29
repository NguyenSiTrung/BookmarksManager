import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
import { App } from "../../src/entrypoints/sidepanel/App";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import { chooseMenuItem, openMenu } from "./menu-helpers";
import { restoreElementRects, stubElementRects } from "./virtual-rects";

/**
 * Empty states through the real `App`: what each empty view says and what its
 * one action does. `matchMedia` is stubbed to "wide" so the folder tree is
 * on screen without opening the drawer.
 */

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});
afterAll(() => {
  db.close();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreElementRects();
});

function stubChrome(options: Parameters<typeof createFakeBookmarks>[0]): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  vi.stubGlobal("chrome", {
    bookmarks: createFakeBookmarks(options),
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
  });
}

beforeEach(async () => {
  stubElementRects();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.consents.clear();
  await db.decisions.clear();
});

const searchbox = (): HTMLElement =>
  screen.getByRole("combobox", { name: "Search bookmarks" });

describe("empty states in the app", () => {
  it("an empty library offers Import…, which opens the import dialog", async () => {
    stubChrome({ bookmarksBar: [], otherBookmarks: [] });
    render(<App />);
    expect(await screen.findByText("No bookmarks yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    expect(
      await screen.findByRole("heading", { name: "Import bookmarks" }),
    ).toBeTruthy();
  });

  it("a search with no hits names the query and Clear search empties the box", async () => {
    stubChrome({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
    });
    render(<App />);
    await screen.findByRole("option", { name: /Alpha/ });
    fireEvent.change(searchbox(), { target: { value: "zzzqqq" } });
    expect(await screen.findByText("No results for “zzzqqq”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() =>
      expect((searchbox() as HTMLInputElement).value).toBe(""),
    );
    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeTruthy();
  });

  it("Duplicates with none says so", async () => {
    stubChrome({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
    });
    render(<App />);
    await screen.findByRole("option", { name: /Alpha/ });
    await openMenu(/^More/);
    await chooseMenuItem("Duplicates");
    expect(await screen.findByText("No duplicates found")).toBeTruthy();
    expect(screen.getByText("Every bookmark URL is unique.")).toBeTruthy();
  });

  it("Untagged says everything is tagged when every bookmark has a tag", async () => {
    stubChrome({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
    });
    const { putMeta } = await import("../../src/db/meta");
    await putMeta("b1", { tags: ["dev"] });
    render(<App />);
    await screen.findByRole("option", { name: /Alpha/ });
    const views = screen.getByRole("navigation", { name: "Views" });
    fireEvent.click(
      Array.from(views.querySelectorAll("button")).find(
        (b) => b.textContent === "Untagged",
      ) as HTMLElement,
    );
    expect(await screen.findByText("Everything is tagged")).toBeTruthy();
  });
});
