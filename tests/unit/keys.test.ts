import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import type { PresetId } from "../../src/schemas/provider";
import {
  deleteProviderKey,
  ProviderKeyError,
  readProviderKey,
  saveProviderKey,
} from "../../src/security/keys";

/**
 * Minimal in-memory `chrome.storage.local` stub — the only chrome surface
 * this module touches. `store` is the live backing map; `writes` snapshots
 * every `set()` payload so tests can prove plaintext never reaches storage.
 */
interface ChromeStorageStub {
  store: Record<string, unknown>;
  writes: Array<Record<string, unknown>>;
}

function installChromeStub(): ChromeStorageStub {
  const store: Record<string, unknown> = {};
  const writes: Array<Record<string, unknown>> = [];
  const local = {
    async get(keys?: string | string[] | null) {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of list) {
        if (key in store) result[key] = store[key];
      }
      return result;
    },
    async set(items: Record<string, unknown>) {
      writes.push(structuredClone(items));
      Object.assign(store, items);
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    },
  };
  vi.stubGlobal("chrome", { storage: { local } });
  return { store, writes };
}

let chromeStub: ChromeStorageStub;

beforeEach(async () => {
  // jsdom's `crypto` lacks WebCrypto subtle; the MV3 worker provides the real
  // implementation, so swap in Node's webcrypto for tests.
  vi.stubGlobal("crypto", webcrypto);
  chromeStub = installChromeStub();
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

const PRESETS = ["typesafe", "openrouter"] as const satisfies readonly PresetId[];
const STORAGE_KEY_PREFIX = "providerKey:";

interface StoredEnvelope {
  v: number;
  iv: string;
  ct: string;
}

describe("provider key storage", () => {
  it.each(PRESETS)("round-trips a saved key for %s", async (preset) => {
    await saveProviderKey(preset, "secret-example");
    expect(await readProviderKey(preset)).toBe("secret-example");
    // Plaintext must never appear in storage writes or the live store.
    expect(JSON.stringify(chromeStub.writes)).not.toContain("secret-example");
    expect(JSON.stringify(chromeStub.store)).not.toContain("secret-example");
  });

  it.each(PRESETS)(
    "scopes the storage entry and CryptoKey to %s",
    async (preset) => {
      await saveProviderKey(preset, "secret-example");
      expect(chromeStub.store[`${STORAGE_KEY_PREFIX}${preset}`]).toBeDefined();
      const entry = await db.keyMaterials.get(`provider:${preset}`);
      expect(entry?.key.type).toBe("secret");
      expect(entry?.key.algorithm.name).toBe("AES-GCM");
      expect(entry?.key.extractable).toBe(false);
    },
  );

  it("uses a fresh random IV on every save", async () => {
    await saveProviderKey("typesafe", "same-plaintext");
    const first = chromeStub.store[
      `${STORAGE_KEY_PREFIX}typesafe`
    ] as StoredEnvelope;
    await saveProviderKey("typesafe", "same-plaintext");
    const second = chromeStub.store[
      `${STORAGE_KEY_PREFIX}typesafe`
    ] as StoredEnvelope;
    expect(second.iv).not.toBe(first.iv);
    expect(second.ct).not.toBe(first.ct);
    expect(await readProviderKey("typesafe")).toBe("same-plaintext");
  });

  it("keeps the two presets' keys independent", async () => {
    await saveProviderKey("typesafe", "typesafe-secret");
    await saveProviderKey("openrouter", "openrouter-secret");
    expect(await readProviderKey("typesafe")).toBe("typesafe-secret");
    expect(await readProviderKey("openrouter")).toBe("openrouter-secret");
    expect(chromeStub.store[`${STORAGE_KEY_PREFIX}typesafe`]).not.toEqual(
      chromeStub.store[`${STORAGE_KEY_PREFIX}openrouter`],
    );
  });

  it("returns null when no ciphertext exists", async () => {
    expect(await readProviderKey("typesafe")).toBeNull();
  });

  it("returns null when key material exists but no ciphertext was stored", async () => {
    await db.keyMaterials.put({
      id: "provider:typesafe",
      key: (await webcrypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )) as CryptoKey,
    });
    expect(await readProviderKey("typesafe")).toBeNull();
  });

  it("maps a malformed stored envelope to a reconnect error", async () => {
    chromeStub.store[`${STORAGE_KEY_PREFIX}typesafe`] = "not-an-envelope";
    await expect(readProviderKey("typesafe")).rejects.toBeInstanceOf(
      ProviderKeyError,
    );
    await expect(readProviderKey("typesafe")).rejects.toMatchObject({
      code: "reconnect",
    });
  });

  it("maps tampered ciphertext to a reconnect error without echoing contents", async () => {
    const secret = "super-secret-plaintext";
    await saveProviderKey("typesafe", secret);
    const envelope = chromeStub.store[
      `${STORAGE_KEY_PREFIX}typesafe`
    ] as StoredEnvelope;
    chromeStub.store[`${STORAGE_KEY_PREFIX}typesafe`] = {
      ...envelope,
      ct: btoa("tampered-ciphertext-bytes"),
    };
    const error = await readProviderKey("typesafe").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderKeyError);
    expect((error as ProviderKeyError).code).toBe("reconnect");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain("tampered");
  });

  it("maps orphaned ciphertext (CryptoKey deleted) to a reconnect error", async () => {
    await saveProviderKey("typesafe", "secret-example");
    await db.keyMaterials.delete("provider:typesafe");
    await expect(readProviderKey("typesafe")).rejects.toMatchObject({
      name: "ProviderKeyError",
      code: "reconnect",
    });
  });

  it("maps unusable stored key material to a reconnect error", async () => {
    await saveProviderKey("typesafe", "secret-example");
    // An extractable, encrypt-only key cannot have been written by this module
    // and cannot decrypt, so it counts as unusable material.
    const wrongKey = (await webcrypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt"],
    )) as CryptoKey;
    await db.keyMaterials.put({ id: "provider:typesafe", key: wrongKey });
    await expect(readProviderKey("typesafe")).rejects.toMatchObject({
      name: "ProviderKeyError",
      code: "reconnect",
    });
  });

  it("deletes ciphertext and CryptoKey for only the named preset", async () => {
    await saveProviderKey("typesafe", "typesafe-secret");
    await saveProviderKey("openrouter", "openrouter-secret");

    await deleteProviderKey("typesafe");

    expect(chromeStub.store[`${STORAGE_KEY_PREFIX}typesafe`]).toBeUndefined();
    expect(await db.keyMaterials.get("provider:typesafe")).toBeUndefined();
    expect(await readProviderKey("typesafe")).toBeNull();
    // The other preset is untouched.
    expect(await readProviderKey("openrouter")).toBe("openrouter-secret");
  });

  it("treats deleting a never-saved preset as a no-op", async () => {
    await expect(deleteProviderKey("openrouter")).resolves.toBeUndefined();
  });

  it("re-saves cleanly after deletion", async () => {
    await saveProviderKey("typesafe", "first-secret");
    await deleteProviderKey("typesafe");
    await saveProviderKey("typesafe", "second-secret");
    expect(await readProviderKey("typesafe")).toBe("second-secret");
    expect(JSON.stringify(chromeStub.store)).not.toContain("second-secret");
  });
});
