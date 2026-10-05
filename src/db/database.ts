import Dexie, { type Table } from "dexie";
import type { BudgetReservation } from "../llm/budget";
import type { AuditEvent } from "../schemas/audit";
import type { Decision } from "../schemas/decision";
import type { Job } from "../schemas/job";
import type {
  BookmarkMeta,
  CorruptMetaRow,
  MetaTombstone,
  TagDef,
} from "../schemas/meta";
import type { ConsentRecord } from "../schemas/provider";
import type { RestructureAssignment } from "../schemas/restructure";
import type { UndoSnapshot } from "../schemas/undo";
import type {
  LlmUsageMonthRollup,
  LlmUsageRecord,
  UsageMonthRollup,
  UsageRecord,
} from "../schemas/usage";

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
 * Closed, content-free outcome vocabulary for an outbound attempt.
 * `retried` means the retry policy selected another attempt; its admission
 * may still refuse that attempt. HTTP statuses are validated by the writer.
 */
export type SentLogOutcome =
  | "ok"
  | "retried"
  | "timeout"
  | "aborted"
  | "redirect"
  | "transport"
  | `http_${number}`;

/**
 * Audit row for one outbound attempt (track spec §3): records dispatch time,
 * destination, feature, request field names, and outcome — never request contents,
 * auth headers, keys, or bookmark data. `id` is assigned by IndexedDB.
 */
export interface SentLogEntry {
  id?: number;
  sentAt: string;
  destination: string;
  feature: string;
  fieldNames: string[];
  /** Absent on legacy rows or a dispatch whose outcome is not yet known. */
  outcome?: SentLogOutcome;
}

/**
 * One committed Jev folder assignment for a `restructure` job (J13). The
 * compound primary key (jobId, bookmarkId) makes the per-item merge a
 * constant-cost upsert — last write wins — instead of rewriting the whole
 * inline `job.restructure.assignments` array per item; `jobId` is indexed so
 * one job's rows list without a table scan.
 */
export interface RestructureAssignmentRow extends RestructureAssignment {
  jobId: string;
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
  declare jobs: Table<Job, string>;
  declare audit: Table<AuditEvent, number>;
  declare usage: Table<UsageRecord, number>;
  declare usageMonths: Table<UsageMonthRollup, string>;
  declare llmUsage: Table<LlmUsageRecord, number>;
  declare llmUsageMonths: Table<LlmUsageMonthRollup, string>;
  declare llmReservations: Table<BudgetReservation, string>;
  declare restructureAssignments: Table<RestructureAssignmentRow, [string, string]>;
  declare metaTombstones: Table<MetaTombstone, string>;
  declare corruptMeta: Table<CorruptMetaRow, number>;

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
    this.version(3).stores({
      // Persisted, resumable batch jobs (FR7); keyed by caller-generated
      // uuid, with status indexed for the queue and createdAt for listing.
      jobs: "id,status,createdAt",
      // Append-only decision audit log (FR6): ++id is append order,
      // decisionId gives per-decision history, changedAt is chronological.
      audit: "++id,decisionId,changedAt",
      // Per-request usage rows (FR8): ++id is append order, jobId rolls up
      // per job, recordedAt is chronological.
      usage: "++id,jobId,recordedAt",
    });
    this.version(4).stores({
      // Per-request usage rows for the dynamic LLM layer (LLM spec FR7):
      // ++id is append order, providerId scopes monthly roll-ups,
      // recordedAt is chronological.
      llmUsage: "++id,providerId,recordedAt",
      // Active/settled/released budget reservations (LLM spec FR7.5-7);
      // caller-generated ids, providerId + status indexed so a provider can
      // sweep its pending reservations on revoke.
      llmReservations: "id,providerId,status",
    });
    this.version(5)
      .stores({
        // A08: `month` (UTC YYYY-MM derived from `recordedAt`) is
        // materialized and indexed so monthly compaction folds expired
        // months without a full-table scan; `jobId`+`month` index the
        // folded per-(job, month) rollup rows.
        usage: "++id,jobId,recordedAt,month",
        usageMonths: "key,jobId,month",
        // `[providerId+month]` lets the budget transaction read exactly the
        // current month for one provider — no all-history scan.
        llmUsage: "++id,providerId,recordedAt,month,[providerId+month]",
        llmUsageMonths: "key,providerId,month",
        // `month` single-keyed so prune-on-write can range over expired
        // months; `[providerId+month]` narrows the budget read.
        llmReservations: "id,providerId,status,month,[providerId+month]",
      })
      .upgrade(async (tx) => {
        // Backfill `month` on rows persisted before the index existed, so
        // they stay readable and compactible; NaN input yields "NaN-NaN",
        // which sorts but never matches a real month.
        const monthOf = (recordedAt: unknown): string => {
          const date = new Date(typeof recordedAt === "string" ? recordedAt : 0);
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, "0");
          return `${year}-${month}`;
        };
        await tx.table("usage").toCollection().modify((row) => {
          row.month = monthOf(row.recordedAt);
        });
        await tx.table("llmUsage").toCollection().modify((row) => {
          row.month = monthOf(row.recordedAt);
        });
      });
    this.version(6).stores({
      // J13: restructure assignments live in their own table keyed
      // (jobId, bookmarkId) — per-item writes are constant-cost upserts, so
      // job-row writes drop to O(batches) instead of O(assignments²).
      // `jobId` lists one job's rows; rows cascade with the job on prune.
      restructureAssignments: "[jobId+bookmarkId],jobId",
      // `[kind+createdAt]` serves latestRestructureJob with a single index
      // read (`.last()`) — no full jobs-table scan.
      jobs: "id,status,createdAt,[kind+createdAt]",
    });
    this.version(7).stores({
      // D12: removed bookmarks' metadata, keyed by URL so a re-created
      // bookmark re-attaches it; `removedAt` indexed for the 30-day
      // retention prune.
      metaTombstones: "url,removedAt",
      // D13: forensic copies of schema-invalid bookmarkMeta rows — never
      // overwritten/deleted without a copy landing here first; bounded.
      corruptMeta: "++id,retainedAt",
    });
  }
}

export const db = new BookmarksManagerDB();
