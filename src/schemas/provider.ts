import { z } from "./z";

/** Jev provider presets — the only destinations this extension may reach
 * (PROJECT_PLAN.md §8.1). */
export const PresetId = z.enum(["typesafe", "openrouter"]);
export type PresetId = z.infer<typeof PresetId>;

/** Models each preset is allowed to use (PROJECT_PLAN.md §8.1). */
export const PRESET_MODELS = {
  typesafe: ["jev-latest", "jev-preview", "jev-1.13.0"],
  openrouter: ["jev-latest", "jev-1.13", "typesafe/jev-1.13"],
} as const satisfies Record<PresetId, readonly string[]>;

/**
 * Persisted provider configuration, stored in the Dexie `metadata` table
 * keyed by preset. `model` is validated against the owning preset's allowlist
 * via superRefine; `keySuffix` is a short masked display hint (e.g. the last
 * four characters) and must never hold a raw API key.
 */
export const ProviderSettings = z
  .object({
    preset: PresetId,
    model: z.string().min(1),
    keySuffix: z.string().min(1).max(8),
  })
  .superRefine((value, ctx) => {
    const allowed: readonly string[] = PRESET_MODELS[value.preset];
    if (!allowed.includes(value.model)) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: `model must be one of: ${allowed.join(", ")}`,
      });
    }
  });
export type ProviderSettings = z.infer<typeof ProviderSettings>;

/**
 * The synthetic Jev test-connection scope: a fixed probe that carries no
 * bookmark content. Kept as its own scope so the `jev_test` guard can stay
 * synthetic-only even after bookmark data starts flowing.
 */
export const CONSENT_SCOPE = "jev_test" as const;

/**
 * The per-provider bookmark-metadata consent scope (FR1). It covers every
 * Phase 4 decision feature (categorize, tags, folder pre-select,
 * near-duplicates, misfiled scan, search re-rank) under one grant per
 * provider origin.
 */
export const DECISIONS_CONSENT_SCOPE = "jev_decisions" as const;

/**
 * Every consent scope this extension can hold, in a stable order. Scope
 * unions are derived from this tuple so a new scope is added in exactly one
 * place and every consumer (the `ConsentRecord` literal, the `SCOPES`
 * registry in `src/net/send.ts`, and the `store/` disclosures) fails to
 * compile until it is handled.
 */
export const CONSENT_SCOPES = [CONSENT_SCOPE, DECISIONS_CONSENT_SCOPE] as const;

/** The union of every registered consent scope. */
export const ConsentScope = z.enum([CONSENT_SCOPE, DECISIONS_CONSENT_SCOPE]);
export type ConsentScope = z.infer<typeof ConsentScope>;

/**
 * A canonical HTTPS origin such as "https://api.typesafe.ai" — no path,
 * query, or trailing slash — so records compare cleanly against preset
 * registry origins.
 */
const HttpsOrigin = z
  .url()
  .refine((value) => {
    // Zod v4 still runs checks after a failed base check, so guard the parse.
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  }, "origin must be a canonical https:// origin without path, query, or trailing slash");

export const ConsentRecord = z.object({
  scope: ConsentScope,
  origin: HttpsOrigin,
  consentVersion: z.number().int().positive(),
  acceptedAt: z.iso.datetime(),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;
