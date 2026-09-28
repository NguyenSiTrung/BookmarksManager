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
  it("accepts a fully-populated metadata row and minimal rows", () => {
    expect(BookmarkMeta.safeParse(validBookmarkMeta).success).toBe(true);
    const parsed = BookmarkMeta.safeParse(minimalBookmarkMeta);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tags).toEqual([]);
    expect(
      BookmarkMeta.safeParse({ ...validBookmarkMeta, notes: "n".repeat(10_000) }).success,
    ).toBe(true);
  });

  it("rejects invalid and malformed fixtures", () => {
    for (const fixture of Object.values(invalidBookmarkMetas)) {
      expect(BookmarkMeta.safeParse(fixture).success).toBe(false);
    }
    for (const fixture of Object.values(malformedBookmarkMetas)) {
      expect(BookmarkMeta.safeParse(fixture).success).toBe(false);
    }
  });
});

describe("TagDef", () => {
  it("accepts valid and minimal tag definitions with bounds", () => {
    expect(TagDef.safeParse(validTagDef).success).toBe(true);
    expect(TagDef.safeParse(minimalTagDef).success).toBe(true);
    for (const name of ["x", "n".repeat(64)]) {
      expect(
        TagDef.safeParse({ ...validTagDef, name, nameKey: tagNameKey(name) }).success,
      ).toBe(true);
    }
    expect(
      TagDef.safeParse({ ...validTagDef, description: "d".repeat(300) }).success,
    ).toBe(true);
  });

  it("rejects invalid and malformed tag fixtures", () => {
    for (const fixture of Object.values(invalidTagDefs)) {
      expect(TagDef.safeParse(fixture).success).toBe(false);
    }
    for (const fixture of Object.values(malformedTagDefs)) {
      expect(TagDef.safeParse(fixture).success).toBe(false);
    }
  });

  it("derives and compares nameKey accurately", () => {
    expect(tagNameKey("Reading List")).toBe("reading list");
    expect(tagNameKey("READING LIST")).toBe("reading list");
    expect(tagNameKey("  reading list  ")).toBe("reading list");
    expect(
      TagDef.safeParse({ ...validTagDef, name: "TYPESCRIPT", nameKey: "typescript" }).success,
    ).toBe(true);
  });
});

describe("UndoNode", () => {
  it("accepts a leaf bookmark node and nested folder children recursively", () => {
    expect(
      UndoNode.safeParse({
        id: "bm-100",
        parentId: "1",
        index: 3,
        title: "Example",
        url: "https://example.com/",
      }).success,
    ).toBe(true);

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

  it("rejects an extra key inside a nested child", () => {
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
  it("accepts valid snapshots across kinds and auto-assigned ids", () => {
    for (const fixture of [validUndoSnapshot, undoBulkMoveSnapshot, undoMergeSnapshot, undoTagDeleteSnapshot]) {
      expect(UndoSnapshot.safeParse(fixture).success).toBe(true);
    }
    expect(UndoSnapshot.safeParse({ ...validUndoSnapshot, id: 7 }).success).toBe(true);
  });

  it("rejects invalid and malformed undo snapshots", () => {
    for (const fixture of Object.values(invalidUndoSnapshots)) {
      expect(UndoSnapshot.safeParse(fixture).success).toBe(false);
    }
    for (const fixture of Object.values(malformedUndoSnapshots)) {
      expect(UndoSnapshot.safeParse(fixture).success).toBe(false);
    }
  });
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
  it("accepts fully-populated and minimal empty-library envelopes", () => {
    expect(ExportEnvelope.safeParse(validExportEnvelope).success).toBe(true);
    expect(ExportEnvelope.safeParse(minimalExportEnvelope).success).toBe(true);
  });

  it("rejects invalid and malformed export envelope fixtures", () => {
    for (const fixture of Object.values(invalidExportEnvelopes)) {
      expect(ExportEnvelope.safeParse(fixture).success).toBe(false);
    }
    for (const fixture of Object.values(malformedExportEnvelopes)) {
      expect(ExportEnvelope.safeParse(fixture).success).toBe(false);
    }
  });

  it("rejects an envelope smuggling disallowed or sensitive fields", () => {
    for (const field of ["keys", "apiKey", "providerSettings", "consents", "sentLog", "keyMaterials", "decisions"]) {
      expect(
        ExportEnvelope.safeParse({ ...validExportEnvelope, [field]: [] }).success,
      ).toBe(false);
    }
  });
});
