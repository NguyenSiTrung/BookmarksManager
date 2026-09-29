import { PRESETS } from "../net/presets";
import {
  PresetId,
  type JevProviderId,
  type ProviderSettings,
} from "../schemas/provider";

/**
 * A resolved egress destination for one configured Jev provider — the
 * System One endpoint the gate may POST to. Consent records and the Chrome
 * host-permission grant key off `origin`; `providerId` keys the settings
 * row and the stored key material. `models` is the allowlist the gate
 * checks the request model against — for a custom provider it holds exactly
 * the configured model, so nothing else can be sent.
 */
export interface JevDestination {
  readonly providerId: JevProviderId;
  readonly origin: string;
  readonly url: string;
  readonly permissionPattern: string;
  readonly models: readonly string[];
}

/** The registry-backed destination for a curated preset. */
export function presetJevDestination(preset: PresetId): JevDestination {
  const id = PresetId.parse(preset);
  const entry = PRESETS[id];
  return Object.freeze({
    providerId: id,
    origin: entry.origin,
    url: entry.url,
    permissionPattern: entry.permissionPattern,
    models: entry.models,
  });
}

/**
 * Resolve validated provider settings into the destination record used by
 * the Jev gate. Presets resolve through the fixed registry; the custom
 * provider derives its System One endpoint as `${baseUrl}/systemone` — the
 * same `<api-root>/systemone` convention the presets use (TypeSafe keeps
 * `/v1`, OpenRouter `/api/v1` in its base) — and pins the allowlist to the
 * configured model. Chrome host patterns cannot express ports, so the
 * permission pattern is host-scoped and the gate re-checks the exact origin
 * (scheme + host + port) before every request. Pure and total over
 * `ProviderSettings` — parse untrusted input through the schema first.
 */
export function resolveJevDestination(
  settings: ProviderSettings,
): JevDestination {
  if (settings.preset === "custom") {
    const url = new URL(settings.baseUrl);
    return Object.freeze({
      providerId: "custom",
      origin: url.origin,
      url: `${settings.baseUrl}/systemone`,
      permissionPattern: `${url.protocol}//${url.hostname}/*`,
      models: Object.freeze([settings.model]),
    });
  }
  return presetJevDestination(settings.preset);
}
