import type { PresetId } from "../schemas/provider";
import {
  CredentialError,
  deleteEnvelope,
  readEnvelope,
  saveEnvelope,
} from "./credentials";

/**
 * Backward-compatible Jev provider-key API. The generic encrypted credential
 * storage lives in `./credentials`; these wrappers preserve the legacy
 * storage identifiers (`provider:<preset>` key material, `providerKey:<preset>`
 * ciphertext envelopes) so existing installs keep their saved keys.
 *
 * Worker-only: only the MV3 service worker may import this module — UI
 * surfaces must never see raw keys.
 */

export type ProviderKeyErrorCode = "reconnect";

/**
 * Failure to use stored key material: malformed envelope, decryption
 * failure, or missing/unusable CryptoKey. `code: "reconnect"` signals the
 * caller that the user must re-enter the key. Messages deliberately omit
 * any stored or supplied key material.
 */
export class ProviderKeyError extends Error {
  readonly code: ProviderKeyErrorCode = "reconnect";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderKeyError";
  }
}

function materialId(preset: PresetId): string {
  return `provider:${preset}`;
}

function storageKey(preset: PresetId): string {
  return `providerKey:${preset}`;
}

/** Translate storage failures into preset-scoped reconnect errors. */
function toProviderKeyError(preset: PresetId, cause: unknown): ProviderKeyError {
  if (cause instanceof CredentialError) {
    return new ProviderKeyError(
      `Stored provider key for preset "${preset}" is missing, malformed, or could not be decrypted; reconnect to re-enter it.`,
      { cause },
    );
  }
  return new ProviderKeyError(
    `Stored provider key for preset "${preset}" could not be read; reconnect to re-enter it.`,
    { cause },
  );
}

/**
 * Encrypt and store a provider API key. Generates a fresh non-extractable
 * AES-GCM CryptoKey on first use and writes a unique-IV ciphertext envelope
 * to `chrome.storage.local`. The masked suffix is owned by the Options flow;
 * this function persists nothing besides ciphertext and key material.
 */
export async function saveProviderKey(
  preset: PresetId,
  plaintext: string,
): Promise<void> {
  await saveEnvelope(storageKey(preset), materialId(preset), plaintext);
}

/**
 * Decrypt the stored key for `preset`. Returns `null` when no ciphertext
 * exists. Malformed envelopes, decryption failures, and missing/unusable
 * CryptoKeys all throw `ProviderKeyError` with `code: "reconnect"` — the
 * error never echoes key material or ciphertext contents.
 */
export async function readProviderKey(
  preset: PresetId,
): Promise<string | null> {
  try {
    return await readEnvelope(storageKey(preset), materialId(preset));
  } catch (cause) {
    throw toProviderKeyError(preset, cause);
  }
}

/**
 * Remove a preset's ciphertext envelope and CryptoKey. Safe to call when
 * nothing is stored.
 */
export async function deleteProviderKey(preset: PresetId): Promise<void> {
  await deleteEnvelope(storageKey(preset), materialId(preset));
}
