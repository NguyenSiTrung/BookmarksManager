import { db } from "../db/database";
import { resolvePreset } from "../net/presets";
import {
  CONSENT_SCOPES,
  CONSENT_SCOPE,
  ConsentRecord,
  type ConsentScope,
  type PresetId,
} from "../schemas/provider";

export type { ConsentScope };

/**
 * Version of the consent grant, shared by every scope. Bump this whenever the
 * set of sent fields or the set of recipients changes (plan §Global
 * Constraints): rows recorded under older versions then fail `hasConsent`
 * and the user must re-accept the disclosure. Version 2 introduced the
 * `jev_decisions` bookmark-metadata scope; version 3 introduces the Phase 5
 * LLM scopes and the dynamic-origin grants behind them, so every earlier
 * row is re-disclosed.
 */
export const CONSENT_VERSION = 3;

/**
 * Record the user's affirmative consent for a scope at an origin. Uses
 * `put` as an upsert over the compound `[scope+origin]` key so a
 * re-grant refreshes `acceptedAt` on the existing row rather than
 * duplicating it. The origin is validated against `ConsentRecord` —
 * canonical HTTPS, or canonical loopback HTTP — before it is stored.
 */
export async function grantConsentAtOrigin(
  scope: ConsentScope,
  origin: string,
): Promise<void> {
  const record: ConsentRecord = ConsentRecord.parse({
    scope,
    origin,
    consentVersion: CONSENT_VERSION,
    acceptedAt: new Date().toISOString(),
  });
  await db.consents.put(record);
}

/** Delete the grant for a scope at an origin. Safe when absent. */
export async function revokeConsentAtOrigin(
  scope: ConsentScope,
  origin: string,
): Promise<void> {
  await db.consents.delete([scope, origin]);
}

/**
 * True only when a row exists for this origin under the given scope AND
 * carries the current `consentVersion`. Scope, origin, and version are
 * compared explicitly on every call so stale-version or foreign-scope
 * rows cannot pass.
 */
export async function hasConsentAtOrigin(
  scope: ConsentScope,
  origin: string,
): Promise<boolean> {
  const record = await db.consents.get([scope, origin]);
  return (
    record !== undefined &&
    record.scope === scope &&
    record.origin === origin &&
    record.consentVersion === CONSENT_VERSION
  );
}

/** Preset wrappers — Jev destinations resolve through the fixed registry. */

export async function grantConsent(
  scope: ConsentScope,
  preset: PresetId,
): Promise<void> {
  await grantConsentAtOrigin(scope, resolvePreset(preset).origin);
}

export async function revokeConsent(
  scope: ConsentScope,
  preset: PresetId,
): Promise<void> {
  await revokeConsentAtOrigin(scope, resolvePreset(preset).origin);
}

export async function hasConsent(
  scope: ConsentScope,
  preset: PresetId,
): Promise<boolean> {
  return await hasConsentAtOrigin(scope, resolvePreset(preset).origin);
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
 * Raised when a provider revoke could not delete every consent scope at its
 * origin. Callers treat the revoke as failed (a grant may remain and the gate
 * will keep blocking), while every deletion that did succeed stays applied.
 */
export class ConsentRevokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConsentRevokeError";
  }
}

/**
 * Delete every consent row a provider holds at its origin — one per
 * registered scope — so revoking a provider can never leave a stale grant
 * behind (FR1). Iterates `CONSENT_SCOPES` rather than naming scopes so a
 * scope added later is revoked automatically, and uses `allSettled` so one
 * failing deletion cannot silently abandon the rest; if any deletion rejects,
 * it throws a `ConsentRevokeError` after the others have run. Safe when rows
 * are absent.
 */
export async function revokeConsentsAtOrigin(origin: string): Promise<void> {
  const results = await Promise.allSettled(
    CONSENT_SCOPES.map((scope) => revokeConsentAtOrigin(scope, origin)),
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected.length > 0) {
    throw new ConsentRevokeError(
      `Could not delete ${rejected.length} consent scope(s) at ${origin}.`,
      { cause: rejected[0]?.reason },
    );
  }
}

export function revokeProviderConsents(preset: PresetId): Promise<void> {
  return revokeConsentsAtOrigin(resolvePreset(preset).origin);
}
