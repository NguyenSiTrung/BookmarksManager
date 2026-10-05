import { z } from "./z";

/**
 * Persisted provider-usage rows (spec FR8, PROJECT_PLAN.md §7/§9.5). One row
 * per outbound request records the token counts, the USD cost when the
 * provider reported one, and the model that answered; `jobId` links the
 * request back to the batch job that issued it (absent for standalone
 * requests such as an "Ask" re-rank or an on-save suggestion). The rows are
 * the raw material for the running cost totals shown in the side panel and
 * Options.
 *
 * `id` is auto-incremented by IndexedDB (`++id`); `jobId` and `recordedAt`
 * are indexed for per-job roll-ups and chronological listing.
 */

/**
 * One `usage` row. `costUsd` is optional because only some providers
 * (OpenRouter) report a cost — absent means "not reported", never "$0.00".
 * `jobId` is absent for requests that do not belong to a job.
 */
export const UsageRecord = z.strictObject({
  id: z.number().int().positive().optional(), // assigned by IndexedDB
  jobId: z.uuid().optional(),
  model: z.string().min(1),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
  recordedAt: z.iso.datetime(),
  /**
   * UTC `YYYY-MM` derived from `recordedAt` at write time (A08). Indexed so
   * monthly compaction folds only expired months; absent only on rows
   * persisted before the v5 upgrade — the upgrade backfills it.
   */
  month: z.string().regex(/^\d{4}-\d{2}$|NaN-NaN/).optional(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/**
 * One `llmUsage` row — per-request accounting for the dynamic LLM layer
 * (spec FR7.1). `providerId` scopes spend per provider; `feature` is the
 * consent scope that authorized the request (e.g. `llm_explain`). Both the
 * configured and returned model ids are recorded (spec FR4.6).
 *
 * Cost provenance is derivable, never stored: `costUsd` present →
 * provider-reported; `estimatedCostUsd` present → locally estimated from
 * configured rates; neither → unknown (never rendered as $0.00);
 * `notBilled === true` → not billed (a pre-response provider rejection,
 * e.g. a capability-probe refusal — egressed traffic recorded, excluded
 * from the monthly cap).
 */
export const LlmUsageRecord = z.strictObject({
  id: z.number().int().positive().optional(), // assigned by IndexedDB
  providerId: z.string().min(1),
  feature: z.string().min(1),
  model: z.string().min(1),
  configuredModel: z.string().min(1),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0).optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  notBilled: z.boolean().optional(),
  recordedAt: z.iso.datetime(),
  /** UTC `YYYY-MM` derived from `recordedAt` at write time (A08). */
  month: z.string().regex(/^\d{4}-\d{2}$|NaN-NaN/).optional(),
});
export type LlmUsageRecord = z.infer<typeof LlmUsageRecord>;

/**
 * One `usageMonths` row (A08): the folded per-(job, month) aggregate of
 * `usage` rows from an EXPIRED month. `key` is `${jobId}|${month}` or
 * `|${month}` for job-less rows (Ask rerank, save-suggest). Rows are
 * written only by the compaction sweep, inside the same transaction as the
 * usage insert that triggered it, so a month is compacted at most once.
 */
export const UsageMonthRollup = z.strictObject({
  key: z.string().min(1),
  /** Absent on the job-less rollup rows. */
  jobId: z.uuid().optional(),
  month: z.string().min(1),
  requests: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Sum of the rows' reported costs; absent = none reported one. */
  costUsd: z.number().min(0).optional(),
  /** Rows that reported no cost — never rendered as $0. */
  unpricedRequests: z.number().int().min(0),
});
export type UsageMonthRollup = z.infer<typeof UsageMonthRollup>;

/**
 * One `llmUsageMonths` row (A08): the folded per-(provider, month)
 * aggregate of `llmUsage` rows from an EXPIRED month, `key` =
 * `${providerId}|${month}`. Field names mirror
 * `MonthlyBudgetSnapshot` so all-time totals recompose without raw rows;
 * `notBilledRequests` stays distinct (a raw snapshot read reproduces as
 * `unknownCostRequests + notBilledRequests`) so the provably-unsent
 * A05 semantic survives the fold.
 */
export const LlmUsageMonthRollup = z.strictObject({
  key: z.string().min(1),
  providerId: z.string().min(1),
  month: z.string().min(1),
  requests: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  reportedCostUsd: z.number().min(0),
  estimatedCostUsd: z.number().min(0),
  unknownCostRequests: z.number().int().min(0),
  notBilledRequests: z.number().int().min(0),
});
export type LlmUsageMonthRollup = z.infer<typeof LlmUsageMonthRollup>;
