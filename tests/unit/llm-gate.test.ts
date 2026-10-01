import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  CONSENT_VERSION,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { readBlocklist } from "../../src/decisions/blocklist";
import type { BudgetReservation } from "../../src/llm/budget";
import {
  LlmGateError,
  sendLlmConsented,
  settleLlmUsage,
  STALE_RESERVATION_TTL_MS,
} from "../../src/net/llm-send";
import { makeOpenAiServer } from "../mock-servers/openai";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import type { ConsentRecord } from "../../src/schemas/provider";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const MODEL = "gpt-4o-mini";
/** A preset model id with no built-in price — the unknown-cost path. */
const UNPRICED_MODEL = "gpt-4o-mini-2024-07-18";
const NOW = new Date("2026-09-15T12:00:00.000Z");

let containsSpy: ReturnType<typeof vi.fn>;
let readCredentialSpy: ReturnType<typeof vi.spyOn>;

/** An in-memory `chrome.storage.local` for the encrypted credential envelope. */
function installChromeStub() {
  const store: Record<string, unknown> = {};
  containsSpy = vi.fn(async () => true);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          const wanted =
            keys === undefined || keys === null
              ? Object.keys(store)
              : Array.isArray(keys)
                ? keys
                : [keys];
          const out: Record<string, unknown> = {};
          for (const k of wanted) {
            if (k in store) out[k] = store[k];
          }
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(store, items);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys])
            delete store[k];
        },
      },
    },
    permissions: { contains: containsSpy },
  });
}

function providerRecord(
  overrides: Partial<LlmProviderRecord> = {},
): LlmProviderRecord {
  return {
    providerId: PROVIDER_ID,
    provider: { kind: "preset", preset: "openai", model: MODEL },
    configuredAt: "2026-09-15T00:00:00.000Z",
    monthlyBudgetUsd: 5,
    ...overrides,
  };
}

function customProviderRecord(
  overrides: Partial<LlmProviderRecord> = {},
): LlmProviderRecord {
  return {
    providerId: "custom:https://llm.example.com/v1",
    provider: {
      kind: "custom",
      baseUrl: "https://llm.example.com/v1",
      model: "llama-3",
      auth: "api-key",
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    },
    configuredAt: "2026-09-15T00:00:00.000Z",
    monthlyBudgetUsd: 5,
    ...overrides,
  };
}

function validRequest(model = MODEL) {
  return {
    model,
    messages: [{ role: "user", content: "hello" }],
  };
}

function send(overrides: object = {}, options: object = {}) {
  const server = makeOpenAiServer();
  return {
    result: sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_test",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
        ...overrides,
      },
      {
        now: () => NOW,
        fetchImpl: server.fetch,
        unknownCostConfirmed: true,
        ...options,
      },
    ),
    fetch: server,
  };
}

