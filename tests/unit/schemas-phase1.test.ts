import { describe, expect, it } from "vitest";
import { BookmarkMeta, TagDef, tagNameKey } from "../../src/schemas/meta";
import { UndoNode, UndoSnapshot } from "../../src/schemas/undo";
import { ExportEnvelope, ExportTreeNode } from "../../src/schemas/export";
import {
  invalidBookmarkMetas,
  invalidTagDefs,
  malformedBookmarkMetas,
  malformedTagDefs,
  minimalBookmarkMeta,
  minimalTagDef,
  validBookmarkMeta,
  validTagDef,
} from "../fixtures/meta";
import {
  invalidUndoSnapshots,
  malformedUndoSnapshots,
  undoBulkMoveSnapshot,
  undoMergeSnapshot,
  undoTagDeleteSnapshot,
  validUndoSnapshot,
} from "../fixtures/undo";
import {
  invalidExportEnvelopes,
  malformedExportEnvelopes,
  minimalExportEnvelope,
  validExportEnvelope,
} from "../fixtures/export";

describe("BookmarkMeta", () => {
  it("accepts a fully-populated metadata row", () => {
    expect(BookmarkMeta.safeParse(validBookmarkMeta).success).toBe(true);
  });

  it("accepts a minimal row and defaults tags to []", () => {
    const parsed = BookmarkMeta.safeParse(minimalBookmarkMeta);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tags).toEqual([]);
  });

  it.each([["boundary 10,000 chars", "n".repeat(10_000)]])(
    "accepts notes of %s",
    (_label, notes) => {
      expect(
        BookmarkMeta.safeParse({ ...validBookmarkMeta, notes }).success,
      ).toBe(true);
    },
  );

  it.each(Object.entries(invalidBookmarkMetas))(
    "rejects invalid fixture %s",
    (_label, fixture) => {
      expect(BookmarkMeta.safeParse(fixture).success).toBe(false);
    },
  );

  it.each(Object.entries(malformedBookmarkMetas))(
    "rejects malformed fixture %s",
    (_label, fixture) => {
      expect(BookmarkMeta.safeParse(fixture).success).toBe(false);
    },
  );
});

describe("TagDef", () => {
  it("accepts a fully-populated tag definition", () => {
    expect(TagDef.safeParse(validTagDef).success).toBe(true);
  });

  it("accepts a minimal tag definition", () => {
    expect(TagDef.safeParse(minimalTagDef).success).toBe(true);
  });

  it.each([["1 char", "x"], ["64 chars", "n".repeat(64)]])(
    "accepts name that is %s",
    (_label, name) => {
      expect(
        TagDef.safeParse({ ...validTagDef, name, nameKey: tagNameKey(name) })
          .success,
      ).toBe(true);
    },
  );

  it.each([["300 chars", "d".repeat(300)]])(
    "accepts description of %s",
    (_label, description) => {
      expect(
        TagDef.safeParse({ ...validTagDef, description }).success,
      ).toBe(true);
    },
  );

  it.each(Object.entries(invalidTagDefs))(
    "rejects invalid fixture %s",
    (_label, fixture) => {
      expect(TagDef.safeParse(fixture).success).toBe(false);
    },
  );

  it.each(Object.entries(malformedTagDefs))(
    "rejects malformed fixture %s",
    (_label, fixture) => {
      expect(TagDef.safeParse(fixture).success).toBe(false);
    },
  );

  it("derives the same nameKey for names that differ only by case and surrounding whitespace", () => {
    expect(tagNameKey("Reading List")).toBe("reading list");
    expect(tagNameKey("READING LIST")).toBe("reading list");
    expect(tagNameKey("  reading list  ")).toBe("reading list");
  });

  it("accepts a tag whose name differs from nameKey only by case", () => {
    expect(
      TagDef.safeParse({ ...validTagDef, name: "TYPESCRIPT", nameKey: "typescript" })
        .success,
    ).toBe(true);
  });
});

describe("UndoNode", () => {
  it("accepts a leaf bookmark node", () => {
    expect(
      UndoNode.safeParse({
        id: "bm-100",
        parentId: "1",
        index: 3,
        title: "Example",
        url: "https://example.com/",
      }).success,
    ).toBe(true);
  });

  it("accepts nested folder children recursively", () => {
    expect(
      UndoNode.safeParse({
        id: "f-9",
        parentId: "1",
        index: 0,
        title: "Folder",
        children: [
          {
            id: "f-10",
            parentId: "f-9",
            index: 0,
            title: "Nested",
            children: [
              { id: "bm-101", parentId: "f-10", index: 0, title: "Leaf", url: "https://a.b/" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an extra key inside a nested child (strict at every level)", () => {
    expect(
      UndoNode.safeParse({
        id: "f-9",
        parentId: "1",
        index: 0,
        title: "Folder",
        children: [
          { id: "bm-1", parentId: "f-9", index: 0, title: "x", keys: [] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("UndoSnapshot", () => {
  it.each([
    ["delete", validUndoSnapshot],
    ["bulk_move", undoBulkMoveSnapshot],
    ["merge", undoMergeSnapshot],
    ["tag_delete", undoTagDeleteSnapshot],
  ])("accepts a %s snapshot", (_kind, fixture) => {
    expect(UndoSnapshot.safeParse(fixture).success).toBe(true);
  });

  it("accepts a row with an auto-increment id already assigned", () => {
    expect(
      UndoSnapshot.safeParse({ ...validUndoSnapshot, id: 7 }).success,
    ).toBe(true);
  });

  it.each(Object.entries(invalidUndoSnapshots))(
    "rejects invalid fixture %s",
    (_label, fixture) => {
      expect(UndoSnapshot.safeParse(fixture).success).toBe(false);
    },
  );

  it.each(Object.entries(malformedUndoSnapshots))(
    "rejects malformed fixture %s",
    (_label, fixture) => {
      expect(UndoSnapshot.safeParse(fixture).success).toBe(false);
    },
  );
});

describe("ExportTreeNode", () => {
  it("accepts nested folder children recursively", () => {
    expect(
      ExportTreeNode.safeParse({
        id: "0",
        title: "Bookmarks bar",
        children: [
          { id: "bm-1", title: "Leaf", url: "https://a.b/" },
          { id: "f-1", title: "Sub", children: [] },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("ExportEnvelope", () => {
  it("accepts a fully-populated envelope", () => {
    expect(ExportEnvelope.safeParse(validExportEnvelope).success).toBe(true);
  });

  it("accepts an empty-library envelope", () => {
    expect(ExportEnvelope.safeParse(minimalExportEnvelope).success).toBe(true);
  });

  it.each(Object.entries(invalidExportEnvelopes))(
    "rejects invalid fixture %s",
    (_label, fixture) => {
      expect(ExportEnvelope.safeParse(fixture).success).toBe(false);
    },
  );

  it.each(Object.entries(malformedExportEnvelopes))(
    "rejects malformed fixture %s",
    (_label, fixture) => {
      expect(ExportEnvelope.safeParse(fixture).success).toBe(false);
    },
  );

  // The envelope is the JSON file users can share; every object level is
  // strict so secret-bearing fields fail validation instead of being carried
  // or silently stripped (spec: "exports never include API keys, key material,
  // consent records, provider settings, the sent log, or decisions").
  it.each([
    "keys",
    "apiKey",
    "providerSettings",
    "consents",
    "sentLog",
    "keyMaterials",
    "decisions",
  ])("rejects an envelope smuggling %j", (field) => {
    expect(
      ExportEnvelope.safeParse({ ...validExportEnvelope, [field]: [] })
        .success,
    ).toBe(false);
  });
});
