import { LOOPBACK_HOSTS, LlmBaseUrl } from "./llm";
import { z } from "./z";
import { RELEASE_JEV_MODELS } from "../decisions/release-policy";

/**
 * Jev provider presets — the curated destinations (PROJECT_PLAN.md §8.1).
 * A Jev provider id is either one of these or {@link CUSTOM_PROVIDER_ID},
 * the single user-configured System One-compatible endpoint slot.
 */
export const PresetId = z.enum(["typesafe", "openrouter"]);
export type PresetId = z.infer<typeof PresetId>;

/**
 * The provider id of the user-configured Jev endpoint. Custom providers are
 * third-party gateways that serve the Jev model over the same System One
 * protocol (e.g. an AI gateway fronting TypeSafe): the user supplies the
 * canonical API base URL and the model id, and the extension POSTs to
 * `<baseUrl>/systemone` — the same `<api-root>/systemone` convention the
 * presets use. One slot, like each preset has one.
 */
export const CUSTOM_PROVIDER_ID = "custom" as const;

/** Every id a Jev provider may be addressed by — a preset or `custom`. */
export const JevProviderId = z.union([PresetId, z.literal(CUSTOM_PROVIDER_ID)]);
export type JevProviderId = z.infer<typeof JevProviderId>;

/** Every Jev provider id in stable order: presets first, `custom` last. */
export const JEV_PROVIDER_IDS = [
  ...PresetId.options,
  CUSTOM_PROVIDER_ID,
] as const;

/** Models each preset is allowed to use (PROJECT_PLAN.md §8.1). */
export const PRESET_MODELS = {
  typesafe: ["jev-latest", "jev-preview", "jev-1.13.0"],
  openrouter: ["jev-latest", "jev-1.13", "typesafe/jev-1.13"],
} as const satisfies Record<PresetId, readonly string[]>;

/**
 * The model each preset's picker starts on — the pinned release id from
 * `RELEASE_JEV_MODELS`, never a moving alias. The release baselines (eval
 * harness + thresholds) are tuned against these ids, so defaulting to an
 * alias would put fresh installs on an unpinned model the thresholds were
 * not validated for. Stored settings still validate against
 * `PRESET_MODELS`; this constant only governs the default.
 */
export const DEFAULT_PROVIDER_MODEL = {
  typesafe: RELEASE_JEV_MODELS.typesafe.request,
  openrouter: RELEASE_JEV_MODELS.openrouter.request,
} as const satisfies Record<PresetId, string>;

/**
 * Persisted provider configuration, stored in the Dexie `metadata` table
 * keyed by provider id (`typesafe`, `openrouter`, or `custom`). The preset
 * variant's `model` is validated against the owning preset's allowlist via
 * superRefine; the custom variant carries the canonical base URL and a
 * free-form model id. `keySuffix` is a short masked display hint (e.g. the
 * last four characters) and must never hold a raw API key. Strict objects
 * reject unknown keys so misconfigured or hostile stored rows fail closed.
 */
const PresetProviderSettings = z
  .strictObject({
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

const CustomProviderSettings = z.strictObject({
  preset: z.literal(CUSTOM_PROVIDER_ID),
  baseUrl: LlmBaseUrl,
  model: z.string().trim().min(1),
  keySuffix: z.string().min(1).max(8),
});

/**
 * A raw provider API key as it may cross the message boundary (H02). Outer
 * whitespace is trimmed before anything stores or displays it, then the key
 * must be printable non-space ASCII — embedded spaces, newlines, and
 * control characters are rejected rather than silently stored, so a key
 * that cannot round-trip is caught here instead of at the provider.
 */
export const ProviderApiKey = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^[\x21-\x7e]+$/,
    "API key must contain only printable characters with no spaces",
  );

export const ProviderSettings = z.discriminatedUnion("preset", [
  PresetProviderSettings,
  CustomProviderSettings,
]);
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

// --- Phase 5: optional LLM provider scopes --------------------------------
// LLM scopes are granted per *dynamic* provider origin (preset or
// user-configured), not per Jev preset. `jev_summary_verify` is the one LLM
// flow whose destination is a Jev provider: it re-checks consent at the Jev
// origin under its own scope (spec FR10.5).

/** Fixed synthetic test request to the configured LLM provider. */
export const LLM_TEST_SCOPE = "llm_test" as const;
/** Plain-language explanation of a review-queue decision (FR5). */
export const LLM_EXPLAIN_SCOPE = "llm_explain" as const;
/** Budget-capped second opinion on low-confidence decisions (FR6). */
export const LLM_ESCALATE_SCOPE = "llm_escalate" as const;
/** Folder restructure proposals (FR8). */
export const LLM_RESTRUCTURE_SCOPE = "llm_restructure" as const;
/** Page summaries via opt-in extraction (FR9/FR10). */
export const LLM_SUMMARY_SCOPE = "llm_summary" as const;
/** Jev support-verification of an LLM summary — destination is Jev (FR10.5). */
export const JEV_SUMMARY_VERIFY_SCOPE = "jev_summary_verify" as const;

/** The scopes a dynamic LLM provider can be granted, in a stable order. */
export const LLM_CONSENT_SCOPES = [
  LLM_TEST_SCOPE,
  LLM_EXPLAIN_SCOPE,
  LLM_ESCALATE_SCOPE,
  LLM_RESTRUCTURE_SCOPE,
  LLM_SUMMARY_SCOPE,
  JEV_SUMMARY_VERIFY_SCOPE,
] as const;
export type LlmConsentScope = (typeof LLM_CONSENT_SCOPES)[number];

/**
 * Every consent scope this extension can hold, in a stable order. Scope
 * unions are derived from this tuple so a new scope is added in exactly one
 * place and every consumer (the `ConsentRecord` literal, the `SCOPES`
 * registry in `src/net/send.ts`, and the `store/` disclosures) fails to
 * compile until it is handled.
 */
export const CONSENT_SCOPES = [
  CONSENT_SCOPE,
  DECISIONS_CONSENT_SCOPE,
  ...LLM_CONSENT_SCOPES,
] as const;

/** The union of every registered consent scope. */
export const ConsentScope = z.enum(CONSENT_SCOPES);
export type ConsentScope = z.infer<typeof ConsentScope>;

/**
 * A canonical origin such as "https://api.typesafe.ai" or
 * "http://localhost:11434" — no path, query, or trailing slash — so records
 * compare cleanly against resolved destination origins. HTTP is accepted
 * only for loopback hosts (localhost, 127.0.0.1, [::1]); every remote
 * provider is HTTPS (spec FR2.3). The port is part of the origin, so two
 * loopback services never share a grant.
 */
const ConsentOrigin = z
  .url()
  .refine((value) => {
    // Zod v4 still runs checks after a failed base check, so guard the parse.
    try {
      const url = new URL(value);
      if (url.origin !== value) return false;
      if (url.protocol === "https:") return true;
      return (
        url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
      );
    } catch {
      return false;
    }
  }, "origin must be a canonical https:// origin, or a canonical http:// loopback origin (localhost, 127.0.0.1, [::1]), without path, query, or trailing slash");

/** Accept historical grant versions for durable storage; authorization
 * checks the shared current version in `src/consent/records.ts`. */
export const ConsentRecord = z.object({
  scope: ConsentScope,
  origin: ConsentOrigin,
  consentVersion: z.number().int().positive(),
  acceptedAt: z.iso.datetime(),
});
export type ConsentRecord = z.infer<typeof ConsentRecord>;
