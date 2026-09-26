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
import { getMeta, listMeta, listTags, createTag, putMeta } from "../../src/db/meta";
import type { MergeSuccess } from "../../src/duplicates/merge";
import type { DuplicateGroup } from "../../src/duplicates/group";
import { DuplicatesView } from "../../src/entrypoints/sidepanel/DuplicatesView";
import { resolveDuplicateGroups } from "../../src/entrypoints/sidepanel/views";
import type { BookmarkMeta } from "../../src/schemas/meta";
import {
  BOOKMARKS_BAR_ID,
  get,
  getChildren,
} from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { BookmarkItem } from "../../src/sync/tree";
import { peekLatest } from "../../src/undo/snapshot";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Task 6 — grouped Duplicates view with "Keep this one" merge.
 *
 * Seeded fake tree:
 *
 * ```
 * 0 root
 * ├─ 1 Bookmarks bar
 * │  ├─ 10 Dev (folder)
 * │  │  ├─ n1 "Norm A"   https://A.example/page?utm_source=x  ┐ normalized
 * │  │  └─ 11 Deep (folder)                                  │ pair
 * │  │     └─ n2 "Norm B" https://a.example/page             ┘
 * │  ├─ x1 "Exact One"   https://x.example/  ┐
 * │  └─ x2 "Exact Two"   https://x.example/  │ exact triple
 * ├─ 2 Other bookmarks                     │
 * │  ├─ 20 Stuff (folder)                  │
 * │  │  └─ x3 "Exact Three" https://x.example/ ┘
 * │  ├─ mA "Managed Pair A" https://m.example/  ┐ exact pair with a
 * │  ├─ mg "Policy" (managed folder)            │ managed loser —
 * │  │  └─ mB "Managed Pair B" https://m.example/ ┘ merge fails `managed`
 * │  └─ solo "Solo" https://solo.example/     (never grouped)
 * └─ 3 Mobile bookmarks
 * ```
 *
 * Expected groups (exact first, first-seen order):
 *  1. exact     "https://x.example/"  → x1, x2, x3
 *  2. exact     "https://m.example/"  → mA, mB
 *  3. normalized "a.example/page"     → n1, n2
 * (the normalized buckets for x.example and m.example equal their exact
 * member sets and are suppressed by groupDuplicates.)
 */

let fake: FakeBookmarksApi;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [
          {
            id: "n1",
            title: "Norm A",
            url: "https://A.example/page?utm_source=x",
          },
          {
            id: "11",
            title: "Deep",
            children: [
              {
                id: "n2",
                title: "Norm B",
                url: "https://a.example/page",
              },
            ],
          },
        ],
      },
      { id: "x1", title: "Exact One", url: "https://x.example/" },
      { id: "x2", title: "Exact Two", url: "https://x.example/" },
    ],
    otherBookmarks: [
      {
        id: "20",
        title: "Stuff",
        children: [
          { id: "x3", title: "Exact Three", url: "https://x.example/" },
        ],
      },
      { id: "mA", title: "Managed Pair A", url: "https://m.example/" },
      {
        id: "mg",
        title: "Policy",
        unmodifiable: "managed",
        children: [
          { id: "mB", title: "Managed Pair B", url: "https://m.example/" },
        ],
      },
      { id: "solo", title: "Solo", url: "https://solo.example/" },
    ],
  });
  // install() stubs {bookmarks} only — add the favicon runtime surface.
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: {
      getURL: (path: string) =>
        `chrome-extension://test-extension-id/${path}`,
    },
  });
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function groupsFromFake(): Promise<DuplicateGroup<BookmarkItem>[]> {
  const nodes = await fake.getTree();
  return resolveDuplicateGroups(flattenTree(nodes));
}

async function metaById(): Promise<Map<string, BookmarkMeta>> {
  return new Map((await listMeta()).map((meta) => [meta.id, meta]));
}

async function tagNameByKey(): Promise<Map<string, string>> {
  return new Map((await listTags()).map((tag) => [tag.nameKey, tag.name]));
}

