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

/** The only consent scope this slice can grant: the synthetic Jev test call. */
export const CONSENT_SCOPE = "jev_test" as const;

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
  scope: z.literal(CONSENT_SCOPE),
  origin: HttpsOrigin,
  consentVersion: z.number().int().positive(),
  acceptedAt: z.iso.datetime(),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;
