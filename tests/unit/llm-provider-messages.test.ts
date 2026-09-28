import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasConsentAtOrigin,
  grantConsentAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  handleLlmProviderMessage,
  type LlmProviderMessageResult,
} from "../../src/messages/llm-provider";
import {
  readActiveLlmProvider,
  readLlmProvider,
  saveLlmProvider,
} from "../../src/llm/settings";
import {
  readCredential,
  saveCredential,
} from "../../src/security/credentials";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

const OPTIONS_URL = "chrome-extension://test-id/options.html";
const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const MODEL = "gpt-4o-mini";

const SENDER = { url: OPTIONS_URL };

let containsSpy: ReturnType<typeof vi.fn>;
let removeSpy: ReturnType<typeof vi.fn>;
let storageStore: Record<string, unknown>;
let storageSet: {
  set: (items: Record<string, unknown>) => Promise<void>;
};

function installChromeStub() {
  storageStore = {};
  containsSpy = vi.fn(async () => true);
  removeSpy = vi.fn(async () => true);
  storageSet = {
    async set(items: Record<string, unknown>) {
      Object.assign(storageStore, items);
    },
  };
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          const wanted =
            keys === undefined || keys === null
              ? Object.keys(storageStore)
              : Array.isArray(keys)
                ? keys
                : [keys];
          const out: Record<string, unknown> = {};
          for (const k of wanted) {
            if (k in storageStore) out[k] = storageStore[k];
          }
          return out;
        },
        set: (items: Record<string, unknown>) => storageSet.set(items),
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys])
            delete storageStore[k];
        },
      },
    },
    permissions: { contains: containsSpy, remove: removeSpy },
    runtime: { getURL: (path: string) => `chrome-extension://test-id/${path}` },
  });
}

const PRESET_SETTINGS = {
  kind: "preset",
  preset: "openai",
  model: MODEL,
} as const;

function storedRecord(
  overrides: Partial<LlmProviderRecord> = {},
): LlmProviderRecord {
  return {
    providerId: PROVIDER_ID,
    provider: PRESET_SETTINGS,
    keySuffix: "1234",
    configuredAt: "2026-09-15T00:00:00.000Z",
    ...overrides,
  };
}

/** Fully enable a provider: record + credential + llm_test consent + perm. */
async function seedEnabledProvider() {
  await saveLlmProvider(storedRecord());
  await saveCredential(PROVIDER_ID, "sk-test-1234");
  await grantConsentAtOrigin("llm_test", ORIGIN);
}

async function call(
  message: unknown,
  sender: { url?: string } = SENDER,
): Promise<LlmProviderMessageResult | undefined> {
  return handleLlmProviderMessage(message, sender);
}

async function expectFailure(
  message: unknown,
  code: string,
  sender: { url?: string } = SENDER,
) {
  const result = await call(message, sender);
  expect(result).toBeDefined();
  if (result === undefined || !("ok" in result) || result.ok !== false) {
    throw new Error(`expected failure ${code}, got ${JSON.stringify(result)}`);
  }
  expect(result.code).toBe(code);
  return result;
}

