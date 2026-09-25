import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTestConsent } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { handleProviderMessage } from "../../src/messages/provider";
import { PRESETS } from "../../src/net/presets";
import type { PresetId } from "../../src/schemas/provider";
import { ProviderSettings } from "../../src/schemas/provider";
import { deleteProviderKey, saveProviderKey } from "../../src/security/keys";

/**
 * The key store is mocked so enable/revoke can be driven without real
 * WebCrypto material; `ProviderKeyError` and the rest of the module stay real.
 * Consent records and metadata use the real Dexie tables on fake-indexeddb.
 */
vi.mock("../../src/security/keys", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/security/keys")>();
  return {
    ...actual,
    saveProviderKey: vi.fn(async () => undefined),
    deleteProviderKey: vi.fn(async () => undefined),
  };
});

const saveKey = vi.mocked(saveProviderKey);
const deleteKey = vi.mocked(deleteProviderKey);

const EXTENSION_ID = "test-extension-id";
const OPTIONS_URL = `chrome-extension://${EXTENSION_ID}/options.html`;

const optionsSender = { url: OPTIONS_URL };
const contentScriptSender = {
  url: "https://example.com/page",
  tab: { id: 7, index: 0 },
};

const RAW_KEY = "sk-live-abcdef";

let containsSpy: ReturnType<typeof vi.fn>;
let removeSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  containsSpy = vi.fn(async () => true);
  removeSpy = vi.fn(async () => true);
  vi.stubGlobal("chrome", {
    permissions: { contains: containsSpy, remove: removeSpy },
    runtime: {
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    },
  });
  saveKey.mockClear();
  deleteKey.mockClear();
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

function enableMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "ENABLE_PROVIDER",
    preset: "typesafe",
    model: "jev-latest",
    key: RAW_KEY,
    ...overrides,
  };
}

async function enableProvider(): Promise<unknown> {
  return handleProviderMessage(enableMessage(), optionsSender);
}

async function storedSettings(preset: PresetId) {
  const row = await db.metadata.get(preset);
  return row === undefined ? undefined : ProviderSettings.parse(row.value);
}

describe("sender validation", () => {
  it("rejects a content-script sender and writes nothing", async () => {
    const result = await handleProviderMessage(
      enableMessage(),
      contentScriptSender,
    );
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
    expect(await db.consents.count()).toBe(0);
  });

  it("rejects another extension page of the same extension", async () => {
    const result = await handleProviderMessage(enableMessage(), {
      url: `chrome-extension://${EXTENSION_ID}/popup.html`,
    });
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("rejects another extension's options page", async () => {
    const result = await handleProviderMessage(enableMessage(), {
      url: "chrome-extension://some-other-id/options.html",
    });
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
  });

  it("rejects a sender with no url", async () => {
    const result = await handleProviderMessage(enableMessage(), {});
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
  });
});

describe("message validation", () => {
  it.each([
    ["a non-object", "ENABLE_PROVIDER"],
    ["an empty object", {}],
    ["an unknown type", { type: "WIPE_EVERYTHING" }],
    ["missing key", { type: "ENABLE_PROVIDER", preset: "typesafe", model: "jev-latest" }],
    ["an empty key", enableMessage({ key: "" })],
    ["an unknown preset", enableMessage({ preset: "anthropic" })],
    [
      "a non-boolean deleteKey",
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: "yes" },
    ],
    ["a missing preset", { type: "PROVIDER_STATUS" }],
  ])("rejects %s as malformed", async (_label, message) => {
    const result = await handleProviderMessage(message, optionsSender);
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
    expect(await db.consents.count()).toBe(0);
  });
});

describe("ENABLE_PROVIDER", () => {
  it("persists settings with the masked suffix, saves the key, and grants consent", async () => {
    const result = await enableProvider();
    expect(result).toMatchObject({
      ok: true,
      status: {
        enabled: true,
        consentGranted: true,
        model: "jev-latest",
        keySuffix: "cdef",
      },
    });
    // The worker computes keySuffix = last 4 chars of the entered key.
    expect(await storedSettings("typesafe")).toEqual({
      preset: "typesafe",
      model: "jev-latest",
      keySuffix: "cdef",
    });
    expect(saveKey).toHaveBeenCalledTimes(1);
    expect(saveKey).toHaveBeenCalledWith("typesafe", RAW_KEY);
    expect(await hasTestConsent("typesafe")).toBe(true);
    // The raw key never leaves the worker: not in the result, not in storage.
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
    const settingsRow = await db.metadata.get("typesafe");
    expect(JSON.stringify(settingsRow)).not.toContain(RAW_KEY);
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("re-checks the freshly granted host permission in the worker", async () => {
    await enableProvider();
    expect(containsSpy).toHaveBeenCalledWith({
      origins: [PRESETS.typesafe.permissionPattern],
    });
  });

  it.each(["x9q", "zz42"])(
    "never persists a short key as its own suffix — %s stores a masked placeholder",
    async (shortKey) => {
      const result = await handleProviderMessage(
        enableMessage({ key: shortKey }),
        optionsSender,
      );
      expect(result).toMatchObject({
        ok: true,
        status: { enabled: true, keySuffix: "****" },
      });
      // The raw key must not appear in the metadata row or any response.
      const settings = await storedSettings("typesafe");
      expect(settings?.keySuffix).toBe("****");
      expect(JSON.stringify(settings)).not.toContain(shortKey);
      const status = await handleProviderMessage(
        { type: "PROVIDER_STATUS", preset: "typesafe" },
        optionsSender,
      );
      expect(JSON.stringify(status)).not.toContain(shortKey);
      expect(JSON.stringify(result)).not.toContain(shortKey);
    },
  );

  it("still stores the last four characters for a five-character key", async () => {
    const result = await handleProviderMessage(
      enableMessage({ key: "abcde" }),
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: true, keySuffix: "bcde" },
    });
    expect(await storedSettings("typesafe")).toMatchObject({
      keySuffix: "bcde",
    });
  });

  it("fails without writes when the host permission was not granted", async () => {
    containsSpy.mockResolvedValue(false);
    const result = await enableProvider();
    expect(result).toMatchObject({ ok: false, code: "no_permission" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
    expect(await hasTestConsent("typesafe")).toBe(false);
  });

  it("fails closed when the permissions API throws", async () => {
    containsSpy.mockRejectedValue(new Error("permissions API down"));
    const result = await enableProvider();
    expect(result).toMatchObject({ ok: false, code: "no_permission" });
    expect(saveKey).not.toHaveBeenCalled();
  });

  it.each(["gpt-4o", "typesafe/jev-1.13"])(
    "rejects unlisted model %s without any writes",
    async (model) => {
      const result = await handleProviderMessage(
        enableMessage({ model }),
        optionsSender,
      );
      expect(result).toMatchObject({ ok: false, code: "unlisted_model" });
      expect(saveKey).not.toHaveBeenCalled();
      expect(await db.metadata.count()).toBe(0);
      expect(await db.consents.count()).toBe(0);
    },
  );

  it("rolls back settings and key when the consent write fails", async () => {
    const putSpy = vi
      .spyOn(db.consents, "put")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));
    const result = await enableProvider();
    putSpy.mockRestore();
    expect(result).toMatchObject({ ok: false, code: "enable_failed" });
    // Best-effort unwind: no settings row, no consent row, key deleted.
    expect(await storedSettings("typesafe")).toBeUndefined();
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(deleteKey).toHaveBeenCalledWith("typesafe");
    // A provider must never appear enabled with missing consent.
    const status = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      optionsSender,
    );
    expect(status).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
  });

  it("rolls back consent/settings when key storage fails", async () => {
    saveKey.mockRejectedValueOnce(new Error("crypto subsystem down"));
    const result = await enableProvider();
    expect(result).toMatchObject({ ok: false, code: "enable_failed" });
    expect(await storedSettings("typesafe")).toBeUndefined();
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(deleteKey).toHaveBeenCalledWith("typesafe");
  });
});

