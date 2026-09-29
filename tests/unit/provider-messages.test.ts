import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsent,
  hasConsent,
  hasConsentAtOrigin,
  hasTestConsent,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { handleProviderMessage } from "../../src/messages/provider";
import { PRESETS } from "../../src/net/presets";
import {
  CONSENT_SCOPE,
  DECISIONS_CONSENT_SCOPE,
  ProviderSettings,
} from "../../src/schemas/provider";
import {
  deleteProviderKey,
  readProviderKey,
  saveProviderKey,
} from "../../src/security/keys";

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
    readProviderKey: vi.fn(async () => "test-provider-key-material"),
    deleteProviderKey: vi.fn(async () => undefined),
  };
});

const saveKey = vi.mocked(saveProviderKey);
const readKey = vi.mocked(readProviderKey);
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
  readKey.mockClear();
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

async function storedSettings(providerId: string) {
  const row = await db.metadata.get(providerId);
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

  it("accepts the Options page when its URL carries a panel hash", async () => {
    // The redesigned shell writes `#<panel>` and Chrome reports that URL
    // verbatim in `sender.url` — including after a reload of a hashed page.
    const result = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      { url: `${OPTIONS_URL}#permissions` },
    );
    expect(result).toMatchObject({ ok: true });
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

  it("removes every consent scope the provider holds, not just jev_test", async () => {
    await enableProvider();
    // A bookmark-data grant at the same origin must come off with the
    // provider revoke (FR1).
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(true);

    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      optionsSender,
    );

    expect(result).toMatchObject({ ok: true });
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(false);
    expect(await db.consents.count()).toBe(0);
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

describe("custom provider", () => {
  const BASE_URL = "https://ai-gateway.example.com/api";
  const ORIGIN = "https://ai-gateway.example.com";

  function customEnable(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: "ENABLE_PROVIDER",
      preset: "custom",
      baseUrl: BASE_URL,
      model: "jev-edge",
      key: RAW_KEY,
      ...overrides,
    };
  }

  it("enables: stores the row under 'custom', re-checks the computed permission, and grants consent at the resolved origin", async () => {
    const result = await handleProviderMessage(
      customEnable(),
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: {
        enabled: true,
        consentGranted: true,
        model: "jev-edge",
        keySuffix: "cdef",
        origin: ORIGIN,
        baseUrl: BASE_URL,
      },
    });
    expect(await storedSettings("custom")).toEqual({
      preset: "custom",
      baseUrl: BASE_URL,
      model: "jev-edge",
      keySuffix: "cdef",
    });
    expect(saveKey).toHaveBeenCalledWith("custom", RAW_KEY);
    // The worker derives the permission pattern from the stored row's
    // destination, never from the message.
    expect(containsSpy).toHaveBeenCalledWith({
      origins: ["https://ai-gateway.example.com/*"],
    });
    expect(
      await hasConsentAtOrigin(CONSENT_SCOPE, ORIGIN),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
  });

  it("requires a base URL — malformed without it", async () => {
    const result = await handleProviderMessage(
      {
        type: "ENABLE_PROVIDER",
        preset: "custom",
        model: "jev-edge",
        key: RAW_KEY,
      },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
    expect(await db.consents.count()).toBe(0);
  });

  it.each([
    "http://ai-gateway.example.com/api", // non-loopback http
    "https://ai-gateway.example.com/api/", // non-canonical
    "https://user:pw@ai-gateway.example.com/api",
    "not a url",
  ])("rejects base URL %s without writes", async (baseUrl) => {
    const result = await handleProviderMessage(
      customEnable({ baseUrl }),
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
  });

  it("ignores a stray baseUrl sent for a preset", async () => {
    // A preset's destination comes from the registry — an extra field on
    // the message cannot redirect it.
    const result = await handleProviderMessage(
      enableMessage({ baseUrl: "https://attacker.example.com" }),
      optionsSender,
    );
    expect(result).toMatchObject({ ok: true });
    expect(await storedSettings("typesafe")).toEqual({
      preset: "typesafe",
      model: "jev-latest",
      keySuffix: "cdef",
    });
    expect(
      await hasConsentAtOrigin(CONSENT_SCOPE, PRESETS.typesafe.origin),
    ).toBe(true);
    expect(
      await hasConsentAtOrigin(
        CONSENT_SCOPE,
        "https://attacker.example.com",
      ),
    ).toBe(false);
  });

  it("reports not-enabled status for an unconfigured custom provider", async () => {
    const result = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "custom" },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
    const status = (result as {
      status: { baseUrl?: string; origin?: string };
    }).status;
    expect(status.baseUrl).toBeUndefined();
    expect(status.origin).toBeUndefined();
  });

  it("re-enabling at a new origin grants consent there — per-origin consent keeps the old grant too", async () => {
    await handleProviderMessage(customEnable(), optionsSender);
    const result = await handleProviderMessage(
      customEnable({ baseUrl: "https://gateway-two.example.com/v1" }),
      optionsSender,
    );
    expect(result).toMatchObject({ ok: true, status: { enabled: true } });
    expect(
      await hasConsentAtOrigin(
        CONSENT_SCOPE,
        "https://gateway-two.example.com",
      ),
    ).toBe(true);
    // Consent is durable per origin — switching back resumes what the
    // user consented to at the first endpoint (same model as the LLM
    // provider layer).
    expect(await hasConsentAtOrigin(CONSENT_SCOPE, ORIGIN)).toBe(true);
  });

  it("revokes: drops consent at the resolved origin, releases its permission, deletes row and key", async () => {
    await handleProviderMessage(customEnable(), optionsSender);
    const result = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "custom", deleteKey: true },
      optionsSender,
    );
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: false },
    });
    expect(await hasConsentAtOrigin(CONSENT_SCOPE, ORIGIN)).toBe(false);
    expect(await db.metadata.get("custom")).toBeUndefined();
    expect(deleteKey).toHaveBeenCalledWith("custom");
    expect(removeSpy).toHaveBeenCalledWith({
      origins: ["https://ai-gateway.example.com/*"],
    });
  });

  it("refuses TEST_PROVIDER for an unconfigured custom provider", async () => {
    const result = await handleProviderMessage(
      { type: "TEST_PROVIDER", preset: "custom" },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
  });

  it("tests a configured custom provider through the gate to <baseUrl>/systemone", async () => {
    await handleProviderMessage(customEnable(), optionsSender);
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-edge",
            answers: { test: { type: "noul", noul: 1 } },
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const result = await handleProviderMessage(
      { type: "TEST_PROVIDER", preset: "custom" },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: true, code: "test_ok" });
    const url = (fetchSpy.mock.calls[0] as unknown[])[0];
    expect(url).toBe(`${BASE_URL}/systemone`);
    expect(readKey).toHaveBeenCalledWith("custom");
  });
});
