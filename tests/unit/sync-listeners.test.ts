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
import {
  BOOKMARKS_CHANGED_TYPE,
  BookmarksChangedMessage,
  registerBookmarkListeners,
} from "../../src/sync/listeners";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
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

describe("bookmarks-changed broadcast", () => {
  it("sends a schema-valid message for each of the five events", async () => {
    installChrome({
      bookmarksBar: [
        { id: "a", title: "a", url: "https://a.example/" },
        { id: "b", title: "b", url: "https://b.example/" },
      ],
    });
    registerBookmarkListeners();

    const created = await fake.create({
      parentId: BOOKMARKS_BAR_ID,
      title: "New",
      url: "https://new.example/",
    });
    // created/changed/moved/reordered broadcast synchronously inside emit.
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: BOOKMARKS_CHANGED_TYPE,
      event: "created",
      id: created.id,
    });

    await fake.update("a", { title: "renamed" });
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: BOOKMARKS_CHANGED_TYPE,
      event: "changed",
      id: "a",
    });

    await fake.move("b", { parentId: OTHER_BOOKMARKS_ID });
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: BOOKMARKS_CHANGED_TYPE,
      event: "moved",
      id: "b",
    });

    fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, [created.id, "a"]);
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: BOOKMARKS_CHANGED_TYPE,
      event: "reordered",
      id: BOOKMARKS_BAR_ID,
    });

    await fake.remove("a");
    // "removed" is broadcast only after the cascade delete resolves.
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenLastCalledWith({
        type: BOOKMARKS_CHANGED_TYPE,
        event: "removed",
        id: "a",
      });
    });

    expect(sendMessage).toHaveBeenCalledTimes(5);
    for (const call of sendMessage.mock.calls) {
      expect(BookmarksChangedMessage.safeParse(call[0]).success).toBe(true);
    }
  });

  it("swallows a sendMessage rejection (no receiver is open)", async () => {
    installChrome();
    sendMessage.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist."),
    );
    registerBookmarkListeners();

    // The handler must not throw into the fake's synchronous dispatch, and
    // the rejection must be handled (no unhandled rejection).
    await expect(
      fake.create({ title: "x", url: "https://x.example/" }),
    ).resolves.toMatchObject({ title: "x" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("tolerates a chrome stub without a runtime surface", async () => {
    fake = createFakeBookmarks({
      bookmarksBar: [
        { id: "doomed", title: "d", url: "https://d.example/" },
      ],
    });
    // No `runtime` at all: broadcasting becomes a no-op, the cascade still runs.
    vi.stubGlobal("chrome", { bookmarks: fake });
    registerBookmarkListeners();
    await putMeta("doomed", { notes: "x" });

    await expect(fake.remove("doomed")).resolves.toBeUndefined();
    await vi.waitFor(async () => {
      expect(await getMeta("doomed")).toBeUndefined();
    });
  });
});

describe("registration lifecycle", () => {
  it("is idempotent for the same chrome.bookmarks instance", async () => {
    installChrome();
    registerBookmarkListeners();
    registerBookmarkListeners();

    await fake.create({ title: "x", url: "https://x.example/" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("registers fresh on a new chrome.bookmarks instance", async () => {
    installChrome();
    registerBookmarkListeners();
    const firstSendMessage = sendMessage;

    installChrome();
    registerBookmarkListeners();

    await fake.create({ title: "y", url: "https://y.example/" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(firstSendMessage).not.toHaveBeenCalled();
  });

  it("the returned unsubscribe detaches all five listeners", async () => {
    installChrome({
      bookmarksBar: [{ id: "n", title: "n", url: "https://n.example/" }],
    });
    const unregister = registerBookmarkListeners();
    unregister();

    const node = await fake.create({
      title: "x",
      url: "https://x.example/",
    });
    await fake.update("n", { title: "n2" });
    await fake.move(node.id, { parentId: BOOKMARKS_BAR_ID });
    fake.simulateChildrenReordered(BOOKMARKS_BAR_ID, ["n", node.id]);
    await fake.remove("n");

    expect(sendMessage).not.toHaveBeenCalled();
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

    expect(sendMessage).toHaveBeenCalledTimes(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
