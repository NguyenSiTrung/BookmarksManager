import "fake-indexeddb/auto";
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
import { getMeta, listMeta, putMeta } from "../../src/db/meta";
import {
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
} from "../../src/sync/chrome-bookmarks";
import { registerBookmarkListeners } from "../../src/sync/listeners";
import {
  invalidateSearchIndex,
  sharedSearchIndex,
} from "../../src/search/omnibox";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import { Decision } from "../../src/schemas/decision";
import {
  claimDecision,
  deleteReviewableByBookmarkIds,
  releaseDecisionClaim,
} from "../../src/decisions/store";
import type {
  FakeBookmarksApi,
  FakeBookmarksOptions,
} from "../fakes/chrome-bookmarks";

/**
 * Worker-sync listener coverage against the in-memory fake.
 *
 * The fake emits bookmark events synchronously during the mutating call, but
 * the `onRemoved` cascade delete is async (`deleteMetaByIds`), so assertions
 * on post-removal state go through `vi.waitFor`. `sendMessage` is a spy on a
 * composed `chrome` stub: `createFakeBookmarks` alone does not stub the
 * global, and `install()` would install `{ bookmarks }` without `runtime`.
 */
let fake: FakeBookmarksApi;
let sendMessage: ReturnType<typeof vi.fn>;

function installChrome(
  options: FakeBookmarksOptions = {},
): FakeBookmarksApi {
  fake = createFakeBookmarks(options);
  sendMessage = vi.fn(() => Promise.resolve(undefined));
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: { sendMessage },
  });
  return fake;
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.decisions.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

