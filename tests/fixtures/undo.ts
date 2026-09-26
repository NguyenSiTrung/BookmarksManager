import type { z } from "../../src/schemas/z";
import type { UndoNode, UndoSnapshot } from "../../src/schemas/undo";
import { validBookmarkMeta, validTagDef } from "./meta";

/** A removed leaf bookmark. */
export const undoLeafNode = {
  id: "bm-100",
  parentId: "1",
  index: 3,
  title: "Example article",
  url: "https://example.com/article",
} satisfies z.input<typeof UndoNode>;

/** A removed folder carrying its subtree (children recurse the same shape). */
export const undoFolderNode = {
  id: "f-9",
  parentId: "1",
  index: 0,
  title: "Research",
  children: [
    {
      id: "f-10",
      parentId: "f-9",
      index: 0,
      title: "Nested folder",
      // The embedded copy must agree with its placement: this leaf sits
      // under "f-10" at position 0 (undoLeafNode's own parentId/index
      // describe where it lives in the bulk_move fixture instead).
      children: [{ ...undoLeafNode, parentId: "f-10", index: 0 }],
    },
  ],
} satisfies z.input<typeof UndoNode>;

/** Delete snapshot: a folder subtree plus the metadata rows on its nodes. */
export const validUndoSnapshot = {
  createdAt: "2026-09-26T11:00:00.000Z",
  kind: "delete",
  nodes: [undoFolderNode],
  meta: [{ ...validBookmarkMeta, id: "bm-100" }],
} satisfies z.input<typeof UndoSnapshot>;

/** Bulk move: nodes keep their original parentId/index for restore. */
export const undoBulkMoveSnapshot = {
  createdAt: "2026-09-26T11:05:00.000Z",
  kind: "bulk_move",
  nodes: [undoLeafNode],
  meta: [{ ...validBookmarkMeta, id: "bm-100" }],
} satisfies z.input<typeof UndoSnapshot>;

/** Merge: the loser nodes that were deleted, with their metadata. */
export const undoMergeSnapshot = {
  createdAt: "2026-09-26T11:10:00.000Z",
  kind: "merge",
  nodes: [
    { ...undoLeafNode, id: "bm-200", index: 5 },
    { ...undoLeafNode, id: "bm-201", index: 8 },
  ],
  meta: [
    { ...validBookmarkMeta, id: "bm-200" },
    { ...validBookmarkMeta, id: "bm-201" },
  ],
} satisfies z.input<typeof UndoSnapshot>;

/**
 * Tag delete: no nodes are removed, but every BookmarkMeta row that referenced
 * the tag is snapshotted, and `tagDef` carries the definition so the tag can
 * be recreated.
 */
export const undoTagDeleteSnapshot = {
  createdAt: "2026-09-26T11:15:00.000Z",
  kind: "tag_delete",
  nodes: [],
  meta: [
    { ...validBookmarkMeta, id: "bm-100", tags: ["reading list"] },
    { ...validBookmarkMeta, id: "bm-201", tags: ["reading list", "typescript"] },
  ],
  tagDef: validTagDef,
} satisfies z.input<typeof UndoSnapshot>;

/** Each entry violates exactly one rule while staying a typed input. */
export const invalidUndoSnapshots = {
  // The only kind-specific cross-field rule: tag_delete needs its tagDef.
  tagDeleteWithoutTagDef: {
    createdAt: "2026-09-26T11:15:00.000Z",
    kind: "tag_delete",
    nodes: [],
    meta: [],
  },
  negativeIndex: {
    ...validUndoSnapshot,
    nodes: [{ ...undoLeafNode, index: -1 }],
  },
  fractionalIndex: {
    ...validUndoSnapshot,
    nodes: [{ ...undoLeafNode, index: 1.5 }],
  },
  emptyUrlString: {
    ...validUndoSnapshot,
    nodes: [{ ...undoLeafNode, url: "" }],
  },
  nonIsoCreatedAt: { ...validUndoSnapshot, createdAt: "earlier today" },
} satisfies Record<string, z.input<typeof UndoSnapshot>>;

/** Entries that do not satisfy the input type shape or strictness. */
export const malformedUndoSnapshots = {
  bogusKind: { ...validUndoSnapshot, kind: "delete_all" },
  nodeMissingParentId: {
    ...validUndoSnapshot,
    nodes: [{ id: "bm-1", index: 0, title: "orphan" }],
  },
  negativeId: { ...validUndoSnapshot, id: -1 },
  extraSecretField: { ...validUndoSnapshot, decisions: [] },
} satisfies Record<string, unknown>;
