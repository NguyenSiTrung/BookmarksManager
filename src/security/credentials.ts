import { db } from "../db/database";
import { z } from "../schemas/z";

/**
 * Worker-only encrypted credential storage. Only the MV3 service worker may
 * import this module — Options and other UI surfaces must never see raw
 * credentials; they receive only masked derivations (e.g. a suffix) persisted
 * by the Options flow.
 *
 * Generalizes the original Jev provider-key storage (`./keys.ts`) so the
 * dynamic LLM layer can store one credential per resolved provider id
 * (`preset:<id>`, `custom:<baseUrl>`) without weakening that boundary.
 *
 * Storage split (plan §Global Constraints):
 *  - Dexie `keyMaterials` holds a non-extractable AES-GCM 256-bit CryptoKey
 *    per credential under `credential:<id>` (legacy Jev keys keep
 *    `provider:<preset>`).
 *  - `chrome.storage.local` holds only an encrypted envelope under
 *    `credential:<id>` (legacy: `providerKey:<preset>`) — a fresh random
 *    12-byte IV plus base64 ciphertext. Plaintext is never written anywhere.
 *
 * Low-level `*Envelope` functions take explicit storage/material ids so
 * wrappers can preserve legacy storage identifiers; callers should prefer
 * the `saveCredential`/`readCredential`/`deleteCredential` API.
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

export type CredentialErrorCode = "reconnect";

/**
 * Failure to use stored credential material: malformed envelope, decryption
 * failure, or missing/unusable CryptoKey. `code: "reconnect"` signals the
 * caller that the user must re-enter the credential. Messages deliberately
 * omit any stored or supplied credential material.
 */
export class CredentialError extends Error {
  readonly code: CredentialErrorCode = "reconnect";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialError";
  }
}

/**
 * Namespaced credential identifier supplied by the caller — e.g.
 * `preset:openai` or `custom:https://api.example.com/v1`. Bounded and
 * whitespace-trimmed so a malformed caller cannot spray arbitrary storage
 * rows; the id is a storage locator, never the secret itself.
 */
export const CredentialId = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => value.trim() === value && value.trim().length > 0, {
    message: "credential id must not be blank or whitespace-padded",
  });
export type CredentialId = z.infer<typeof CredentialId>;

/** AES-GCM IV size in bytes — a fresh random value per save. */
const IV_LENGTH = 12;

/** Ciphertext envelope persisted in `chrome.storage.local`. */
const CredentialEnvelope = z.object({
  v: z.literal(1),
  iv: z.base64(),
  ct: z.base64(),
});
type CredentialEnvelope = z.infer<typeof CredentialEnvelope>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function credentialStorageKey(id: CredentialId): string {
  return `credential:${id}`;
}

function credentialMaterialId(id: CredentialId): string {
  return `credential:${id}`;
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

/**
 * In-flight CryptoKey creation per material id. Concurrent saves for the same
 * credential must share one CryptoKey: without this lock, two racing
 * `generateKey` calls could each `put` a key, leaving an envelope encrypted
 * under the losing key undecryptable.
 */
const keyCreationLocks = new Map<string, Promise<CryptoKey>>();

function getOrCreateKey(materialId: string): Promise<CryptoKey> {
  const pending = keyCreationLocks.get(materialId);
  if (pending) {
    return pending;
  }
  const created = (async () => {
    const existing = await db.keyMaterials.get(materialId);
    if (isUsableKey(existing?.key)) {
      return existing.key;
    }
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    await db.keyMaterials.put({ id: materialId, key });
    return key;
  })();
  keyCreationLocks.set(materialId, created);
  void created.finally(() => {
    if (keyCreationLocks.get(materialId) === created) {
      keyCreationLocks.delete(materialId);
    }
  });
  return created;
}

/**
 * Serialized envelope operations per CryptoKey material id (H02). An
 * envelope in `chrome.storage.local` and its CryptoKey in `keyMaterials`
 * are two stores: a save that resolved its key before a concurrent delete
 * ran would write an envelope under a since-deleted CryptoKey —
 * undecryptable forever. Queuing every envelope op for one material id
 * behind the previous makes each caller observe a before-or-after state,
 * never a torn one. Failed ops do not poison the queue, and the map entry
 * is removed once the chain drains.
 */
const envelopeChains = new Map<string, Promise<void>>();

function serializeEnvelopeOp<T>(
  materialId: string,
  op: () => Promise<T>,
): Promise<T> {
  const previous = envelopeChains.get(materialId) ?? Promise.resolve();
  const next = previous.then(op, op);
  const stored = next.then(
    () => undefined,
    () => undefined,
  );
  envelopeChains.set(materialId, stored);
  void stored.finally(() => {
    if (envelopeChains.get(materialId) === stored) {
      envelopeChains.delete(materialId);
    }
  });
  return next;
}

/**
 * Encrypt and store a credential under explicit storage ids. Generates a
 * fresh non-extractable AES-GCM CryptoKey on first use and writes a
 * unique-IV ciphertext envelope to `chrome.storage.local`.
 */
export async function saveEnvelope(
  storageKey: string,
  materialId: string,
  plaintext: string,
): Promise<void> {
  return serializeEnvelopeOp(materialId, async () => {
    const key = await getOrCreateKey(materialId);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plaintext),
    );
    const envelope: CredentialEnvelope = {
      v: 1,
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ciphertext)),
    };
    await chrome.storage.local.set({ [storageKey]: envelope });
  });
}

