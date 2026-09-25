import { db } from "../db/database";
import type { PresetId } from "../schemas/provider";
import { z } from "../schemas/z";

/**
 * Worker-only provider key storage. Only the MV3 service worker may import
 * this module — Options and other UI surfaces must never see raw keys; they
 * receive only the masked `keySuffix` persisted by the Options flow.
 *
 * Storage split (plan §Global Constraints):
 *  - Dexie `keyMaterials` table holds a non-extractable AES-GCM 256-bit
 *    CryptoKey per preset under id `"provider:<preset>"`.
 *  - `chrome.storage.local` holds only an encrypted envelope per preset under
 *    `"providerKey:<preset>"` — a fresh random 12-byte IV plus base64
 *    ciphertext. Plaintext keys are never written anywhere.
 */

/**
 * `chrome` is provided by the extension runtime. `@types/chrome` declares the
 * `chrome` namespace but no global binding usable in worker scope, and WXT's
 * `browser` export captures `globalThis.chrome` at module load — too early
 * for test stubs. Declare just the slice of the API this module uses so
 * access stays lazy (and `vi.stubGlobal("chrome", ...)` works in tests).
 */
interface ChromeLocalStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
declare const chrome: { storage: { local: ChromeLocalStorageArea } };

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

/** AES-GCM IV size in bytes — a fresh random value per save. */
const IV_LENGTH = 12;

/** Ciphertext envelope persisted in `chrome.storage.local`. */
const KeyEnvelope = z.object({
  v: z.literal(1),
  iv: z.base64(),
  ct: z.base64(),
});
type KeyEnvelope = z.infer<typeof KeyEnvelope>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function materialId(preset: PresetId): string {
  return `provider:${preset}`;
}

function storageKey(preset: PresetId): string {
  return `providerKey:${preset}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * A CryptoKey this module can use: a non-extractable AES-GCM secret key
 * holding both usages. Extractable or partial-usage material cannot have
 * been written here and is treated as unusable.
 */
function isUsableKey(key: CryptoKey | undefined): key is CryptoKey {
  return (
    key !== undefined &&
    key.type === "secret" &&
    key.algorithm.name === "AES-GCM" &&
    key.extractable === false &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

async function getOrCreateKey(preset: PresetId): Promise<CryptoKey> {
  const id = materialId(preset);
  const existing = await db.keyMaterials.get(id);
  if (isUsableKey(existing?.key)) {
    return existing.key;
  }
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await db.keyMaterials.put({ id, key });
  return key;
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
  const key = await getOrCreateKey(preset);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  const envelope: KeyEnvelope = {
    v: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
  };
  await chrome.storage.local.set({ [storageKey(preset)]: envelope });
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
  const key = storageKey(preset);
  const stored = await chrome.storage.local.get(key);
  const raw = stored[key];
  if (raw === undefined) {
    return null;
  }

  const envelope = KeyEnvelope.safeParse(raw);
  if (!envelope.success) {
    throw new ProviderKeyError(
      `Stored provider key for preset "${preset}" is malformed; reconnect to re-enter it.`,
    );
  }

  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = base64ToBytes(envelope.data.iv);
    ciphertext = base64ToBytes(envelope.data.ct);
  } catch (cause) {
    throw new ProviderKeyError(
      `Stored provider key for preset "${preset}" is malformed; reconnect to re-enter it.`,
      { cause },
    );
  }
  if (iv.length !== IV_LENGTH) {
    throw new ProviderKeyError(
      `Stored provider key for preset "${preset}" is malformed; reconnect to re-enter it.`,
    );
  }

  const entry = await db.keyMaterials.get(materialId(preset));
  if (!isUsableKey(entry?.key)) {
    throw new ProviderKeyError(
      `Key material for preset "${preset}" is missing or unusable; reconnect to re-enter the key.`,
    );
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      entry.key,
      ciphertext,
    );
    return decoder.decode(plaintext);
  } catch (cause) {
    throw new ProviderKeyError(
      `Stored provider key for preset "${preset}" could not be decrypted; reconnect to re-enter it.`,
      { cause },
    );
  }
}

/**
 * Remove a preset's ciphertext envelope and CryptoKey. Safe to call when
 * nothing is stored.
 */
export async function deleteProviderKey(preset: PresetId): Promise<void> {
  await chrome.storage.local.remove(storageKey(preset));
  await db.keyMaterials.delete(materialId(preset));
}
