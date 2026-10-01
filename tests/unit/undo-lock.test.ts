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
import { BOOKMARKS_BAR_ID, get, getChildren } from "../../src/sync/chrome-bookmarks";
import { removeTree } from "../../src/sync/mutations";
import { UNDO_LOCK_NAME, withUndoLock } from "../../src/undo/lock";
import {
  captureSubtree,
  peekLatest,
  pushSnapshot,
} from "../../src/undo/snapshot";
import {
  discardById,
  discardLatest,
  undoExpected,
  undoLatest,
} from "../../src/undo/restore";
import type { UndoResult, UndoSuccess } from "../../src/undo/restore";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import {
  currentWebLocksFake,
  removeWebLocksFake,
} from "../fakes/web-locks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * B13 — undo serialization across extension contexts.
 *
 * `restore.ts`'s module-local promise tail only orders calls INSIDE one
 * module instance. Two extension contexts (side panel, options page, service
 * worker) each have their own instance and their own Dexie connection, so
 * without an origin-scoped Web Lock both can peek the same stack head and
 * replay it — a double restore that duplicates real bookmarks.
 *
 * These tests model that with `vi.resetModules()` + a dynamic import: the
 * second instance shares only the IndexedDB database and the navigator
 * globals, exactly like a second context. The queueing `navigator.locks` fake
 * from `tests/fakes/web-locks.ts` (installed for every test by
 * `tests/setup-web-locks.ts`) supplies the platform lock the production code
 * must take.
 */

/**
 * The one extension-wide lock name, pinned literally: the name is part of the
 * cross-context contract (every context must agree on it), so the tests here
 * do not merely mirror the implementation's constant.
 */
const EXTENSION_LOCK_NAME = "bookmarks-manager:undo";

let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
    bookmarksBar: [
      { id: "folder-a", title: "Folder A" },
      { id: "bm-b", title: "B", url: "https://b.example/" },
      { id: "bm-c", title: "C", url: "https://c.example/" },
    ],
  });
  await db.bookmarkMeta.clear();
  await db.undo.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/**
 * Import an INDEPENDENT instance of a module: fresh module-local state, fresh
 * Dexie connection over the same IndexedDB database — the "another extension
 * context" model.
 */
async function importFreshRestore(): Promise<typeof import("../../src/undo/restore")> {
  vi.resetModules();
  return import("../../src/undo/restore");
}

async function importFreshLock(): Promise<typeof import("../../src/undo/lock")> {
  vi.resetModules();
  return import("../../src/undo/lock");
}

/** Let queued microtasks and fake-indexeddb callbacks run. */
async function flush(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Push a `delete` snapshot for `id` and remove the node it describes. */
async function snapshotAndDelete(id: string): Promise<number> {
  const capture = await captureSubtree(id);
  if (capture === undefined) throw new Error(`missing fixture node ${id}`);
  const snapshotId = await pushSnapshot({
    kind: "delete",
    nodes: [capture.node],
    meta: capture.meta,
  });
  await removeTree(id);
  return snapshotId;
}

/** Narrow the result union to its success arm (fails the test otherwise). */
function expectOk(result: UndoResult): UndoSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`undo failed: ${result.message}`);
  return result;
}

function requireLocks(): NonNullable<ReturnType<typeof currentWebLocksFake>> {
  const locks = currentWebLocksFake();
  if (locks === undefined) throw new Error("missing web locks fake");
  return locks;
}

/**
 * Pause the FIRST stack read (`listSnapshots`'s Dexie `toArray`) so a test can
 * push an unrelated snapshot into the window between a replay's head check and
 * its replay — the B13 interleave. Returns a handle to observe the pause and
 * release it.
 *
 * Dexie resolves a `PromiseExtended`, so the gate chains on the real promise;
 * an `async` wrapper would return a plain promise and fail the spy's type.
 */
function gateFirstStackRead(): { delayed: () => boolean; release: () => void } {
  const realToArray = db.undo.toArray.bind(db.undo);
  let delayed = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(db.undo, "toArray").mockImplementation(() =>
    realToArray().then((rows) => {
      if (delayed) return rows;
      delayed = true;
      return gate.then(() => rows);
    }),
  );
  return { delayed: () => delayed, release };
}

// ---------------------------------------------------------------------------
// Cross-context serialization
// ---------------------------------------------------------------------------

