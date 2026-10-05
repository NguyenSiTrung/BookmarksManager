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
  getMeta,
  getTag,
  listTags,
  putMeta,
} from "../../src/db/meta";
import type { Category } from "../../src/schemas/bookmark";
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkSetCategory,
  deleteTagWithUndo,
  recolorTag,
  renameTag,
} from "../../src/sync/tag-ops";
import { undoLatest } from "../../src/undo/restore";
import { listSnapshots, peekLatest } from "../../src/undo/snapshot";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Seeded tree for every test (the fake is required only by the undo round
 * trip — `restore.ts` checks that a snapshotted bookmark still exists before
 * re-adding its tag; the bulk ops themselves never touch the tree):
 *
 * ```
 * 0 root
 * └─ 1 Bookmarks bar
 *    ├─ bm-a   https://a.example/
 *    ├─ bm-b   https://b.example/
 *    └─ bm-c   https://c.example/
 * ```
 */
beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  installBookmarksFake({
    bookmarksBar: [
      { id: "bm-a", title: "A", url: "https://a.example/" },
      { id: "bm-b", title: "B", url: "https://b.example/" },
      { id: "bm-c", title: "C", url: "https://c.example/" },
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

/** Narrow a tag-ops result union to its success arm (fails the test otherwise). */
function expectOk<R extends { ok: boolean }>(
  result: R,
): Extract<R, { ok: true }> {
  if (!result.ok) {
    throw new Error(`op failed: ${JSON.stringify(result)}`);
  }
  return result as Extract<R, { ok: true }>;
}

// ---------------------------------------------------------------------------
// bulkAddTag
// ---------------------------------------------------------------------------

describe("bulkAddTag", () => {
  it("creates the def for a new name and adds its nameKey to every id", async () => {
    await putMeta("bm-a", { notes: "kept" });
    const result = expectOk(await bulkAddTag(["bm-a", "bm-b"], "Reading List"));

    expect(result.created).toBe(true);
    expect(result.affected).toBe(2);
    expect(result.tag).toMatchObject({
      name: "Reading List",
      nameKey: "reading list",
    });
    // Existing fields survive; the new key is appended.
    expect(await getMeta("bm-a")).toMatchObject({
      tags: ["reading list"],
      notes: "kept",
    });
    // bm-b had no row — patchMeta lazily created one.
    expect((await getMeta("bm-b"))?.tags).toEqual(["reading list"]);
    expect(await getTag("reading list")).toBeDefined();
  });

  it("resolves an existing def case-insensitively and skips ids that already carry it", async () => {
    await createTag("Reading List");
    const before = await putMeta("bm-a", { tags: ["reading list"] });
    const result = expectOk(
      await bulkAddTag(["bm-a", "bm-b"], "  READING LIST "),
    );

    expect(result.created).toBe(false);
    expect(result.tag.name).toBe("Reading List"); // the stored def wins
    expect(result.affected).toBe(1); // only bm-b actually changed
    // The already-tagged row was not rewritten — even its timestamp is untouched.
    expect((await getMeta("bm-a"))?.updatedAt).toBe(before?.updatedAt);
    expect((await getMeta("bm-b"))?.tags).toEqual(["reading list"]);
    expect(await listTags()).toHaveLength(1); // no duplicate def
  });

  it("appends after existing tags and collapses duplicate ids", async () => {
    await putMeta("bm-a", { tags: ["first"] });
    const result = expectOk(
      await bulkAddTag(["bm-a", "bm-a", "bm-b", "bm-a"], "Second"),
    );
    expect(result.affected).toBe(2);
    expect((await getMeta("bm-a"))?.tags).toEqual(["first", "second"]);
    expect((await getMeta("bm-b"))?.tags).toEqual(["second"]);
  });

  it("still resolves the def on an empty selection, and fails invalid_tag on bad names", async () => {
    // "Add tag" in the UI doubles as "create this tag": the def is
    // resolve-or-created up front, so an empty selection still creates it.
    const result = expectOk(await bulkAddTag([], "New Tag"));
    expect(result.created).toBe(true);
    expect(result.affected).toBe(0);
    expect(await getTag("new tag")).toBeDefined();
    await db.tags.clear();
    expect(await bulkAddTag(["bm-a"], "   ")).toMatchObject({
      ok: false,
      code: "invalid_tag",
    });
    expect(await bulkAddTag(["bm-a"], "n".repeat(65))).toMatchObject({
      ok: false,
      code: "invalid_tag",
    });
    expect(await db.tags.count()).toBe(0);
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("merges overlapping adds on the same id without losing updates", async () => {
    // Each op does its read-modify-write inside one bookmarkMeta
    // transaction, so the two transactions serialize and both keys survive
    // (a bulk read + whole-array rewrite would lose whichever came second).
    const [first, second] = await Promise.all([
      bulkAddTag(["bm-a"], "First"),
      bulkAddTag(["bm-a"], "Second"),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const tags = (await getMeta("bm-a"))?.tags ?? [];
    expect([...tags].sort()).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// bulkRemoveTag
// ---------------------------------------------------------------------------

describe("bulkRemoveTag", () => {
  it("removes the key from every selected row carrying it and counts them", async () => {
    await putMeta("bm-a", { tags: ["doomed", "keep"], notes: "n" });
    await putMeta("bm-b", { tags: ["doomed"] });
    await putMeta("bm-c", { tags: ["other"] });

    const result = expectOk(
      await bulkRemoveTag(["bm-a", "bm-b", "bm-c"], "doomed"),
    );
    expect(result.affected).toBe(2); // bm-c never carried the key

    expect(await getMeta("bm-a")).toMatchObject({
      tags: ["keep"],
      notes: "n",
    });
    // bm-b's only metadata was the tag — the lazy-row rule deletes the row.
    expect(await getMeta("bm-b")).toBeUndefined();
    expect(await db.bookmarkMeta.get("bm-b")).toBeUndefined();
    expect((await getMeta("bm-c"))?.tags).toEqual(["other"]);
    // The tag definition itself is untouched — removal is not deletion.
    expect(await getTag("doomed")).toBeUndefined(); // never had a def
  });

  it("accepts a display name and normalizes it to the nameKey", async () => {
    await putMeta("bm-a", { tags: ["reading list"] });
    const result = expectOk(
      await bulkRemoveTag(["bm-a"], "  Reading LIST "),
    );
    expect(result.affected).toBe(1);
    expect(await getMeta("bm-a")).toBeUndefined();
  });

  it("reports zero for absent keys and fails invalid_tag on a blank reference", async () => {
    await putMeta("bm-a", { tags: ["other"] });
    expect(await bulkRemoveTag(["bm-a"], "ghost")).toMatchObject({
      ok: true,
      affected: 0,
    });
    expect(await bulkRemoveTag([], "ghost")).toMatchObject({
      ok: true,
      affected: 0,
    });
    expect(await bulkRemoveTag(["bm-a"], "  ")).toMatchObject({
      ok: false,
      code: "invalid_tag",
    });
  });

  it("does not lose a concurrent add when another op removes a different tag", async () => {
    await putMeta("bm-a", { tags: ["doomed"] });
    const [removed, added] = await Promise.all([
      bulkRemoveTag(["bm-a"], "doomed"),
      bulkAddTag(["bm-a"], "fresh"),
    ]);
    expect(removed.ok).toBe(true);
    expect(added.ok).toBe(true);
    // Whichever transaction landed first, the row ends up carrying only
    // "fresh": the remove saw and stripped "doomed", the add appended.
    expect((await getMeta("bm-a"))?.tags).toEqual(["fresh"]);
  });
});

// ---------------------------------------------------------------------------
// bulkSetCategory
// ---------------------------------------------------------------------------

describe("bulkSetCategory", () => {
  it("sets the category on every selected id, creating rows lazily", async () => {
    await putMeta("bm-a", { tags: ["t"], category: "docs" });
    const result = expectOk(await bulkSetCategory(["bm-a", "bm-b"], "video"));
    expect(result.affected).toBe(2);
    expect(await getMeta("bm-a")).toMatchObject({
      tags: ["t"],
      category: "video",
    });
    expect(await getMeta("bm-b")).toMatchObject({
      tags: [],
      category: "video",
    });
  });

  it("clears the category on null, drops emptied rows, and counts only real changes", async () => {
    await putMeta("bm-a", { category: "docs" });
    await putMeta("bm-b", { category: "docs", notes: "keep" });
    const result = expectOk(await bulkSetCategory(["bm-a", "bm-b"], null));
    expect(result.affected).toBe(2);
    // bm-a's only metadata was the category — the row is gone.
    expect(await db.bookmarkMeta.get("bm-a")).toBeUndefined();
    expect(await getMeta("bm-b")).toMatchObject({ notes: "keep" });
    expect((await getMeta("bm-b"))?.category).toBeUndefined();
    // Setting a category already held changes nothing.
    await putMeta("bm-a", { category: "docs" });
    await putMeta("bm-b", { category: "video", notes: "x" });
    expect(
      await bulkSetCategory(["bm-a", "bm-b"], "docs"),
    ).toMatchObject({ ok: true, affected: 1 });
    // Clearing likewise counts only rows that lose a category.
    expect((await getMeta("bm-a"))?.category).toBe("docs");
    expect(
      await bulkSetCategory(["bm-a", "bm-c"], null),
    ).toMatchObject({ ok: true, affected: 1 }); // only bm-a had one
    expect(await db.bookmarkMeta.get("bm-a")).toBeUndefined();
  });

  it("fails invalid_meta on a non-enum category and writes nothing", async () => {
    await putMeta("bm-a", { notes: "keep" });
    expect(
      await bulkSetCategory(["bm-a"], "bogus" as Category),
    ).toMatchObject({ ok: false, code: "invalid_meta" });
    expect(await getMeta("bm-a")).toMatchObject({ notes: "keep" });
    expect((await getMeta("bm-a"))?.category).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// renameTag / recolorTag — thin delegations over the meta repo
// ---------------------------------------------------------------------------

describe("renameTag", () => {
  it("renames the def, propagates the new nameKey, and reports the count", async () => {
    await createTag("Reading List");
    await putMeta("bm-a", { tags: ["reading list", "other"] });
    await putMeta("bm-b", { tags: ["reading list"] });

    const result = expectOk(await renameTag("reading list", "Articles"));
    expect(result.affectedBookmarks).toBe(2);
    expect(result.renamed).toMatchObject({
      name: "Articles",
      nameKey: "articles",
    });
    expect((await getMeta("bm-a"))?.tags).toEqual(["articles", "other"]);
    expect((await getMeta("bm-b"))?.tags).toEqual(["articles"]);
    expect(await getTag("reading list")).toBeUndefined();
  });

  it("fails not_found, tag_exists (rolled back), and invalid_tag without touching data", async () => {
    expect(await renameTag("ghost", "New")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await createTag("Alpha");
    await createTag("Beta");
    await putMeta("bm-a", { tags: ["alpha"] });
    expect(await renameTag("alpha", "BETA")).toMatchObject({
      ok: false,
      code: "tag_exists",
    });
    expect((await getTag("alpha"))?.name).toBe("Alpha");
    expect((await getMeta("bm-a"))?.tags).toEqual(["alpha"]);
    await createTag("Foo");
    expect(await renameTag("foo", "n".repeat(65))).toMatchObject({
      ok: false,
      code: "invalid_tag",
    });
    expect((await getTag("foo"))?.name).toBe("Foo");
  });
});

describe("recolorTag", () => {
  it("sets and clears the color", async () => {
    await createTag("Foo");
    const set = expectOk(await recolorTag("foo", "#a1b2c3"));
    expect(set.tag).toMatchObject({ nameKey: "foo", color: "#a1b2c3" });
    const cleared = expectOk(await recolorTag("Foo", null));
    expect(cleared.tag.color).toBeUndefined();
    expect((await getTag("foo"))?.color).toBeUndefined();
  });

  it("fails not_found for a missing tag", async () => {
    expect(await recolorTag("ghost", "#fff")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

// ---------------------------------------------------------------------------
// deleteTagWithUndo
// ---------------------------------------------------------------------------

describe("deleteTagWithUndo", () => {
  it("snapshots first, deletes the def, strips the key, and reports affected", async () => {
    await createTag("Doomed", { color: "#123456", description: "doomed tag" });
    await putMeta("bm-a", { tags: ["doomed", "keep"], notes: "n" });
    await putMeta("bm-b", { tags: ["doomed"] });
    await putMeta("bm-c", { tags: ["other"] });

    const result = expectOk(await deleteTagWithUndo("doomed"));
    expect(result.affected).toBe(2);
    expect(typeof result.snapshotId).toBe("number");

    expect(await getTag("doomed")).toBeUndefined();
    expect((await getMeta("bm-a"))?.tags).toEqual(["keep"]);
    expect(await getMeta("bm-b")).toBeUndefined(); // lazy-row rule
    expect((await getMeta("bm-c"))?.tags).toEqual(["other"]);

    // The snapshot carries the def plus the pre-delete rows; no nodes.
    const snapshot = await peekLatest();
    expect(snapshot).toMatchObject({ id: result.snapshotId, kind: "tag_delete" });
    expect(snapshot?.nodes).toEqual([]);
    expect(snapshot?.tagDef).toMatchObject({
      name: "Doomed",
      nameKey: "doomed",
      color: "#123456",
      description: "doomed tag",
    });
    expect(snapshot?.meta.map((m) => m.id).sort()).toEqual(["bm-a", "bm-b"]);
    expect(snapshot?.meta.find((m) => m.id === "bm-a")?.tags).toEqual([
      "doomed",
      "keep",
    ]);
  });

  it("is undoable: undoLatest re-creates the def and restores the rows", async () => {
    await createTag("Reading List", {
      color: "#3178c6",
      description: "long reads",
    });
    await putMeta("bm-a", { tags: ["reading list", "other"], notes: "n" });
    await putMeta("bm-b", { tags: ["reading list"] });

    expectOk(await deleteTagWithUndo("reading list"));
    expect(await getTag("reading list")).toBeUndefined();

    const undo = await undoLatest();
    expect(undo.ok).toBe(true);
    if (!undo.ok) throw new Error(`undo failed: ${undo.message}`);
    expect(undo.restoredIds.sort()).toEqual(["bm-a", "bm-b"]);

    // Def restored with its display fields; rows carry the key again.
    expect(await getTag("reading list")).toMatchObject({
      name: "Reading List",
      color: "#3178c6",
      description: "long reads",
    });
    expect(await getMeta("bm-a")).toMatchObject({
      tags: ["reading list", "other"],
      notes: "n",
    });
    // bm-b's whole row was lazily deleted with the tag — restore re-creates it.
    expect(await getMeta("bm-b")).toMatchObject({ tags: ["reading list"] });
    // Pop-on-success consumed the snapshot.
    expect(await peekLatest()).toBeUndefined();
    expect(await listSnapshots()).toEqual([]);
  });

  it("deletes a tag no bookmark carries (affected 0); undo still restores the def", async () => {
    await createTag("Empty");
    const result = expectOk(await deleteTagWithUndo("empty"));
    expect(result.affected).toBe(0);
    expect(await getTag("empty")).toBeUndefined();

    const undo = await undoLatest();
    expect(undo.ok).toBe(true);
    if (!undo.ok) throw new Error(`undo failed: ${undo.message}`);
    expect(undo.restoredIds).toEqual([]);
    expect(await getTag("empty")).toMatchObject({ name: "Empty" });
  });

  it("is atomic: a delete failure rolls back the snapshot AND the strip (D10)", async () => {
    await createTag("Atomic", { color: "#aa0000" });
    await putMeta("bm-a", { tags: ["atomic", "keep"] });
    await putMeta("bm-b", { tags: ["atomic"] });

    // Fail the actual delete inside the shared transaction — after the
    // snapshot push — so the whole unit (capture + push + strip + delete)
    // must roll back together.
    const deleteSpy = vi
      .spyOn(db.tags, "delete")
      .mockRejectedValue(new Error("simulated delete failure"));
    try {
      const result = await deleteTagWithUndo("atomic");
      expect(result).toMatchObject({ ok: false });
    } finally {
      deleteSpy.mockRestore();
    }

    // Nothing happened: the def survives, the rows still carry the key,
    // and the stack does NOT claim an undo for a delete that never ran.
    expect(await getTag("atomic")).toMatchObject({ name: "Atomic" });
    expect((await getMeta("bm-a"))?.tags).toEqual(["atomic", "keep"]);
    expect((await getMeta("bm-b"))?.tags).toEqual(["atomic"]);
    expect(await db.undo.count()).toBe(0);
    expect(await peekLatest()).toBeUndefined();
  });

  it("fails not_found/invalid_tag on unknown or blank refs and writes no snapshot", async () => {
    // Rows carrying an orphaned key are left alone too — only a real def is
    // deletable through this path (there is nothing to snapshot/restore).
    await putMeta("bm-a", { tags: ["orphan"] });
    expect(await deleteTagWithUndo("orphan")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await db.undo.count()).toBe(0);
    expect((await getMeta("bm-a"))?.tags).toEqual(["orphan"]);
    expect(await deleteTagWithUndo("   ")).toMatchObject({
      ok: false,
      code: "invalid_tag",
    });
    expect(await db.undo.count()).toBe(0);
  });
});
