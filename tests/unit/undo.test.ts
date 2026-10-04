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
import {
  createTag,
  deleteMetaByIds,
  deleteTag,
  getMeta,
  getMetaByIds,
  getTag,
  putMeta,
} from "../../src/db/meta";
import type { UndoSnapshot } from "../../src/schemas/undo";
import {
  BOOKMARKS_BAR_ID,
  OTHER_BOOKMARKS_ID,
  get,
  getChildren,
  getSubTree,
} from "../../src/sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { moveNode, removeTree } from "../../src/sync/mutations";
import {
  captureNodes,
  captureSubtree,
  listSnapshots,
  peekLatest,
  pushSnapshot,
  UNDO_STACK_LIMIT,
} from "../../src/undo/snapshot";
import { discardLatest, undoExpected, undoLatest } from "../../src/undo/restore";
import type { UndoResult, UndoSuccess } from "../../src/undo/restore";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Seeded tree for every test:
 *
 * ```
 * 0 root
 * ├─ 1 Bookmarks bar
 * │  ├─ folder-a            folder
 * │  │  ├─ bm-a1            https://a1.example/
 * │  │  └─ sub-a            folder
 * │  │     └─ bm-a2         https://a2.example/
 * │  ├─ bm-b                https://b.example/
 * │  ├─ bm-c                https://c.example/
 * │  ├─ bm-k                https://k.example/   (merge "keep" target)
 * │  ├─ bm-l1               https://l1.example/  (merge loser)
 * │  └─ bm-l2               https://l2.example/  (merge loser)
 * ├─ 2 Other bookmarks
 * │  ├─ folder-x            folder
 * │  │  └─ bm-x1            https://x1.example/
 * │  └─ managed             folder, unmodifiable: "managed"
 * │     └─ managed-leaf     https://ml.example/
 * └─ 3 Mobile bookmarks
 * ```
 */
let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

async function resetEnv() {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fake = installBookmarksFake({
    bookmarksBar: [
      {
        id: "folder-a",
        title: "Folder A",
        children: [
          { id: "bm-a1", title: "A1", url: "https://a1.example/" },
          {
            id: "sub-a",
            title: "Sub A",
            children: [
              { id: "bm-a2", title: "A2", url: "https://a2.example/" },
            ],
          },
        ],
      },
      { id: "bm-b", title: "B", url: "https://b.example/" },
      { id: "bm-c", title: "C", url: "https://c.example/" },
      { id: "bm-k", title: "K", url: "https://k.example/" },
      { id: "bm-l1", title: "L1", url: "https://l1.example/" },
      { id: "bm-l2", title: "L2", url: "https://l2.example/" },
    ],
    otherBookmarks: [
      {
        id: "folder-x",
        title: "Folder X",
        children: [{ id: "bm-x1", title: "X1", url: "https://x1.example/" }],
      },
      {
        id: "managed",
        title: "Policy",
        unmodifiable: "managed",
        children: [
          { id: "managed-leaf", title: "ML", url: "https://ml.example/" },
        ],
      },
    ],
  });
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
}

beforeEach(resetEnv);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/** Narrow the result union to its success arm (fails the test otherwise). */
function expectOk(result: UndoResult): UndoSuccess {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`undo failed: ${result.message}`);
  return result;
}

/**
 * The meta cascade on removal is the onRemoved listener's job; tests don't
 * register listeners, so deleted nodes' meta rows are dropped explicitly to
 * match production state.
 */
async function removeWithCascade(id: string): Promise<void> {
  const ids = await subtreeIds(id);
  await removeTree(id);
  await deleteMetaByIds(ids);
}

async function subtreeIds(id: string): Promise<string[]> {
  const [root] = await getSubTree(id);
  const ids: string[] = [];
  const walk = (node: BookmarksTreeNode): void => {
    ids.push(node.id);
    for (const child of node.children ?? []) walk(child);
  };
  if (root !== undefined) walk(root);
  return ids;
}

function leafSnapshotNode(
  id: string,
  parentId: string,
  index: number,
): UndoSnapshot["nodes"][number] {
  return {
    id,
    parentId,
    index,
    title: `title-${id}`,
    url: `https://snap-${id}.example/`,
  };
}

// ---------------------------------------------------------------------------
// captureSubtree
// ---------------------------------------------------------------------------

