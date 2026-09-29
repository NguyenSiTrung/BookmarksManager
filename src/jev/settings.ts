import { db } from "../db/database";
import { hasConsentAtOrigin } from "../consent/records";
import {
  DECISIONS_CONSENT_SCOPE,
  JEV_PROVIDER_IDS,
  JevProviderId,
  ProviderSettings,
  type ConsentScope,
} from "../schemas/provider";
import {
  presetJevDestination,
  resolveJevDestination,
  type JevDestination,
} from "./providers";

/**
 * Jev provider settings persistence + resolution (worker-side). Settings
 * rows live in the shared `metadata` table keyed by provider id — the bare
 * preset name for curated providers, `custom` for the user-configured
 * endpoint. `metadata.value` is untyped at storage, so every read
 * re-validates through `ProviderSettings` and a malformed or hostile row
 * fails closed to `null`.
 */

/** Read one provider's persisted settings, or `null` when absent/invalid. */
export async function readJevProvider(
  providerId: JevProviderId,
): Promise<ProviderSettings | null> {
  const row = await db.metadata.get(providerId);
  const parsed = ProviderSettings.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve a provider id to its egress destination: presets resolve through
 * the frozen registry; `custom` resolves from its stored settings row (the
 * base URL lives nowhere else). `null` when the id is not a Jev provider or
 * the custom row is missing/invalid — callers treat that as "no such
 * provider", never as a fallback to some default destination.
 */
export async function resolveStoredJevDestination(
  providerId: string,
): Promise<JevDestination | null> {
  const id = JevProviderId.safeParse(providerId);
  if (!id.success) return null;
  if (id.data !== "custom") {
    return presetJevDestination(id.data);
  }
  const settings = await readJevProvider("custom");
  if (settings === null || settings.preset !== "custom") return null;
  const destination = resolveJevDestination(settings);
  return destination.providerId === providerId ? destination : null;
}

/** The consented provider + resolved destination a Jev flow runs against. */
export interface ActiveJevProvider {
  readonly providerId: JevProviderId;
  readonly model: string;
  readonly destination: JevDestination;
}

/**
 * The first provider with a stored, valid `ProviderSettings` row AND a
 * current consent grant for `scope` at its resolved origin — the provider
 * the given flow runs against. `null` when none qualifies; every handler
 * that would egress refuses rather than guessing.
 */
export async function readActiveJevProvider(
  scope: ConsentScope = DECISIONS_CONSENT_SCOPE,
): Promise<ActiveJevProvider | null> {
  for (const providerId of JEV_PROVIDER_IDS) {
    try {
      const settings = await readJevProvider(providerId);
      if (settings === null) continue;
      const destination = resolveJevDestination(settings);
      if (!(await hasConsentAtOrigin(scope, destination.origin))) continue;
      return { providerId, model: settings.model, destination };
    } catch {
      // A broken row / lookup just skips this provider.
    }
  }
  return null;
}
