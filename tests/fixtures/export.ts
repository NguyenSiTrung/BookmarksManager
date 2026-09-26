import type { z } from "../../src/schemas/z";
import type { ExportEnvelope, ExportTreeNode } from "../../src/schemas/export";
import { validBookmarkMeta, validTagDef } from "./meta";

/** One top-level folder with a leaf and a nested folder inside. */
export const exportFolderNode = {
  id: "1",
  title: "Bookmarks bar",
  children: [
    {
      id: "bm-001",
      title: "Example article",
      url: "https://example.com/article",
    },
    {
      id: "f-1",
      title: "Reading",
      children: [
        {
          id: "bm-002",
          title: "Deep leaf",
          url: "https://example.com/deep",
        },
      ],
    },
  ],
} satisfies z.input<typeof ExportTreeNode>;

/**
 * Fully-populated v1 envelope. `meta` row ids reference `ExportTreeNode.id`
 * values so an importer can remap them to the new Chrome ids it creates.
 */
export const validExportEnvelope = {
  version: 1,
  exportedAt: "2026-09-26T12:00:00.000Z",
  tree: [exportFolderNode],
  tags: [validTagDef],
  meta: [validBookmarkMeta],
} satisfies z.input<typeof ExportEnvelope>;

/** An empty library still produces a valid envelope. */
export const minimalExportEnvelope = {
  version: 1,
  exportedAt: "2026-09-26T12:00:00.000Z",
  tree: [],
  tags: [],
  meta: [],
} satisfies z.input<typeof ExportEnvelope>;

/** Each entry violates one field rule while staying a typed input. */
export const invalidExportEnvelopes = {
  nonIsoExportedAt: { ...validExportEnvelope, exportedAt: "noon UTC" },
  // A nested meta row that fails its own schema (notes too long).
  invalidMetaRow: {
    ...validExportEnvelope,
    meta: [{ ...validBookmarkMeta, notes: "n".repeat(10_001) }],
  },
  // A nested tag def that fails its own schema (bad nameKey).
  invalidTagRow: {
    ...validExportEnvelope,
    tags: [{ ...validTagDef, nameKey: "Reading List" }],
  },
} satisfies Record<string, z.input<typeof ExportEnvelope>>;

/**
 * Entries that do not satisfy the input type shape: wrong `version` literal,
 * missing required fields, and secret-bearing extra keys. Every strict object
 * level — envelope, tree node, tag def, meta row — rejects unknown keys.
 */
export const malformedExportEnvelopes = {
  versionTwo: { ...validExportEnvelope, version: 2 },
  missingVersion: {
    exportedAt: "2026-09-26T12:00:00.000Z",
    tree: [],
    tags: [],
    meta: [],
  },
  smuggledKeys: { ...validExportEnvelope, keys: ["sk-live-000"] },
  smuggledConsents: { ...validExportEnvelope, consents: [] },
  smuggledSentLog: { ...validExportEnvelope, sentLog: [] },
  smuggledKeyMaterials: { ...validExportEnvelope, keyMaterials: [] },
  smuggledDecisions: { ...validExportEnvelope, decisions: [] },
  smuggledProvider: {
    ...validExportEnvelope,
    providerSettings: { preset: "typesafe", model: "jev-latest" },
  },
  nodeExtraField: {
    ...validExportEnvelope,
    tree: [{ id: "0", title: "Root", keyMaterial: "bytes" }],
  },
  metaExtraField: {
    ...validExportEnvelope,
    meta: [{ ...validBookmarkMeta, apiKey: "sk-live-000" }],
  },
  tagExtraField: {
    ...validExportEnvelope,
    tags: [{ ...validTagDef, sentLog: [] }],
  },
} satisfies Record<string, unknown>;
