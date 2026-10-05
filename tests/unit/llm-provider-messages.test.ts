import "fake-indexeddb/auto";
import Dexie from "dexie";
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
import { createLlmForTest as createLlmClient, reservedInputBound, scopeRequest } from "../fakes/llm";
import { pingRequest } from "../../src/llm/prompt-contracts";
import { utcMonthOf } from "../../src/llm/budget";
import type { BudgetReservation } from "../../src/llm/budget";
import { settleLlmUsage } from "../../src/net/llm-send";
import { deleteAllExtensionData } from "../../src/security/delete-all";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

const OPTIONS_URL = "chrome-extension://test-id/options.html";
const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const MODEL = "gpt-4o-mini";

// A04: the serialized explain request estimates above the declared
// 100-token bound, so reservations use the honest bound instead.
const BOUND_INPUT = reservedInputBound(scopeRequest("llm_explain", MODEL), 100, 50);
const rateCost = (input: number, output: number) =>
  (input * 2 + output * 4) / 1e6;
const BOUND_COST = rateCost(BOUND_INPUT, 50);
// The LLM_TEST probe's ping request estimates above its declared 64.
const PING_BOUND = reservedInputBound(pingRequest(MODEL, "json_schema"), 64, 16);

const SENDER = { url: OPTIONS_URL };

let containsSpy: ReturnType<typeof vi.fn>;
let removeSpy: ReturnType<typeof vi.fn>;
let storageStore: Record<string, unknown>;
let storageSet: {
  set: (items: Record<string, unknown>) => Promise<void>;
};
let storageRemove: ReturnType<typeof vi.fn>;

function installChromeStub() {
  storageStore = {};
  containsSpy = vi.fn(async () => true);
  removeSpy = vi.fn(async () => true);
  storageSet = {
    async set(items: Record<string, unknown>) {
      Object.assign(storageStore, items);
    },
  };
  storageRemove = vi.fn(async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys])
      delete storageStore[k];
  });
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
        remove: storageRemove,
        async clear() {
          for (const k of Object.keys(storageStore)) delete storageStore[k];
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Hold the actual wire boundary, not the gate or accounting implementation. */
function heldCompletion() {
  const invoked = deferred<void>();
  const response = deferred<Response>();
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    invoked.resolve();
    return response.promise;
  });
  const client = createLlmClient(PROVIDER_ID, {
    scope: "llm_explain",
    kind: "manual",
    maxInputTokens: 100,
    maxOutputTokens: 50,
    fetchImpl,
  });
  const request = scopeRequest("llm_explain", MODEL);
  return { client, request, fetchImpl, invoked: invoked.promise, response };
}

async function seedExplainProvider() {
  await seedEnabledProvider();
  await saveLlmProvider(storedRecord({
    provider: {
      ...PRESET_SETTINGS,
      pricing: { inputPerMillion: 2, outputPerMillion: 4 },
    },
    monthlyBudgetUsd: 1,
  }));
  await grantConsentAtOrigin("llm_explain", ORIGIN);
}

