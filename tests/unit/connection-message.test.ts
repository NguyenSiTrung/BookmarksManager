import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeTestConsent } from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  JevConnectionError,
  type JevConnectionErrorCode,
  testJevConnection,
} from "../../src/jev/connection";
import {
  handleProviderMessage,
  ProviderMessageResult,
} from "../../src/messages/provider";
import { NetworkGateError } from "../../src/net/send";
import { ProviderSettings } from "../../src/schemas/provider";
import {
  deleteProviderKey,
  ProviderKeyError,
  saveProviderKey,
} from "../../src/security/keys";

/**
 * Worker-side coverage for the TEST_PROVIDER message (Phase 3 Task 2).
 *
 * `testJevConnection` is mocked so this suite exercises the message layer —
 * sender trust, not-enabled refusal, stored-model routing, and error-code
 * mapping — without touching the gate, consent checks inside `send`, or
 * fetch. `JevConnectionError`/`NetworkGateError`/`ProviderKeyError` stay real
 * so code/message mapping is asserted against the genuine classes. Consent
 * and settings rows use the real Dexie tables on fake-indexeddb, and
 * `saveProviderKey` is stubbed so the enable flow needs no WebCrypto.
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

vi.mock("../../src/jev/connection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/jev/connection")>();
  return { ...actual, testJevConnection: vi.fn() };
});

const testConnection = vi.mocked(testJevConnection);

const EXTENSION_ID = "test-extension-id";
const OPTIONS_URL = `chrome-extension://${EXTENSION_ID}/options.html`;

const optionsSender = { url: OPTIONS_URL };
const contentScriptSender = {
  url: "https://example.com/page",
  tab: { id: 7, index: 0 },
};

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
  testConnection.mockReset();
  vi.mocked(saveProviderKey).mockClear();
  vi.mocked(deleteProviderKey).mockClear();
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

/** Drive a real enable so a fully-enabled preset exists in storage. */
async function enableProvider(
  preset: "typesafe" | "openrouter" = "typesafe",
  model = "jev-1.13.0",
): Promise<void> {
  const result = await handleProviderMessage(
    {
      type: "ENABLE_PROVIDER",
      preset,
      model,
      key: "sk-live-abcdef",
    },
    optionsSender,
  );
  expect(result).toMatchObject({ ok: true });
}

function testMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "TEST_PROVIDER", preset: "typesafe", ...overrides };
}