describe("onRemoved cascade delete", () => {
  it("deletes metadata for the removed node and every descendant", async () => {
    installChrome({
      bookmarksBar: [
        {
          id: "doomed",
          title: "Folder",
          children: [
            { id: "leaf", title: "Leaf", url: "https://leaf.example/" },
            {
              id: "sub",
              title: "Sub",
              children: [
                {
                  id: "deep",
                  title: "Deep",
                  url: "https://deep.example/",
                },
              ],
            },
          ],
        },
      ],
    });
    registerBookmarkListeners();
    await putMeta("doomed", { notes: "folder note" });
    await putMeta("leaf", { tags: ["Keep"] });
    await putMeta("sub", { category: "docs" });
    await putMeta("deep", { notes: "deep note" });
    // A row unrelated to the removed subtree must survive.
    await putMeta("unrelated", { notes: "keep me" });

    await fake.removeTree("doomed");

    await vi.waitFor(async () => {
      expect((await listMeta()).map((m) => m.id)).toEqual(["unrelated"]);
    });
    for (const id of ["doomed", "leaf", "sub", "deep"]) {
      expect(await getMeta(id)).toBeUndefined();
    }
    expect((await getMeta("unrelated"))?.notes).toBe("keep me");
  });

  it("deletes just the node when a lone bookmark is removed", async () => {
    installChrome({
      bookmarksBar: [
        { id: "solo", title: "Solo", url: "https://solo.example/" },
      ],
    });
    registerBookmarkListeners();
    await putMeta("solo", { notes: "x" });

    await fake.remove("solo");

    await vi.waitFor(async () => {
      expect(await getMeta("solo")).toBeUndefined();
    });
  });

  it("deletes reviewable decisions for removed ids and keeps decided rows (J14)", async () => {
    installChrome({
      bookmarksBar: [
        {
          id: "doomed",
          title: "Folder",
          children: [
            { id: "leaf", title: "Leaf", url: "https://leaf.example/" },
          ],
        },
        { id: "keeper", title: "Keeper", url: "https://k.example/" },
      ],
    });
    registerBookmarkListeners();
    const row = (status: Decision["status"], bookmarkIds: string[]): Decision =>
      Decision.parse({
        id: crypto.randomUUID(),
        bookmarkIds,
        confidence: 0.9,
        status,
        source: {
          engine: "jev",
          providerId: "typesafe",
          model: "jev-1",
          questionSetVersion: "v1",
        },
        createdAt: "2026-10-05T00:00:00.000Z",
        kind: "set_category",
        category: "article",
      });
    await db.decisions.bulkAdd([
      row("pending", ["leaf"]),
      row("unsure", ["doomed"]),
      // One member removed is enough: the suggestion's premise is gone.
      row("approved", ["leaf", "keeper"]),
      // Decided rows are history — they stay for undo and the audit trail.
      row("applied", ["leaf"]),
      row("reverted", ["doomed"]),
      row("pending", ["keeper"]),
    ]);

    await fake.removeTree("doomed");

    await vi.waitFor(async () => {
      expect(
        (await db.decisions.toArray()).map((r) => r.status).sort(),
      ).toEqual(["applied", "pending", "reverted"]);
    });
    const survivors = await db.decisions.toArray();
    expect(survivors).toHaveLength(3);
    expect(
      survivors.filter((r) => r.status === "pending")[0]?.bookmarkIds,
    ).toEqual(["keeper"]);
  });

  it("skips a decision under a live claim — the merge-apply race (J14)", async () => {
    installChrome({
      bookmarksBar: [
        { id: "loser", title: "L", url: "https://l.example/" },
        { id: "winner", title: "W", url: "https://w.example/" },
      ],
    });
    registerBookmarkListeners();
    // A merge decision spans winner+loser; approveDecision's applyAction
    // removes the loser while the row is still reviewable but claimed.
    const merged = Decision.parse({
      id: crypto.randomUUID(),
      bookmarkIds: ["winner", "loser"],
      confidence: 0.9,
      status: "pending",
      source: {
        engine: "jev",
        providerId: "typesafe",
        model: "jev-1",
        questionSetVersion: "v1",
      },
      createdAt: "2026-10-05T00:00:00.000Z",
      kind: "merge_duplicates",
      keepId: "winner",
    });
    await db.decisions.add(merged);
    await putMeta("loser", { notes: "x" });
    const { token } = await claimDecision(merged.id, "applied");

    await fake.remove("loser");
    // The cascade ran (meta gone) but the claimed row must survive —
    // deleting it here would race transitionStatus into a compensate.
    await vi.waitFor(async () => {
      expect(await getMeta("loser")).toBeUndefined();
    });
    expect(await db.decisions.get(merged.id)).not.toBeUndefined();

    // Claim released (transition finished or failed): the sweep takes it.
    await releaseDecisionClaim(merged.id, token);
    await deleteReviewableByBookmarkIds(["loser"]);
    expect(await db.decisions.get(merged.id)).toBeUndefined();
  });

  it("keeps metadata when a different subtree is removed", async () => {
    installChrome({
      bookmarksBar: [
        {
          id: "victim",
          title: "Victim",
          children: [
            { id: "victim-child", title: "c", url: "https://c.example/" },
          ],
        },
        {
          id: "survivor",
          title: "Survivor",
          children: [
            {
              id: "survivor-child",
              title: "s",
              url: "https://s.example/",
            },
          ],
        },
      ],
    });
    registerBookmarkListeners();
    await putMeta("victim", { notes: "v" });
    await putMeta("victim-child", { notes: "vc" });
    await putMeta("survivor", { notes: "s" });
    await putMeta("survivor-child", { notes: "sc" });

    await fake.removeTree("victim");

    await vi.waitFor(async () => {
      expect((await listMeta()).map((m) => m.id)).toEqual([
        "survivor",
        "survivor-child",
      ]);
    });
  });
});

