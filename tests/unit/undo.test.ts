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
import { undoLatest } from "../../src/undo/restore";
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

beforeEach(async () => {
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
});

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
// undoLatest — merge
// ---------------------------------------------------------------------------

describe("undoLatest — merge", () => {
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
