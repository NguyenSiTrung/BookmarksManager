import type {
  LlmAuthMode,
  LlmPresetId,
  LlmProviderSettings,
} from "../schemas/llm";
import { LlmPresetId as LlmPresetIdSchema } from "../schemas/llm";

/**
 * A resolved egress destination for one configured LLM provider. Everything
 * downstream (consent records, host-permission requests, the LLM gate) keys
 * off `origin` — the canonical `scheme://host[:port]` — while `baseUrl`
 * keeps any configured path such as `/v1` for endpoint joining.
 */
export interface LlmDestination {
  readonly providerId: string;
  readonly origin: string;
  readonly baseUrl: string;
  readonly chatCompletionsUrl: string;
  readonly modelsUrl: string;
  readonly permissionPattern: string;
  readonly model: string;
  readonly auth: LlmAuthMode;
}

interface LlmPreset {
  readonly baseUrl: string;
  readonly defaultModel: string;
}

/** Curated OpenAI-compatible presets — fixed endpoints, Bearer auth. */
export const LLM_PRESETS = Object.freeze({
  openai: Object.freeze({
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  }),
  openrouter: Object.freeze({
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
  }),
} as const) satisfies Readonly<Record<LlmPresetId, LlmPreset>>;

function destinationFor(baseUrl: string, model: string, auth: LlmAuthMode, providerId: string): LlmDestination {
  const url = new URL(baseUrl);
  return Object.freeze({
    providerId,
    origin: url.origin,
    baseUrl,
    chatCompletionsUrl: `${baseUrl}/chat/completions`,
    modelsUrl: `${baseUrl}/models`,
    // Chrome host patterns cannot express ports; the gate re-checks the
    // exact origin (including port) before every request.
    permissionPattern: `${url.protocol}//${url.hostname}/*`,
    model,
    auth,
  });
}

/**
 * Resolve validated provider settings into the destination record used by
 * the LLM gate. Pure and total over `LlmProviderSettings` — parse untrusted
 * input through the schema first; `preset` is re-validated so arbitrary
 * strings throw instead of indexing `LLM_PRESETS` to `undefined`.
 */
export function resolveLlmDestination(
  settings: LlmProviderSettings,
): LlmDestination {
  if (settings.kind === "preset") {
    const preset = LLM_PRESETS[LlmPresetIdSchema.parse(settings.preset)];
    return destinationFor(
      preset.baseUrl,
      settings.model ?? preset.defaultModel,
      "bearer",
      `preset:${settings.preset}`,
    );
  }
  return destinationFor(
    settings.baseUrl,
    settings.model,
    settings.auth,
    `custom:${settings.baseUrl}`,
  );
}