describe("undo lock — cross-context serialization", () => {
  it("restores once when two contexts replay the same delete snapshot simultaneously", async () => {
    const restoredUrl = "https://b.example/";
    await snapshotAndDelete("bm-b");
    const createSpy = vi.spyOn(fake, "create");

    const other = await importFreshRestore();
    const results = await Promise.all([undoLatest(), other.undoLatest()]);

    // Exactly one context won the replay; the loser found an empty stack.
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.code === "empty"),
    ).toHaveLength(1);
    // …and the bookmark exists exactly once — no duplicate restore.
    const restored = (await getChildren(BOOKMARKS_BAR_ID)).filter(
      (node) => node.url === restoredUrl,
    );
    expect(restored).toHaveLength(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(await peekLatest()).toBeUndefined();
  });

  it("lets only one context consume a snapshot when two contexts discard the same row", async () => {
    const rowId = await snapshotAndDelete("bm-b");
    const other = await importFreshRestore();

    const results = await Promise.all([
      discardById(rowId),
      other.discardById(rowId),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.code === "empty"),
    ).toHaveLength(1);
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("waits for the extension lock while another context holds it", async () => {
    const locks = requireLocks();
    await snapshotAndDelete("bm-b");

    // Another context (the options page) is mid-replay: it holds the lock.
    let releaseHolder!: () => void;
    const holder = locks.request(
      EXTENSION_LOCK_NAME,
      { mode: "exclusive" },
      () => new Promise<void>((resolve) => (releaseHolder = resolve)),
    );
    await vi.waitFor(() => expect(locks.inspect().held).toHaveLength(1));

    const pending = undoLatest();
    let settled = false;
    void pending.then(() => (settled = true));
    await flush();

    // The undo is queued behind the other context — nothing replayed yet.
    expect(settled).toBe(false);
    expect(locks.inspect().pending).toEqual([
      { name: EXTENSION_LOCK_NAME, mode: "exclusive" },
    ]);
    await expect(get("bm-b")).rejects.toThrow();

    releaseHolder();
    await holder;
    expectOk(await pending);
    const restored = (await getChildren(BOOKMARKS_BAR_ID)).filter(
      (node) => node.url === "https://b.example/",
    );
    expect(restored).toHaveLength(1);
  });

  it("wraps the discard paths in the same extension lock", async () => {
    const locks = requireLocks();
    const rowId = await snapshotAndDelete("bm-b");

    let releaseHolder!: () => void;
    const holder = locks.request(
      EXTENSION_LOCK_NAME,
      { mode: "exclusive" },
      () => new Promise<void>((resolve) => (releaseHolder = resolve)),
    );
    await vi.waitFor(() => expect(locks.inspect().held).toHaveLength(1));

    const pending = discardLatest();
    let settled = false;
    void pending.then(() => (settled = true));
    await flush();

    // A discard is a stack mutation too: it must not slip past another
    // context's replay, so the row is still there while the lock is held.
    expect(settled).toBe(false);
    expect(await db.undo.get(rowId)).toBeDefined();

    releaseHolder();
    await holder;
    expect(await pending).toMatchObject({ ok: true, discardedId: rowId });
    expect(await db.undo.get(rowId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Lock availability
// ---------------------------------------------------------------------------

describe("undo lock — availability refusals", () => {
  it("refuses typed with zero mutations when the runtime has no Web Locks", async () => {
    const snapshotId = await snapshotAndDelete("bm-b");
    const createSpy = vi.spyOn(fake, "create");
    removeWebLocksFake();

    const result = await undoLatest();

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    // Zero mutations: nothing recreated, the row still on the stack.
    expect(createSpy).not.toHaveBeenCalled();
    await expect(get("bm-b")).rejects.toThrow();
    expect((await peekLatest())?.id).toBe(snapshotId);
  });

  it("refuses typed with zero mutations when the lock manager rejects the request", async () => {
    const snapshotId = await snapshotAndDelete("bm-b");
    const createSpy = vi.spyOn(fake, "create");
    vi.spyOn(requireLocks(), "request").mockRejectedValue(
      new Error("lock denied"),
    );

    const result = await undoLatest();

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(createSpy).not.toHaveBeenCalled();
    await expect(get("bm-b")).rejects.toThrow();
    expect((await peekLatest())?.id).toBe(snapshotId);
  });

  it("releases the lock when a replay fails, so the retry can run", async () => {
    const locks = requireLocks();
    await snapshotAndDelete("bm-b");
    const originalCreate = fake.create.bind(fake);
    let failOnce = true;
    vi.spyOn(fake, "create").mockImplementation((details) => {
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new Error("chrome boom"));
      }
      return originalCreate(details);
    });

    const failed = await undoLatest();
    expect(failed).toMatchObject({ ok: false, code: "api" });
    // The failed critical section released the lock …
    expect(locks.inspect().held).toEqual([]);

    // … so the retry resumes the replay instead of deadlocking on a lock the
    // same context still held.
    expectOk(await undoLatest());
    expect((await getChildren(BOOKMARKS_BAR_ID)).filter((n) => n.title === "B")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// withUndoLock
// ---------------------------------------------------------------------------

describe("withUndoLock", () => {
  it("publishes one stable extension-wide lock name", () => {
    expect(UNDO_LOCK_NAME).toBe(EXTENSION_LOCK_NAME);
  });

  it("is re-entrant in one context: a nested call cannot deadlock", async () => {
    const snapshotId = await snapshotAndDelete("bm-b");

    const result = await withUndoLock(async () => {
      // A nested acquisition from the same context must run inside the hold
      // instead of queueing behind it forever.
      return undoExpected(snapshotId);
    });

    expectOk(result);
    expect(await peekLatest()).toBeUndefined();
  });

  it("serializes two same-context callers, even while the first is awaiting", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = withUndoLock(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = withUndoLock(async () => {
      order.push("second");
    });

    await flush();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("excludes an independent context's hold — holders never overlap", async () => {
    const locks = requireLocks();
    const other = await importFreshLock();

    let active = 0;
    let maxActive = 0;
    const body = async (tag: string): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await flush();
      active -= 1;
      return tag;
    };

    const results = await Promise.all([
      withUndoLock(() => body("here")),
      other.withUndoLock(() => body("there")),
    ]);

    expect([...results].sort()).toEqual(["here", "there"]);
    expect(maxActive).toBe(1);
    expect(locks.inspect().maxHolders).toBe(1);
  });

  it("releases the lock when the body throws", async () => {
    const locks = requireLocks();

    await expect(
      withUndoLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(locks.inspect().held).toEqual([]);
    await expect(withUndoLock(async () => "after")).resolves.toBe("after");
  });
});

// ---------------------------------------------------------------------------
// undoExpected — atomic targeted replay
// ---------------------------------------------------------------------------

describe("undoExpected", () => {
  it("replays the checked head and pops exactly that row", async () => {
    const snapshotId = await snapshotAndDelete("bm-b");

    const result = expectOk(await undoExpected(snapshotId));

    expect(Object.keys(result.idMap)).toEqual(["bm-b"]);
    expect(
      (await getChildren(BOOKMARKS_BAR_ID)).filter(
        (node) => node.url === "https://b.example/",
      ),
    ).toHaveLength(1);
    expect(await peekLatest()).toBeUndefined();
  });

  it("refuses with conflict when the expected snapshot is not the head", async () => {
    const older = await snapshotAndDelete("bm-b");
    const head = await snapshotAndDelete("bm-c");

    const result = await undoExpected(older);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    // Zero mutations: both rows survive and neither bookmark came back.
    expect((await peekLatest())?.id).toBe(head);
    expect(await db.undo.get(older)).toBeDefined();
    await expect(get("bm-b")).rejects.toThrow();
    await expect(get("bm-c")).rejects.toThrow();
  });

  it("never pops a head it did not check: a snapshot pushed mid-replay survives", async () => {
    const snapshotId = await snapshotAndDelete("bm-b");
    const decoy = await captureSubtree("bm-c");
    if (decoy === undefined) throw new Error("missing fixture node bm-c");

    // Pause the FIRST stack read of the targeted replay; another context
    // pushes an unrelated snapshot while the replay is in flight.
    const read = gateFirstStackRead();

    const replaying = undoExpected(snapshotId);
    await vi.waitFor(() => expect(read.delayed()).toBe(true));
    await pushSnapshot({ kind: "delete", nodes: [decoy.node], meta: [] });
    await removeTree("bm-c");
    read.release();

    expectOk(await replaying);
    // The replayed snapshot is the CHECKED one — the decoy is untouched …
    expect((await peekLatest())?.nodes.map((node) => node.id)).toEqual(["bm-c"]);
    await expect(get("bm-c")).rejects.toThrow();
    // … and the target restored exactly once.
    expect(
      (await getChildren(BOOKMARKS_BAR_ID)).filter(
        (node) => node.url === "https://b.example/",
      ),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// WebLocksFake — the serialization contract every test above relies on
// ---------------------------------------------------------------------------

describe("WebLocksFake contract", () => {
  it("grants exclusive requests one at a time, in FIFO order", async () => {
    const locks = requireLocks();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = locks.request("demo", { mode: "exclusive" }, async () => {
      order.push("first");
      await gate;
    });
    const second = locks.request("demo", { mode: "exclusive" }, () => {
      order.push("second");
    });

    await flush();
    expect(order).toEqual(["first"]);
    expect(locks.inspect()).toMatchObject({ grants: 1, maxHolders: 1 });

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(locks.inspect().held).toEqual([]);
  });

  it("hands an opportunistic request null while the lock is held", async () => {
    const locks = requireLocks();
    let release!: () => void;
    const holder = locks.request(
      "demo",
      { mode: "exclusive" },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await vi.waitFor(() => expect(locks.inspect().held).toHaveLength(1));

    await expect(
      locks.request("demo", { mode: "exclusive", ifAvailable: true }, (lock) => lock === null),
    ).resolves.toBe(true);

    release();
    await holder;
    await expect(
      locks.request("demo", { mode: "exclusive", ifAvailable: true }, (lock) => lock !== null),
    ).resolves.toBe(true);
  });

  it("rejects a queued request whose signal aborts", async () => {
    const locks = requireLocks();
    let release!: () => void;
    const holder = locks.request(
      "demo",
      { mode: "exclusive" },
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await vi.waitFor(() => expect(locks.inspect().held).toHaveLength(1));

    const controller = new AbortController();
    const pending = locks.request(
      "demo",
      { mode: "exclusive", signal: controller.signal },
      () => "never",
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(locks.inspect().pending).toEqual([]);

    release();
    await holder;
  });

  it("refuses to pretend it can steal a held lock", () => {
    expect(() =>
      requireLocks().request(
        "demo",
        { mode: "exclusive", steal: true },
        () => undefined,
      ),
    ).toThrowError(/steal/);
  });
});
