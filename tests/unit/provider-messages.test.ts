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
/**
 * Stateful plaintext store behind the key-store mock: reads see exactly
 * what saves wrote and nothing when nothing was saved, so enable/revoke
 * flows exercise the real write/read/delete contract (including the H01
 * snapshot-then-restore path) instead of a fixed fixture value.
 */
const keyStore = vi.hoisted(() => new Map<string, string>());

vi.mock("../../src/security/keys", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/security/keys")>();
  return {
    ...actual,
    saveProviderKey: vi.fn(async (providerId: string, plaintext: string) => {
      keyStore.set(providerId, plaintext);
    }),
    readProviderKey: vi.fn(
      async (providerId: string) => keyStore.get(providerId) ?? null,
    ),
    deleteProviderKey: vi.fn(async (providerId: string) => {
      keyStore.delete(providerId);
    }),
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
  keyStore.clear();
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
  it("rejects untrusted senders — content scripts, other pages, other extensions, no url — and writes nothing", async () => {
    for (const [label, sender] of [
      ["content script", contentScriptSender],
      ["same-extension popup", { url: `chrome-extension://${EXTENSION_ID}/popup.html` }],
      ["other extension", { url: "chrome-extension://some-other-id/options.html" }],
      ["no url", {}],
    ] as const) {
      const result = await handleProviderMessage(enableMessage(), sender);
      expect(result, label).toMatchObject({
        ok: false,
        code: "untrusted_sender",
      });
      expect(saveKey, label).not.toHaveBeenCalled();
      expect(await db.metadata.count(), label).toBe(0);
      expect(await db.consents.count(), label).toBe(0);
    }
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
  it("rejects malformed messages", async () => {
    for (const [label, message] of [
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
    ] as const) {
      const result = await handleProviderMessage(message, optionsSender);
      expect(result, label).toMatchObject({ ok: false, code: "malformed_message" });
      expect(saveKey, label).not.toHaveBeenCalled();
      expect(await db.metadata.count(), label).toBe(0);
      expect(await db.consents.count(), label).toBe(0);
    }
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

  it("masks key suffixes — a placeholder for short keys, the last four otherwise", async () => {
    for (const shortKey of ["x9q", "zz42"]) {
      const result = await handleProviderMessage(
        enableMessage({ key: shortKey }),
        optionsSender,
      );
      expect(result, shortKey).toMatchObject({
        ok: true,
        status: { enabled: true, keySuffix: "****" },
      });
      // The raw key must not appear in the metadata row or any response.
      const settings = await storedSettings("typesafe");
      expect(settings?.keySuffix, shortKey).toBe("****");
      expect(JSON.stringify(settings)).not.toContain(shortKey);
      const status = await handleProviderMessage(
        { type: "PROVIDER_STATUS", preset: "typesafe" },
        optionsSender,
      );
      expect(JSON.stringify(status)).not.toContain(shortKey);
      expect(JSON.stringify(result)).not.toContain(shortKey);
    }
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

  it("fails closed without writes when the host permission is denied or the API throws", async () => {
    containsSpy.mockResolvedValue(false);
    const denied = await enableProvider();
    expect(denied).toMatchObject({ ok: false, code: "no_permission" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
    expect(await hasTestConsent("typesafe")).toBe(false);
    containsSpy.mockRejectedValue(new Error("permissions API down"));
    const thrown = await enableProvider();
    expect(thrown).toMatchObject({ ok: false, code: "no_permission" });
    expect(saveKey).not.toHaveBeenCalled();
  });

  it("rejects unlisted models without any writes", async () => {
    for (const model of ["gpt-4o", "typesafe/jev-1.13"]) {
      const result = await handleProviderMessage(
        enableMessage({ model }),
        optionsSender,
      );
      expect(result, model).toMatchObject({ ok: false, code: "unlisted_model" });
      expect(saveKey, model).not.toHaveBeenCalled();
      expect(await db.metadata.count(), model).toBe(0);
      expect(await db.consents.count(), model).toBe(0);
    }
  });

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

  it("trims whitespace-padded keys and rejects keys containing spaces or newlines", async () => {
    const padded = await handleProviderMessage(
      enableMessage({ key: "  sk-live-9abc \t" }),
      optionsSender,
    );
    expect(padded).toMatchObject({ ok: true, status: { enabled: true } });
    expect(saveKey).toHaveBeenCalledWith("typesafe", "sk-live-9abc");
    const status = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      optionsSender,
    );
    expect(status).toMatchObject({ ok: true, status: { keySuffix: "9abc" } });

    keyStore.clear();
    for (const bad of ["sk\nkey", "sk key", "\tsk	key"]) {
      const rejected = await handleProviderMessage(
        enableMessage({ key: bad }),
        optionsSender,
      );
      expect(rejected, bad).toMatchObject({
        ok: false,
        code: "malformed_message",
      });
    }
    // The rejects wrote nothing: only the successful enable's rows exist.
    expect(await db.metadata.count()).toBe(1);
    expect(await db.consents.count()).toBe(1);
  });

  it("a failed re-enable restores the previous credential, settings and consent", async () => {
    const first = await handleProviderMessage(
      enableMessage({ model: "jev-1.13.0", key: "sk-first-key" }),
      optionsSender,
    );
    expect(first).toMatchObject({ ok: true, status: { enabled: true } });
    saveKey.mockClear();
    deleteKey.mockClear();

    // Key write fails mid-enable: everything the attempt overwrote is put
    // back rather than stripped.
    saveKey.mockRejectedValueOnce(new Error("crypto subsystem down"));
    const failed = await handleProviderMessage(
      enableMessage({ model: "jev-latest", key: "sk-second-key" }),
      optionsSender,
    );
    expect(failed).toMatchObject({ ok: false, code: "enable_failed" });

    const settings = await storedSettings("typesafe");
    expect(settings?.model).toBe("jev-1.13.0");
    expect(keyStore.get("typesafe")).toBe("sk-first-key");
    expect(await hasTestConsent("typesafe")).toBe(true);
    // The restore re-saved the prior key — it did not delete it.
    expect(saveKey).toHaveBeenCalledWith("typesafe", "sk-first-key");
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("a failed re-enable at the consent step restores settings and key, and keeps the grant", async () => {
    await enableProvider();
    saveKey.mockClear();
    deleteKey.mockClear();

    const putSpy = vi
      .spyOn(db.consents, "put")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));
    const failed = await handleProviderMessage(
      enableMessage({ model: "jev-1.13.0", key: "sk-second-key" }),
      optionsSender,
    );
    putSpy.mockRestore();

    expect(failed).toMatchObject({ ok: false, code: "enable_failed" });
    const settings = await storedSettings("typesafe");
    expect(settings?.model).toBe("jev-latest");
    expect(keyStore.get("typesafe")).toBe(RAW_KEY);
    expect(await hasTestConsent("typesafe")).toBe(true);
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("a failed first enable still unwinds to nothing", async () => {
    saveKey.mockRejectedValueOnce(new Error("crypto subsystem down"));
    const result = await enableProvider();
    expect(result).toMatchObject({ ok: false, code: "enable_failed" });
    expect(await storedSettings("typesafe")).toBeUndefined();
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(keyStore.has("typesafe")).toBe(false);
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

  it("reports disabled when the permission was removed, and keeps presets independent", async () => {
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
    const other = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "openrouter" },
      optionsSender,
    );
    expect(other).toMatchObject({
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

  it("keeps the encrypted key when deleteKey is false, and no-ops on a never-enabled preset", async () => {
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
    const noop = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "openrouter", deleteKey: true },
      optionsSender,
    );
    expect(noop).toMatchObject({
      ok: true,
      status: { enabled: false, consentGranted: false },
    });
    expect(removeSpy).toHaveBeenCalledWith({
      origins: [PRESETS.openrouter.permissionPattern],
    });
  });

  it("fails revoke when consent or permission removal fails, honoring the spec ordering", async () => {
    await enableProvider();
    const deleteSpy = vi
      .spyOn(db.consents, "delete")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));
    const consentFail = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      optionsSender,
    );
    deleteSpy.mockRestore();
    expect(consentFail).toMatchObject({ ok: false, code: "revoke_failed" });
    // The spec ordering: nothing else runs when consent removal fails.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
    expect(await storedSettings("typesafe")).toBeDefined();
    // A permission-removal failure still leaves consent revoked and the
    // requested key deletion honored.
    removeSpy.mockRejectedValue(new Error("permissions API down"));
    const permFail = await handleProviderMessage(
      { type: "REVOKE_PROVIDER", preset: "typesafe", deleteKey: true },
      optionsSender,
    );
    expect(permFail).toMatchObject({ ok: false, code: "revoke_failed" });
    // Consent came off first, so the gate still blocks all traffic.
    expect(await hasTestConsent("typesafe")).toBe(false);
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

  it("requires a base URL and rejects non-loopback, non-canonical, credentialed, or malformed ones without writes", async () => {
    const missing = await handleProviderMessage(
      {
        type: "ENABLE_PROVIDER",
        preset: "custom",
        model: "jev-edge",
        key: RAW_KEY,
      },
      optionsSender,
    );
    expect(missing).toMatchObject({ ok: false, code: "malformed_message" });
    expect(saveKey).not.toHaveBeenCalled();
    expect(await db.metadata.count()).toBe(0);
    expect(await db.consents.count()).toBe(0);
    for (const baseUrl of [
      "http://ai-gateway.example.com/api", // non-loopback http
      "https://ai-gateway.example.com/api/", // non-canonical
      "https://user:pw@ai-gateway.example.com/api",
      "not a url",
    ]) {
      const result = await handleProviderMessage(
        customEnable({ baseUrl }),
        optionsSender,
      );
      expect(result, baseUrl).toMatchObject({ ok: false, code: "malformed_message" });
      expect(saveKey, baseUrl).not.toHaveBeenCalled();
      expect(await db.metadata.count(), baseUrl).toBe(0);
    }
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

  it("reports not-enabled status and refuses TEST_PROVIDER for an unconfigured custom provider", async () => {
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
    const test = await handleProviderMessage(
      { type: "TEST_PROVIDER", preset: "custom" },
      optionsSender,
    );
    expect(test).toMatchObject({ ok: false, code: "not_enabled" });
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

  it("relays a transport abort from the connection test as aborted", async () => {
    await handleProviderMessage(customEnable(), optionsSender);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }));
    const result = await handleProviderMessage(
      { type: "TEST_PROVIDER", preset: "custom" },
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, code: "aborted" });
  });
});
