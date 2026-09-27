import { db } from "../db/database";
import { resolvePreset } from "../net/presets";
import {
  CONSENT_SCOPES,
  CONSENT_SCOPE,
  type ConsentRecord,
  type ConsentScope,
  type PresetId,
} from "../schemas/provider";

export type { ConsentScope };

/**
 * Version of the consent grant, shared by every scope. Bump this whenever the
 * set of sent fields or the set of recipients changes (plan §Global
 * Constraints): rows recorded under older versions then fail `hasConsent`
 * and the user must re-accept the disclosure. Version 2 introduces the
 * `jev_decisions` bookmark-metadata scope, so a stale v1 `jev_test` record
 * is re-disclosed too.
 */
export const CONSENT_VERSION = 2;

/**
 * Record the user's affirmative consent for a scope at a preset's origin.
 * Uses `put` as an upsert over the compound `[scope+origin]` key so a
 * re-grant refreshes `acceptedAt` on the existing row rather than
 * duplicating it.
 */
export async function grantConsent(
  scope: ConsentScope,
  preset: PresetId,
): Promise<void> {
  const { origin } = resolvePreset(preset);
  const record: ConsentRecord = {
    scope,
    origin,
    consentVersion: CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  await db.consents.put(record);
}

/** Delete the grant for a scope at a preset's origin. Safe when absent. */
export async function revokeConsent(
  scope: ConsentScope,
  preset: PresetId,
): Promise<void> {
  const { origin } = resolvePreset(preset);
  await db.consents.delete([scope, origin]);
}

/**
 * True only when a row exists for this preset's origin under the given
 * scope AND carries the current `consentVersion`. Scope, origin, and
 * version are compared explicitly on every call so stale-version or
 * foreign-scope rows cannot pass.
 */
export async function hasConsent(
  scope: ConsentScope,
  preset: PresetId,
): Promise<boolean> {
  const { origin } = resolvePreset(preset);
  const record = await db.consents.get([scope, origin]);
  return (
    record !== undefined &&
    record.scope === scope &&
    record.origin === origin &&
    record.consentVersion === CONSENT_VERSION
  );
}

// --- `jev_test` convenience wrappers -------------------------------------
// Thin aliases kept for existing callers; they forward to the scoped
// helpers under the synthetic test scope.

export function grantTestConsent(preset: PresetId): Promise<void> {
  return grantConsent(CONSENT_SCOPE, preset);
}

export function revokeTestConsent(preset: PresetId): Promise<void> {
  return revokeConsent(CONSENT_SCOPE, preset);
}

export function hasTestConsent(preset: PresetId): Promise<boolean> {
  return hasConsent(CONSENT_SCOPE, preset);
}

/**
 * Delete every consent row a provider holds at its origin — one per
 * registered scope — so revoking a provider can never leave a stale grant
 * behind (FR1). Iterates `CONSENT_SCOPES` rather than naming scopes so a
 * scope added later is revoked automatically. Safe when rows are absent.
 */
export async function revokeProviderConsents(preset: PresetId): Promise<void> {
  await Promise.all(CONSENT_SCOPES.map((scope) => revokeConsent(scope, preset)));
}