describe("PROVIDER_STATUS", () => {
  it("reports a disabled provider before any setup", async () => {
    const result = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
    expect(JSON.stringify(result)).not.toContain("model");
    expect(JSON.stringify(result)).not.toContain("keySuffix");
  });

  it("restores the persisted model and masked suffix after enable", async () => {
    await handleProviderMessage(
      enableMessage({ model: "jev-1.13.0", key: "sk-live-9abc" }),
      optionsSender,
    );
    const result = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: {
        enabled: true,
        consentGranted: true,
        model: "jev-1.13.0",
        keySuffix: "9abc",
      },
    });
    // Status never carries key material.
    expect(JSON.stringify(result)).not.toContain("sk-live-9abc");
  });

  it("reports disabled when the permission was removed outside the app, consent still recorded", async () => {
    await enableProvider();
    containsSpy.mockResolvedValue(false);
    const result = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: true },
    });
  });

  it("keeps the two presets independent", async () => {
    await enableProvider();
    const result = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "openrouter" },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
  });
});

describe("REVOKE_PROVIDER", () => {
  it("removes consent, permission, settings, and the stored key when deleteKey is chosen", async () => {
    await enableProvider();
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith({
      origins: [PRESETS.typesafe.permissionPattern],
    });
    expect(deleteKey).toHaveBeenCalledWith("typesafe");
    expect(await storedSettings("typesafe")).toBeUndefined();
  });

  it("keeps the encrypted key when deleteKey is false but removes consent and permission", async () => {
    await enableProvider();
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: false },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: true });
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith({
      origins: [PRESETS.typesafe.permissionPattern],
    });
    expect(deleteKey).not.toHaveBeenCalled();
    expect(await storedSettings("typesafe")).toBeUndefined();
  });

  it("is a harmless no-op for a never-enabled preset", async () => {
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "openrouter", deleteKey: true },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
    expect(removeSpy).toHaveBeenCalledWith({
      origins: [PRESETS.openrouter.permissionPattern],
    });
  });

  it("stops when consent removal fails — permission and key untouched", async () => {
    await enableProvider();
    const deleteSpy = vi
      .spyOn(db.consents, "delete")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      optionsSender,
    );
    deleteSpy.mockRestore();
    expect(result).toMatchObject({ ok: false, code: "revoke_failed" });
    // The spec ordering: nothing else runs when consent removal fails.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
    expect(await storedSettings("typesafe")).toBeDefined();
  });

  it("still removes consent when permission removal fails, and reports the failure", async () => {
    await enableProvider();
    removeSpy.mockRejectedValue(new Error("permissions API down"));
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, code: "revoke_failed" });
    // Consent came off first, so the gate still blocks all traffic.
    expect(await hasTestConsent("typesafe")).toBe(false);
    // The requested key deletion is still honored.
    expect(deleteKey).toHaveBeenCalledWith("typesafe");
  });

  it("ignores a revoke sent by an untrusted sender", async () => {
    await enableProvider();
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      contentScriptSender,
    );
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(await hasTestConsent("typesafe")).toBe(true);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
  });
});
