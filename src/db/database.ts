import Dexie, { type Table } from "dexie";
import type { Decision } from "../schemas/decision";
import type { ConsentRecord } from "../schemas/provider";

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
  // version(1).stores() below.
  declare metadata: Table<MetadataEntry, string>;
  declare decisions: Table<Decision, string>;
  declare consents: Table<ConsentRecord, [string, string]>;
  declare sentLog: Table<SentLogEntry, number>;
  declare keyMaterials: Table<KeyMaterialEntry, string>;

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
  }
}

export const db = new BookmarksManagerDB();
