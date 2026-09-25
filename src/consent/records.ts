import { db } from "../db/database";
import { resolvePreset } from "../net/presets";
import {
  CONSENT_SCOPE,
  type ConsentRecord,
  type PresetId,
} from "../schemas/provider";

/**
 * Version of the `jev_test` consent grant. Bump this whenever the synthetic
 * test fields or the set of recipients change (plan §Global Constraints):
 * rows recorded under older versions then fail `hasTestConsent` and the
 * user must re-accept the disclosure.
 */
export const CONSENT_VERSION = 1;

/**
 * Record the user's affirmative `jev_test` consent for a preset's origin.
 * Uses `put` as an upsert over the compound `[scope+origin]` key so a
 * re-grant refreshes `acceptedAt` on the existing row rather than
 * duplicating it.
 */
export async function grantTestConsent(preset: PresetId): Promise<void> {
  const { origin } = resolvePreset(preset);
  const record: ConsentRecord = {
    scope: CONSENT_SCOPE,
    origin,
    consentVersion: CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  await db.consents.put(record);
}

/**
 * Delete the `jev_test` grant for a preset's origin. Safe to call when no
 * grant exists.
 */
export async function revokeTestConsent(preset: PresetId): Promise<void> {
  const { origin } = resolvePreset(preset);
  await db.consents.delete([CONSENT_SCOPE, origin]);
}

/**
 * True only when a row exists for this preset's origin under the `jev_test`
 * scope AND carries the current `consentVersion`. Scope, origin, and
 * version are compared explicitly on every call so stale-version or
 * foreign-scope rows cannot pass.
 */
export async function hasTestConsent(preset: PresetId): Promise<boolean> {
  const { origin } = resolvePreset(preset);
  const record = await db.consents.get([CONSENT_SCOPE, origin]);
  return (
    record !== undefined &&
    record.scope === CONSENT_SCOPE &&
    record.origin === origin &&
    record.consentVersion === CONSENT_VERSION
  );
}