describe("search index invalidation (D14)", () => {
  it("invalidates the shared index on every bookmark event", async () => {
    installChrome({
      bookmarksBar: [{ id: "a", title: "a", url: "https://a.example/" }],
    });
    registerBookmarkListeners();

    invalidateSearchIndex();
    const first = await sharedSearchIndex();
    expect(first).not.toBeNull();
    expect(await sharedSearchIndex()).toBe(first);

    const created = await fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: "x",
      url: "https://x.example/",
    });
    const afterCreate = await sharedSearchIndex();
    expect(afterCreate).not.toBe(first);

    await fake.update("a", { title: "renamed" });
    const afterChange = await sharedSearchIndex();
    expect(afterChange).not.toBe(afterCreate);

    fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["a", created.id]);
    const afterReorder = await sharedSearchIndex();
    expect(afterReorder).not.toBe(afterChange);

    await fake.move("a", { parentId: OTHER_BOOKMARKS_ID });
    expect(await sharedSearchIndex()).not.toBe(afterReorder);

    const beforeRemove = await sharedSearchIndex();
    await fake.remove("a");
    await vi.waitFor(async () => {
      expect(await sharedSearchIndex()).not.toBe(beforeRemove);
    });
  });

  it("rebuilds into new content after invalidation", async () => {
    installChrome({
      bookmarksBar: [{ id: "a", title: "Alpha", url: "https://a.example/" }],
    });
    registerBookmarkListeners();
    invalidateSearchIndex();
    const first = await sharedSearchIndex();

    await fake.create({ title: "Zeta", url: "https://z.example/" });
    const rebuilt = await sharedSearchIndex();
    expect(rebuilt).not.toBe(first);
    // The rebuilt index serves the new bookmark.
    const { runQuery } = await import("../../src/search/run");
    expect(
      runQuery(rebuilt!.index, "zeta", rebuilt!.ctx).hits.length,
    ).toBeGreaterThan(0);
  });

  it("invalidates on a meta write from another context (BroadcastChannel)", async () => {
    installChrome({
      bookmarksBar: [{ id: "a", title: "a", url: "https://a.example/" }],
    });
    registerBookmarkListeners();
    invalidateSearchIndex();
    const first = await sharedSearchIndex();

    await putMeta("a", { notes: "edited elsewhere" });
    await vi.waitFor(async () => {
      expect(await sharedSearchIndex()).not.toBe(first);
    });
  });

  it("never broadcasts bookmarks-changed over runtime.sendMessage", async () => {
    installChrome({
      bookmarksBar: [{ id: "a", title: "a", url: "https://a.example/" }],
    });
    registerBookmarkListeners();

    const created = await fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: "x",
      url: "https://x.example/",
    });
    await fake.update("a", { title: "renamed" });
    fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["a", created.id]);
    await fake.move("a", { parentId: OTHER_BOOKMARKS_ID });
    await fake.remove("a");
    await vi.waitFor(async () => {
      expect(await getMeta("a")).toBeUndefined();
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("registration lifecycle", () => {
  it("is idempotent for the same chrome.bookmarks instance", () => {
    installChrome();
    const addCreated = vi.spyOn(fake.onCreated, "addListener");
    registerBookmarkListeners();
    registerBookmarkListeners();

    expect(addCreated).toHaveBeenCalledTimes(1);
  });

  it("registers fresh on a new chrome.bookmarks instance", () => {
    installChrome();
    const firstAdd = vi.spyOn(fake.onCreated, "addListener");
    registerBookmarkListeners();

    installChrome();
    const secondAdd = vi.spyOn(fake.onCreated, "addListener");
    registerBookmarkListeners();

    expect(firstAdd).toHaveBeenCalledTimes(1);
    expect(secondAdd).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the chrome namespace has no bookmarks slice", () => {
    vi.stubGlobal("chrome", {});

    // Must not throw: background.ts calls this BEFORE the provider
    // onMessage registration, so a throw would take the handler down.
    expect(() => registerBookmarkListeners()).not.toThrow();
    const off = registerBookmarkListeners();
    expect(() => off()).not.toThrow();
  });

  it("is a no-op when no chrome global exists at all", () => {
    // jsdom exposes no `chrome`; nothing is stubbed in this test.
    expect(() => registerBookmarkListeners()).not.toThrow();
    expect(registerBookmarkListeners()()).toBeUndefined();
  });

  it("cleans up partial subscriptions when an event surface is missing", async () => {
    fake = createFakeBookmarks();
    sendMessage = vi.fn(() => Promise.resolve(undefined));
    // Partial surface: `onMoved` is absent, so registration fails mid-way
    // through the five subscriptions (created + changed already attached).
    // The spread shares the fake's FakeEvent instances, so spying on
    // `fake.onX` observes what `partial.onX` receives.
    const partial = { ...fake, onMoved: undefined };
    vi.stubGlobal("chrome", {
      bookmarks: partial,
      runtime: { sendMessage },
    });
    const addCreated = vi.spyOn(fake.onCreated, "addListener");
    const addChanged = vi.spyOn(fake.onChanged, "addListener");
    const addReordered = vi.spyOn(fake.onChildrenReordered, "addListener");
    const addRemoved = vi.spyOn(fake.onRemoved, "addListener");
    const removeCreated = vi.spyOn(fake.onCreated, "removeListener");
    const removeChanged = vi.spyOn(fake.onChanged, "removeListener");

    const off = registerBookmarkListeners(); // must not throw

    // created + changed were subscribed before the throw at onMoved…
    expect(addCreated).toHaveBeenCalledTimes(1);
    expect(addChanged).toHaveBeenCalledTimes(1);
    // …reordered/removed were never reached…
    expect(addReordered).not.toHaveBeenCalled();
    expect(addRemoved).not.toHaveBeenCalled();
    // …and the two attached listeners were detached again by the cleanup —
    // removeListener received exactly the callback addListener took.
    expect(removeCreated).toHaveBeenCalledTimes(1);
    expect(removeChanged).toHaveBeenCalledTimes(1);
    expect(removeCreated.mock.calls[0]?.[0]).toBe(
      addCreated.mock.calls[0]?.[0],
    );
    expect(removeChanged.mock.calls[0]?.[0]).toBe(
      addChanged.mock.calls[0]?.[0],
    );

    // End state: no live subscription — the detached listener is gone
    // (all-or-nothing registration, no leaked partials).
    expect(
      fake.onCreated.hasListener(addCreated.mock.calls[0]![0]),
    ).toBe(false);
    await fake.create({ title: "x", url: "https://x.example/" });

    // The failed registration returns an inert unsubscribe and is not
    // recorded in the WeakMap, so a repaired surface may register later —
    // and a repeat attempt on the same partial api cleans up again.
    expect(() => off()).not.toThrow();
    expect(() => registerBookmarkListeners()).not.toThrow();
    expect(addCreated).toHaveBeenCalledTimes(2);
    expect(removeCreated).toHaveBeenCalledTimes(2);
    expect(
      fake.onCreated.hasListener(addCreated.mock.calls[1]![0]),
    ).toBe(false);
  });

  it("the returned unsubscribe detaches all five listeners", async () => {
    installChrome({
      bookmarksBar: [{ id: "n", title: "n", url: "https://n.example/" }],
    });
    await putMeta("n", { notes: "kept" });
    const addCreated = vi.spyOn(fake.onCreated, "addListener");
    const addRemoved = vi.spyOn(fake.onRemoved, "addListener");
    const unregister = registerBookmarkListeners();
    const createdFn = addCreated.mock.calls[0]![0];
    const removedFn = addRemoved.mock.calls[0]![0];
    unregister();

    expect(fake.onCreated.hasListener(createdFn)).toBe(false);
    expect(fake.onRemoved.hasListener(removedFn)).toBe(false);

    const node = await fake.create({
      title: "x",
      url: "https://x.example/",
    });
    await fake.update("n", { title: "n2" });
    await fake.move(node.id, { parentId: BOOKMARKS_BAR_ID });
    fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["n", node.id]);
    await fake.remove("n");

    // Post-unregister events reach no listener — the cascade can't fire,
    // so the meta row survives the removal.
    await fake.create({ title: "y", url: "https://y.example/" });
    expect((await getMeta("n"))?.notes).toBe("kept");
  });
});

describe("egress", () => {
  it("never touches the network", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("fetch must not be called from sync listeners");
    });
    vi.stubGlobal("fetch", fetchSpy);
    installChrome({
      bookmarksBar: [
        { id: "n1", title: "n1", url: "https://n1.example/" },
        { id: "n2", title: "n2", url: "https://n2.example/" },
      ],
    });
    registerBookmarkListeners();
    await putMeta("n1", { notes: "x" });

    const node = await fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: "c",
      url: "https://c.example/",
    });
    await fake.update("n2", { title: "n2b" });
    await fake.move(node.id, { parentId: OTHER_BOOKMARKS_ID });
    fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["n2", "n1"]);
    await fake.remove("n1");
    await vi.waitFor(async () => {
      expect(await getMeta("n1")).toBeUndefined();
    });

    // No `bookmarks-changed` broadcast exists anymore (D14) — runtime
    // messaging is never touched either.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