function completionResponse() {
  return Response.json({
    id: "synthetic-completion",
    object: "chat.completion",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function reservationRow(
  id: string,
  overrides: Partial<BudgetReservation> = {},
): BudgetReservation {
  return {
    id,
    providerId: PROVIDER_ID,
    model: MODEL,
    month: "2026-09",
    reservedUsd: 0.0004,
    maxInputTokens: 100,
    maxOutputTokens: 50,
    pricing: { inputPerMillion: 2, outputPerMillion: 4 },
    kind: "manual",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const REVOKE = {
  type: "LLM_REVOKE",
  providerId: PROVIDER_ID,
  deleteKey: true,
};

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

async function resetEnv() {
  installChromeStub();
  vi.restoreAllMocks();
  await db.delete();
  await db.open();
}

beforeEach(resetEnv);

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("dispatch and trust boundary", () => {
  it("ignores non-protocol messages and refuses malformed ones", async () => {
    expect(await call({ type: "PROVIDER_STATUS", preset: "openai" })).toBeUndefined();
    expect(await call({ type: "something-else" })).toBeUndefined();
    expect(await call("a string")).toBeUndefined();
    expect(await call(null)).toBeUndefined();
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

  it("gates senders: refuses non-Options URLs, accepts an Options URL carrying a panel hash", async () => {
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
    // The redesigned shell writes `#<panel>` and Chrome reports that URL
    // verbatim in `sender.url` — including after a reload of a hashed page.
    const result = await call(
      { type: "LLM_PROVIDER_STATUS" },
      { url: `${OPTIONS_URL}#permissions` },
    );
    expect(result).toMatchObject({ ok: true });
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

  it("drops the stored credential when reconfigured to auth:none", async () => {
    // Same baseUrl ⇒ same providerId; flipping auth api-key → none must not
    // leave the key stored-but-unreachable behind the new record.
    const baseUrl = "http://localhost:11434/v1";
    const providerId = `custom:${baseUrl}`;
    const first = await call({
      type: "LLM_CONFIGURE",
      settings: {
        kind: "custom",
        baseUrl,
        model: "llama3",
        auth: "api-key",
      },
      key: "sk-once-secret",
    });
    expect(first).toMatchObject({ ok: true });
    expect(await readCredential(providerId)).not.toBeNull();

    const second = await call({
      type: "LLM_CONFIGURE",
      settings: {
        kind: "custom",
        baseUrl,
        model: "llama3",
        auth: "none",
      },
    });
    expect(second).toMatchObject({ ok: true });
    expect(await readCredential(providerId)).toBeNull();
    // The record itself reflects the new auth mode (keySuffix is dropped).
    const record = await readLlmProvider(providerId);
    expect(record?.provider).toMatchObject({ kind: "custom", auth: "none" });
    expect(record?.keySuffix).toBeUndefined();
  });

  it("stores an explicitly unlimited ceiling and reports it", async () => {
    const result = await call({
      type: "LLM_CONFIGURE",
      settings: PRESET_SETTINGS,
      key: "sk-live-key-9",
      monthlyBudgetUnlimited: true,
    });
    expect(result).toMatchObject({
      ok: true,
      status: { budget: "unlimited", pricingKnown: true },
    });
    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.monthlyBudgetUnlimited).toBe(true);
    expect(record?.monthlyBudgetUsd).toBeUndefined();
  });

  it("rejects a message carrying both a cap and unlimited", async () => {
    await expectFailure(
      {
        type: "LLM_CONFIGURE",
        settings: PRESET_SETTINGS,
        key: "sk-live-key-9",
        monthlyBudgetUsd: 5,
        monthlyBudgetUnlimited: true,
      },
      "malformed_message",
    );
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
  });

  it("trims padded keys and rejects keys containing spaces or newlines", async () => {
    const padded = await call({
      type: "LLM_CONFIGURE",
      settings: PRESET_SETTINGS,
      key: "  sk-pad-key \t",
    });
    expect(padded).toMatchObject({ ok: true });
    expect(await readCredential(PROVIDER_ID)).toBe("sk-pad-key");
    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.keySuffix).toBe("-key");

    for (const bad of ["sk\nkey", "sk key", "\tsk\tkey"]) {
      await expectFailure(
        {
          type: "LLM_CONFIGURE",
          settings: PRESET_SETTINGS,
          key: bad,
        },
        "malformed_message",
      );
    }
    // The rejected messages wrote nothing: the first configure's single
    // credential row is still the only envelope in storage.
    expect(
      Object.keys(storageStore).filter((k) => k.startsWith("credential:")),
    ).toHaveLength(1);
    expect(await db.consents.count()).toBe(1);
  });

  it("a failed re-configure restores the previous record, credential, consent and active pointer", async () => {
    const first = await call({
      type: "LLM_CONFIGURE",
      settings: PRESET_SETTINGS,
      key: "sk-first-key",
      monthlyBudgetUsd: 5,
    });
    expect(first).toMatchObject({ ok: true });

    const putSpy = vi
      .spyOn(db.consents, "put")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));
    await expectFailure(
      {
        type: "LLM_CONFIGURE",
        settings: { ...PRESET_SETTINGS, model: "gpt-4o" },
        key: "sk-second-key",
      },
      "configure_failed",
    );
    putSpy.mockRestore();

    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.provider.model).toBe(MODEL);
    expect(record?.monthlyBudgetUsd).toBe(5);
    // The attempt's overwrite of the credential was rolled back.
    expect(await readCredential(PROVIDER_ID)).toBe("sk-first-key");
    expect(await hasConsentAtOrigin("llm_test", ORIGIN)).toBe(true);
    expect((await readActiveLlmProvider())?.providerId).toBe(PROVIDER_ID);
  });

  it("a settings-only re-configure keeps the ceiling and pricing override", async () => {
    await call({
      type: "LLM_CONFIGURE",
      settings: PRESET_SETTINGS,
      key: "sk-first-key",
      monthlyBudgetUsd: 5,
    });
    // The pricing override lives behind LLM_BUDGET_SET — a configure that
    // does not mention pricing must not silently drop it (H01).
    await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "capped", usd: 5 },
      pricing: { inputPerMillion: 9, outputPerMillion: 9 },
    });

    const second = await call({
      type: "LLM_CONFIGURE",
      settings: { ...PRESET_SETTINGS, model: "gpt-4o" },
      key: "sk-second-key",
    });
    expect(second).toMatchObject({ ok: true });
    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.provider.model).toBe("gpt-4o");
    expect(record?.monthlyBudgetUsd).toBe(5);
    expect(record?.provider.pricing).toEqual({
      inputPerMillion: 9,
      outputPerMillion: 9,
    });
  });
});