function memberRow(id: string): HTMLElement {
  const row = screen
    .getAllByTestId("duplicate-member")
    .find((el) => el.dataset.bookmarkId === id);
  if (row === undefined) {
    throw new Error(`no member row rendered for ${id}`);
  }
  return row;
}

function groupCard(key: string): HTMLElement {
  const card = screen
    .getAllByTestId("duplicate-group")
    .find((el) => el.dataset.groupKey === key);
  if (card === undefined) {
    throw new Error(`no group card rendered for ${key}`);
  }
  return card;
}

async function barChildIds(): Promise<string[]> {
  return (await getChildren(BOOKMARKS_BAR_ID)).map((node) => node.id);
}

/** Click "Keep this one" for `keepId`, then confirm the merge. */
async function mergeKeeping(
  keepId: string,
  extra: { onRequestUndo?: () => void; onMerged?: (r: MergeSuccess) => void } = {},
): Promise<void> {
  const groups = await groupsFromFake();
  render(
    <DuplicatesView
      groups={groups}
      metaById={await metaById()}
      {...extra}
    />,
  );
  fireEvent.click(
    within(memberRow(keepId)).getByRole("button", { name: "Keep this one" }),
  );
  const confirm = await screen.findByTestId("merge-confirm");
  fireEvent.click(
    within(confirm).getByRole("button", { name: "Confirm merge" }),
  );
  await screen.findByTestId("merge-result");
}

// ---------------------------------------------------------------------------
// resolveDuplicateGroups — additive resolver in views.ts
// ---------------------------------------------------------------------------

