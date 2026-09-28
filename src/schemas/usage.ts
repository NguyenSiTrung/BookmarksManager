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
 * configured rates; neither → unknown (never rendered as $0.00).
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
  recordedAt: z.iso.datetime(),
});
export type LlmUsageRecord = z.infer<typeof LlmUsageRecord>;
