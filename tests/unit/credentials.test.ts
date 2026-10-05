import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  CredentialError,
  deleteCredential,
  readCredential,
  saveCredential,
} from "../../src/security/credentials";
import {
  readProviderKey,
  saveProviderKey,
} from "../../src/security/keys";

/**
 * Minimal in-memory `chrome.storage.local` stub — mirrors the stub in
 * keys.test.ts. `writes` snapshots every `set()` payload so tests can prove
 * plaintext never reaches storage.
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
  vi.stubGlobal("crypto", webcrypto);
  chromeStub = installChromeStub();
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

const STORAGE_KEY_PREFIX = "credential:";
const MATERIAL_ID_PREFIX = "credential:";

interface StoredEnvelope {
  v: number;
  iv: string;
  ct: string;
}

describe("saveCredential / readCredential", () => {
  it("round-trips a saved credential without storing plaintext", async () => {
    await saveCredential("preset:openai", "sk-secret-example");
    expect(await readCredential("preset:openai")).toBe("sk-secret-example");
    expect(JSON.stringify(chromeStub.writes)).not.toContain(
      "sk-secret-example",
    );
    expect(JSON.stringify(chromeStub.store)).not.toContain(
      "sk-secret-example",
    );
  });

  it("stores the envelope and CryptoKey under the credential namespace", async () => {
    await saveCredential("preset:openai", "sk-secret");
    expect(
      chromeStub.store[`${STORAGE_KEY_PREFIX}preset:openai`],
    ).toBeDefined();
    const entry = await db.keyMaterials.get(
      `${MATERIAL_ID_PREFIX}preset:openai`,
    );
    expect(entry?.key.type).toBe("secret");
    expect(entry?.key.algorithm.name).toBe("AES-GCM");
    expect(entry?.key.extractable).toBe(false);
    expect(entry?.key.usages).toContain("encrypt");
    expect(entry?.key.usages).toContain("decrypt");
  });

  it("accepts credential ids that embed a custom base URL", async () => {
    const id = "custom:https://api.example.com/v1";
    await saveCredential(id, "sk-custom");
    expect(await readCredential(id)).toBe("sk-custom");
  });

  it("keeps two credential ids independent", async () => {
    await saveCredential("preset:openai", "openai-secret");
    await saveCredential("preset:openrouter", "openrouter-secret");
    expect(await readCredential("preset:openai")).toBe("openai-secret");
    expect(await readCredential("preset:openrouter")).toBe(
      "openrouter-secret",
    );
    expect(
      chromeStub.store[`${STORAGE_KEY_PREFIX}preset:openai`],
    ).not.toEqual(chromeStub.store[`${STORAGE_KEY_PREFIX}preset:openrouter`]);
  });

  it("does not collide with the legacy Jev provider-key namespace", async () => {
    await saveProviderKey("typesafe", "jev-secret");
    await saveCredential("preset:openai", "llm-secret");

    expect(await readProviderKey("typesafe")).toBe("jev-secret");
    expect(await readCredential("preset:openai")).toBe("llm-secret");
    // Separate rows: Jev material stays under `provider:`, envelopes under
    // `providerKey:`; LLM material under `credential:`.
    expect(await db.keyMaterials.get("provider:typesafe")).toBeDefined();
    expect(await db.keyMaterials.get("credential:preset:openai")).toBeDefined();
    expect(chromeStub.store["providerKey:typesafe"]).toBeDefined();
    expect(chromeStub.store["credential:preset:openai"]).toBeDefined();
  });

  it("deleting a credential leaves Jev provider keys untouched", async () => {
    await saveProviderKey("typesafe", "jev-secret");
    await saveCredential("preset:openai", "llm-secret");

    await deleteCredential("preset:openai");

    expect(await readCredential("preset:openai")).toBeNull();
    expect(await readProviderKey("typesafe")).toBe("jev-secret");
  });

  it("uses a fresh random IV on every save", async () => {
    await saveCredential("preset:openai", "same-plaintext");
    const first = chromeStub.store[
      `${STORAGE_KEY_PREFIX}preset:openai`
    ] as StoredEnvelope;
    await saveCredential("preset:openai", "same-plaintext");
    const second = chromeStub.store[
      `${STORAGE_KEY_PREFIX}preset:openai`
    ] as StoredEnvelope;
    expect(second.iv).not.toBe(first.iv);
    expect(second.ct).not.toBe(first.ct);
    expect(await readCredential("preset:openai")).toBe("same-plaintext");
  });

  it("serializes concurrent saves so both remain decryptable", async () => {
    await Promise.all([
      saveCredential("preset:openai", "first"),
      saveCredential("preset:openai", "second"),
    ]);
    // Last-write-wins: either value is acceptable, but the winner must be
    // decryptable under the single surviving CryptoKey.
    const value = await readCredential("preset:openai");
    expect(["first", "second"]).toContain(value);
    const materials = await db.keyMaterials.toArray();
    expect(
      materials.filter((m) => m.id === `${MATERIAL_ID_PREFIX}preset:openai`),
    ).toHaveLength(1);
  });

  it("returns null when nothing was stored", async () => {
    expect(await readCredential("preset:openai")).toBeNull();
  });

  it("returns null when key material exists but no ciphertext was stored", async () => {
    await db.keyMaterials.put({
      id: `${MATERIAL_ID_PREFIX}preset:openai`,
      key: (await webcrypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )) as CryptoKey,
    });
    expect(await readCredential("preset:openai")).toBeNull();
  });

  it("maps a malformed stored envelope to a redacted reconnect error", async () => {
    chromeStub.store[`${STORAGE_KEY_PREFIX}preset:openai`] = "not-an-envelope";
    const error = await readCredential("preset:openai").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).code).toBe("reconnect");
    expect((error as Error).message).not.toContain("not-an-envelope");
  });

  it("maps tampered ciphertext to a reconnect error without echoing contents", async () => {
    const secret = "super-secret-plaintext";
    await saveCredential("preset:openai", secret);
    const envelope = chromeStub.store[
      `${STORAGE_KEY_PREFIX}preset:openai`
    ] as StoredEnvelope;
    chromeStub.store[`${STORAGE_KEY_PREFIX}preset:openai`] = {
      ...envelope,
      ct: btoa("tampered-ciphertext-bytes"),
    };
    const error = await readCredential("preset:openai").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).code).toBe("reconnect");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain("tampered");
  });

  it("maps orphaned ciphertext (CryptoKey deleted) to a reconnect error", async () => {
    await saveCredential("preset:openai", "secret-example");
    await db.keyMaterials.delete(`${MATERIAL_ID_PREFIX}preset:openai`);
    await expect(readCredential("preset:openai")).rejects.toMatchObject({
      name: "CredentialError",
      code: "reconnect",
    });
  });

  it("maps unusable stored key material to a reconnect error", async () => {
    await saveCredential("preset:openai", "secret-example");
    const wrongKey = (await webcrypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt"],
    )) as CryptoKey;
    await db.keyMaterials.put({
      id: `${MATERIAL_ID_PREFIX}preset:openai`,
      key: wrongKey,
    });
    await expect(readCredential("preset:openai")).rejects.toMatchObject({
      name: "CredentialError",
      code: "reconnect",
    });
  });

  it("deletes only the named credential's envelope and CryptoKey", async () => {
    await saveCredential("preset:openai", "openai-secret");
    await saveCredential("preset:openrouter", "openrouter-secret");

    await deleteCredential("preset:openai");

    expect(
      chromeStub.store[`${STORAGE_KEY_PREFIX}preset:openai`],
    ).toBeUndefined();
    expect(
      await db.keyMaterials.get(`${MATERIAL_ID_PREFIX}preset:openai`),
    ).toBeUndefined();
    expect(await readCredential("preset:openai")).toBeNull();
    expect(await readCredential("preset:openrouter")).toBe(
      "openrouter-secret",
    );
  });

  it("treats deleting a never-saved credential as a no-op", async () => {
    await expect(
      deleteCredential("preset:openrouter"),
    ).resolves.toBeUndefined();
  });

  it("re-saves cleanly after deletion", async () => {
    await saveCredential("preset:openai", "first-secret");
    await deleteCredential("preset:openai");
    await saveCredential("preset:openai", "second-secret");
    expect(await readCredential("preset:openai")).toBe("second-secret");
    expect(JSON.stringify(chromeStub.store)).not.toContain("second-secret");
  });

  it("rejects invalid credential ids", async () => {
    for (const id of ["", "   "]) {
      await expect(saveCredential(id, "secret"), JSON.stringify(id)).rejects.toThrow();
      await expect(readCredential(id), JSON.stringify(id)).rejects.toThrow();
      await expect(deleteCredential(id), JSON.stringify(id)).rejects.toThrow();
    }
  });
});

/**
 * Reach the in-memory `chrome.storage.local` stub so tests can gate one op
 * mid-flight. The stub object is the same instance the module under test
 * uses, so replacing a method here intercepts its calls.
 */
