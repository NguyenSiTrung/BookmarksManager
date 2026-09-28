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
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
 * Persisted LLM provider configuration. Presets carry only their id and the
 * selected model (auth and endpoints are fixed by the preset); custom
 * providers carry the canonical base URL, model, auth mode, and optional
 * pricing. Strict objects reject unknown keys so misconfigured or hostile
 * stored rows fail closed.
 */
export const LlmProviderSettings = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("preset"),
    preset: LlmPresetId,
    model: z.string().trim().min(1).optional(),
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
