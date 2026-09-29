import type {
  LlmProviderSettings,
  LlmPresetId,
  ModelPricing,
} from "../schemas/llm";
import { LLM_PRESETS } from "./providers";

/**
 * Built-in per-token pricing for the curated preset providers.
 *
 * Why this exists: the reservation engine must know a request's estimated
 * cost *before* it is sent, and automatic (unattended) requests refuse to
 * run at all without pricing (`reserveBudget` → `pricing_required`). Before
 * this table a preset provider could never satisfy that — `pricing` is a
 * field of the *custom* variant only — so automatic escalation was
 * unreachable on OpenAI/OpenRouter presets no matter what the user set.
 *
 * Scope: the preset's own default model, which is what a fresh setup uses.
 * Every other model id falls back to "unpriced" and refuses automatic
 * requests until the user enters prices in Options — the provider preset
 * variant now accepts a manual `pricing` override for exactly that case.
 * A wrong built-in price would silently mis-estimate the monthly cap, so
 * the table stays deliberately small and every entry is verified against
 * the provider's own published rate.
 *
 * Sources (checked {@link PRESET_PRICING_VERIFIED_ON}): OpenAI's published
 * per-million-token list price, and OpenRouter's live `/api/v1/models`
 * response (`pricing.prompt` / `pricing.completion`), which resells the
 * OpenAI model at the same rate. Drift is self-correcting where the
 * provider reports actual cost: `reconcileBudget` prefers a reported cost
 * over the estimate, so only the *pre*request reservation uses this table.
 */
export const PRESET_PRICING_VERIFIED_ON = "2026-09-29";

/**
 * Built-in per-token pricing for the curated preset providers. Declared as a
 * wide `Record<string, ModelPricing>` lookup: the model id a preset sends is
 * user-typed, so an unknown id must simply miss the table.
 */
export const PRESET_MODEL_PRICING: Readonly<
  Record<LlmPresetId, Readonly<Record<string, ModelPricing>>>
> = {
  openai: {
    "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  },
  openrouter: {
    "openai/gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  },
};

/** The model id a preset provider actually sends to (see `resolveLlmDestination`). */
function effectiveModel(settings: {
  preset: LlmPresetId;
  model?: string | undefined;
}): string {
  return settings.model ?? LLM_PRESETS[settings.preset].defaultModel;
}

/**
 * The per-token pricing a provider's requests are reserved against, or
 * `undefined` when the provider is unpriced (automatic requests then refuse
 * with `pricing_required`; manual ones need the unknown-cost confirmation).
 *
 * A user-entered `pricing` always wins — for a custom endpoint it is the
 * only source, and for a preset it overrides the built-in entry so a user
 * on a different model or a re-priced model can stay accurate.
 */
export function resolveProviderPricing(
  settings: LlmProviderSettings,
): ModelPricing | undefined {
  if (settings.pricing !== undefined) return settings.pricing;
  if (settings.kind !== "preset") return undefined;
  return PRESET_MODEL_PRICING[settings.preset][effectiveModel(settings)];
}