describe("captureSubtree", () => {
  it("captures a leaf bookmark's parent, index, title, and url", async () => {
    const capture = await captureSubtree("bm-b");
    expect(capture).toBeDefined();
    expect(capture?.node).toEqual({
      id: "bm-b",
      parentId: BOOKMARKS_BAR_ID,
      index: 1,
      title: "B",
      url: "https://b.example/",
    });
    expect(capture?.meta).toEqual([]);
  });

  it("captures a folder's whole subtree recursively with its meta rows", async () => {
    await putMeta("bm-a1", { tags: ["TS"] });
    await putMeta("bm-a2", { notes: "deep note" });
    const capture = await captureSubtree("folder-a");
    expect(capture?.node).toEqual({
      id: "folder-a",
      parentId: BOOKMARKS_BAR_ID,
      index: 0,
      title: "Folder A",
      children: [
        {
          id: "bm-a1",
          parentId: "folder-a",
          index: 0,
          title: "A1",
          url: "https://a1.example/",
        },
        {
          id: "sub-a",
          parentId: "folder-a",
          index: 1,
          title: "Sub A",
          children: [
            {
              id: "bm-a2",
              parentId: "sub-a",
              index: 0,
              title: "A2",
              url: "https://a2.example/",
            },
          ],
        },
      ],
    });
    expect(capture?.meta.map((m) => m.id).sort()).toEqual(["bm-a1", "bm-a2"]);
    expect(capture?.meta.find((m) => m.id === "bm-a1")).toMatchObject({
      tags: ["ts"],
    });
  });

  it("returns undefined for an unknown node", async () => {
    expect(await captureSubtree("no-such-node")).toBeUndefined();
  });

  it("returns undefined for every fixed root — a snapshot of a root could never be restored", async () => {
    // "0" has no parentId/index (already excluded); "1"–"3" DO have them,
    // so without the guard they would produce snapshots whose restore can
    // only ever fail `root` — wedging the stack head.
    for (const id of ["0", "1", "2", "3"]) {
      expect(await captureSubtree(id)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// captureNodes
// ---------------------------------------------------------------------------

describe("captureNodes", () => {
  it("records each node's original parent+index so a move can be reversed", async () => {
    await putMeta("bm-b", { tags: ["b-tag"] });
    const capture = await captureNodes(["bm-c", "bm-b", "bm-c"]);
    // Input order kept; duplicate ids collapse to one node.
    expect(capture.nodes).toEqual([
      {
        id: "bm-c",
        parentId: BOOKMARKS_BAR_ID,
        index: 2,
        title: "C",
        url: "https://c.example/",
      },
      {
        id: "bm-b",
        parentId: BOOKMARKS_BAR_ID,
        index: 1,
        title: "B",
        url: "https://b.example/",
      },
    ]);
    expect(capture.meta.map((m) => m.id)).toEqual(["bm-b"]);
  });

  it("skips ids that no longer exist", async () => {
    const capture = await captureNodes(["bm-b", "ghost"]);
    expect(capture.nodes.map((n) => n.id)).toEqual(["bm-b"]);
  });

  it("skips fixed roots — moving a root can never be replayed", async () => {
    const capture = await captureNodes([
      BOOKMARKS_BAR_ID,
      "bm-b",
      OTHER_BOOKMARKS_ID,
      "0",
    ]);
    expect(capture.nodes.map((n) => n.id)).toEqual(["bm-b"]);
  });
});

// ---------------------------------------------------------------------------
// pushSnapshot / listSnapshots / peekLatest
// ---------------------------------------------------------------------------

describe("pushSnapshot", () => {
  it("assigns an incrementing id, stamps createdAt, and never mutates the input", async () => {
    const input = Object.freeze({
      kind: "delete" as const,
      nodes: Object.freeze([leafSnapshotNode("n1", "1", 0)]),
      meta: Object.freeze([]),
    });
    const id = await pushSnapshot(input);
    expect(typeof id).toBe("number");
    // The Dexie generated-key write-back must not reach the caller's object.
    expect("id" in input).toBe(false);
    const stored = await db.undo.get(id);
    expect(stored).toMatchObject({ id, kind: "delete" });
    expect(Number.isNaN(Date.parse(stored?.createdAt ?? ""))).toBe(false);
  });

  it("honours a caller-supplied createdAt", async () => {
    const id = await pushSnapshot({
      kind: "delete",
      nodes: [],
      meta: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await db.undo.get(id))?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it(`caps the stack at ${UNDO_STACK_LIMIT} snapshots, dropping the oldest`, async () => {
    for (let i = 0; i < UNDO_STACK_LIMIT + 2; i++) {
      await pushSnapshot({
        kind: "delete",
        nodes: [leafSnapshotNode(`n-${i}`, "1", 0)],
        meta: [],
      });
    }
    expect(await db.undo.count()).toBe(UNDO_STACK_LIMIT);
    const snapshots = await listSnapshots();
    expect(snapshots).toHaveLength(UNDO_STACK_LIMIT);
    const remaining = new Set(snapshots.map((s) => s.nodes[0]?.id));
    expect(remaining.has("n-0")).toBe(false);
    expect(remaining.has("n-1")).toBe(false);
    expect(remaining.has(`n-${UNDO_STACK_LIMIT + 1}`)).toBe(true);
  });
});

describe("listSnapshots / peekLatest", () => {
  it("lists snapshots newest-first and peeks the latest", async () => {
    await pushSnapshot({
      kind: "delete",
      nodes: [leafSnapshotNode("first", "1", 0)],
      meta: [],
    });
    await pushSnapshot({
      kind: "delete",
      nodes: [leafSnapshotNode("second", "1", 1)],
      meta: [],
    });
    const snapshots = await listSnapshots();
    expect(snapshots.map((s) => s.nodes[0]?.id)).toEqual(["second", "first"]);
    expect((await peekLatest())?.nodes[0]?.id).toBe("second");
  });

  it("returns undefined on an empty stack", async () => {
    expect(await peekLatest()).toBeUndefined();
    expect(await listSnapshots()).toEqual([]);
  });

  it("treats corrupt stored rows as absent", async () => {
    await pushSnapshot({
      kind: "delete",
      nodes: [leafSnapshotNode("valid", "1", 0)],
      meta: [],
    });
    await db.undo.add({ bogus: true } as unknown as UndoSnapshot);
    expect((await peekLatest())?.nodes[0]?.id).toBe("valid");
    expect(await listSnapshots()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// undoLatest — delete
// ---------------------------------------------------------------------------

describe("undoLatest — delete", () => {
  it("preserves summary metadata on a recreated ID", async () => {
    for (const fields of [
      { tags: [], summary: "Verified summary only." },
      { tags: ["docs"], category: "paper" as const, notes: "Saved notes.", summary: "Verified with notes." },
    ]) {
    await resetEnv();
    await putMeta("bm-b", fields);
    await putMeta("bm-c", { tags: ["untouched"], summary: "Unrelated summary." });
    const unrelated = await getMeta("bm-c");
    const captured = await captureNodes(["bm-b"]);
    await pushSnapshot({ kind: "delete", ...captured });
    await removeWithCascade("bm-b");

    const result = expectOk(await undoLatest());
    const newId = result.idMap["bm-b"];
    expect(newId).toBeDefined();
    expect(newId).not.toBe("bm-b");
    expect(await getMeta(newId!)).toMatchObject(fields);
    expect(await getMeta("bm-b")).toBeUndefined();
    expect(await getMeta("bm-c")).toEqual(unrelated);
    }
  });

  it("re-creates a deleted leaf at its original parent+index and remaps its meta", async () => {
    await putMeta("bm-b", { tags: ["docs"], notes: "keep me" });
    const capture = await captureSubtree("bm-b");
    const rowId = await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: capture!.meta,
    });
    await removeWithCascade("bm-b");
    expect(await getMeta("bm-b")).toBeUndefined();

    const result = expectOk(await undoLatest());
    const newId = result.idMap["bm-b"];
    expect(newId).toBeDefined();
    expect(newId).not.toBe("bm-b");
    expect(result.restoredIds).toEqual([newId]);
    expect(result.fellBackToOther).toBe(false);

    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar.map((n) => n.id)).toEqual([
      "folder-a",
      newId,
      "bm-c",
      "bm-k",
      "bm-l1",
      "bm-l2",
    ]);
    const [restored] = await get(newId as string);
    expect(restored).toMatchObject({
      title: "B",
      url: "https://b.example/",
      parentId: BOOKMARKS_BAR_ID,
      index: 1,
    });
    // Metadata is rewritten under the NEW Chrome id.
    expect(await getMeta(newId as string)).toMatchObject({
      tags: ["docs"],
      notes: "keep me",
    });
    // Pop-on-success: the consumed row is gone.
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("re-creates a whole folder subtree and remaps every meta row", async () => {
    await putMeta("bm-a1", { tags: ["ts"] });
    await putMeta("bm-a2", { notes: "nested note" });
    const capture = await captureSubtree("folder-a");
    await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: capture!.meta,
    });
    await removeWithCascade("folder-a");

    const result = expectOk(await undoLatest());
    const newFolder = result.idMap["folder-a"];
    const newA1 = result.idMap["bm-a1"];
    const newSub = result.idMap["sub-a"];
    const newA2 = result.idMap["bm-a2"];
    expect(newFolder).toBeDefined();
    expect(newA1).toBeDefined();
    expect(newSub).toBeDefined();
    expect(newA2).toBeDefined();
    expect(result.restoredIds).toHaveLength(4);

    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar[0]?.id).toBe(newFolder);
    const kids = await getChildren(newFolder as string);
    expect(kids.map((n) => n.id)).toEqual([newA1, newSub]);
    expect((await getChildren(newSub as string)).map((n) => n.id)).toEqual([
      newA2,
    ]);
    expect((await get(newA1 as string))[0]).toMatchObject({
      title: "A1",
      url: "https://a1.example/",
    });
    expect(await getMeta(newA1 as string)).toMatchObject({ tags: ["ts"] });
    expect(await getMeta(newA2 as string)).toMatchObject({
      notes: "nested note",
    });
  });

  it("clamps the restore index when the parent has shrunk", async () => {
    const capture = await captureSubtree("bm-l2"); // original index 5
    await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: [],
    });
    // The parent shrinks below the recorded index before the undo.
    await removeTree("bm-l2");
    await removeTree("bm-l1");
    await removeTree("bm-k");
    const result = expectOk(await undoLatest());
    const newId = result.idMap["bm-l2"];
    const bar = await getChildren(BOOKMARKS_BAR_ID);
    // Index 5 clamped to the shrunken parent's end.
    expect(bar.map((n) => n.id)).toEqual([
      "folder-a",
      "bm-b",
      "bm-c",
      newId,
    ]);
  });

  it("restores snapshots newest-first (LIFO)", async () => {
    const b = await captureSubtree("bm-b");
    await pushSnapshot({ kind: "delete", nodes: [b!.node], meta: [] });
    const c = await captureSubtree("bm-c");
    await pushSnapshot({ kind: "delete", nodes: [c!.node], meta: [] });
    await removeTree("bm-b");
    await removeTree("bm-c");

    const first = expectOk(await undoLatest());
    expect((await get(first.restoredIds[0] as string))[0]?.title).toBe("C");
    const second = expectOk(await undoLatest());
    expect((await get(second.restoredIds[0] as string))[0]?.title).toBe("B");
    expect(await undoLatest()).toMatchObject({ ok: false, code: "empty" });
  });

  it("restores into Other bookmarks and reports the fallback when the original parent is gone", async () => {
    const capture = await captureSubtree("bm-x1"); // parent: folder-x
    await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: [],
    });
    await removeTree("folder-x"); // takes bm-x1 with it
    const result = expectOk(await undoLatest());
    expect(result.fellBackToOther).toBe(true);
    const newId = result.idMap["bm-x1"];
    const [restored] = await get(newId as string);
    expect(restored?.parentId).toBe(OTHER_BOOKMARKS_ID);
    const other = await getChildren(OTHER_BOOKMARKS_ID);
    expect(other.some((n) => n.id === newId)).toBe(true);
  });

  it("fails typed when the original parent is now managed, and keeps the snapshot", async () => {
    // A snapshot whose recorded parent turned managed since the delete —
    // built by hand because a managed node's children can't be deleted for
    // a live capture.
    await pushSnapshot({
      kind: "delete",
      nodes: [leafSnapshotNode("ghost", "managed", 0)],
      meta: [],
    });
    const result = await undoLatest();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("managed");
    // A failed restore keeps the row for a later attempt.
    expect(await listSnapshots()).toHaveLength(1);
  });

  it("keeps the snapshot when the restore rejects, then succeeds on retry", async () => {
    const capture = await captureSubtree("bm-b");
    await pushSnapshot({ kind: "delete", nodes: [capture!.node], meta: [] });
    await removeTree("bm-b");
    const spy = vi
      .spyOn(fake, "create")
      .mockRejectedValue(new Error("chrome boom"));
    const failed = await undoLatest();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("api");
    expect(await peekLatest()).toBeDefined();
    spy.mockRestore();
    const retried = expectOk(await undoLatest());
    expect(retried.idMap["bm-b"]).toBeDefined();
    expect(await peekLatest()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// undoLatest — idempotent / resumable restore
// ---------------------------------------------------------------------------

describe("undoLatest — idempotent restore", () => {
  it("does not recreate a top-level node whose original id still resolves", async () => {
    // A snapshot pushed by a mutation that then failed BEFORE removing
    // anything (e.g. a merge whose patchMeta threw) still sits on the stack.
    // Chrome never reuses ids, so a live original id means "never deleted" —
    // replaying the row must be a no-op for that node, not a duplicate.
    const capture = await captureSubtree("bm-b");
    await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: capture!.meta,
    });
    // NB: bm-b is NOT removed — the mutation never happened.

    const result = expectOk(await undoLatest());
    expect(result.idMap).toEqual({});
    expect(result.restoredIds).toEqual([]);
    // Exactly one bm-b, untouched at its original slot.
    expect((await getChildren(BOOKMARKS_BAR_ID)).map((n) => n.id)).toEqual([
      "folder-a",
      "bm-b",
      "bm-c",
      "bm-k",
      "bm-l1",
      "bm-l2",
    ]);
    expect(await peekLatest()).toBeUndefined(); // still pops on success
  });

  it("resumes a partially-failed restore instead of replaying it", async () => {
    const b = await captureSubtree("bm-b");
    const c = await captureSubtree("bm-c");
    await pushSnapshot({
      kind: "delete",
      nodes: [b!.node, c!.node],
      meta: [],
    });
    await removeTree("bm-b");
    await removeTree("bm-c");

    // First attempt: bm-b is recreated, then the second create fails.
    const origCreate = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "C"
        ? Promise.reject(new Error("chrome boom"))
        : origCreate(details),
    );
    const failed = await undoLatest();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("api");

    // The kept row carries its progress: bm-b's old→new id mapping survived.
    const kept = await peekLatest();
    expect(kept?.idMap?.["bm-b"]).toBeDefined();
    vi.restoreAllMocks();

    const retried = expectOk(await undoLatest());
    const newB = retried.idMap["bm-b"];
    const newC = retried.idMap["bm-c"];
    expect(newB).toBeDefined();
    expect(newC).toBeDefined();
    // bm-b was NOT recreated a second time — the resume skipped it.
    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar.map((n) => n.id)).toEqual([
      "folder-a",
      newB,
      newC,
      "bm-k",
      "bm-l1",
      "bm-l2",
    ]);
    expect(bar.filter((n) => n.title === "B")).toHaveLength(1);
    expect(await peekLatest()).toBeUndefined();
  });

  it("serializes concurrent calls: one replays, the other reports empty — no double replay", async () => {
    const capture = await captureSubtree("bm-b");
    await pushSnapshot({ kind: "delete", nodes: [capture!.node], meta: [] });
    await removeTree("bm-b");
    const spy = vi.spyOn(fake, "create");

    const results = await Promise.all([undoLatest(), undoLatest()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && r.code === "empty"),
    ).toHaveLength(1);
    // The snapshot was replayed exactly once — no duplicate bookmark.
    expect(spy).toHaveBeenCalledTimes(1);
    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar.filter((n) => n.title === "B")).toHaveLength(1);
    expect(await peekLatest()).toBeUndefined();
  });

  it("returns a typed failure instead of throwing when the stack read fails", async () => {
    vi.spyOn(db.undo, "toArray").mockRejectedValue(new Error("idb boom"));
    await expect(undoLatest()).resolves.toMatchObject({
      ok: false,
      code: "api",
      message: expect.stringContaining("idb boom"),
    });
  });

  it("returns a typed failure when the pop fails after a successful restore", async () => {
    const capture = await captureSubtree("bm-b");
    await pushSnapshot({ kind: "delete", nodes: [capture!.node], meta: [] });
    await removeTree("bm-b");
    vi.spyOn(db.undo, "delete").mockRejectedValue(new Error("idb boom"));

    const result = await undoLatest();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("api");
    // The snapshot row survives for a later attempt (which will skip the
    // already-restored node via the persisted idMap).
    const kept = await peekLatest();
    expect(kept).toBeDefined();
    expect(kept?.idMap?.["bm-b"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// undoLatest — bulk_move
// ---------------------------------------------------------------------------

describe("undoLatest — bulk_move", () => {
  it("moves nodes back to their snapshot parent+index in ascending index order", async () => {
    const capture = await captureNodes(["bm-b", "bm-c"]);
    await pushSnapshot({
      kind: "bulk_move",
      nodes: capture.nodes,
      meta: capture.meta,
    });
    await moveNode("bm-b", { parentId: "folder-x" });
    await moveNode("bm-c", { parentId: "folder-x" });
    expect((await getChildren("folder-x")).map((n) => n.id)).toEqual([
      "bm-x1",
      "bm-b",
      "bm-c",
    ]);

    const result = expectOk(await undoLatest());
    expect(result.fellBackToOther).toBe(false);
    expect(result.idMap).toEqual({}); // moves keep Chrome ids — nothing remapped
    expect(result.restoredIds).toEqual(["bm-b", "bm-c"]);
    expect((await getChildren(BOOKMARKS_BAR_ID)).map((n) => n.id)).toEqual([
      "folder-a",
      "bm-b",
      "bm-c",
      "bm-k",
      "bm-l1",
      "bm-l2",
    ]);
  });

  it("moves into Other bookmarks when the recorded parent is gone", async () => {
    const capture = await captureNodes(["bm-x1"]);
    await pushSnapshot({
      kind: "bulk_move",
      nodes: capture.nodes,
      meta: [],
    });
    await moveNode("bm-x1", { parentId: BOOKMARKS_BAR_ID });
    await removeTree("folder-x");
    const result = expectOk(await undoLatest());
    expect(result.fellBackToOther).toBe(true);
    expect((await get("bm-x1"))[0]?.parentId).toBe(OTHER_BOOKMARKS_ID);
  });

  it("skips moved nodes that no longer exist instead of failing", async () => {
    const capture = await captureNodes(["bm-b"]);
    await pushSnapshot({ kind: "bulk_move", nodes: capture.nodes, meta: [] });
    await moveNode("bm-b", { parentId: "folder-x" });
    await removeTree("bm-b");
    const result = expectOk(await undoLatest());
    expect(result.restoredIds).toEqual([]);
  });

  it("does not rewrite metadata when undoing a move", async () => {
    await putMeta("bm-b", { tags: ["before"] });
    const capture = await captureNodes(["bm-b"]);
    await pushSnapshot({
      kind: "bulk_move",
      nodes: capture.nodes,
      meta: capture.meta,
    });
    await moveNode("bm-b", { parentId: "folder-x" });
    await putMeta("bm-b", { tags: ["after"] });
    expectOk(await undoLatest());
    expect(await getMeta("bm-b")).toMatchObject({ tags: ["after"] });
  });
});

// ---------------------------------------------------------------------------
// undoLatest — restructure
// ---------------------------------------------------------------------------

describe("undoLatest — restructure", () => {
  it("retains the snapshot without cloning a live bookmark when its original-id lookup fails once", async () => {
    const capture = await captureNodes(["bm-b"]);
    const rowId = await pushSnapshot({ kind: "restructure", ...capture });
    await moveNode("bm-b", { parentId: "folder-x" });
    const before = await fake.getTree();
    const originalGet = fake.get.bind(fake);
    let failLookup = true;
    vi.spyOn(fake, "get").mockImplementation(async (id) => {
      if (id === "bm-b" && failLookup) {
        failLookup = false;
        throw new Error("controlled original-id lookup failure");
      }
      return originalGet(id);
    });

    expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
    expect(await fake.getTree()).toEqual(before); // no new bookmark or move
    expect((await get("bm-b"))[0]?.parentId).toBe("folder-x");
    expect(await db.undo.get(rowId)).toMatchObject({ id: rowId });
    expect((await db.undo.get(rowId))?.idMap).toBeUndefined();

    const retried = expectOk(await undoLatest());
    expect(retried.idMap).toEqual({});
    expect(retried.restoredIds).toEqual(["bm-b"]);
    expect((await get("bm-b"))[0]).toMatchObject({ parentId: "1", index: 1 });
    expect((await getChildren("1")).filter((node) => node.title === "B")).toHaveLength(1);
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("keeps a live persisted remap when its lookup fails once instead of recreating it", async () => {
    await putMeta("bm-b", { tags: ["docs"], notes: "captured note" });
    const capture = await captureNodes(["bm-b"]);
    const rowId = await pushSnapshot({ kind: "restructure", ...capture });
    await removeWithCascade("bm-b");
    vi.spyOn(db.bookmarkMeta, "put").mockRejectedValue(new Error("controlled metadata failure"));
    expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
    const kept = await db.undo.get(rowId);
    const mappedId = kept?.idMap?.["bm-b"];
    expect(mappedId).toBeDefined();
    vi.restoreAllMocks();

    const before = await fake.getTree();
    const originalGet = fake.get.bind(fake);
    let failLookup = true;
    vi.spyOn(fake, "get").mockImplementation(async (id) => {
      if (id === mappedId && failLookup) {
        failLookup = false;
        throw new Error("controlled remapped-id lookup failure");
      }
      return originalGet(id);
    });

    expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
    expect(await fake.getTree()).toEqual(before); // no duplicate native node
    expect((await db.undo.get(rowId))?.idMap).toEqual(kept?.idMap);
    expect((await get(mappedId!))[0]?.title).toBe("B");

    const retried = expectOk(await undoLatest());
    expect(retried.idMap["bm-b"]).toBe(mappedId);
    expect((await getChildren("1")).filter((node) => node.title === "B")).toHaveLength(1);
    expect(await getMeta(mappedId!)).toMatchObject({ tags: ["docs"], notes: "captured note" });
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("does not fall back or create a bookmark when its recorded parent lookup fails once", async () => {
    const capture = await captureNodes(["bm-b"]);
    const rowId = await pushSnapshot({ kind: "restructure", ...capture });
    await removeWithCascade("bm-b");
    const before = await fake.getTree();
    const originalGet = fake.get.bind(fake);
    let failLookup = true;
    vi.spyOn(fake, "get").mockImplementation(async (id) => {
      if (id === "1" && failLookup) {
        failLookup = false;
        throw new Error("controlled parent lookup failure");
      }
      return originalGet(id);
    });

    expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
    expect(await fake.getTree()).toEqual(before);
    expect(await db.undo.get(rowId)).toBeDefined();
    const retried = expectOk(await undoLatest());
    expect(retried.fellBackToOther).toBe(false);
    expect((await get(retried.idMap["bm-b"]!))[0]?.parentId).toBe("1");
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("retains the snapshot when a created-folder lookup fails once during cleanup", async () => {
    const folder = await fake.create({ parentId: "1", title: "Created" });
    const rowId = await pushSnapshot({
      kind: "restructure", nodes: [], meta: [], createdFolderIds: [folder.id],
    });
    const originalGet = fake.get.bind(fake);
    let failLookup = true;
    vi.spyOn(fake, "get").mockImplementation(async (id) => {
      if (id === folder.id && failLookup) {
        failLookup = false;
        throw new Error("controlled created-folder lookup failure");
      }
      return originalGet(id);
    });

    expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
    expect((await get(folder.id))[0]?.title).toBe("Created");
    expect(await db.undo.get(rowId)).toBeDefined();
    expectOk(await undoLatest());
    expect((await getChildren("1")).some((node) => node.id === folder.id)).toBe(false);
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("restores metadata on recreated ids without overwriting surviving nodes' later edits", async () => {
    await putMeta("bm-b", {
      tags: ["captured"], category: "docs", notes: "captured note",
      summary: "Captured public page summary.",
    });
    await putMeta("bm-c", { tags: ["before"], notes: "before" });
    const capture = await captureNodes(["bm-b", "bm-c"]);
    await pushSnapshot({ kind: "restructure", ...capture });
    await moveNode("bm-b", { parentId: "folder-x" });
    await moveNode("bm-c", { parentId: "folder-x" });
    await removeWithCascade("bm-b");
    const laterMeta = await putMeta("bm-c", {
      tags: ["later"], category: "course", notes: "later edit",
      summary: "Later public page summary.",
    });

    const result = expectOk(await undoLatest());
    const newB = result.idMap["bm-b"];
    expect(newB).toBeDefined();
    expect((await get(newB!))[0]).toMatchObject({
      title: "B", url: "https://b.example/", parentId: "1", index: 1,
    });
    expect(await getMeta(newB!)).toMatchObject({
      tags: ["captured"], category: "docs", notes: "captured note",
      summary: "Captured public page summary.",
    });
    expect((await get("bm-c"))[0]).toMatchObject({ parentId: "1", index: 2 });
    expect(await getMeta("bm-c")).toEqual(laterMeta);
    expect(await peekLatest()).toBeUndefined();
  });

  it("resumes partial recreation from a durable idMap with or without a mapped node deleted before retry", async () => {
    for (const deleteMappedNode of [false, true]) {
      await resetEnv();
      await putMeta("bm-b", { tags: ["b"], notes: "B note" });
      await putMeta("bm-c", { category: "docs" });
      const capture = await captureNodes(["bm-b", "bm-c"]);
      const rowId = await pushSnapshot({ kind: "restructure", ...capture });
      await removeWithCascade("bm-b");
      await removeWithCascade("bm-c");
      const originalCreate = fake.create.bind(fake);
      vi.spyOn(fake, "create").mockImplementation(async (details) => {
        if (details.title === "C") throw new Error("controlled second create failure");
        return originalCreate(details);
      });

      expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
      const kept = await db.undo.get(rowId);
      const firstB = kept?.idMap?.["bm-b"];
      expect(firstB).toBeDefined();
      expect((await get(firstB!))[0]?.title).toBe("B");
      expect(kept?.idMap?.["bm-c"]).toBeUndefined();
      vi.restoreAllMocks();
      if (deleteMappedNode) await removeWithCascade(firstB!);

      const retried = expectOk(await undoLatest());
      const newB = retried.idMap["bm-b"];
      const newC = retried.idMap["bm-c"];
      expect(newB).toBeDefined();
      expect(newC).toBeDefined();
      if (deleteMappedNode) expect(newB).not.toBe(firstB);
      else expect(newB).toBe(firstB);
      expect((await getChildren("1")).map((node) => node.id)).toEqual([
        "folder-a", newB, newC, "bm-k", "bm-l1", "bm-l2",
      ]);
      expect((await getChildren("1")).filter((node) => node.title === "B")).toHaveLength(1);
      expect(await getMeta(newB!)).toMatchObject({ tags: ["b"], notes: "B note" });
      expect(await getMeta(newC!)).toMatchObject({ category: "docs" });
      expect(await db.undo.get(rowId)).toBeUndefined();
    }
  });

  it("retries a recreated-node metadata failure without duplicating bookmarks", async () => {
    await putMeta("bm-b", { tags: ["docs"], notes: "saved note" });
    const capture = await captureNodes(["bm-b"]);
    const rowId = await pushSnapshot({ kind: "restructure", ...capture });
    await removeWithCascade("bm-b");
    vi.spyOn(db.bookmarkMeta, "put").mockRejectedValue(new Error("controlled metadata failure"));

    expect(await undoLatest()).toMatchObject({ ok: false, code: "api" });
    const remapped = (await db.undo.get(rowId))?.idMap?.["bm-b"];
    expect(remapped).toBeDefined();
    vi.restoreAllMocks();
    const retried = expectOk(await undoLatest());
    expect(retried.idMap["bm-b"]).toBe(remapped);
    expect((await getChildren("1")).filter((node) => node.title === "B")).toHaveLength(1);
    expect(await getMeta(remapped!)).toMatchObject({ tags: ["docs"], notes: "saved note" });
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("keeps an occupied created folder and the snapshot when its child lookup fails", async () => {
    const capture = await captureNodes(["bm-b"]);
    const rowId = await pushSnapshot({
      kind: "restructure", ...capture, createdFolderIds: ["folder-x"],
    });
    await moveNode("bm-b", { parentId: "folder-x" });
    const originalChildren = fake.getChildren.bind(fake);
    vi.spyOn(fake, "getChildren").mockImplementation(async (id) => {
      if (id === "folder-x") throw new Error("controlled child lookup failure");
      return originalChildren(id);
    });

    const result = await undoLatest();
    await expect(get(["bm-b", "bm-x1"])).resolves.toMatchObject([
      { id: "bm-b" }, { id: "bm-x1" },
    ]);
    expect((await get("folder-x"))[0]?.title).toBe("Folder X");
    expect(result).toMatchObject({ ok: false, code: "api" });
    expect(await db.undo.get(rowId)).toBeDefined();
    vi.restoreAllMocks();
    expectOk(await undoLatest());
    expect((await getChildren("folder-x")).map((node) => node.id)).toEqual(["bm-x1"]);
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("preserves a racing child at the native non-recursive cleanup boundary", async () => {
    const folder = await fake.create({ parentId: "1", title: "Created" });
    const rowId = await pushSnapshot({
      kind: "restructure", nodes: [], meta: [], createdFolderIds: [folder.id],
    });
    const originalRemove = fake.remove.bind(fake);
    const originalRemoveTree = fake.removeTree.bind(fake);
    let childId = "";
    const insertChild = async (id: string) => {
      childId = (await fake.create({
        parentId: id, title: "Racing child", url: "https://racing.io/",
      })).id;
    };
    vi.spyOn(fake, "remove").mockImplementation(async (id) => {
      await insertChild(id);
      return originalRemove(id);
    });
    vi.spyOn(fake, "removeTree").mockImplementation(async (id) => {
      await insertChild(id);
      return originalRemoveTree(id);
    });

    const result = await undoLatest();
    await expect(get(childId)).resolves.toMatchObject([{ parentId: folder.id }]);
    expect((await get(folder.id))[0]?.title).toBe("Created");
    expect(result).toMatchObject({ ok: false, code: "api" });
    expect(await db.undo.get(rowId)).toBeDefined();
    vi.restoreAllMocks();
    expectOk(await undoLatest());
    expect((await get(childId))[0]?.parentId).toBe(folder.id);
    expect(await db.undo.get(rowId)).toBeUndefined();
  });

  it("never cleans up a fixed root, managed folder, or bookmark recorded as a created folder", async () => {
    for (const id of ["1", "managed", "bm-b"]) {
      await resetEnv();
      await pushSnapshot({
        kind: "restructure", nodes: [], meta: [], createdFolderIds: [id],
      });
      const before = await fake.getTree();
      await undoLatest();
      expect(await fake.getTree()).toEqual(before);
    }
  });

  it("retains the snapshot when a missing bookmark's recorded parent is managed", async () => {
    await pushSnapshot({
      kind: "restructure", nodes: [leafSnapshotNode("gone", "managed", 0)], meta: [],
    });
    const before = await fake.getTree();
    expect(await undoLatest()).toMatchObject({ ok: false, code: "managed" });
    expect(await fake.getTree()).toEqual(before);
    expect(await peekLatest()).toBeDefined();
  });

  it("falls back to Other bookmarks when recreating under a missing original parent", async () => {
    const capture = await captureNodes(["bm-x1"]);
    await pushSnapshot({ kind: "restructure", ...capture });
    await removeWithCascade("folder-x");
    const result = expectOk(await undoLatest());
    expect(result.idMap["bm-x1"]).toBeDefined();
    expect(result.fellBackToOther).toBe(true);
    expect((await get(result.idMap["bm-x1"]!))[0]?.parentId).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// undoLatest — merge
// ---------------------------------------------------------------------------

describe("undoLatest — merge", () => {
  it("restores a surviving target summary alongside remapped loser metadata", async () => {
    for (const fields of [
      { tags: [], summary: "Original summary only." },
      { tags: ["kept"], category: "docs" as const, notes: "Kept notes.", summary: "Original full summary." },
    ]) {
    await resetEnv();
    await putMeta("bm-k", fields);
    await putMeta("bm-l1", { tags: [], summary: "Loser summary." });
    const captured = await captureNodes(["bm-l1"]);
    const kept = await getMeta("bm-k");
    if (kept === undefined) throw new Error("missing fixture metadata");
    await pushSnapshot({ kind: "merge", ...captured, meta: [...captured.meta, kept] });
    await putMeta("bm-k", { tags: ["merged"], notes: "Merged notes.", summary: "Merged summary." });
    await removeWithCascade("bm-l1");

    const result = expectOk(await undoLatest());
    expect(await getMeta("bm-k")).toMatchObject(fields);
    if (!("notes" in fields)) expect((await getMeta("bm-k"))?.notes).toBeUndefined();
    expect((await getMeta(result.idMap["bm-l1"]!))?.summary).toBe("Loser summary.");
    expect(await getMeta("bm-l1")).toBeUndefined();
    }
  });

  it("clears a merge-created summary when the captured target had none", async () => {
    await putMeta("bm-k", { tags: ["original"], notes: "Original notes." });
    const kept = await getMeta("bm-k");
    if (kept === undefined) throw new Error("missing fixture metadata");
    await pushSnapshot({ kind: "merge", nodes: [], meta: [kept] });
    await putMeta("bm-k", { tags: ["merged"], summary: "Later summary." });

    expectOk(await undoLatest());
    expect(await getMeta("bm-k")).toMatchObject({ tags: ["original"], notes: "Original notes." });
    expect((await getMeta("bm-k"))?.summary).toBeUndefined();
  });

  it("re-creates the merged-away bookmarks and restores the kept node's pre-merge meta", async () => {
    await putMeta("bm-k", { tags: ["keep"], notes: "kept notes" });
    await putMeta("bm-l1", { tags: ["l1"] });
    await putMeta("bm-l2", { tags: ["l2"], category: "docs" });
    const l1 = await captureSubtree("bm-l1");
    const l2 = await captureSubtree("bm-l2");
    const keptMeta = await getMeta("bm-k");
    // Merge snapshots carry the losers' nodes plus EVERY touched meta row —
    // the kept node's row is distinguished by its id not appearing in nodes.
    await pushSnapshot({
      kind: "merge",
      nodes: [l1!.node, l2!.node],
      meta: [...l1!.meta, ...l2!.meta, keptMeta!],
    });
    // The merge itself: unioned fields onto the kept node, losers removed.
    await putMeta("bm-k", {
      tags: ["keep", "l1", "l2"],
      notes: "kept notes\n---\nl2 notes",
      category: "docs",
    });
    await removeTree("bm-l1");
    await removeTree("bm-l2");
    await deleteMetaByIds(["bm-l1", "bm-l2"]);

    const result = expectOk(await undoLatest());
    const newL1 = result.idMap["bm-l1"];
    const newL2 = result.idMap["bm-l2"];
    expect(newL1).toBeDefined();
    expect(newL2).toBeDefined();
    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar.map((n) => n.id)).toEqual([
      "folder-a",
      "bm-b",
      "bm-c",
      "bm-k",
      newL1,
      newL2,
    ]);
    expect(await getMeta(newL1 as string)).toMatchObject({ tags: ["l1"] });
    expect(await getMeta(newL2 as string)).toMatchObject({
      tags: ["l2"],
      category: "docs",
    });
    // The kept node's overwritten meta is restored at the SAME id.
    const kept = await getMeta("bm-k");
    expect(kept).toMatchObject({ tags: ["keep"], notes: "kept notes" });
    expect(kept?.category).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// undoLatest — tag_delete
// ---------------------------------------------------------------------------

describe("undoLatest — tag_delete", () => {
  it("re-creates the tag def and re-adds the nameKey to every listed bookmark", async () => {
    await createTag("Reading List", {
      color: "#3178c6",
      description: "long reads",
    });
    await putMeta("bm-b", { tags: ["reading list", "other"], notes: "n" });
    await putMeta("bm-c", { tags: ["reading list"] });
    const tagDef = await getTag("reading list");
    const meta = await getMetaByIds(["bm-b", "bm-c"]);
    await pushSnapshot({ kind: "tag_delete", nodes: [], meta, tagDef });

    const affected = await deleteTag("reading list");
    expect(affected).toBe(2);
    expect(await getTag("reading list")).toBeUndefined();
    // bm-c's only metadata was the tag — the lazy-row rule deleted it.
    expect(await getMeta("bm-c")).toBeUndefined();
    expect(await getMeta("bm-b")).toMatchObject({ tags: ["other"] });

    const result = expectOk(await undoLatest());
    expect(result.fellBackToOther).toBe(false);
    expect(result.restoredIds).toEqual(["bm-b", "bm-c"]);
    expect(await getTag("reading list")).toMatchObject({
      name: "Reading List",
      color: "#3178c6",
    });
    expect(await getMeta("bm-b")).toMatchObject({
      tags: ["reading list", "other"],
      notes: "n",
    });
    expect(await getMeta("bm-c")).toMatchObject({ tags: ["reading list"] });
  });

  it("keeps an already-recreated tag def instead of failing on the collision", async () => {
    await createTag("Reading List");
    await putMeta("bm-b", { tags: ["reading list"] });
    const tagDef = await getTag("reading list");
    await pushSnapshot({
      kind: "tag_delete",
      nodes: [],
      meta: await getMetaByIds(["bm-b"]),
      tagDef,
    });
    await deleteTag("reading list");
    await createTag("Reading List", { color: "#aabbcc" }); // user re-created it
    expectOk(await undoLatest());
    expect(await getTag("reading list")).toMatchObject({ color: "#aabbcc" });
    expect(await getMeta("bm-b")).toMatchObject({ tags: ["reading list"] });
  });

  it("skips meta rows whose bookmark no longer exists", async () => {
    await createTag("Reading List");
    await putMeta("bm-c", { tags: ["reading list"] });
    const tagDef = await getTag("reading list");
    await pushSnapshot({
      kind: "tag_delete",
      nodes: [],
      meta: await getMetaByIds(["bm-c"]),
      tagDef,
    });
    await deleteTag("reading list");
    await removeTree("bm-c");
    const result = expectOk(await undoLatest());
    expect(result.restoredIds).toEqual([]);
    // No orphan meta row is written for a bookmark that is gone.
    expect(await getMeta("bm-c")).toBeUndefined();
    expect(await getTag("reading list")).toBeDefined();
  });

  it("re-adds ONLY the deleted nameKey — tags removed since the delete stay gone", async () => {
    await createTag("Doomed");
    await putMeta("bm-b", { tags: ["doomed", "keep"] });
    const tagDef = await getTag("doomed");
    await pushSnapshot({
      kind: "tag_delete",
      nodes: [],
      meta: await getMetaByIds(["bm-b"]),
      tagDef,
    });
    await deleteTag("doomed");
    // Post-delete the user removed "keep" and added "new" — undo must not
    // resurrect "keep" from the stale snapshot row.
    await putMeta("bm-b", { tags: ["new"] });

    const result = expectOk(await undoLatest());
    expect(result.restoredIds).toEqual(["bm-b"]);
    // "doomed" returns at its recorded position (index 0); "keep" stays gone.
    expect((await getMeta("bm-b"))?.tags).toEqual(["doomed", "new"]);
  });

  it("reports no restored rows when the bookmark already carries the key again", async () => {
    await createTag("T");
    await putMeta("bm-b", { tags: ["t"] });
    const tagDef = await getTag("t");
    await pushSnapshot({
      kind: "tag_delete",
      nodes: [],
      meta: await getMetaByIds(["bm-b"]),
      tagDef,
    });
    await deleteTag("t");
    await putMeta("bm-b", { tags: ["t", "x"] }); // re-added before undo

    const result = expectOk(await undoLatest());
    expect(result.restoredIds).toEqual([]);
    expect((await getMeta("bm-b"))?.tags).toEqual(["t", "x"]);
  });

  it("restores the tag def with its original createdAt", async () => {
    const old = "2020-01-01T00:00:00.000Z";
    await db.tags.put({
      name: "Vintage",
      nameKey: "vintage",
      createdAt: old,
      updatedAt: old,
    });
    const tagDef = await getTag("vintage");
    await putMeta("bm-b", { tags: ["vintage"] });
    await pushSnapshot({
      kind: "tag_delete",
      nodes: [],
      meta: await getMetaByIds(["bm-b"]),
      tagDef,
    });
    await deleteTag("vintage");

    expectOk(await undoLatest());
    expect(await getTag("vintage")).toMatchObject({
      name: "Vintage",
      createdAt: old,
    });
  });
});

// ---------------------------------------------------------------------------
// undoLatest — stack semantics
// ---------------------------------------------------------------------------

describe("undoLatest — stack semantics", () => {
  it("reports `empty` when there is nothing to undo", async () => {
    expect(await undoLatest()).toEqual({
      ok: false,
      code: "empty",
      message: expect.any(String),
    });
  });

  it("treats a corrupt stored snapshot as absent", async () => {
    await db.undo.add({ bogus: true } as unknown as UndoSnapshot);
    expect(await undoLatest()).toMatchObject({ ok: false, code: "empty" });
  });
});

// ---------------------------------------------------------------------------
// discardLatest — the wedged-head escape hatch
// ---------------------------------------------------------------------------

describe("discardLatest", () => {
  it("drops a permanently failing head so the stack below becomes reachable", async () => {
    const restorable = await captureSubtree("bm-b");
    await pushSnapshot({
      kind: "delete",
      nodes: [restorable!.node],
      meta: [],
    });
    // The head can never restore: its recorded parent is managed.
    await pushSnapshot({
      kind: "delete",
      nodes: [leafSnapshotNode("wedged", "managed", 0)],
      meta: [],
    });
    await removeTree("bm-b");

    const blocked = await undoLatest();
    expect(blocked).toMatchObject({ ok: false, code: "managed" });
    expect(await peekLatest()).toBeDefined();

    const discarded = await discardLatest();
    expect(discarded).toMatchObject({ ok: true });
    expect(await peekLatest()).toBeDefined(); // bm-b's row now heads the stack

    const result = expectOk(await undoLatest());
    expect(result.idMap["bm-b"]).toBeDefined();
    expect(await peekLatest()).toBeUndefined();
  });

  it("reports empty when there is nothing to discard", async () => {
    expect(await discardLatest()).toMatchObject({ ok: false, code: "empty" });
  });
});

// ---------------------------------------------------------------------------
// undoExpected — atomic targeted replay
// ---------------------------------------------------------------------------

describe("undoExpected", () => {
  it("replays the head it was asked for and leaves the snapshot below it next", async () => {
    const b = await captureSubtree("bm-b");
    await pushSnapshot({ kind: "delete", nodes: [b!.node], meta: [] });
    await removeTree("bm-b");
    const c = await captureSubtree("bm-c");
    const cRowId = await pushSnapshot({
      kind: "delete",
      nodes: [c!.node],
      meta: [],
    });
    await removeTree("bm-c");

    const targeted = expectOk(await undoExpected(cRowId));
    expect(targeted.restoredIds).toHaveLength(1);
    // Only the targeted row was replayed: bm-c is back, bm-b is still gone.
    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar.filter((node) => node.url === "https://c.example/")).toHaveLength(1);
    await expect(get("bm-b")).rejects.toThrow();
    // The row below the popped head is the next undo target.
    const next = expectOk(await undoLatest());
    expect(next.idMap["bm-b"]).toBeDefined();
    expect(
      (await getChildren(BOOKMARKS_BAR_ID)).filter(
        (node) => node.url === "https://b.example/",
      ),
    ).toHaveLength(1);
    expect(await peekLatest()).toBeUndefined();
  });

  it("resumes a partially-failed targeted replay instead of duplicating nodes", async () => {
    const b = await captureSubtree("bm-b");
    const c = await captureSubtree("bm-c");
    const rowId = await pushSnapshot({
      kind: "delete",
      nodes: [b!.node, c!.node],
      meta: [],
    });
    await removeTree("bm-b");
    await removeTree("bm-c");

    // First attempt: bm-b is recreated, then the second create fails.
    const originalCreate = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "C"
        ? Promise.reject(new Error("chrome boom"))
        : originalCreate(details),
    );
    const failed = await undoExpected(rowId);
    expect(failed).toMatchObject({ ok: false, code: "api" });
    // The kept row carries its progress: bm-b's old→new id mapping survived.
    expect((await peekLatest())?.idMap?.["bm-b"]).toBeDefined();
    vi.restoreAllMocks();

    const retried = expectOk(await undoExpected(rowId));
    expect(retried.idMap["bm-b"]).toBeDefined();
    expect(retried.idMap["bm-c"]).toBeDefined();
    // Neither node was created twice — the resume skipped the finished one.
    const bar = await getChildren(BOOKMARKS_BAR_ID);
    expect(bar.filter((node) => node.title === "B")).toHaveLength(1);
    expect(bar.filter((node) => node.title === "C")).toHaveLength(1);
    expect(await peekLatest()).toBeUndefined();
  });

  it("restores a merge target's summary through a targeted replay", async () => {
    await putMeta("bm-k", { tags: ["keep"], summary: "Original summary." });
    await putMeta("bm-l1", { tags: [], summary: "Loser summary." });
    const captured = await captureNodes(["bm-l1"]);
    const kept = await getMeta("bm-k");
    if (kept === undefined) throw new Error("missing fixture metadata");
    const rowId = await pushSnapshot({
      kind: "merge",
      ...captured,
      meta: [...captured.meta, kept],
    });
    await putMeta("bm-k", { tags: ["merged"], summary: "Merged summary." });
    await removeWithCascade("bm-l1");

    const result = expectOk(await undoExpected(rowId));
    // The surviving target's pre-merge summary is restored at the same id …
    expect(await getMeta("bm-k")).toMatchObject({
      tags: ["keep"],
      summary: "Original summary.",
    });
    // … and the recreated loser carries its own captured summary.
    expect((await getMeta(result.idMap["bm-l1"]!))?.summary).toBe(
      "Loser summary.",
    );
  });

  it("refuses with conflict for a row id that is not on the stack, mutating nothing", async () => {
    const capture = await captureSubtree("bm-b");
    const rowId = await pushSnapshot({
      kind: "delete",
      nodes: [capture!.node],
      meta: [],
    });
    await removeTree("bm-b");
    const createSpy = vi.spyOn(fake, "create");

    const result = await undoExpected(rowId + 1000);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(createSpy).not.toHaveBeenCalled();
    expect((await peekLatest())?.id).toBe(rowId);
    await expect(get("bm-b")).rejects.toThrow();
  });
});