describe("resolveDuplicateGroups", () => {
  it("returns exact groups first, then normalized, preserving BookmarkItem rows", async () => {
    const groups = await groupsFromFake();
    expect(groups.map((group) => group.kind)).toEqual([
      "exact",
      "exact",
      "normalized",
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "https://x.example/",
      "https://m.example/",
      "a.example/page",
    ]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual([
      "x1",
      "x2",
      "x3",
    ]);
    // Full BookmarkItem payloads: path is needed for the member row's
    // folder trail — x3 lives under Other bookmarks / Stuff.
    const x3 = groups[0]?.items.find((item) => item.id === "x3");
    expect(x3?.kind).toBe("bookmark");
    expect(x3?.path).toEqual(["Other bookmarks", "Stuff"]);
  });
});

// ---------------------------------------------------------------------------
// Group rendering — badges, counts, keys, member rows
// ---------------------------------------------------------------------------

describe("DuplicatesView rendering", () => {
  it("renders each group as a card with kind badge, member count, and shared key", async () => {
    const groups = await groupsFromFake();
    render(<DuplicatesView groups={groups} />);

    const cards = screen.getAllByTestId("duplicate-group");
    expect(cards.length).toBe(3);

    const exact = groupCard("https://x.example/");
    expect(within(exact).getByText("Exact")).toBeTruthy();
    expect(exact.textContent).toContain("https://x.example/");
    expect(exact.textContent).toMatch(/3 (members|duplicates)/);

    const normalized = groupCard("a.example/page");
    expect(within(normalized).getByText("Normalized")).toBeTruthy();
    expect(normalized.textContent).toContain("a.example/page");
    expect(normalized.textContent).toMatch(/2 (members|duplicates)/);

    // Different visual weight: the two badge styles must not be identical.
    const exactBadge = within(exact).getByText("Exact");
    const normalizedBadge = within(normalized).getByText("Normalized");
    expect(exactBadge.className).not.toBe(normalizedBadge.className);
  });

  it("renders member rows with favicon, title, url, folder path, and tag chips", async () => {
    await putMeta("x1", { tags: ["Dev", "Ops"], category: "tool" });
    await putMeta("x2", { notes: "x2 note" });
    await createTag("Dev");
    await createTag("Ops");

    const groups = await groupsFromFake();
    render(
      <DuplicatesView
        groups={groups}
        metaById={await metaById()}
        tagNameByKey={await tagNameByKey()}
      />,
    );

    const row = memberRow("x1");
    expect(row.textContent).toContain("Exact One");
    expect(row.textContent).toContain("https://x.example/");
    // Folder path: x1 sits at the top of the Bookmarks bar.
    expect(row.textContent).toContain("Bookmarks bar");
    // Display names from tagNameByKey, plus a count.
    expect(row.textContent).toContain("Dev");
    expect(row.textContent).toContain("Ops");
    expect(row.textContent).toMatch(/2 tags/);
    expect(row.textContent).toContain("tool");
    // Favicon routed through the _favicon renderer.
    const img = row.querySelector("img");
    expect(img?.getAttribute("src")).toContain(
      "chrome-extension://test-extension-id/_favicon/",
    );
    expect(img?.getAttribute("src")).toContain(
      encodeURIComponent("https://x.example/"),
    );

    const x2 = memberRow("x2");
    expect(x2.textContent).toContain("notes");

    // Nested path: "Bookmarks bar / Dev / Deep" for n2.
    const n2 = memberRow("n2");
    expect(n2.textContent).toContain("Bookmarks bar");
    expect(n2.textContent).toContain("Dev");
    expect(n2.textContent).toContain("Deep");
  });

  it("shows the empty state when there are no groups", () => {
    render(<DuplicatesView groups={[]} />);
    expect(screen.getByText(/No duplicates/)).toBeTruthy();
  });

  it("shows a loading affordance while the tree loads", async () => {
    const groups = await groupsFromFake();
    render(<DuplicatesView groups={groups} loading />);
    expect(screen.getByText(/[Ss]canning|[Ll]oading/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Merge flow — keep-one → confirm → mergeGroup → success + undo
// ---------------------------------------------------------------------------

describe("DuplicatesView merge flow", () => {
  beforeEach(async () => {
    await putMeta("x1", { tags: ["keep", "shared"], notes: "kept note" });
    await putMeta("x2", { tags: ["l2", "shared"], notes: "l2 note" });
    await putMeta("x3", { tags: ["l3"], category: "docs" });
  });

  it("confirms then merges: losers leave the fake tree, kept meta is unioned", async () => {
    const groups = await groupsFromFake();
    const onMerged = vi.fn();
    render(
      <DuplicatesView
        groups={groups}
        metaById={await metaById()}
        onMerged={onMerged}
      />,
    );

    // Choose the keep — other members gain the "will be removed" affordance.
    fireEvent.click(
      within(memberRow("x1")).getByRole("button", {
        name: "Keep this one",
      }),
    );
    expect(memberRow("x1").textContent).toContain("Keeping");
    expect(memberRow("x2").textContent).toContain("will be removed");
    expect(memberRow("x3").textContent).toContain("will be removed");

    const confirm = screen.getByTestId("merge-confirm");
    expect(confirm.textContent).toContain("Exact One");
    expect(confirm.textContent).toMatch(/2 bookmarks will be removed/);

    // Pre-merge preview from getMetaByIds: tag union (kept first),
    // notes combined from 2 members, winning category "docs" (x3's —
    // the kept bookmark has none).
    await waitFor(() => {
      expect(confirm.textContent).toContain("keep");
      expect(confirm.textContent).toContain("l3");
    });
    expect(confirm.textContent).toContain("shared");
    expect(confirm.textContent).toContain("l2");
    expect(confirm.textContent).toMatch(/4 tags|Tags after merge/);
    expect(confirm.textContent).toMatch(/2 notes|notes will be combined/i);
    expect(confirm.textContent).toContain("docs");

    fireEvent.click(
      within(confirm).getByRole("button", { name: "Confirm merge" }),
    );

    // Success feedback names the kept bookmark and the removal count.
    const result = await screen.findByTestId("merge-result");
    await waitFor(() => {
      expect(result.textContent).toContain("Exact One");
    });
    expect(result.textContent).toMatch(/2 (removed|merged|duplicates)/);
    expect(result.textContent).toContain("4");
    expect(result.textContent).toContain("docs");
    expect(
      within(result).getByRole("button", { name: "Undo" }),
    ).toBeTruthy();
    expect(onMerged).toHaveBeenCalledOnce();

    // The fake tree and Dexie both reflect the merge.
    await expect(get("x2")).rejects.toThrow('Can\'t find bookmark');
    await expect(get("x3")).rejects.toThrow('Can\'t find bookmark');
    expect((await get("x1"))[0]).toMatchObject({
      title: "Exact One",
      url: "https://x.example/",
    });
    expect(await getMeta("x1")).toMatchObject({
      tags: ["keep", "shared", "l2", "l3"],
      category: "docs",
    });
    expect((await getMeta("x1"))?.notes).toContain("kept note");
    expect((await getMeta("x1"))?.notes).toContain("l2 note");
    expect(await getMeta("x2")).toBeUndefined();
    expect(await getMeta("x3")).toBeUndefined();

    // The merged group collapses to its "Merged" state — no more actions.
    const card = groupCard("https://x.example/");
    expect(card.textContent).toContain("Merged");
    expect(
      within(card).queryAllByRole("button", { name: "Keep this one" }),
    ).toHaveLength(0);
  });

  it("cancel restores the idle state without mutating anything", async () => {
    const groups = await groupsFromFake();
    render(<DuplicatesView groups={groups} metaById={await metaById()} />);

    fireEvent.click(
      within(memberRow("x1")).getByRole("button", {
        name: "Keep this one",
      }),
    );
    const confirm = screen.getByTestId("merge-confirm");
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByTestId("merge-confirm")).toBeNull();
    expect(memberRow("x2").textContent).not.toContain("will be removed");
    expect(await barChildIds()).toEqual(["10", "x1", "x2"]);
    expect(await peekLatest()).toBeUndefined();
  });

  it("routes Undo through the onRequestUndo seam when provided", async () => {
    const onRequestUndo = vi.fn();
    await mergeKeeping("x1", { onRequestUndo });
    fireEvent.click(
      within(screen.getByTestId("merge-result")).getByRole("button", {
        name: "Undo",
      }),
    );
    expect(onRequestUndo).toHaveBeenCalledOnce();
  });

  it("falls back to undoLatest directly when no seam is wired", async () => {
    await mergeKeeping("x1");
    const barBefore = await barChildIds();
    expect(barBefore).toEqual(["10", "x1"]);

    fireEvent.click(
      within(screen.getByTestId("merge-result")).getByRole("button", {
        name: "Undo",
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("merge-result").textContent).toMatch(
        /[Uu]ndo (applied|complete|done)/i,
      );
    });

    // Losers recreated under fresh ids at their recorded positions.
    const barAfter = await barChildIds();
    expect(barAfter.length).toBe(3);
    expect(barAfter[0]).toBe("10");
    expect(barAfter[1]).toBe("x1");
    const newX2 = barAfter[2];
    expect(newX2).not.toBe("x2");
    expect((await get(newX2 as string))[0]).toMatchObject({
      title: "Exact Two",
      url: "https://x.example/",
    });
    // Loser meta restored under the new id; kept meta reverted.
    expect(await getMeta(newX2 as string)).toMatchObject({
      tags: ["l2", "shared"],
      notes: "l2 note",
    });
    const kept = await getMeta("x1");
    expect(kept).toMatchObject({ tags: ["keep", "shared"], notes: "kept note" });
    expect(kept?.category).toBeUndefined();
    expect(await peekLatest()).toBeUndefined();
  });

  it("surfaces a typed failure code and message when the merge rejects", async () => {
    await putMeta("mA", { tags: ["keepme"] });
    const groups = await groupsFromFake();
    render(<DuplicatesView groups={groups} metaById={await metaById()} />);

    fireEvent.click(
      within(memberRow("mA")).getByRole("button", {
        name: "Keep this one",
      }),
    );
    const confirm = screen.getByTestId("merge-confirm");
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Confirm merge" }),
    );

    const alert = await screen.findByRole("alert");
    // Typed code AND message: the managed folder guard's own wording.
    expect(alert.textContent).toContain("managed");
    expect(alert.textContent).toContain("managed folder");

    // The managed loser is untouched; the view stays usable.
    expect((await get("mB"))[0]).toBeDefined();
    expect(screen.queryByTestId("merge-result")).toBeNull();
  });
});
