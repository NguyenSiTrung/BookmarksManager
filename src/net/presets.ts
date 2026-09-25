import { PRESET_MODELS, PresetId } from "../schemas/provider";

/**
 * One fixed remote destination the extension may reach (PROJECT_PLAN.md
 * §8.1). `origin` is the canonical HTTPS origin that keys consent records;
 * `url` is the full System One endpoint the worker POSTs to;
 * `permissionPattern` is the Chrome host permission requested from a direct
 * user click; `models` is the preset's allowlist from `PRESET_MODELS`.
 */
export interface PresetDestination {
  readonly origin: string;
  readonly url: string;
  readonly permissionPattern: string;
  readonly models: readonly string[];
}

/**
 * The closed registry of permitted remote origins — TypeSafe and OpenRouter
 * only, no custom or HTTP destinations. Deeply frozen at runtime and
 * readonly at type level; callers must never mutate entries or treat this
 * module as a fetch layer (it holds constants only).
 */
export const PRESETS = Object.freeze({
  typesafe: Object.freeze({
    origin: "https://api.typesafe.ai",
    url: "https://api.typesafe.ai/v1/systemone",
    permissionPattern: "https://api.typesafe.ai/*",
    models: Object.freeze(PRESET_MODELS.typesafe),
  }),
  openrouter: Object.freeze({
    origin: "https://openrouter.ai",
    url: "https://openrouter.ai/api/v1/systemone",
    permissionPattern: "https://openrouter.ai/*",
    models: Object.freeze(PRESET_MODELS.openrouter),
  }),
} as const) satisfies Readonly<Record<PresetId, PresetDestination>>;

/**
 * Resolve a possibly-untrusted preset id to its registry entry. The id is
 * validated against the `PresetId` schema at runtime — callers forward
 * message-channel data, and a non-preset string must throw a ZodError here
 * rather than silently indexing `PRESETS` to `undefined`.
 */
export function resolvePreset(preset: PresetId): PresetDestination {
  return PRESETS[PresetId.parse(preset)];
}