/**
 * Decrypt the envelope at `storageKey` using the CryptoKey at `materialId`.
 * Returns `null` when no ciphertext exists. Malformed envelopes, decryption
 * failures, and missing/unusable CryptoKeys throw `CredentialError` with
 * `code: "reconnect"` — the error never echoes credential material or
 * ciphertext contents.
 */
export async function readEnvelope(
  storageKey: string,
  materialId: string,
): Promise<string | null> {
  return serializeEnvelopeOp(materialId, () => readEnvelopeNow(storageKey, materialId));
}

async function readEnvelopeNow(
  storageKey: string,
  materialId: string,
): Promise<string | null> {
  const stored = await chrome.storage.local.get(storageKey);
  const raw = stored[storageKey];
  if (raw === undefined) {
    return null;
  }

  const malformed = () =>
    new CredentialError(
      "Stored credential is malformed; reconnect to re-enter it.",
    );

  const envelope = CredentialEnvelope.safeParse(raw);
  if (!envelope.success) {
    throw malformed();
  }

  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = base64ToBytes(envelope.data.iv);
    ciphertext = base64ToBytes(envelope.data.ct);
  } catch (cause) {
    throw new CredentialError(
      "Stored credential is malformed; reconnect to re-enter it.",
      { cause },
    );
  }
  if (iv.length !== IV_LENGTH) {
    throw malformed();
  }

  const entry = await db.keyMaterials.get(materialId);
  if (!isUsableKey(entry?.key)) {
    throw new CredentialError(
      "Credential key material is missing or unusable; reconnect to re-enter the credential.",
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
    throw new CredentialError(
      "Stored credential could not be decrypted; reconnect to re-enter it.",
      { cause },
    );
  }
}

/** Remove the envelope and CryptoKey at the given storage ids. */
export async function deleteEnvelope(
  storageKey: string,
  materialId: string,
): Promise<void> {
  return serializeEnvelopeOp(materialId, async () => {
    await chrome.storage.local.remove(storageKey);
    await db.keyMaterials.delete(materialId);
  });
}

/**
 * Encrypt and store a credential under the generic `credential:` namespace.
 * `id` is the caller-chosen locator — the LLM layer uses its resolved
 * provider id (`preset:<id>` or `custom:<baseUrl>`).
 */
export async function saveCredential(
  id: string,
  plaintext: string,
): Promise<void> {
  const parsedId = CredentialId.parse(id);
  await saveEnvelope(
    credentialStorageKey(parsedId),
    credentialMaterialId(parsedId),
    plaintext,
  );
}

/**
 * Decrypt the stored credential for `id`. Returns `null` when no ciphertext
 * exists; storage or CryptoKey failures throw `CredentialError` with
 * `code: "reconnect"`.
 */
export async function readCredential(id: string): Promise<string | null> {
  const parsedId = CredentialId.parse(id);
  return readEnvelope(
    credentialStorageKey(parsedId),
    credentialMaterialId(parsedId),
  );
}

/** Remove a credential's ciphertext envelope and CryptoKey. Safe to no-op. */
export async function deleteCredential(id: string): Promise<void> {
  const parsedId = CredentialId.parse(id);
  await deleteEnvelope(
    credentialStorageKey(parsedId),
    credentialMaterialId(parsedId),
  );
}
