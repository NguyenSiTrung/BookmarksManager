import type { z } from "../../src/schemas/z";
import type { AuditEvent } from "../../src/schemas/audit";
import type { Job } from "../../src/schemas/job";
import type { UsageRecord } from "../../src/schemas/usage";

/**
 * Fixtures for the Phase 4 Dexie v3 schemas: `jobs` (FR7), `audit` (FR6),
 * and `usage` (FR8). Valid entries are typed `z.input` so a schema change
 * breaks compilation here; invalid entries violate exactly one rule while
 * staying type-valid; malformed entries break the input shape or strictness
 * and are typed `unknown` for the same reason as `tests/fixtures/undo.ts`.
 */

// --- jobs -----------------------------------------------------------------

/** A running library scan with a full progress block and usage summary. */
export const validJob = {
  id: "b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  kind: "library_scan",
  status: "running",
  progress: { totalBatches: 10, committedBatches: 3, processedCount: 300 },
  bookmarkIds: ["bm-001", "bm-002"],
  usage: { inputTokens: 4_500, outputTokens: 1_200, costUsd: 0.0002, requests: 3 },
  createdAt: "2026-09-27T09:00:00.000Z",
  updatedAt: "2026-09-27T09:05:00.000Z",
} satisfies z.input<typeof Job>;

/** A freshly queued selection analysis that resumes from a cursor. */
export const minimalJob = {
  id: "c2b3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  kind: "analyze_selection",
  status: "pending",
  progress: { totalBatches: 0, committedBatches: 0, processedCount: 0 },
  cursor: 0,
  usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  createdAt: "2026-09-27T09:00:00.000Z",
  updatedAt: "2026-09-27T09:00:00.000Z",
} satisfies z.input<typeof Job>;

/** A failed job carrying its error text. */
export const failedJob = {
  ...validJob,
  status: "failed",
  error: "provider returned 503",
} satisfies z.input<typeof Job>;

/** Each entry violates exactly one rule while staying a typed input. */
export const invalidJobs = {
  // A job must be resumable: no bookmark id set and no cursor.
  noResumePoint: {
    ...minimalJob,
    cursor: undefined,
  },
  emptyBookmarkIds: { ...validJob, bookmarkIds: [] },
  committedExceedsTotal: {
    ...validJob,
    progress: { totalBatches: 2, committedBatches: 3, processedCount: 300 },
  },
  negativeProcessed: {
    ...validJob,
    progress: { totalBatches: 10, committedBatches: 3, processedCount: -1 },
  },
  fractionalBatches: {
    ...validJob,
    progress: { totalBatches: 10, committedBatches: 1.5, processedCount: 300 },
  },
  negativeTokens: {
    ...validJob,
    usage: { ...validJob.usage, inputTokens: -1 },
  },
  negativeCost: {
    ...validJob,
    usage: { ...validJob.usage, costUsd: -0.01 },
  },
  nonIsoUpdatedAt: { ...validJob, updatedAt: "this morning" },
} satisfies Record<string, z.input<typeof Job>>;

/** Entries that do not satisfy the input type shape or strictness. */
export const malformedJobs = {
  bogusKind: { ...validJob, kind: "restructure" },
  bogusStatus: { ...validJob, status: "done" },
  missingProgress: {
    id: validJob.id,
    kind: validJob.kind,
    status: validJob.status,
    bookmarkIds: validJob.bookmarkIds,
    usage: validJob.usage,
    createdAt: validJob.createdAt,
    updatedAt: validJob.updatedAt,
  },
  nonUuidId: { ...validJob, id: "job-1" },
  extraSecretField: { ...validJob, bookmarkTitles: ["secret"] },
} satisfies Record<string, unknown>;

// --- audit ----------------------------------------------------------------

/** One user-driven decision status change. */
export const validAuditEvent = {
  decisionId: "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a",
  from: "pending",
  to: "approved",
  actor: "user",
  changedAt: "2026-09-27T09:10:00.000Z",
} satisfies z.input<typeof AuditEvent>;

/** One policy-driven (auto-apply) status change. */
export const policyAuditEvent = {
  decisionId: "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a",
  from: "pending",
  to: "auto_applied",
  actor: "policy",
  changedAt: "2026-09-27T09:11:00.000Z",
} satisfies z.input<typeof AuditEvent>;

/** Each entry violates exactly one rule while staying a typed input. */
export const invalidAuditEvents = {
  // A status CHANGE cannot have identical endpoints.
  sameStatus: { ...validAuditEvent, to: "pending" as const },
  nonIsoChangedAt: { ...validAuditEvent, changedAt: "yesterday" },
  nonPositiveId: { ...validAuditEvent, id: 0 },
  nonUuidDecisionId: { ...validAuditEvent, decisionId: "decision-1" },
} satisfies Record<string, z.input<typeof AuditEvent>>;

/** Entries that do not satisfy the input type shape or strictness. */
export const malformedAuditEvents = {
  bogusActor: { ...validAuditEvent, actor: "system" },
  bogusStatus: { ...validAuditEvent, to: "queued" },
  missingDecisionId: {
    from: validAuditEvent.from,
    to: validAuditEvent.to,
    actor: validAuditEvent.actor,
    changedAt: validAuditEvent.changedAt,
  },
  // Audit rows must never carry bookmark content.
  carriesBookmarkTitle: { ...validAuditEvent, bookmarkTitle: "My bank" },
} satisfies Record<string, unknown>;

// --- usage ----------------------------------------------------------------

/** A per-request usage row linked to a job, with a reported cost. */
export const validUsageRecord = {
  jobId: "b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  model: "jev-1.13.0",
  inputTokens: 1_500,
  outputTokens: 400,
  costUsd: 0.00006,
  recordedAt: "2026-09-27T09:12:00.000Z",
} satisfies z.input<typeof UsageRecord>;

/** A standalone request with no job link and no provider-reported cost. */
export const minimalUsageRecord = {
  model: "jev-1.13.0",
  inputTokens: 3_000,
  outputTokens: 0,
  recordedAt: "2026-09-27T09:13:00.000Z",
} satisfies z.input<typeof UsageRecord>;

/** Each entry violates exactly one rule while staying a typed input. */
export const invalidUsageRecords = {
  negativeInputTokens: { ...validUsageRecord, inputTokens: -1 },
  fractionalOutputTokens: { ...validUsageRecord, outputTokens: 1.5 },
  negativeCost: { ...validUsageRecord, costUsd: -0.01 },
  nonIsoRecordedAt: { ...validUsageRecord, recordedAt: "later" },
  nonUuidJobId: { ...validUsageRecord, jobId: "job-1" },
} satisfies Record<string, z.input<typeof UsageRecord>>;

/** Entries that do not satisfy the input type shape or strictness. */
export const malformedUsageRecords = {
  emptyModel: { ...validUsageRecord, model: "" },
  missingModel: {
    jobId: validUsageRecord.jobId,
    inputTokens: validUsageRecord.inputTokens,
    outputTokens: validUsageRecord.outputTokens,
    recordedAt: validUsageRecord.recordedAt,
  },
  extraSecretField: { ...validUsageRecord, prompt: "raw text" },
} satisfies Record<string, unknown>;