describe("TEST_PROVIDER validation and sender trust", () => {
  it.each([
    ["a missing preset", { type: "TEST_PROVIDER" }],
    ["a non-preset value", testMessage({ preset: "anthropic" })],
    ["a numeric preset", testMessage({ preset: 42 })],
  ])("rejects %s as malformed and never tests", async (_label, message) => {
    await enableProvider();
    const result = await handleProviderMessage(message, optionsSender);
    expect(result).toMatchObject({ ok: false, code: "malformed_message" });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("rejects a content-script sender before touching the provider", async () => {
    await enableProvider();
    const result = await handleProviderMessage(
      testMessage(),
      contentScriptSender,
    );
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("rejects a sender that is another extension page", async () => {
    await enableProvider();
    const result = await handleProviderMessage(testMessage(), {
      url: `chrome-extension://${EXTENSION_ID}/sidepanel.html`,
    });
    expect(result).toMatchObject({ ok: false, code: "untrusted_sender" });
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe("TEST_PROVIDER enabled gate", () => {
  it("refuses with not_enabled before any transport on a fresh install", async () => {
    const result = await handleProviderMessage(testMessage(), optionsSender);
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    expect(ProviderMessageResult.parse(result)).toBeTruthy();
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("refuses when settings exist but consent was never granted", async () => {
    await db.metadata.put({
      key: "typesafe",
      value: ProviderSettings.parse({
        preset: "typesafe",
        model: "jev-latest",
        keySuffix: "cdef",
      }),
    });
    const result = await handleProviderMessage(testMessage(), optionsSender);
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("refuses when consent was revoked after enabling", async () => {
    await enableProvider();
    await revokeTestConsent("typesafe");
    const result = await handleProviderMessage(testMessage(), optionsSender);
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("refuses when the host permission was removed outside the app", async () => {
    await enableProvider();
    containsSpy.mockResolvedValue(false);
    const result = await handleProviderMessage(testMessage(), optionsSender);
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("keeps presets independent — a different enabled preset does not unblock the test", async () => {
    await enableProvider("typesafe", "jev-latest");
    const result = await handleProviderMessage(
      testMessage({ preset: "openrouter" }),
      optionsSender,
    );
    expect(result).toMatchObject({ ok: false, code: "not_enabled" });
    expect(testConnection).not.toHaveBeenCalled();
  });
});

describe("TEST_PROVIDER success", () => {
  it("runs the synthetic test with the stored model and returns a typed result", async () => {
    await enableProvider("typesafe", "jev-1.13.0");
    testConnection.mockResolvedValue({ model: "jev-1.13.0", latencyMs: 37 });

    const result = await handleProviderMessage(testMessage(), optionsSender);

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(testConnection).toHaveBeenCalledWith("typesafe", "jev-1.13.0");
    expect(result).toMatchObject({
      ok: true,
      code: "test_ok",
      result: { model: "jev-1.13.0", latencyMs: 37 },
    });
    // The success wire shape round-trips through the shared result schema.
    expect(ProviderMessageResult.parse(result)).toEqual(result);
  });

  it("ignores a model field smuggled into the message — the stored model wins", async () => {
    await enableProvider("typesafe", "jev-1.13.0");
    testConnection.mockResolvedValue({ model: "jev-1.13.0", latencyMs: 12 });

    const result = await handleProviderMessage(
      testMessage({ model: "jev-latest" }),
      optionsSender,
    );

    expect(testConnection).toHaveBeenCalledWith("typesafe", "jev-1.13.0");
    expect(result).toMatchObject({ ok: true, code: "test_ok" });
  });

  it("carries the optional cost through for OpenRouter-shaped results", async () => {
    await enableProvider("openrouter", "typesafe/jev-1.13");
    testConnection.mockResolvedValue({
      model: "typesafe/jev-1.13",
      latencyMs: 58,
      cost: 0.000041,
    });

    const result = await handleProviderMessage(
      testMessage({ preset: "openrouter" }),
      optionsSender,
    );

    expect(testConnection).toHaveBeenCalledWith(
      "openrouter",
      "typesafe/jev-1.13",
    );
    expect(result).toMatchObject({
      ok: true,
      code: "test_ok",
      result: { model: "typesafe/jev-1.13", latencyMs: 58, cost: 0.000041 },
    });
    expect(ProviderMessageResult.parse(result)).toEqual(result);
  });
});

describe("TEST_PROVIDER failure mapping", () => {
  it.each([
    "auth",
    "incompatible",
    "retry_later",
    "invalid_response",
    "http_error",
    "gate",
  ] as const satisfies readonly JevConnectionErrorCode[])(
    "maps JevConnectionError code %s with its redacted message verbatim",
    async (code) => {
      await enableProvider();
      const message = `redacted guidance for ${code}`;
      testConnection.mockRejectedValue(new JevConnectionError(code, message));

      const result = await handleProviderMessage(testMessage(), optionsSender);

      expect(result).toEqual({ ok: false, code, message });
      expect(ProviderMessageResult.parse(result)).toEqual(result);
    },
  );

  it("maps a propagated NetworkGateError to the gate code, message preserved", async () => {
    await enableProvider();
    const gateError = new NetworkGateError(
      "no_permission",
      'Missing host permission for preset "typesafe".',
    );
    testConnection.mockRejectedValue(gateError);

    const result = await handleProviderMessage(testMessage(), optionsSender);

    expect(result).toEqual({
      ok: false,
      code: "gate",
      message: gateError.message,
    });
  });

  it.each([
    [
      "a ProviderKeyError storage failure",
      new ProviderKeyError("crypto subsystem unavailable"),
    ],
    ["a non-Error rejection", "kaboom-secret-material"],
  ])(
    "maps %s to internal_error without echoing internals",
    async (_label, thrown) => {
      await enableProvider();
      testConnection.mockRejectedValue(thrown);

      const result = await handleProviderMessage(testMessage(), optionsSender);

      expect(result).toMatchObject({ ok: false, code: "internal_error" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("crypto subsystem unavailable");
      expect(serialized).not.toContain("kaboom-secret-material");
    },
  );

  it("leaves consent, settings, and key untouched by a failed test", async () => {
    await enableProvider();
    testConnection.mockRejectedValue(
      new JevConnectionError("auth", "rejected"),
    );
    const result = await handleProviderMessage(testMessage(), optionsSender);
    expect(result).toMatchObject({ ok: false, code: "auth" });
    // A failed test is read-only: nothing was revoked or deleted.
    const status = await handleProviderMessage(
      { type: "PROVIDER_STATUS", preset: "typesafe" },
      optionsSender,
    );
    expect(status).toMatchObject({ ok: true, status: { enabled: true } });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(deleteProviderKey).not.toHaveBeenCalled();
  });
});