async function expectGateBlock(
  call: Promise<unknown>,
  code: string,
): Promise<LlmGateError> {
  const error = (await call.catch(
    (caught: unknown) => caught,
  )) as LlmGateError;
  expect(error).toBeInstanceOf(LlmGateError);
  expect(error.code).toBe(code);
  return error;
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

describe("sendLlmConsented gate order", () => {
  it("refuses unregistered scopes before touching anything", async () => {
    const { result, fetch } = send({ scope: "jev_test" });
    await expectGateBlock(result, "unregistered_scope");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses when no provider record exists", async () => {
    const { result, fetch } = send();
    await expectGateBlock(result, "no_provider");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses a malformed wire request", async () => {
    await saveLlmProvider(providerRecord());
    const { result, fetch } = send({ request: { model: MODEL } });
    await expectGateBlock(result, "request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses a model other than the configured one", async () => {
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_test", ORIGIN);
    const { result, fetch } = send({ request: validRequest("other-model") });
    await expectGateBlock(result, "unlisted_model");
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses without consent — before permission or credential reads", async () => {
    const credentials = await import("../../src/security/credentials");
    readCredentialSpy = vi.spyOn(credentials, "readCredential");
    await saveLlmProvider(providerRecord());
    const { result, fetch } = send();
    await expectGateBlock(result, "no_consent");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readCredentialSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses a stale-version consent row", async () => {
    await saveLlmProvider(providerRecord());
    await db.consents.put({
      scope: "llm_test",
      origin: ORIGIN,
      consentVersion: CONSENT_VERSION - 1,
      acceptedAt: "2020-01-01T00:00:00.000Z",
    } as ConsentRecord);
    const { result, fetch } = send();
    await expectGateBlock(result, "no_consent");
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses without host permission — before the credential read", async () => {
    const credentials = await import("../../src/security/credentials");
    readCredentialSpy = vi.spyOn(credentials, "readCredential");
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_test", ORIGIN);
    containsSpy.mockResolvedValue(false);
    const { result, fetch } = send();
    await expectGateBlock(result, "no_permission");
    expect(readCredentialSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses without a stored credential — before the reservation", async () => {
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_test", ORIGIN);
    const { result, fetch } = send();
    await expectGateBlock(result, "no_key");
    expect(await db.llmReservations.count()).toBe(0);
    expect(fetch.requests).toHaveLength(0);
  });
});

describe("sendLlmConsented happy path", () => {
  beforeEach(async () => {
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_test", ORIGIN);
    await saveCredential(PROVIDER_ID, "sk-test-1234");
  });

  it("releases an admission-refused reservation only when no fetch attempt left", async () => {
    const { result, fetch } = send({}, {
      beforeSend: async () => {
        throw new LlmGateError("request_not_allowed", "Feature admission refused.");
      },
    });
    await expectGateBlock(result, "request_not_allowed");
    expect(fetch.requests).toHaveLength(0);
    expect((await db.llmReservations.toArray())[0]?.status).toBe("released");
    expect(await db.llmUsage.count()).toBe(0);
  });

  it.each(["429", "transport"] as const)(
    "settles prior %s exposure when admission stops an internal retry",
    async (failure) => {
      const server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
      });
      const fetchImpl: typeof fetch = async (...args) => {
        try {
          return await server.fetch(...args);
        } finally {
          await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
        }
      };
      const beforeSend = async () => {
        if ((await readBlocklist()).includes("a-site.com")) {
          throw new LlmGateError("request_not_allowed", "Feature admission refused.");
        }
      };
      const { result } = send({}, { fetchImpl, beforeSend });
      await expectGateBlock(result, "request_not_allowed");
      expect(server.requests).toHaveLength(1);
      const reservations = await db.llmReservations.toArray();
      expect(reservations).toHaveLength(1);
      expect(reservations[0]?.status).toBe("settled");
      expect(await db.llmUsage.toArray()).toMatchObject([{
        inputTokens: 100, outputTokens: 50,
        estimatedCostUsd: expect.closeTo(0.000045, 10),
      }]);
      await settleLlmUsage(reservations[0]!.id, "llm_test", {
        inputTokens: 100, outputTokens: 50,
      }, NOW);
      expect(await db.llmUsage.count()).toBe(1);
      await saveLlmProvider(providerRecord({ monthlyBudgetUsd: 0.00005 }));
      const next = send();
      await expectGateBlock(next.result, "budget_exceeded");
      expect(next.fetch.requests).toHaveLength(0);
    },
  );

  it("accounts for every prior attempt when admission refuses the third attempt", async () => {
    const server = makeOpenAiServer({
      failures: [{ status: 429 }, { throw: new TypeError("reset") }],
    });
    const fetchImpl: typeof fetch = async (...args) => {
      try {
        return await server.fetch(...args);
      } finally {
        if (server.requests.length === 2) {
          await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
        }
      }
    };
    const beforeSend = async () => {
      if ((await readBlocklist()).includes("a-site.com")) {
        throw new LlmGateError("request_not_allowed", "Feature admission refused.");
      }
    };
    const { result } = send({}, { fetchImpl, beforeSend, retries: 2 });
    await expectGateBlock(result, "request_not_allowed");
    expect(server.requests).toHaveLength(2);
    expect(await db.llmUsage.toArray()).toMatchObject([{
      inputTokens: 200, outputTokens: 100,
      estimatedCostUsd: expect.closeTo(0.00009, 10),
    }]);
  });

  it("records unknown monetary exposure after a refused retry of a confirmed unpriced request", async () => {
    await saveLlmProvider(providerRecord({
      provider: { kind: "preset", preset: "openai", model: UNPRICED_MODEL },
    }));
    const server = makeOpenAiServer({ failures: [{ status: 429 }] });
    const fetchImpl: typeof fetch = async (...args) => {
      const response = await server.fetch(...args);
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      return response;
    };
    const beforeSend = async () => {
      if ((await readBlocklist()).includes("a-site.com")) {
        throw new LlmGateError("request_not_allowed", "Feature admission refused.");
      }
    };
    const { result } = send({ request: validRequest(UNPRICED_MODEL) }, { fetchImpl, beforeSend });
    await expectGateBlock(result, "request_not_allowed");
    expect(server.requests).toHaveLength(1);
    expect((await db.llmReservations.toArray())[0]?.status).toBe("settled");
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(usage[0]?.costUsd).toBeUndefined();
    expect(usage[0]?.estimatedCostUsd).toBeUndefined();
  });

  it.each(["429", "transport"] as const)(
    "preserves the internal %s retry with an allowed feature callback",
    async (failure) => {
      const server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
      });
      const beforeSend = async () => {
        if ((await readBlocklist()).includes("a-site.com")) {
          throw new LlmGateError("request_not_allowed", "Feature admission refused.");
        }
      };
      const { response } = await send({}, { fetchImpl: server.fetch, beforeSend }).result;
      expect(response.status).toBe(200);
      expect(server.requests).toHaveLength(2);
    },
  );

  it("sends exactly one gated POST with bearer auth, no cookies, no redirects", async () => {
    const { result, fetch } = send();
    const { response, reservation } = await result;
    expect(response.status).toBe(200);
    expect(fetch.requests).toHaveLength(1);
    const req = fetch.requests[0]!;
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer sk-test-1234");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(reservation.status).toBe("active");
    expect(reservation.providerId).toBe(PROVIDER_ID);
    // The reservation row is persisted as active.
    const stored = await db.llmReservations.get(reservation.id);
    expect(stored?.status).toBe("active");
    // Audit row: metadata only.
    const log = await db.sentLog.toArray();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      destination: ORIGIN,
      feature: "llm_test",
    });
    expect(log[0]?.fieldNames.sort()).toEqual(["messages", "model"]);
    expect(JSON.stringify(log[0])).not.toContain("hello");
  });

  it("settles the reservation with reported token usage", async () => {
    const { result } = send();
    const { reservation } = await result;
    await settleLlmUsage(
      reservation.id,
      "llm_test",
      { inputTokens: 100, outputTokens: 40, reportedCostUsd: 0.001 },
      NOW,
    );
    const stored = await db.llmReservations.get(reservation.id);
    expect(stored?.status).toBe("settled");
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      providerId: PROVIDER_ID,
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.001,
    });
  });

  it("rejects when the budget cap would be exceeded", async () => {
    await saveLlmProvider(providerRecord({ monthlyBudgetUsd: 0 }));
    // custom record carries pricing so the refusal is budget_exceeded, not
    // pricing_required
    await saveLlmProvider(
      customProviderRecord({ monthlyBudgetUsd: 0.0000001 }),
    );
    await grantConsentAtOrigin(
      "llm_explain",
      "https://llm.example.com",
    );
    await saveCredential("custom:https://llm.example.com/v1", "k");
    containsSpy.mockResolvedValue(true);
    const server = makeOpenAiServer();
    const result = sendLlmConsented(
      {
        providerId: "custom:https://llm.example.com/v1",
        scope: "llm_explain",
        request: { model: "llama-3", messages: [{ role: "user", content: "x" }] },
        maxInputTokens: 100_000,
        maxOutputTokens: 100_000,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch },
    );
    await expectGateBlock(result, "budget_exceeded");
    expect(server.requests).toHaveLength(0);
    expect(await db.llmReservations.count()).toBe(0);
  });

  it("manual request without pricing needs confirmation_required", async () => {
    // A preset model with no built-in price and no override — the built-in
    // table covers the preset's default model only.
    await saveLlmProvider(
      providerRecord({
        provider: { kind: "preset", preset: "openai", model: UNPRICED_MODEL },
      }),
    );
    const { result, fetch } = send({ request: validRequest(UNPRICED_MODEL) }, {
      unknownCostConfirmed: false,
    });
    await expectGateBlock(result, "confirmation_required");
    expect(fetch.requests).toHaveLength(0);
  });

  it("automatic requests can never use the unknown-cost override", async () => {
    await saveLlmProvider(
      providerRecord({
        provider: { kind: "preset", preset: "openai", model: UNPRICED_MODEL },
      }),
    );
    const { result, fetch } = send(
      { kind: "automatic", request: validRequest(UNPRICED_MODEL) },
      { unknownCostConfirmed: true },
    );
    await expectGateBlock(result, "pricing_required");
    expect(fetch.requests).toHaveLength(0);
  });

  it("prices a preset from the built-in table without a confirmation", async () => {
    // The preset default model is priced out of the box, so neither the
    // unknown-cost confirmation nor a manual override is needed.
    await saveLlmProvider(providerRecord());
    const { result, fetch } = send({ kind: "automatic" }, {
      unknownCostConfirmed: false,
    });
    const { response, reservation } = await result;
    expect(response.status).toBe(200);
    expect(fetch.requests).toHaveLength(1);
    expect(reservation.reservedUsd).toBeGreaterThan(0);
    // 0.15 USD/1M × 100 tokens + 0.60 USD/1M × 50 tokens = 0.000045.
    expect(reservation.reservedUsd).toBeCloseTo(0.000045, 8);
  });

  it("a manual price override beats the built-in preset table", async () => {
    await saveLlmProvider(
      providerRecord({
        provider: {
          kind: "preset",
          preset: "openai",
          model: UNPRICED_MODEL,
          pricing: { inputPerMillion: 3, outputPerMillion: 4 },
        },
      }),
    );
    const { result, fetch } = send(
      { kind: "automatic", request: validRequest(UNPRICED_MODEL) },
      { unknownCostConfirmed: false },
    );
    const { response, reservation } = await result;
    expect(response.status).toBe(200);
    expect(fetch.requests).toHaveLength(1);
    // 3 USD/1M × 100 tokens + 4 USD/1M × 50 tokens = 0.0005.
    expect(reservation.reservedUsd).toBeCloseTo(0.0005, 8);
  });

  it("retries a transport failure once, then succeeds", async () => {
    const server = makeOpenAiServer({
      failures: [{ throw: new TypeError("connection reset") }],
    });
    const { response } = await sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_test",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch, unknownCostConfirmed: true },
    );
    expect(response.status).toBe(200);
    expect(server.requests).toHaveLength(2);
    expect(await db.sentLog.count()).toBe(1);
  });

  it("honors retry-after on 429 then succeeds", async () => {
    const server = makeOpenAiServer({
      failures: [{ status: 429, retryAfterSeconds: 0 }],
    });
    const { response } = await sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_test",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch, unknownCostConfirmed: true },
    );
    expect(response.status).toBe(200);
    expect(server.requests).toHaveLength(2);
  });

  it("does not retry a permanent 400", async () => {
    const server = makeOpenAiServer({ failures: [{ status: 400 }] });
    const { response } = await sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_test",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch, unknownCostConfirmed: true },
    );
    expect(response.status).toBe(400);
    expect(server.requests).toHaveLength(1);
  });

  it("releases the reservation and throws timeout on abort", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const server = makeOpenAiServer({
      failures: [
        { throw: abort },
        { throw: abort },
        { throw: abort },
      ],
    });
    const error = (await sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_test",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      {
        now: () => NOW,
        fetchImpl: server.fetch,
        unknownCostConfirmed: true,
        retries: 0,
      },
    ).catch((caught: unknown) => caught)) as LlmGateError;
    expect(error).toBeInstanceOf(LlmGateError);
    expect(error.code).toBe("timeout");
    const rows = await db.llmReservations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("released");
    expect(await db.sentLog.count()).toBe(0);
  });

  it("uses api-key auth for custom providers and hits the custom origin", async () => {
    const custom = customProviderRecord();
    await saveLlmProvider(custom);
    await grantConsentAtOrigin("llm_summary", "https://llm.example.com");
    await saveCredential(custom.providerId, "custom-key");
    const server = makeOpenAiServer();
    const { response } = await sendLlmConsented(
      {
        providerId: custom.providerId,
        scope: "llm_summary",
        request: {
          model: "llama-3",
          messages: [{ role: "user", content: "summarize" }],
        },
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch },
    );
    expect(response.status).toBe(200);
    const req = server.requests[0]!;
    expect(req.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(req.headers["api-key"]).toBe("custom-key");
    expect(req.headers.Authorization).toBeUndefined();
  });

  it("sends no auth header for auth:none loopback providers", async () => {
    const local: LlmProviderRecord = {
      providerId: "custom:http://localhost:11434",
      provider: {
        kind: "custom",
        baseUrl: "http://localhost:11434",
        model: "llama3",
        auth: "none",
      },
      configuredAt: "2026-09-15T00:00:00.000Z",
      monthlyBudgetUsd: 5,
    };
    await saveLlmProvider(local);
    await grantConsentAtOrigin("llm_summary", "http://localhost:11434");
    const server = makeOpenAiServer();
    const { response } = await sendLlmConsented(
      {
        providerId: local.providerId,
        scope: "llm_summary",
        request: {
          model: "llama3",
          messages: [{ role: "user", content: "s" }],
        },
        maxInputTokens: 10,
        maxOutputTokens: 10,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch, unknownCostConfirmed: true },
    );
    expect(response.status).toBe(200);
    const req = server.requests[0]!;
    expect(req.url).toBe("http://localhost:11434/chat/completions");
    expect(req.headers.Authorization).toBeUndefined();
    expect(req.headers["api-key"]).toBeUndefined();
  });

  it("releases a stale active reservation inside the reservation transaction", async () => {
    // An `active` row older than the TTL can only be orphaned by a request
    // killed mid-flight — the next send releases it instead of letting it
    // charge the cap forever.
    const stale: BudgetReservation = {
      id: "stale-1",
      providerId: PROVIDER_ID,
      model: MODEL,
      month: "2026-09",
      reservedUsd: 0.5,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      kind: "manual",
      status: "active",
      createdAt: new Date(
        NOW.getTime() - STALE_RESERVATION_TTL_MS - 1,
      ).toISOString(),
    };
    await db.llmReservations.put(stale);

    const { reservation } = await send().result;
    expect(reservation.status).toBe("active");
    expect((await db.llmReservations.get("stale-1"))?.status).toBe(
      "released",
    );
  });

  it("does NOT release a fresh active reservation — it still charges the cap", async () => {
    // A priced provider so the new request's own reservation carries a
    // committed amount against the cap.
    const custom = customProviderRecord({ monthlyBudgetUsd: 5 });
    await saveLlmProvider(custom);
    await grantConsentAtOrigin("llm_explain", "https://llm.example.com");
    await saveCredential(custom.providerId, "k");
    const fresh: BudgetReservation = {
      id: "fresh-1",
      providerId: custom.providerId,
      model: "llama-3",
      month: "2026-09",
      reservedUsd: 999,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      kind: "manual",
      status: "active",
      createdAt: NOW.toISOString(),
    };
    await db.llmReservations.put(fresh);

    const server = makeOpenAiServer();
    const result = sendLlmConsented(
      {
        providerId: custom.providerId,
        scope: "llm_explain",
        request: {
          model: "llama-3",
          messages: [{ role: "user", content: "x" }],
        },
        maxInputTokens: 100,
        maxOutputTokens: 100,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch },
    );
    await expectGateBlock(result, "budget_exceeded");
    expect(server.requests).toHaveLength(0);
    // The fresh reservation stays active — only stale ones are swept.
    expect((await db.llmReservations.get("fresh-1"))?.status).toBe(
      "active",
    );
  });

  it("serializes concurrent sends: the second sees the first's reservation", async () => {
    // The cap admits one request at these bounds but not two — under a
    // non-transactional reserve both could pass the check against each
    // other's pre-reservation state (TOCTOU). With the whole reserve inside
    // one rw transaction, IndexedDB serializes them and exactly one wins.
    const custom = customProviderRecord({
      monthlyBudgetUsd: 0.4,
      provider: {
        kind: "custom",
        baseUrl: "https://llm.example.com/v1",
        model: "llama-3",
        auth: "api-key",
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      },
    });
    await saveLlmProvider(custom);
    await grantConsentAtOrigin("llm_explain", "https://llm.example.com");
    await saveCredential(custom.providerId, "k");
    const server = makeOpenAiServer();

    const sendOne = () =>
      sendLlmConsented(
        {
          providerId: custom.providerId,
          scope: "llm_explain",
          request: {
            model: "llama-3",
            messages: [{ role: "user", content: "x" }],
          },
          // 100k × $1/M + 100k × $2/M = $0.30 reserved per request.
          maxInputTokens: 100_000,
          maxOutputTokens: 100_000,
          kind: "manual",
        },
        {
          now: () => NOW,
          fetchImpl: server.fetch,
        },
      );
    const [first, second] = await Promise.allSettled([sendOne(), sendOne()]);

    const outcomes = [first, second].map((s) => s.status);
    expect(outcomes.sort()).toEqual(["fulfilled", "rejected"]);
    const refused = [first, second].find((s) => s.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: "budget_exceeded",
    });
    expect(server.requests).toHaveLength(1);
    expect(
      (await db.llmReservations.toArray()).filter(
        (r) => r.status === "active",
      ),
    ).toHaveLength(1);
  });
});