describe("LLM_BUDGET_SET", () => {
  it("switches an enabled provider from a cap to unlimited without re-consent", async () => {
    await seedEnabledProvider();
    await saveLlmProvider(storedRecord({ monthlyBudgetUsd: 5 }));
    const result = await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "unlimited" },
    });
    expect(result).toMatchObject({
      ok: true,
      status: { enabled: true, budget: "unlimited" },
    });
    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.monthlyBudgetUnlimited).toBe(true);
    expect(record?.monthlyBudgetUsd).toBeUndefined();
    // Consent and credential are untouched — no re-prompt, no re-entry.
    expect(await hasConsentAtOrigin("llm_test", ORIGIN)).toBe(true);
    expect(await readCredential(PROVIDER_ID)).not.toBeNull();
  });

  it("can go back to a cap, and to no choice at all", async () => {
    await seedEnabledProvider();
    await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "capped", usd: 12.5 },
    });
    expect((await readLlmProvider(PROVIDER_ID))?.monthlyBudgetUsd).toBe(12.5);

    const cleared = await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "unset" },
    });
    expect(cleared).toMatchObject({ ok: true, status: { budget: "unset" } });
    const record = await readLlmProvider(PROVIDER_ID);
    expect(record?.monthlyBudgetUsd).toBeUndefined();
    expect(record?.monthlyBudgetUnlimited).toBeUndefined();
  });

  it("applies a pricing override and can clear it again", async () => {
    await seedEnabledProvider();
    await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "capped", usd: 5 },
      pricing: { inputPerMillion: 3, outputPerMillion: 4 },
    });
    let record = await readLlmProvider(PROVIDER_ID);
    expect(record?.provider).toMatchObject({
      pricing: { inputPerMillion: 3, outputPerMillion: 4 },
    });

    await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "capped", usd: 5 },
      pricing: null,
    });
    record = await readLlmProvider(PROVIDER_ID);
    expect(record?.provider).not.toHaveProperty("pricing");
    // The built-in table still prices the preset default model.
    expect(record?.provider).toEqual(PRESET_SETTINGS);
  });

  it("refuses an unconfigured provider", async () => {
    await expectFailure(
      {
        type: "LLM_BUDGET_SET",
        providerId: PROVIDER_ID,
        budget: { kind: "unlimited" },
      },
      "not_configured",
    );
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

  it("flips enabled off when consent is revoked or the host permission is gone", async () => {
    await seedEnabledProvider();
    await db.consents.clear();
    const revoked = await call({ type: "LLM_PROVIDER_STATUS" });
    expect(revoked).toMatchObject({
      ok: true,
      status: { configured: true, enabled: false, consentGranted: false },
    });
    await seedEnabledProvider();
    containsSpy.mockResolvedValue(false);
    const unpermitted = await call({ type: "LLM_PROVIDER_STATUS" });
    expect(unpermitted).toMatchObject({
      ok: true,
      status: { permissionGranted: false, enabled: false },
    });
  });
});

