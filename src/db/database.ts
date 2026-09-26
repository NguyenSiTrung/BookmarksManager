import Dexie, { type Table } from "dexie";
import type { Decision } from "../schemas/decision";
import type { BookmarkMeta, TagDef } from "../schemas/meta";
import type { ConsentRecord } from "../schemas/provider";
import type { UndoSnapshot } from "../schemas/undo";

/**
 * Settings row. `key` is a stable lookup string — ProviderSettings rows use
 * the PresetId as their key. `value` is untyped on storage; readers validate
 * with the matching Zod schema at the trust boundary.
 */
export interface MetadataEntry {
  key: string;
  value: unknown;
}

/**
 * Audit row for one outbound request (track spec §3): records the time,
 * destination, feature, and request field names — never request contents,
 * auth headers, keys, or bookmark data. `id` is assigned by IndexedDB.
 */
export interface SentLogEntry {
  id?: number;
  sentAt: string;
  destination: string;
  feature: string;
  fieldNames: string[];
}

/**
 * Non-extractable WebCrypto key material. `id` is a stable string such as
 * `"provider:<preset>"` so the worker can find and delete a preset's key.
 */
export interface KeyMaterialEntry {
  id: string;
  key: CryptoKey;
}

export class BookmarksManagerDB extends Dexie {
  // `declare` keeps these off emitted class fields; Dexie assigns them in
  // the version().stores() declarations below.
  declare metadata: Table<MetadataEntry, string>;
  declare decisions: Table<Decision, string>;
  declare consents: Table<ConsentRecord, [string, string]>;
  declare sentLog: Table<SentLogEntry, number>;
  declare keyMaterials: Table<KeyMaterialEntry, string>;
  declare bookmarkMeta: Table<BookmarkMeta, string>;
  declare tags: Table<TagDef, string>;
  declare undo: Table<UndoSnapshot, number>;

  constructor() {
    super("BookmarksManager");
    this.version(1).stores({
      // Settings keyed by a caller-chosen string (ProviderSettings: PresetId).
      metadata: "key",
      // Decisions keyed by their uuid; status + createdAt indexed for review
      // queues and chronological listing.
      decisions: "id,status,createdAt",
      // One consent row per (scope, origin); acceptedAt indexed for audits.
      consents: "[scope+origin],acceptedAt",
      // Append-only audit log with auto-incremented row ids.
      sentLog: "++id,sentAt",
      // CryptoKey handles persisted via structured clone under a stable id.
      keyMaterials: "id",
    });
    this.version(2).stores({
      // Extension-owned metadata, one row per Chrome bookmark node id;
      // *tags is a multiEntry index over tag nameKeys so tag → bookmark
      // lookups don't require a full-table scan.
      bookmarkMeta: "id,*tags,category,updatedAt",
      // TagDef rows keyed by their case-insensitive nameKey.
      tags: "nameKey",
      // LIFO undo snapshots; ++id is the recency order, createdAt indexed.
      undo: "++id,createdAt",
    });
  }
}

export const db = new BookmarksManagerDB();
