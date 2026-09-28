import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../src/db/database";
import {
  createTag,
  setBookmarkSummary,
  deleteMetaByIds,
  deleteTag,
  getMeta,
  getMetaByCategory,
  getMetaByIds,
  getMetaByTag,
  getTag,
  listMeta,
  listTags,
  MetaRepoError,
  patchMeta,
  putMeta,
  recolorTag,
  renameTag,
  updateTag,
} from "../../src/db/meta";

const ISO = "2026-09-26T10:00:00.000Z";

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
});

afterAll(() => {
  db.close();
});

describe("getMeta", () => {
  it("returns undefined for an unknown id", async () => {
    expect(await getMeta("no-such-id")).toBeUndefined();
  });

  it("returns a stored row, validated and normalized", async () => {
    await putMeta("bm-1", {
      tags: ["Docs"],
      category: "docs",
      notes: "kept",
    });
    const meta = await getMeta("bm-1");
    expect(meta).toMatchObject({
      id: "bm-1",
      tags: ["docs"],
      category: "docs",
      notes: "kept",
    });
    expect(Number.isNaN(Date.parse(meta!.updatedAt))).toBe(false);
  });

  it("treats a schema-invalid stored row as absent", async () => {
    // Bypass the repo: a row whose tag entry is not a valid nameKey.
    await db.bookmarkMeta.put({
      id: "bad",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    expect(await getMeta("bad")).toBeUndefined();
  });
});

describe("putMeta", () => {
  it("creates a row and stamps updatedAt itself", async () => {
    const before = Date.now();
    const meta = await putMeta("bm-1", { tags: ["TS"], notes: "note" });
    expect(meta).toMatchObject({
      id: "bm-1",
      tags: ["ts"],
      notes: "note",
    });
    expect(Date.parse(meta!.updatedAt)).toBeGreaterThanOrEqual(before);
    expect((await db.bookmarkMeta.get("bm-1"))?.notes).toBe("note");
  });

  it("replaces the whole field set on an existing id (upsert)", async () => {
    await putMeta("bm-1", { tags: ["a"], category: "docs", notes: "x" });
    const meta = await putMeta("bm-1", { category: "video" });
    expect(meta).toMatchObject({ id: "bm-1", tags: [], category: "video" });
    expect(meta?.notes).toBeUndefined();
  });

  it("deletes the row when the resulting meta is empty (lazy rows)", async () => {
    await putMeta("bm-1", { tags: ["a"], notes: "x" });
    expect(await db.bookmarkMeta.count()).toBe(1);
    const meta = await putMeta("bm-1", {});
    expect(meta).toBeUndefined();
    expect(await db.bookmarkMeta.get("bm-1")).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("stores no row for an all-empty put on a fresh id", async () => {
    // "   " normalizes to an empty nameKey and is dropped, leaving nothing.
    expect(await putMeta("bm-1", { tags: ["   "] })).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("stores an empty-string notes value as no-notes", async () => {
    expect(await putMeta("bm-1", { notes: "" })).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("normalizes tag entries to nameKeys and dedupes", async () => {
    const meta = await putMeta("bm-1", {
      tags: [" TypeScript ", "typescript", "Reading List"],
    });
    expect(meta?.tags).toEqual(["typescript", "reading list"]);
  });

  it("does not mutate the caller's field object or tag array", async () => {
    const tags = Object.freeze(["A", "B"]);
    const fields = { tags, notes: "n" } as const;
    const meta = await putMeta("bm-1", fields);
    expect([...tags]).toEqual(["A", "B"]);
    expect(fields.notes).toBe("n");
    expect(meta?.tags).toEqual(["a", "b"]);
  });

  it("returns objects decoupled from storage", async () => {
    const meta = await putMeta("bm-1", { tags: ["a"] });
    meta!.tags.push("caller-pollution");
    expect((await getMeta("bm-1"))?.tags).toEqual(["a"]);
  });

  it("rejects a field set that violates the schema", async () => {
    await expect(
      putMeta("bm-1", { notes: "n".repeat(10_001) }),
    ).rejects.toBeInstanceOf(MetaRepoError);
    await expect(
      putMeta("bm-1", { notes: "n".repeat(10_001) }),
    ).rejects.toMatchObject({ code: "invalid_meta" });
    // A 65-char tag entry is not a valid nameKey either.
    await expect(
      putMeta("bm-1", { tags: ["x".repeat(65)] }),
    ).rejects.toMatchObject({ code: "invalid_meta" });
    expect(await db.bookmarkMeta.count()).toBe(0);
  });
});

describe("patchMeta", () => {
  it("creates the row on first write (lazy create)", async () => {
    const meta = await patchMeta("bm-1", { notes: "hello" });
    expect(meta).toMatchObject({ id: "bm-1", tags: [], notes: "hello" });
  });

  it("merges: absent fields keep their stored values", async () => {
    await putMeta("bm-1", { tags: ["a"], category: "docs", notes: "keep" });
    const meta = await patchMeta("bm-1", { notes: "updated" });
    expect(meta).toMatchObject({
      tags: ["a"],
      category: "docs",
      notes: "updated",
    });
  });

  it("clears category and notes on null", async () => {
    await putMeta("bm-1", { category: "docs", notes: "x", tags: ["t"] });
    const meta = await patchMeta("bm-1", { category: null, notes: null });
    expect(meta).toMatchObject({ tags: ["t"] });
    expect(meta?.category).toBeUndefined();
    expect(meta?.notes).toBeUndefined();
  });

  it("clears the tag list on an empty array", async () => {
    await putMeta("bm-1", { tags: ["a"], notes: "x" });
    const meta = await patchMeta("bm-1", { tags: [] });
    expect(meta?.tags).toEqual([]);
    expect(meta?.notes).toBe("x");
  });

  it("deletes the row when the last field is cleared", async () => {
    await putMeta("bm-1", { tags: ["solo"] });
    const meta = await patchMeta("bm-1", { tags: [] });
    expect(meta).toBeUndefined();
    expect(await db.bookmarkMeta.get("bm-1")).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("treats empty-string notes as a clear", async () => {
    await putMeta("bm-1", { notes: "x" });
    expect(await patchMeta("bm-1", { notes: "" })).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("keeps a missing row absent on an empty patch", async () => {
    expect(await patchMeta("bm-1", {})).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("merges onto an absent base when the stored row is invalid", async () => {
    await db.bookmarkMeta.put({
      id: "bad",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    const meta = await patchMeta("bad", { notes: "repaired" });
    expect(meta).toMatchObject({ id: "bad", tags: [], notes: "repaired" });
  });

  it("stamps updatedAt on write", async () => {
    const first = await putMeta("bm-1", { notes: "x" });
    const second = await patchMeta("bm-1", { notes: "y" });
    expect(Date.parse(second!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(first!.updatedAt),
    );
  });

  it("rejects a patch that violates the schema and writes nothing", async () => {
    await putMeta("bm-1", { notes: "keep" });
    await expect(
      patchMeta("bm-1", { notes: "n".repeat(10_001) }),
    ).rejects.toMatchObject({ code: "invalid_meta" });
    expect((await getMeta("bm-1"))?.notes).toBe("keep");
  });
});

describe("getMetaByIds", () => {
  it("returns rows in input order, skipping misses", async () => {
    await putMeta("a", { notes: "1" });
    await putMeta("b", { notes: "2" });
    const metas = await getMetaByIds(["b", "ghost", "a"]);
    expect(metas.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("collapses duplicate ids", async () => {
    await putMeta("a", { notes: "1" });
    expect(await getMetaByIds(["a", "a", "a"])).toHaveLength(1);
  });

  it("drops schema-invalid rows", async () => {
    await putMeta("good", { notes: "x" });
    await db.bookmarkMeta.put({
      id: "bad",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    const metas = await getMetaByIds(["good", "bad"]);
    expect(metas.map((m) => m.id)).toEqual(["good"]);
  });

  it("returns [] for empty input", async () => {
    expect(await getMetaByIds([])).toEqual([]);
  });
});

describe("listMeta / index reads", () => {
  it("listMeta returns every valid row", async () => {
    await putMeta("a", { notes: "1" });
    await putMeta("b", { tags: ["t"] });
    await db.bookmarkMeta.put({
      id: "bad",
      tags: ["Not A Key"],
      updatedAt: ISO,
    });
    expect((await listMeta()).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("getMetaByTag resolves rows through the *tags index", async () => {
    await putMeta("a", { tags: ["x", "y"] });
    await putMeta("b", { tags: ["y"] });
    await putMeta("c", { notes: "none" });
    const found = await getMetaByTag("y");
    expect(found.map((m) => m.id).sort()).toEqual(["a", "b"]);
    expect(await getMetaByTag("zzz")).toEqual([]);
  });

  it("getMetaByTag normalizes display-name input to a nameKey", async () => {
    await putMeta("a", { tags: ["reading list"] });
    const found = await getMetaByTag("  Reading LIST ");
    expect(found.map((m) => m.id)).toEqual(["a"]);
  });

  it("getMetaByCategory resolves rows through the category index", async () => {
    await putMeta("a", { category: "docs" });
    await putMeta("b", { category: "video" });
    await putMeta("c", { notes: "none" });
    expect((await getMetaByCategory("docs")).map((m) => m.id)).toEqual(["a"]);
    expect(await getMetaByCategory("repo")).toEqual([]);
  });
});

describe("deleteMetaByIds", () => {
  it("bulk-deletes existing rows and returns the count", async () => {
    await putMeta("a", { notes: "1" });
    await putMeta("b", { notes: "2" });
    await putMeta("c", { notes: "3" });
    expect(await deleteMetaByIds(["a", "b"])).toBe(2);
    expect(await getMeta("a")).toBeUndefined();
    expect(await getMeta("b")).toBeUndefined();
    expect((await getMeta("c"))?.notes).toBe("3");
  });

  it("counts only rows that actually existed", async () => {
    await putMeta("a", { notes: "1" });
    expect(await deleteMetaByIds(["a", "ghost"])).toBe(1);
  });

  it("returns 0 for empty input", async () => {
    expect(await deleteMetaByIds([])).toBe(0);
  });
});

describe("createTag", () => {
  it("creates a def with derived nameKey and timestamps", async () => {
    const before = Date.now();
    const tag = await createTag("Reading List", {
      color: "#3178c6",
      description: "Long-form reads.",
    });
    expect(tag).toMatchObject({
      name: "Reading List",
      nameKey: "reading list",
      color: "#3178c6",
      description: "Long-form reads.",
    });
    expect(Date.parse(tag.createdAt)).toBeGreaterThanOrEqual(before);
    expect(tag.updatedAt).toBe(tag.createdAt);
    expect(await getTag("reading list")).toEqual(tag);
  });

  it("trims display-name edges before storing", async () => {
    const tag = await createTag("  Foo  ");
    expect(tag.name).toBe("Foo");
    expect(tag.nameKey).toBe("foo");
  });

  it("rejects case-insensitive duplicates", async () => {
    await createTag("Reading List");
    await expect(createTag("reading list")).rejects.toMatchObject({
      code: "tag_exists",
    });
    await expect(createTag("  READING LIST ")).rejects.toMatchObject({
      code: "tag_exists",
    });
    expect(await db.tags.count()).toBe(1);
  });

  it("rejects empty and whitespace-only names", async () => {
    await expect(createTag("")).rejects.toMatchObject({
      code: "invalid_tag",
    });
    await expect(createTag("   ")).rejects.toMatchObject({
      code: "invalid_tag",
    });
    expect(await db.tags.count()).toBe(0);
  });

  it("rejects names >64 chars and descriptions >300", async () => {
    await expect(createTag("n".repeat(65))).rejects.toMatchObject({
      code: "invalid_tag",
    });
    await expect(
      createTag("ok", { description: "d".repeat(301) }),
    ).rejects.toMatchObject({ code: "invalid_tag" });
  });
});

describe("getTag / listTags", () => {
  it("getTag returns undefined for unknown keys and accepts display names", async () => {
    await createTag("Foo");
    expect((await getTag("foo"))?.name).toBe("Foo");
    expect((await getTag("Foo"))?.nameKey).toBe("foo");
    expect(await getTag("bar")).toBeUndefined();
  });

  it("listTags returns defs sorted by nameKey", async () => {
    await createTag("Beta");
    await createTag("alpha");
    await createTag("Gamma");
    expect((await listTags()).map((t) => t.nameKey)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("listTags drops schema-invalid stored defs", async () => {
    await createTag("Good");
    // nameKey "WRONG" is not its own trim+lowercase form.
    await db.tags.put({
      name: "Bad",
      nameKey: "WRONG",
      createdAt: ISO,
      updatedAt: ISO,
    });
    expect((await listTags()).map((t) => t.nameKey)).toEqual(["good"]);
    expect(await getTag("WRONG")).toBeUndefined();
  });
});

describe("updateTag / recolorTag", () => {
  it("merges display fields and stamps updatedAt", async () => {
    const created = await createTag("Foo", {
      color: "#111",
      description: "d1",
    });
    const tag = await updateTag("foo", { description: "d2" });
    expect(tag).toMatchObject({
      name: "Foo",
      color: "#111",
      description: "d2",
      createdAt: created.createdAt,
    });
    expect(Date.parse(tag!.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(created.updatedAt),
    );
  });

  it("clears fields on null", async () => {
    await createTag("Foo", { color: "#111", description: "d" });
    const tag = await updateTag("foo", { color: null, description: null });
    expect(tag?.color).toBeUndefined();
    expect(tag?.description).toBeUndefined();
    const stored = await getTag("foo");
    expect(stored?.color).toBeUndefined();
    expect(stored?.description).toBeUndefined();
  });

  it("recolorTag sets and clears color", async () => {
    await createTag("Foo");
    expect((await recolorTag("foo", "#abc"))?.color).toBe("#abc");
    expect((await recolorTag("foo", null))?.color).toBeUndefined();
  });

  it("returns undefined for a missing tag", async () => {
    expect(await updateTag("ghost", { color: "#fff" })).toBeUndefined();
    expect(await recolorTag("ghost", "#fff")).toBeUndefined();
  });

  it("rejects a patch that violates the schema and writes nothing", async () => {
    await createTag("Foo");
    await expect(
      updateTag("foo", { description: "d".repeat(301) }),
    ).rejects.toMatchObject({ code: "invalid_tag" });
    expect((await getTag("foo"))?.description).toBeUndefined();
  });
});

describe("renameTag", () => {
  it("renames the def and rewrites every meta row via the *tags index", async () => {
    await createTag("Reading List");
    await putMeta("a", { tags: ["reading list", "other"] });
    await putMeta("b", { tags: ["reading list"] });
    await putMeta("c", { tags: ["unrelated"] });

    const result = await renameTag("reading list", "Articles");
    expect(result?.tag).toMatchObject({
      name: "Articles",
      nameKey: "articles",
    });
    expect(result?.bookmarkCount).toBe(2);

    expect(await db.tags.get("reading list")).toBeUndefined();
    expect((await getMeta("a"))?.tags).toEqual(["articles", "other"]);
    expect((await getMeta("b"))?.tags).toEqual(["articles"]);
    expect((await getMeta("c"))?.tags).toEqual(["unrelated"]);
    // The multiEntry index resolves the new key and forgets the old one.
    expect(
      await db.bookmarkMeta.where("tags").equals("articles").count(),
    ).toBe(2);
    expect(
      await db.bookmarkMeta.where("tags").equals("reading list").count(),
    ).toBe(0);
  });

  it("handles a case-only rename (nameKey unchanged)", async () => {
    await createTag("foo");
    await putMeta("a", { tags: ["foo"] });
    const result = await renameTag("foo", "Foo");
    expect(result?.tag.name).toBe("Foo");
    expect(result?.tag.nameKey).toBe("foo");
    expect(result?.bookmarkCount).toBe(1);
    expect((await getMeta("a"))?.tags).toEqual(["foo"]);
    expect(await db.tags.count()).toBe(1);
  });

  it("dedupes when the new key already sits in a row", async () => {
    await createTag("Foo");
    // Bookmarks may carry keys with no def (orphans); "bar" has none here.
    await putMeta("a", { tags: ["foo", "bar"] });
    const result = await renameTag("foo", "BAR");
    expect(result?.tag.nameKey).toBe("bar");
    expect((await getMeta("a"))?.tags).toEqual(["bar"]);
  });

  it("rejects a rename that collides with a different tag and rolls back", async () => {
    await createTag("Alpha");
    await createTag("Beta");
    await putMeta("a", { tags: ["alpha"] });
    await expect(renameTag("alpha", "BETA")).rejects.toMatchObject({
      code: "tag_exists",
    });
    // Transaction rolled back: defs and meta rows untouched.
    expect((await getTag("alpha"))?.name).toBe("Alpha");
    expect((await getTag("beta"))?.name).toBe("Beta");
    expect((await getMeta("a"))?.tags).toEqual(["alpha"]);
  });

  it("rejects an invalid new name", async () => {
    await createTag("Foo");
    await expect(renameTag("foo", "   ")).rejects.toMatchObject({
      code: "invalid_tag",
    });
    await expect(renameTag("foo", "n".repeat(65))).rejects.toMatchObject({
      code: "invalid_tag",
    });
  });

  it("returns undefined for a missing tag", async () => {
    expect(await renameTag("ghost", "New")).toBeUndefined();
  });
});

describe("deleteTag", () => {
  it("removes the def, strips the key from all rows, returns the count", async () => {
    await createTag("Doomed");
    await putMeta("a", { tags: ["doomed", "keep"], notes: "n" });
    await putMeta("b", { tags: ["doomed"] });
    await putMeta("c", { tags: ["other"] });

    expect(await deleteTag("doomed")).toBe(2);
    expect(await getTag("doomed")).toBeUndefined();
    expect((await getMeta("a"))?.tags).toEqual(["keep"]);
    expect((await getMeta("a"))?.notes).toBe("n");
    // "b" was carried only by that tag: the lazy-row rule deletes the row.
    expect(await getMeta("b")).toBeUndefined();
    expect(await db.bookmarkMeta.get("b")).toBeUndefined();
    expect((await getMeta("c"))?.tags).toEqual(["other"]);
    expect(
      await db.bookmarkMeta.where("tags").equals("doomed").count(),
    ).toBe(0);
  });

  it("keeps rows that still carry other metadata", async () => {
    await createTag("T");
    await putMeta("a", { tags: ["t"], category: "docs" });
    expect(await deleteTag("t")).toBe(1);
    const meta = await getMeta("a");
    expect(meta?.tags).toEqual([]);
    expect(meta?.category).toBe("docs");
  });

  it("strips orphaned keys even when no def exists", async () => {
    await putMeta("a", { tags: ["orphan"] });
    expect(await deleteTag("orphan")).toBe(1);
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("returns 0 when nothing references the key", async () => {
    expect(await deleteTag("ghost")).toBe(0);
    await createTag("Empty");
    expect(await deleteTag("empty")).toBe(0);
    expect(await getTag("empty")).toBeUndefined();
  });
});

describe("setBookmarkSummary", () => {
  it("stores a verified summary on an existing row without touching other fields", async () => {
    await putMeta("bm-1", { tags: ["Docs"], category: "docs", notes: "kept" });
    const meta = await setBookmarkSummary("bm-1", "A verified summary.");
    expect(meta).toMatchObject({
      id: "bm-1",
      tags: ["docs"],
      category: "docs",
      notes: "kept",
      summary: "A verified summary.",
    });
    expect((await getMeta("bm-1"))?.summary).toBe("A verified summary.");
  });

  it("lazily creates a row when the bookmark has no other metadata", async () => {
    const meta = await setBookmarkSummary("bm-new", "Verified.");
    expect(meta?.summary).toBe("Verified.");
    expect((await getMeta("bm-new"))?.summary).toBe("Verified.");
  });

  it("rejects a summary over 2,000 chars and a non-string", async () => {
    await putMeta("bm-1", { tags: ["x"] });
    await expect(
      setBookmarkSummary("bm-1", "s".repeat(2001)),
    ).rejects.toBeInstanceOf(MetaRepoError);
    await expect(
      setBookmarkSummary("bm-1", 42 as unknown as string),
    ).rejects.toBeInstanceOf(MetaRepoError);
  });

  it("null clears the summary without deleting a row that still has data", async () => {
    await putMeta("bm-1", { tags: ["x"] });
    await setBookmarkSummary("bm-1", "Verified.");
    const meta = await setBookmarkSummary("bm-1", null);
    expect(meta?.summary).toBeUndefined();
    expect(meta?.tags).toEqual(["x"]);
  });

  it("keeps the row when a stored summary survives a tag rewrite", async () => {
    await putMeta("bm-1", { summary: "kept" });
    await expect(getMeta("bm-1")).resolves.toMatchObject({
      summary: "kept",
    });
    // A summary-only row is data — the lazy-row rule must not delete it.
    await deleteMetaByIds(["other"]);
    expect((await getMeta("bm-1"))?.summary).toBe("kept");
  });

  it("parses pre-Phase-4 rows that have no summary field", async () => {
    // Stored before `summary` existed — strict-parse must still accept.
    await putMeta("bm-1", { tags: ["x"] });
    const raw = await db.bookmarkMeta.get("bm-1");
    expect(raw).toBeDefined();
    expect("summary" in (raw as object)).toBe(false);
    const meta = await getMeta("bm-1");
    expect(meta).toBeDefined();
    expect(meta?.summary).toBeUndefined();
  });
});
