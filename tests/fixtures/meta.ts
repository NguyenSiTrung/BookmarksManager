import type { z } from "../../src/schemas/z";
import type { BookmarkMeta, TagDef } from "../../src/schemas/meta";

/**
 * Fully-populated metadata row. `tags` holds nameKeys (the trim+lowercase
 * forms of the tag names), matching BookmarkMeta's contract.
 */
export const validBookmarkMeta = {
  id: "bm-001",
  tags: ["typescript", "reading list"],
  category: "docs",
  notes: "Reference for the migration writeup.",
  updatedAt: "2026-09-26T10:00:00.000Z",
} satisfies z.input<typeof BookmarkMeta>;

/**
 * Lazy-row case: a bookmark with only an id and a timestamp — `tags` is
 * absent so tests can assert the [] default.
 */
export const minimalBookmarkMeta = {
  id: "bm-002",
  updatedAt: "2026-09-26T10:05:00.000Z",
} satisfies z.input<typeof BookmarkMeta>;

/** Each entry violates exactly one field rule while staying a typed input. */
export const invalidBookmarkMetas = {
  notesTooLong: { ...validBookmarkMeta, notes: "n".repeat(10_001) },
  nonKeyTag: { ...validBookmarkMeta, tags: ["TypeScript"] },
  emptyTagKey: { ...validBookmarkMeta, tags: [""] },
  nonIsoUpdatedAt: { ...validBookmarkMeta, updatedAt: "last Tuesday" },
} satisfies Record<string, z.input<typeof BookmarkMeta>>;

/** Entries that do not even satisfy the input type shape or strictness. */
export const malformedBookmarkMetas = {
  unknownCategory: { ...validBookmarkMeta, category: "not-a-category" },
  extraSecretField: { ...validBookmarkMeta, apiKey: "sk-live-000" },
} satisfies Record<string, unknown>;

export const validTagDef = {
  name: "Reading List",
  nameKey: "reading list",
  color: "#3178c6",
  description: "Long-form articles to read later.",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
} satisfies z.input<typeof TagDef>;

export const minimalTagDef = {
  name: "typescript",
  nameKey: "typescript",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
} satisfies z.input<typeof TagDef>;

/** Each entry violates exactly one rule while staying a typed input. */
export const invalidTagDefs = {
  // name fails min(1); nameKey "" mirrors what the derivation would produce.
  emptyName: { ...validTagDef, name: "", nameKey: "" },
  nameTooLong: {
    ...validTagDef,
    name: "n".repeat(65),
    nameKey: "n".repeat(65),
  },
  // Whitespace-only names derive "" which can never be a valid nameKey.
  blankName: { ...validTagDef, name: "   ", nameKey: "" },
  descriptionTooLong: { ...validTagDef, description: "d".repeat(301) },
  // Valid format, but not the key derived from this name (case-insensitive
  // uniqueness requires nameKey === tagNameKey(name)).
  nameKeyMismatch: { ...validTagDef, nameKey: "reading lists" },
  // Not the trim+lowercase form — fails the nameKey format rule.
  nameKeyNotLowercase: { ...validTagDef, nameKey: "Reading List" },
} satisfies Record<string, z.input<typeof TagDef>>;

/** Entries that do not satisfy the input type shape or strictness. */
export const malformedTagDefs = {
  missingNameKey: {
    name: "Reading List",
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
  },
  extraSecretField: { ...validTagDef, keyMaterial: "raw-key-bytes" },
} satisfies Record<string, unknown>;
