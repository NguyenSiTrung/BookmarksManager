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
 * rows recorded under older versions then fail `hasConsent` and the user
 * must re-accept the disclosure.
 */
export const CONSENT_VERSION = 1;

/**
 * The consent scopes this extension can hold. Only `jev_test` exists today —
 * the synthetic connection test that carries no bookmark content. New scopes
 * (e.g. a bookmark-analysis scope in Phase 4) are added here, in the
 * `ConsentRecord` schema's `scope` literal, and in `src/net/send.ts`'s
 * `SCOPES` registry, always together.
 */
export type ConsentScope = typeof CONSENT_SCOPE;

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
// helpers under the only registered scope.

export function grantTestConsent(preset: PresetId): Promise<void> {
  return grantConsent(CONSENT_SCOPE, preset);
}

export function revokeTestConsent(preset: PresetId): Promise<void> {
  return revokeConsent(CONSENT_SCOPE, preset);
}

export function hasTestConsent(preset: PresetId): Promise<boolean> {
  return hasConsent(CONSENT_SCOPE, preset);
}
