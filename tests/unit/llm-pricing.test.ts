import { describe, expect, it } from "vitest";
import { LLM_PRESETS } from "../../src/llm/providers";
import {
  PRESET_MODEL_PRICING,
  PRESET_PRICING_VERIFIED_ON,
  resolveProviderPricing,
} from "../../src/llm/pricing";
import type { LlmPresetId } from "../../src/schemas/llm";

const PRESETS = ["openai", "openrouter"] as const satisfies readonly LlmPresetId[];

describe("preset pricing table", () => {
  it.each(PRESETS)(
    "prices the %s preset's default model — the model a fresh setup sends",
    (preset) => {
      // Without this the reservation engine refuses every automatic request
      // with `pricing_required`, making escalation unreachable on presets.
      const pricing = resolveProviderPricing({
        kind: "preset",
        preset,
        model: LLM_PRESETS[preset].defaultModel,
      });
      expect(pricing).toBeDefined();
      expect(pricing!.inputPerMillion).toBeGreaterThan(0);
      expect(pricing!.outputPerMillion).toBeGreaterThan(0);
    },
  );

  it.each(PRESETS)("prices the %s preset with no explicit model", (preset) => {
    expect(resolveProviderPricing({ kind: "preset", preset })).toEqual(
      PRESET_MODEL_PRICING[preset][LLM_PRESETS[preset].defaultModel],
    );
  });

  it("records when the built-in rates were verified", () => {
    expect(PRESET_PRICING_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const preset of PRESETS) {
      for (const [model, pricing] of Object.entries(
        PRESET_MODEL_PRICING[preset],
      )) {
        expect(model.length).toBeGreaterThan(0);
        expect(pricing.inputPerMillion).toBeGreaterThan(0);
        expect(pricing.outputPerMillion).toBeGreaterThan(0);
      }
    }
  });

  it("leaves a preset model without a built-in price unpriced", () => {
    expect(
      resolveProviderPricing({
        kind: "preset",
        preset: "openai",
        model: "gpt-4o-mini-2024-07-18",
      }),
    ).toBeUndefined();
  });

  it("prefers a manual override over the built-in entry", () => {
    expect(
      resolveProviderPricing({
        kind: "preset",
        preset: "openai",
        model: LLM_PRESETS.openai.defaultModel,
        pricing: { inputPerMillion: 9, outputPerMillion: 9 },
      }),
    ).toEqual({ inputPerMillion: 9, outputPerMillion: 9 });
  });

  it("has no built-in price for custom endpoints", () => {
    expect(
      resolveProviderPricing({
        kind: "custom",
        baseUrl: "https://llm.example.com/v1",
        model: "llama-3",
        auth: "bearer",
      }),
    ).toBeUndefined();
    expect(
      resolveProviderPricing({
        kind: "custom",
        baseUrl: "https://llm.example.com/v1",
        model: "llama-3",
        auth: "bearer",
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      }),
    ).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
  });
});