describe("LLM_TEST", () => {
  async function startHeldProbe() {
    await seedExplainProvider();
    await saveLlmProvider(storedRecord({
      provider: { ...PRESET_SETTINGS, pricing: { inputPerMillion: 2, outputPerMillion: 4 } },
      monthlyBudgetUnlimited: true,
    }));
    const held = heldCompletion();
    vi.stubGlobal("fetch", held.fetchImpl);
    const pending = call({ type: "LLM_TEST", providerId: PROVIDER_ID });
    await held.invoked;
    const [reservation] = await db.llmReservations.toArray();
    expect(reservation).toMatchObject({ status: "active", maxInputTokens: PING_BOUND, maxOutputTokens: 16 });
    return { ...held, pending, reservationId: reservation!.id };
  }

  async function finishHeldProbe(held: Awaited<ReturnType<typeof startHeldProbe>>) {
    held.response.resolve(completionResponse());
    expect(await held.pending).toMatchObject({ ok: true, code: "test_ok", result: { model: MODEL, tier: "json_schema" } });
    expect(await db.llmUsage.toArray()).toMatchObject([{
      providerId: PROVIDER_ID,
      feature: "llm_test",
      model: MODEL,
      configuredModel: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.00004,
    }]);
    await Promise.all([
      settleLlmUsage(held.reservationId, "llm_test", { reportedCostUsd: 99 }),
      settleLlmUsage(held.reservationId, "llm_test", { reportedCostUsd: 99 }),
    ]);
    expect(await db.llmUsage.count()).toBe(1);
    expect((await db.llmReservations.get(held.reservationId))?.status).toBe("settled");
  }

  it("does not recreate revoked settings when a real connection probe completes late", async () => {
    const held = await startHeldProbe();
    expect(await call(REVOKE)).toMatchObject({ ok: true });
    await finishHeldProbe(held);
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await db.metadata.get("llmActiveProvider")).toBeUndefined();
    expect(await db.consents.count()).toBe(0);
    expect(await readCredential(PROVIDER_ID)).toBeNull();
    await expectFailure({ type: "LLM_TEST", providerId: PROVIDER_ID }, "not_configured");
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not replace re-enabled cap, model, prices or key with a late probe's old unlimited record", async () => {
    const held = await startHeldProbe();
    expect(await call(REVOKE)).toMatchObject({ ok: true });
    expect(await call({
      type: "LLM_CONFIGURE",
      settings: { ...PRESET_SETTINGS, model: "gpt-4o", pricing: { inputPerMillion: 100, outputPerMillion: 200 } },
      key: "sk-synthetic-current-key",
      monthlyBudgetUsd: 0.001,
    })).toMatchObject({ ok: true });
    const current = await readLlmProvider(PROVIDER_ID);
    const consents = await db.consents.toArray();
    const storage = { ...storageStore };
    await finishHeldProbe(held);
    expect(await readLlmProvider(PROVIDER_ID)).toEqual(current);
    expect((await readActiveLlmProvider())?.providerId).toBe(PROVIDER_ID);
    expect((await readLlmProvider(PROVIDER_ID))?.provider).toMatchObject({
      model: "gpt-4o",
      pricing: { inputPerMillion: 100, outputPerMillion: 200 },
    });
    expect((await readLlmProvider(PROVIDER_ID))?.monthlyBudgetUsd).toBe(0.001);
    expect((await readLlmProvider(PROVIDER_ID))?.monthlyBudgetUnlimited).toBeUndefined();
    expect(await db.consents.toArray()).toEqual(consents);
    expect(storageStore).toEqual(storage);
    expect(await readCredential(PROVIDER_ID)).toBe("sk-synthetic-current-key");
    // Fresh grants/key exist, so the current cap (not missing consent) must refuse.
    await expectFailure({ type: "LLM_TEST", providerId: PROVIDER_ID }, "budget_exceeded");
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves a concurrent budget or pricing update during a real connection probe", async () => {
    for (const pricing of [
      undefined,
      { inputPerMillion: 100, outputPerMillion: 200 },
    ] as const) {
    await resetEnv();
    const label = pricing === undefined ? "budget-only update" : "budget and pricing update";
    const held = await startHeldProbe();
    expect(await call({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "capped", usd: 0 },
      ...(pricing === undefined ? {} : { pricing }),
    })).toMatchObject({ ok: true });
    const current = await readLlmProvider(PROVIDER_ID);
    const consents = await db.consents.toArray();
    const storage = { ...storageStore };
    await finishHeldProbe(held);
    expect(await readLlmProvider(PROVIDER_ID)).toEqual(current);
    expect((await readActiveLlmProvider())?.providerId).toBe(PROVIDER_ID);
    expect(await db.consents.toArray()).toEqual(consents);
    expect(storageStore).toEqual(storage);
    expect(await readCredential(PROVIDER_ID)).toBe("sk-test-1234");
    await expectFailure({ type: "LLM_TEST", providerId: PROVIDER_ID }, "budget_exceeded");
    expect(held.fetchImpl, label).toHaveBeenCalledTimes(1);
    }
  });

  it("serializes tier persistence with a delete or replace queued between the fresh check and save", async () => {
    for (const operation of ["delete", "replace"] as const) {
    await resetEnv();
    const held = await startHeldProbe();
    const replacement = storedRecord({
      provider: { ...PRESET_SETTINGS, model: "gpt-4o" },
      monthlyBudgetUsd: 0,
      configuredAt: "2026-10-01T00:00:00.000Z",
    });
    const put = db.metadata.put.bind(db.metadata);
    let queued: Promise<unknown> | undefined;
    vi.spyOn(db.metadata, "put").mockImplementation((row, key) => {
      if (row.key === `llmProvider:${PROVIDER_ID}` &&
          typeof row.value === "object" && row.value !== null && "tier" in row.value) {
        // Queue an independent context's real metadata write exactly at the
        // check/save boundary. No gate, read, transaction or write is mocked
        // away: the spy only schedules the competing mutation.
        queued = Dexie.ignoreTransaction(() =>
          operation === "delete"
            ? db.metadata.delete(`llmProvider:${PROVIDER_ID}`)
            : put({ key: `llmProvider:${PROVIDER_ID}`, value: replacement }),
        );
      }
      return put(row, key);
    });
    await finishHeldProbe(held);
    expect(queued).toBeDefined();
    await queued;
    expect(await readLlmProvider(PROVIDER_ID)).toEqual(operation === "delete" ? null : replacement);
    }
  });

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

  it("refuses when the provider is not fully enabled or not configured", async () => {
    await seedEnabledProvider();
    await db.consents.clear();
    const server = makeOpenAiServer();
    vi.stubGlobal("fetch", server.fetch);
    await expectFailure({ type: "LLM_TEST" }, "not_enabled");
    expect(server.requests).toHaveLength(0);
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
  it("settles a held successful response once after settings and credential removal", async () => {
    await seedExplainProvider();
    const held = heldCompletion();
    const inFlight = held.client.send(held.request);
    await held.invoked;
    const [reservation] = await db.llmReservations.toArray();
    expect(reservation).toMatchObject({ status: "active", reservedUsd: BOUND_COST });

    expect(await call(REVOKE)).toMatchObject({ ok: true });
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await readActiveLlmProvider()).toBeNull();
    expect(await readCredential(PROVIDER_ID)).toBeNull();
    expect(await db.consents.count()).toBe(0);
    await expect(held.client.send(held.request)).rejects.toMatchObject({ code: "no_provider" });
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);

    held.response.resolve(completionResponse());
    await inFlight;
    expect(await db.llmUsage.toArray()).toMatchObject([{
      providerId: PROVIDER_ID,
      feature: "llm_explain",
      model: MODEL,
      configuredModel: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.00004,
    }]);
    expect((await db.llmReservations.get(reservation!.id))?.status).toBe("settled");
    await Promise.all([
      settleLlmUsage(reservation!.id, "llm_explain", { reportedCostUsd: 99 }),
      settleLlmUsage(reservation!.id, "llm_explain", { reportedCostUsd: 99 }),
    ]);
    expect(await db.llmUsage.count()).toBe(1);
    expect((await db.llmUsage.toArray())[0]?.costUsd).toBeUndefined();
  });

  it("accounts for a late attempt outcome without allowing another attempt", async () => {
    for (const { label, response, error, tokens, cost } of [
      { label: "HTTP error with reported usage", response: () => Response.json({ usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.02 } }, { status: 400 }), error: { status: 400 }, tokens: [3, 2], cost: { costUsd: 0.02 } },
      { label: "retryable HTTP error", response: () => Response.json({ error: "temporary failure" }, { status: 503 }), error: { code: "no_provider" }, tokens: [BOUND_INPUT, 50], cost: { estimatedCostUsd: BOUND_COST } },
      { label: "malformed success", response: () => new Response("not JSON"), error: { code: "transport" }, tokens: [BOUND_INPUT, 50], cost: { estimatedCostUsd: BOUND_COST } },
      { label: "aborted transport", response: () => null, error: { code: "aborted" }, tokens: [BOUND_INPUT, 50], cost: { estimatedCostUsd: BOUND_COST } },
    ] as const) {
    await resetEnv();
    await seedExplainProvider();
    const held = heldCompletion();
    // Attach rejection handling before releasing the held transport.
    const outcome = held.client.send(held.request).catch((cause: unknown) => cause);
    await held.invoked;
    const [reservation] = await db.llmReservations.toArray();
    expect(await call(REVOKE)).toMatchObject({ ok: true });
    const wire = response();
    if (wire === null) held.response.reject(new DOMException("Synthetic abort", "AbortError"));
    else held.response.resolve(wire);
    expect(await outcome).toMatchObject(error);
    expect(await db.llmUsage.toArray()).toMatchObject([{
      inputTokens: tokens[0],
      outputTokens: tokens[1],
      ...cost,
    }]);
    await settleLlmUsage(reservation!.id, "llm_explain", { reportedCostUsd: 99 });
    expect(await db.llmUsage.count()).toBe(1);
    await expect(held.client.send(held.request)).rejects.toMatchObject({ code: "no_provider" });
    expect(held.fetchImpl, label).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves old active and unknown exposure, terminal rows, unrelated providers, and existing usage", async () => {
    await seedEnabledProvider();
    const unknown = reservationRow("unknown", { reservedUsd: null });
    delete unknown.pricing;
    const reservations = [
      reservationRow("active"),
      unknown,
      reservationRow("settled", { status: "settled", settledAt: "2026-09-02T00:00:00.000Z" }),
      reservationRow("released", { status: "released", settledAt: "2026-09-02T00:00:00.000Z" }),
      reservationRow("other", { providerId: "preset:openrouter" }),
    ];
    await db.llmReservations.bulkPut(reservations);
    await saveLlmProvider(storedRecord({
      providerId: "preset:openrouter",
      provider: { kind: "preset", preset: "openrouter" },
    }));
    await grantConsentAtOrigin("llm_explain", "https://openrouter.ai");
    await db.llmUsage.add({
      providerId: PROVIDER_ID,
      feature: "llm_explain",
      model: MODEL,
      configuredModel: MODEL,
      inputTokens: 7,
      outputTokens: 3,
      costUsd: 0.1,
      recordedAt: "2026-09-02T00:00:00.000Z",
    });
    const usage = await db.llmUsage.toArray();
    expect(await call(REVOKE)).toMatchObject({ ok: true });
    expect(await db.llmReservations.toArray()).toEqual(
      [...reservations].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await db.llmUsage.toArray()).toEqual(usage);
    expect((await readActiveLlmProvider())?.providerId).toBe("preset:openrouter");
    expect(await hasConsentAtOrigin("llm_explain", "https://openrouter.ai")).toBe(true);
    // Unpriced paid exposure must remain unknown, not become a free request.
    await settleLlmUsage("unknown", "llm_explain", {});
    const rows = await db.llmUsage.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(rows[0]?.costUsd).toBeUndefined();
    expect(rows[0]?.estimatedCostUsd).toBeUndefined();
    // A08: the pre-existing September row folded into its monthly rollup
    // inside the same settle transaction — preserved, not lost.
    expect(await db.llmUsageMonths.get(`${PROVIDER_ID}|2026-09`)).toMatchObject({
      providerId: PROVIDER_ID,
      month: "2026-09",
      requests: 1,
      inputTokens: 7,
      outputTokens: 3,
      reportedCostUsd: 0.1,
      unknownCostRequests: 0,
    });
  });

  it("serializes concurrent settlement with revoke and makes the late client settlement inert", async () => {
    await seedExplainProvider();
    const held = heldCompletion();
    const inFlight = held.client.send(held.request);
    await held.invoked;
    const [reservation] = await db.llmReservations.toArray();
    const [revoked] = await Promise.all([
      call(REVOKE),
      settleLlmUsage(reservation!.id, "llm_explain", { inputTokens: 10, outputTokens: 5 }),
      settleLlmUsage(reservation!.id, "llm_explain", { inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(revoked).toMatchObject({ ok: true });
    held.response.resolve(completionResponse());
    await inFlight;
    expect(await db.llmUsage.count()).toBe(1);
    expect((await db.llmReservations.get(reservation!.id))?.status).toBe("settled");
  });

  it("keeps the original model and pricing snapshot when re-enabled before a late response", async () => {
    await seedExplainProvider();
    const held = heldCompletion();
    const inFlight = held.client.send(held.request);
    await held.invoked;
    expect(await call(REVOKE)).toMatchObject({ ok: true });
    expect(await call({
      type: "LLM_CONFIGURE",
      settings: { ...PRESET_SETTINGS, model: "gpt-4o", pricing: { inputPerMillion: 100, outputPerMillion: 200 } },
      key: "sk-synthetic-reenabled",
      // New request costs 0.02; only the retained exposure blocks it.
      monthlyBudgetUsd: 0.0203,
    })).toMatchObject({ ok: true });
    expect(await call({ type: "LLM_BUDGET_SNAPSHOT" })).toMatchObject({
      ok: true,
      snapshot: { reservedUsd: BOUND_COST, requestCount: 0 },
    });
    await grantConsentAtOrigin("llm_explain", ORIGIN);
    // A new configuration starts a new input-bound client operation; retain
    // the original held send and shared dispatcher so budget concurrency stays real.
    const nextClient = createLlmClient(PROVIDER_ID, {
      scope: "llm_explain", kind: "manual", maxInputTokens: 100, maxOutputTokens: 50,
    });
    await expect(nextClient.send({ ...held.request, model: "gpt-4o" })).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);
    held.response.resolve(completionResponse());
    await inFlight;
    expect(await db.llmUsage.toArray()).toMatchObject([{
      model: MODEL,
      configuredModel: MODEL,
      estimatedCostUsd: 0.00004,
    }]);
    expect((await readLlmProvider(PROVIDER_ID))?.provider).toMatchObject({ model: "gpt-4o" });
  });

  it("does not change permission, settings, keys or reservations if consent removal fails", async () => {
    await seedEnabledProvider();
    await db.llmReservations.put(reservationRow("active"));
    const metadata = await db.metadata.toArray();
    const storage = { ...storageStore };
    vi.spyOn(db.consents, "delete").mockRejectedValue(new Error("Synthetic consent storage failure"));
    await expectFailure(REVOKE, "revoke_failed");
    expect(removeSpy).not.toHaveBeenCalled();
    expect(await db.metadata.toArray()).toEqual(metadata);
    expect(storageStore).toEqual(storage);
    expect(await hasConsentAtOrigin("llm_test", ORIGIN)).toBe(true);
    expect(await db.llmReservations.toArray()).toEqual([reservationRow("active")]);
  });

  it("blocks new egress as soon as consent is removed, before later revoke steps finish", async () => {
    await seedExplainProvider();
    const held = heldCompletion();
    const inFlight = held.client.send(held.request);
    await held.invoked;
    const removalStarted = deferred<void>();
    const permissionRemoved = deferred<boolean>();
    removeSpy.mockImplementation(async () => {
      removalStarted.resolve();
      return permissionRemoved.promise;
    });
    const revoked = call(REVOKE);
    await removalStarted.promise;
    expect(await hasConsentAtOrigin("llm_explain", ORIGIN)).toBe(false);
    expect(await readLlmProvider(PROVIDER_ID)).not.toBeNull();
    expect(await readCredential(PROVIDER_ID)).not.toBeNull();
    await expect(held.client.send(held.request)).rejects.toMatchObject({ code: "no_consent" });
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);
    permissionRemoved.resolve(true);
    expect(await revoked).toMatchObject({ ok: true });
    held.response.resolve(completionResponse());
    await inFlight;
    expect(await db.llmUsage.count()).toBe(1);
  });

  it("fails closed on permission or key removal failure while retaining in-flight accounting", async () => {
    for (const failure of ["permission", "key"] as const) {
    await resetEnv();
    await seedExplainProvider();
    const held = heldCompletion();
    const inFlight = held.client.send(held.request);
    await held.invoked;
    if (failure === "permission") removeSpy.mockResolvedValue(false);
    else storageRemove.mockRejectedValue(new Error("Synthetic key storage failure"));
    await expectFailure(REVOKE, "revoke_failed");
    expect(await hasConsentAtOrigin("llm_explain", ORIGIN)).toBe(false);
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    if (failure === "key") expect(await readCredential(PROVIDER_ID)).not.toBeNull();
    await expect(held.client.send(held.request)).rejects.toMatchObject({ code: "no_provider" });
    expect(held.fetchImpl).toHaveBeenCalledTimes(1);
    held.response.resolve(completionResponse());
    await inFlight;
    expect(await db.llmUsage.count()).toBe(1);
    }
  });

  it("allows explicit delete-all to wipe the accounting ordinary revoke preserves", async () => {
    await seedEnabledProvider();
    await db.llmReservations.put(reservationRow("active"));
    await db.llmUsage.add({
      providerId: PROVIDER_ID,
      feature: "llm_explain",
      model: MODEL,
      configuredModel: MODEL,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      recordedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(await call({ ...REVOKE, deleteKey: false })).toMatchObject({ ok: true });
    expect(await db.llmReservations.count()).toBe(1);
    expect(await db.llmUsage.count()).toBe(1);
    expect(await readCredential(PROVIDER_ID)).not.toBeNull();
    const held = heldCompletion();
    vi.stubGlobal("fetch", held.fetchImpl);
    const result = await deleteAllExtensionData({ releaseGraceMs: 0, databaseTimeoutMs: 1000 });
    expect(result.databaseDeleted).toBe(true);
    expect(db.isOpen()).toBe(false);
    expect(storageStore).toEqual({});
    await db.open();
    expect(await db.llmReservations.count()).toBe(0);
    expect(await db.llmUsage.count()).toBe(0);
    expect(await db.metadata.count()).toBe(0);
    expect(await db.consents.count()).toBe(0);
    await settleLlmUsage("active", "llm_explain", { reportedCostUsd: 99 });
    expect(await db.llmUsage.count()).toBe(0);
    expect(held.fetchImpl).not.toHaveBeenCalled();
  });

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

  it("keeps the stored credential when deleteKey is false, and reports not_configured for unknown ids", async () => {
    await seedEnabledProvider();
    const result = await call({
      type: "LLM_REVOKE",
      providerId: PROVIDER_ID,
      deleteKey: false,
    });
    expect(result).toMatchObject({ ok: true });
    expect(await readLlmProvider(PROVIDER_ID)).toBeNull();
    expect(await readCredential(PROVIDER_ID)).not.toBeNull();
    await expectFailure(
      { type: "LLM_REVOKE", providerId: "preset:openrouter", deleteKey: true },
      "not_configured",
    );
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
      // A08: only `month`-materialized rows enter the `[providerId+month]`
      // index the snapshot reads through.
      month: utcMonthOf(new Date()),
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