beforeEach(async () => {
  installChromeStub();
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("dispatch and trust boundary", () => {
  it("returns undefined for messages outside the LLM provider protocol", async () => {
    expect(await call({ type: "PROVIDER_STATUS", preset: "openai" })).toBeUndefined();
    expect(await call({ type: "something-else" })).toBeUndefined();
    expect(await call("a string")).toBeUndefined();
    expect(await call(null)).toBeUndefined();
  });

  it("refuses senders that are not the Options page", async () => {
    await expectFailure(
      { type: "LLM_PROVIDER_STATUS" },
      "untrusted_sender",
      { url: "https://evil.example.com/page" },
    );
    await expectFailure(
      { type: "LLM_PROVIDER_STATUS" },
      "untrusted_sender",
      {},
    );
  });

  it("refuses malformed LLM protocol messages", async () => {
    await expectFailure({ type: "LLM_CONFIGURE" }, "malformed_message");
    await expectFailure(
      { type: "LLM_TEST", providerId: 42 },
      "malformed_message",
    );
    await expectFailure(
      { type: "LLM_REVOKE", providerId: PROVIDER_ID },
      "malformed_message",
    );
    await expectFailure(
      {
        type: "LLM_CONFIGURE",
        settings: { kind: "custom", baseUrl: "http://evil.com" },
      },
      "malformed_message",
    );
  });
});

describe("LLM_CONFIGURE", () => {
  it("enables a preset provider: record, credential, consent at origin", async () => {
    const result = await call({
      type: "LLM_CONFIGURE",
      settings: PRESET_SETTINGS,
      key: "sk-live-key-9",
      monthlyBudgetUsd: 5,
    });
    expect(result).toMatchObject({ ok: true, status: { enabled: true } });

    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.provider).toEqual(PRESET_SETTINGS);
    expect(record?.keySuffix).toBe("ey-9");
    expect(record?.monthlyBudgetUsd).toBe(5);
    expect(await readCredential(PROVIDER_ID)).not.toBeNull();
    expect(await hasConsentAtOrigin("llm_test", ORIGIN)).toBe(true);
    // Configuring makes it the active provider.
    expect((await readActiveLlmProvider())?.providerId).toBe(PROVIDER_ID);
  });

  it("never returns raw key material", async () => {
    const result = await call({
      type: "LLM_CONFIGURE",
      settings: PRESET_SETTINGS,
      key: "sk-live-secret-value",
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-value");
    const record = await readLlmProvider(PROVIDER_ID);
    expect(JSON.stringify(record)).not.toContain("sk-live-secret-value");
  });

  it("requires a key unless the provider auth mode is none", async () => {
    await expectFailure(
      { type: "LLM_CONFIGURE", settings: PRESET_SETTINGS },
      "key_required",
    );
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
  });

  it("refuses to configure when the exact host permission is missing", async () => {
    containsSpy.mockResolvedValue(false);
    await expectFailure(
      {
        type: "LLM_CONFIGURE",
        settings: PRESET_SETTINGS,
        key: "sk-x",
      },
      "no_permission",
    );
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await db.consents.count()).toBe(0);
  });

  it("rolls back a partial enable when consent storage fails", async () => {
    // Force the credential envelope write to fail after the record lands
    // by sabotaging storage.set for credential: keys — the configure flow
    // must unwind the record and leave no consent row.
    const originalSet = storageSet.set;
    vi.spyOn(storageSet, "set").mockImplementation(
      async (items: Record<string, unknown>) => {
        if (Object.keys(items).some((k) => k.startsWith("credential:"))) {
          throw new Error("storage failure");
        }
        return originalSet(items);
      },
    );

    await expectFailure(
      {
        type: "LLM_CONFIGURE",
        settings: PRESET_SETTINGS,
        key: "sk-x",
      },
      "configure_failed",
    );

    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await readCredential(PROVIDER_ID)).toBeNull();
    expect(await db.consents.count()).toBe(0);
  });

  it("configures an auth:none loopback custom provider without a key", async () => {
    const settings = {
      kind: "custom",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      auth: "none",
    } as const;
    const result = await call({ type: "LLM_CONFIGURE", settings });
    expect(result).toMatchObject({ ok: true });
    const record = await readLlmProvider("custom:http://localhost:11434/v1");
    expect(record).not.toBeNull();
    expect(
      await hasConsentAtOrigin("llm_test", "http://localhost:11434"),
    ).toBe(true);
  });
});

describe("LLM_PROVIDER_STATUS", () => {
  it("reports configured:false when nothing is set up", async () => {
    const result = await call({ type: "LLM_PROVIDER_STATUS" });
    expect(result).toMatchObject({
      ok: true,
      status: { configured: false, enabled: false },
    });
  });

  it("reports enabled only when record + consent + permission all hold", async () => {
    await seedEnabledProvider();
    const result = await call({ type: "LLM_PROVIDER_STATUS" });
    expect(result).toMatchObject({
      ok: true,
      status: {
        configured: true,
        enabled: true,
        consentGranted: true,
        permissionGranted: true,
        providerId: PROVIDER_ID,
        origin: ORIGIN,
        model: MODEL,
        keySuffix: "1234",
        auth: "bearer",
        active: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("flips enabled off when consent is revoked underneath", async () => {
    await seedEnabledProvider();
    await db.consents.clear();
    const result = await call({ type: "LLM_PROVIDER_STATUS" });
    expect(result).toMatchObject({
      ok: true,
      status: { configured: true, enabled: false, consentGranted: false },
    });
  });

  it("flips enabled off when the host permission is gone", async () => {
    await seedEnabledProvider();
    containsSpy.mockResolvedValue(false);
    const result = await call({ type: "LLM_PROVIDER_STATUS" });
    expect(result).toMatchObject({
      ok: true,
      status: { permissionGranted: false, enabled: false },
    });
  });
});

describe("LLM_TEST", () => {
  it("sends a synthetic ping, reports model/latency/tier, persists the tier", async () => {
    await seedEnabledProvider();
    const server = makeOpenAiServer();
    vi.stubGlobal("fetch", server.fetch);

    const result = await call({ type: "LLM_TEST" });
    expect(result).toMatchObject({
      ok: true,
      code: "test_ok",
      result: {
        model: MODEL,
        tier: "json_schema",
      },
    });
    if (result === undefined || !result.ok || !("result" in result)) {
      throw new Error("expected test_ok");
    }
    expect(result.result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.result.usage?.inputTokens).toBe(10);

    // Synthetic payload only: fixed connectivity-check messages, bounded.
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0]!.body as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens?: number;
    };
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBeLessThanOrEqual(16);
    const joined = JSON.stringify(body);
    expect(joined).not.toContain("sk-test");
    expect(joined).not.toContain("bookmark");
    // The discovered tier is persisted on the provider record.
    expect((await readLlmProvider(PROVIDER_ID))?.tier).toBe("json_schema");
  });

  it("falls back to json_object when json_schema is rejected as unsupported", async () => {
    await seedEnabledProvider();
    const server = makeOpenAiServer({
      failures: [
        {
          status: 400,
          body: { error: { message: "response_format json_schema not supported" } },
        },
      ],
    });
    vi.stubGlobal("fetch", server.fetch);

    const result = await call({ type: "LLM_TEST" });
    expect(result).toMatchObject({
      ok: true,
      result: { tier: "json_object" },
    });
    expect(server.requests).toHaveLength(2);
    expect((await readLlmProvider(PROVIDER_ID))?.tier).toBe("json_object");
  });

  it("fails incompatible when every tier is rejected", async () => {
    await seedEnabledProvider();
    const server = makeOpenAiServer({
      failures: [
        { status: 400, body: { error: { message: "response_format json_schema not supported" } } },
        { status: 400, body: { error: { message: "json mode not supported" } } },
        { status: 400, body: { error: { message: "model unavailable" } } },
      ],
    });
    vi.stubGlobal("fetch", server.fetch);

    // Third failure's body lacks a capability hint → plain http_error.
    const result = await expectFailure({ type: "LLM_TEST" }, "http_error");
    expect(result.code).toBe("http_error");
  });

  it("refuses test when the provider is not fully enabled", async () => {
    await seedEnabledProvider();
    await db.consents.clear();
    const server = makeOpenAiServer();
    vi.stubGlobal("fetch", server.fetch);
    await expectFailure({ type: "LLM_TEST" }, "not_enabled");
    expect(server.requests).toHaveLength(0);
  });

  it("reports not_configured for a missing provider", async () => {
    await expectFailure(
      { type: "LLM_TEST", providerId: "preset:openrouter" },
      "not_configured",
    );
  });

  it("relays redacted gate errors (no_key) without leaking internals", async () => {
    await saveLlmProvider(storedRecord());
    await grantConsentAtOrigin("llm_test", ORIGIN);
    // no credential stored
    const result = await expectFailure({ type: "LLM_TEST" }, "no_key");
    expect(result.message).not.toContain("sk-");
  });
});

describe("LLM_REVOKE", () => {
  it("removes consent first, then permission, record, and key on request", async () => {
    await seedEnabledProvider();
    await grantConsentAtOrigin("llm_explain", ORIGIN);

    const result = await call({
      type: "LLM_REVOKE",
      providerId: PROVIDER_ID,
      deleteKey: true,
    });
    expect(result).toMatchObject({ ok: true });

    expect(await db.consents.count()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*"],
    });
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await readCredential(PROVIDER_ID)).toBeNull();
  });

  it("keeps the stored credential when deleteKey is false", async () => {
    await seedEnabledProvider();
    const result = await call({
      type: "LLM_REVOKE",
      providerId: PROVIDER_ID,
      deleteKey: false,
    });
    expect(result).toMatchObject({ ok: true });
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await readCredential(PROVIDER_ID)).not.toBeNull();
  });

  it("still revokes consent when permission removal fails", async () => {
    await seedEnabledProvider();
    removeSpy.mockRejectedValue(new Error("browser refused"));
    const result = await expectFailure(
      { type: "LLM_REVOKE", providerId: PROVIDER_ID, deleteKey: true },
      "revoke_failed",
    );
    expect(result.message).toContain("permission");
    // Consent already gone — the gate still blocks every send.
    expect(await db.consents.count()).toBe(0);
  });

  it("reports not_configured for an unknown provider id", async () => {
    await expectFailure(
      { type: "LLM_REVOKE", providerId: "preset:openrouter", deleteKey: true },
      "not_configured",
    );
  });
});

describe("LLM_BUDGET_SNAPSHOT", () => {
  it("returns the monthly snapshot for the active provider", async () => {
    await seedEnabledProvider();
    await db.llmUsage.add({
      providerId: PROVIDER_ID,
      feature: "llm_test",
      model: MODEL,
      configuredModel: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      recordedAt: new Date().toISOString(),
    });
    const result = await call({ type: "LLM_BUDGET_SNAPSHOT" });
    expect(result).toMatchObject({
      ok: true,
      code: "budget_snapshot",
      snapshot: {
        requestCount: 1,
        inputTokens: 10,
        reportedCostUsd: 0.001,
        hasUnknownCost: false,
      },
    });
  });

  it("reports not_configured when no provider exists", async () => {
    await expectFailure({ type: "LLM_BUDGET_SNAPSHOT" }, "not_configured");
  });
});

describe("totality", () => {
  it("never rejects — every failure resolves to a result object", async () => {
    // Even with a sender whose getter throws, the handler answers.
    const evil = {
      get url(): string {
        throw new Error("hostile sender");
      },
    };
    const result = await call({ type: "LLM_PROVIDER_STATUS" }, evil);
    expect(result).toMatchObject({ ok: false });
  });
});
