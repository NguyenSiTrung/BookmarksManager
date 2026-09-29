import { z } from "./z";

/**
 * Optional OpenAI-compatible LLM layer (Phase 5 spec FR1/FR2). Provider
 * configuration is either a curated preset or a custom OpenAI-compatible
 * endpoint; every remote destination must be HTTPS, with plain HTTP allowed
 * only for literal loopback hosts.
 */

export const LlmPresetId = z.enum(["openai", "openrouter"]);
export type LlmPresetId = z.infer<typeof LlmPresetId>;

/**
 * The user's spend-ceiling decision for a provider: a monthly `capped` USD
 * amount, an explicitly chosen `unlimited` ceiling, or `unset` — never
 * decided. Unattended (automatic) requests refuse while `unset`: an
 * unbounded background spend must be a choice, not a default.
 */
export const BudgetChoice = z.enum(["capped", "unlimited", "unset"]);
export type BudgetChoice = z.infer<typeof BudgetChoice>;

/**
 * The only authentication modes a provider may use. `bearer` sends
 * `Authorization: Bearer <token>`; `api-key` sends `api-key: <token>`;
 * `none` sends no credential header. Arbitrary headers are never allowed.
 */
export const LlmAuthMode = z.enum(["bearer", "api-key", "none"]);
export type LlmAuthMode = z.infer<typeof LlmAuthMode>;

/**
 * Structured-output capability tiers, strongest first (FR4): strict
 * `response_format: json_schema`, then `json_object` with the schema embedded
 * in the system prompt, then prompt-only with bounded JSON extraction.
 * Determined by Test Connection and persisted on the provider record.
 */
export const StructuredOutputTier = z.enum([
  "json_schema",
  "json_object",
  "prompt_only",
]);
export type StructuredOutputTier = z.infer<typeof StructuredOutputTier>;

/**
 * User-configured per-token pricing (USD per million tokens) used for
 * budget estimates when the provider cannot report cost reliably (FR7).
 */
export const ModelPricing = z.strictObject({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

/** Literal hosts allowed to use plain HTTP — loopback only (FR1.5). */
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A canonical provider base URL: `scheme://host[:port][/path]` — the path is
 * optional (e.g. `/v1`) and must not end in `/`. Rejects credentials, query
 * strings, fragments, unsupported schemes, non-loopback HTTP, and any input
 * that does not already equal its canonical form (so default ports, uppercase
 * hosts, `.`/`..` segments, and redundant slashes are refused rather than
 * silently rewritten).
 */
export const LlmBaseUrl = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "base URL is not a valid URL" });
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      ctx.addIssue({
        code: "custom",
        message: "base URL must use https:// (http:// only for loopback)",
      });
      return;
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({ code: "custom", message: "base URL must not contain credentials" });
      return;
    }
    if (url.search !== "" || url.hash !== "") {
      ctx.addIssue({ code: "custom", message: "base URL must not contain a query or fragment" });
      return;
    }
    if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: "plain http:// is only permitted for localhost, 127.0.0.1, or [::1]",
      });
      return;
    }
    const path = url.pathname === "/" ? "" : url.pathname;
    const canonical = `${url.origin}${path}`;
    if (path.endsWith("/") || path.includes("//") || value !== canonical) {
      ctx.addIssue({ code: "custom", message: "base URL is not canonical" });
      return;
    }
  });
export type LlmBaseUrl = z.infer<typeof LlmBaseUrl>;

/**
 * Persisted LLM provider configuration. Presets carry their id, the selected
 * model, and an optional pricing override (the built-in table covers the
 * preset default model; anything else needs the user's own numbers before an
 * unattended request may run); custom providers carry the canonical base URL,
 * model, auth mode, and optional pricing. Strict objects reject unknown keys
 * so misconfigured or hostile stored rows fail closed.
 */
export const LlmProviderSettings = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("preset"),
    preset: LlmPresetId,
    model: z.string().trim().min(1).optional(),
    pricing: ModelPricing.optional(),
  }),
  z.strictObject({
    kind: z.literal("custom"),
    baseUrl: LlmBaseUrl,
    model: z.string().trim().min(1),
    auth: LlmAuthMode,
    pricing: ModelPricing.optional(),
  }),
]);
export type LlmProviderSettings = z.infer<typeof LlmProviderSettings>;

/**
 * A configured LLM provider as persisted in the Dexie `metadata` table under
 * `llmProvider:<providerId>`. `keySuffix` is a short masked display hint
 * (e.g. `…wxyz`) and must never hold a raw credential; `tier` is the
 * structured-output capability discovered by Test Connection. Strict — a
 * stored row carrying extra fields (e.g. a raw key) fails closed.
 *
 * The spend ceiling is a deliberate three-state choice (see
 * {@link budgetChoiceOf}): a capped `monthlyBudgetUsd`, an explicit
 * `monthlyBudgetUnlimited: true`, or — with neither — "not chosen yet",
 * which refuses unattended (automatic) requests. An explicit unlimited
 * state exists so "no ceiling" is something the user picked and the UI can
 * warn about, never a silent default.
 */
export const LlmProviderRecord = z
  .strictObject({
    providerId: z.string().min(1).max(300),
    provider: LlmProviderSettings,
    keySuffix: z.string().min(1).max(8).optional(),
    tier: StructuredOutputTier.optional(),
    /** Monthly spend cap in USD; requests without reliable pricing refuse
     *  unless the user explicitly confirms an unknown-cost request (FR7). */
    monthlyBudgetUsd: z.number().nonnegative().optional(),
    /** The user chose to spend without a monthly ceiling. */
    monthlyBudgetUnlimited: z.literal(true).optional(),
    configuredAt: z.iso.datetime(),
  })
  .superRefine((record, ctx) => {
    if (
      record.monthlyBudgetUnlimited === true &&
      record.monthlyBudgetUsd !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyBudgetUnlimited"],
        message:
          "a provider cannot be both capped and unlimited; drop monthlyBudgetUsd",
      });
    }
  });
export type LlmProviderRecord = z.infer<typeof LlmProviderRecord>;
