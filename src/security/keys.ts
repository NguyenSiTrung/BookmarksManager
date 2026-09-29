import {
  CredentialError,
  deleteEnvelope,
  readEnvelope,
  saveEnvelope,
} from "./credentials";

/**
 * Backward-compatible Jev provider-key API. The generic encrypted credential
 * storage lives in `./credentials`; these wrappers preserve the legacy
 * storage identifiers (`provider:<providerId>` key material,
 * `providerKey:<providerId>` ciphertext envelopes) so existing installs keep
 * their saved keys — presets keep their names, the custom provider slots in
 * as `provider:custom`.
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

function materialId(providerId: string): string {
  return `provider:${providerId}`;
}

function storageKey(providerId: string): string {
  return `providerKey:${providerId}`;
}

/** Translate storage failures into provider-scoped reconnect errors. */
function toProviderKeyError(
  providerId: string,
  cause: unknown,
): ProviderKeyError {
  if (cause instanceof CredentialError) {
    return new ProviderKeyError(
      `Stored provider key for provider "${providerId}" is missing, malformed, or could not be decrypted; reconnect to re-enter it.`,
      { cause },
    );
  }
  return new ProviderKeyError(
    `Stored provider key for provider "${providerId}" could not be read; reconnect to re-enter it.`,
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
  providerId: string,
  plaintext: string,
): Promise<void> {
  await saveEnvelope(storageKey(providerId), materialId(providerId), plaintext);
}

/**
 * Decrypt the stored key for `providerId`. Returns `null` when no ciphertext
 * exists. Malformed envelopes, decryption failures, and missing/unusable
 * CryptoKeys all throw `ProviderKeyError` with `code: "reconnect"` — the
 * error never echoes key material or ciphertext contents.
 */
export async function readProviderKey(
  providerId: string,
): Promise<string | null> {
  try {
    return await readEnvelope(storageKey(providerId), materialId(providerId));
  } catch (cause) {
    throw toProviderKeyError(providerId, cause);
  }
}

/**
 * Remove a provider's ciphertext envelope and CryptoKey. Safe to call when
 * nothing is stored.
 */
export async function deleteProviderKey(providerId: string): Promise<void> {
  await deleteEnvelope(storageKey(providerId), materialId(providerId));
}