interface MutableLocalStub {
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function chromeLocal(): MutableLocalStub {
  return (
    globalThis as unknown as {
      chrome: { storage: { local: MutableLocalStub } };
    }
  ).chrome.storage.local;
}

describe("per-material serialization (H02)", () => {
  it("queues a delete behind an in-flight save — no torn state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = chromeLocal();
    const originalSet = local.set;
    const originalRemove = local.remove;
    const order: string[] = [];
    let setGated = true;
    local.set = async (items) => {
      order.push("set");
      if (setGated) {
        setGated = false;
        await gate;
      }
      await originalSet(items);
    };
    local.remove = async (keys) => {
      order.push("remove");
      await originalRemove(keys);
    };

    const saving = saveCredential("preset:openai", "first-secret");
    const deleting = deleteCredential("preset:openai");
    // Let both callers reach their awaited boundaries — the delete must be
    // queued behind the save's whole op, not interleaved into it.
    await new Promise((r) => setTimeout(r, 25));
    expect(order).toEqual(["set"]);
    release();
    await Promise.all([saving, deleting]);
    expect(order).toEqual(["set", "remove"]);
    expect(await readCredential("preset:openai")).toBeNull();
  });

  it("queues a save behind an in-flight delete so the envelope never outlives its CryptoKey", async () => {
    await saveCredential("preset:openai", "first-secret");
    const writesBefore = chromeStub.writes.length;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = chromeLocal();
    const originalRemove = local.remove;
    let removeGated = true;
    local.remove = async (keys) => {
      if (removeGated) {
        removeGated = false;
        await gate;
      }
      await originalRemove(keys);
    };

    // The delete starts and hangs mid-op. An unserialized save would
    // resolve the still-present CryptoKey, write its envelope, then have
    // the delete destroy that key — an undecryptable envelope. Queued, it
    // runs after the whole delete and mints a fresh key instead.
    const deleting = deleteCredential("preset:openai");
    const saving = saveCredential("preset:openai", "second-secret");
    await new Promise((r) => setTimeout(r, 25));
    expect(chromeStub.writes.length).toBe(writesBefore);
    release();
    await Promise.all([deleting, saving]);

    expect(await readCredential("preset:openai")).toBe("second-secret");
  });
});
