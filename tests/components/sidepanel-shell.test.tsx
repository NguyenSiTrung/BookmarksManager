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
import { CONSENT_VERSION } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { putMeta } from "../../src/db/meta";
import { App } from "../../src/entrypoints/sidepanel/App";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import { chooseMenuItem, openMenu } from "./menu-helpers";

/**
 * Side-panel shell: narrow (drawer) and wide (permanent column) hosts, the
 * chips + More menu and the Tools menu, all through the real `App`.
 * `matchMedia` is stubbed per test; without it `useIsWide` reports wide.
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

/**
 * jsdom reports 0 for offsetHeight/offsetWidth, so the virtualizer renders no
 * rows. Give only the scroll container a 600x400 box.
 */
const SCROLL_TESTID = "bookmark-scroll";
let savedRectDescriptors: [string, PropertyDescriptor | undefined][] = [];

function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  savedRectDescriptors = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID ? value : 0;
      },
    });
    return [prop, prior];
  });
}

function restoreElementRects(): void {
  for (const [prop, prior] of savedRectDescriptors) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  savedRectDescriptors = [];
}

function stubViewport(wide: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: wide,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.consents.clear();
  await db.decisions.clear();
  const fake = createFakeBookmarks({
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [{ id: "b1", title: "Alpha", url: "https://a.example/" }],
      },
      { id: "b3", title: "Gamma", url: "https://x.example/" },
    ],
    otherBookmarks: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
  });
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: {
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    },
  });
});

async function renderApp(): Promise<void> {
  stubElementRects();
  render(<App />);
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

async function seedConsent(): Promise<void> {
  await db.consents.put({
    scope: DECISIONS_CONSENT_SCOPE,
    origin: "https://provider.example",
    consentVersion: CONSENT_VERSION,
    acceptedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("narrow shell", () => {
  it("hides the folder tree until the scope heading opens the drawer", async () => {
    stubViewport(false);
    await renderApp();
    expect(screen.queryByRole("treeitem")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    const drawer = await screen.findByRole("dialog", { name: "Browse" });
    expect(drawer).toBeTruthy();
    expect(await screen.findByRole("treeitem", { name: "Dev" })).toBeTruthy();
  });

  it("selecting a folder in the drawer closes it and retitles the scope", async () => {
    stubViewport(false);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: "Dev" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("heading", { name: "Dev" })).toBeTruthy();
    await waitFor(() => {
      const texts = screen
        .getAllByRole("option")
        .map((el) => el.textContent ?? "")
        .join("|");
      expect(texts).toContain("Alpha");
      expect(texts).not.toContain("Gamma");
    });
  });

  it("lists only non-empty categories, with counts, in the drawer", async () => {
    await putMeta("b1", { category: "docs" });
    await putMeta("b3", { category: "docs" });
    stubViewport(false);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "All bookmarks" }));
    const docs = await screen.findByRole("button", { name: /^Docs/ });
    expect(docs.textContent).toContain("2");
    expect(screen.queryByRole("button", { name: /^Video/ })).toBeNull();
  });
});

describe("wide shell", () => {
  it("shows the permanent scope column and a plain scope heading", async () => {
    stubViewport(true);
    await renderApp();
    expect(await screen.findByRole("treeitem", { name: "Dev" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Browse" })).toBeTruthy();
    const heading = screen.getByRole("heading", { name: "All bookmarks" });
    expect(heading.querySelector("button")).toBeNull();
  });
});

describe("Tools and More menus", () => {
  it("offers Set up AI and no Scan or Restructure without a provider", async () => {
    stubViewport(false);
    await renderApp();

    await openMenu("Tools");
    expect(screen.getByRole("menuitem", { name: "Set up AI…" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Scan library…" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await openMenu(/^More/);
    expect(screen.getByRole("menuitem", { name: "Duplicates" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Review/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Restructure" })).toBeNull();
  });

  it("offers Scan, Review and Restructure once a provider is connected", async () => {
    await seedConsent();
    stubViewport(false);
    await renderApp();

    await openMenu("Tools");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Scan library…" })).toBeTruthy(),
    );
    expect(screen.queryByRole("menuitem", { name: "Set up AI…" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await openMenu(/^More/);
    expect(screen.getByRole("menuitem", { name: /Review suggestions/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Restructure" })).toBeTruthy();
  });

  it("switches to Duplicates from More and relabels the chip", async () => {
    stubViewport(false);
    await renderApp();
    await openMenu(/^More/);
    await chooseMenuItem("Duplicates");
    expect(await screen.findByRole("heading", { name: "Duplicates" })).toBeTruthy();
    const views = screen.getByRole("navigation", { name: "Views" });
    expect(within(views).getByRole("button", { name: /^Duplicates/ })).toBeTruthy();
  });

  it("opens the Manage tags dialog from Tools", async () => {
    stubViewport(false);
    await renderApp();
    await openMenu("Tools");
    await chooseMenuItem("Manage tags…");
    expect(await screen.findByRole("heading", { name: "Manage tags" })).toBeTruthy();
  });
});
