import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { setImmediate as yieldIO } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  CONSENT_VERSION,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { readBlocklist } from "../../src/decisions/blocklist";
import { monthlyBudgetSnapshot, type BudgetReservation } from "../../src/llm/budget";
import {
  LlmGateError,
  settleLlmUsage,
  STALE_RESERVATION_TTL_MS,
} from "../../src/net/llm-send";
import { sendLlmForTest as sendLlmConsented, scopeRequest, TEST_LLM_SCOPES } from "../fakes/llm";
import { makeOpenAiServer } from "../mock-servers/openai";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import type { ConsentRecord } from "../../src/schemas/provider";
import { LLM_CONSENT_SCOPES } from "../../src/schemas/provider";

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
  return scopeRequest("llm_explain", model);
}

function send(overrides: object = {}, options: object = {}) {
  const server = makeOpenAiServer();
  return {
    result: sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_explain",
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

afterEach(() => vi.useRealTimers());

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("sendLlmConsented gate order", () => {
  it("refuses unregistered scopes and missing providers before touching anything", async () => {
    const { result: scoped, fetch: scopedFetch } = send({ scope: "jev_test" });
    await expectGateBlock(scoped, "unregistered_scope");
    expect(scopedFetch.requests).toHaveLength(0);
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

  it("keeps the cheap request guard before permission/key reads for every consent scope", async () => {
    const credentials = await import("../../src/security/credentials");
    readCredentialSpy = vi.spyOn(credentials, "readCredential");
    await saveLlmProvider(providerRecord());
    for (const scope of LLM_CONSENT_SCOPES) {
      const { result, fetch } = send({
        scope,
        request: { ...validRequest(), max_output_tokens: 25 },
      });
      await expectGateBlock(result, scope === "jev_summary_verify" ? "unregistered_scope" : "request_not_allowed");
      expect(fetch.requests).toHaveLength(0);
    }
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readCredentialSpy).not.toHaveBeenCalled();
    expect(await db.llmReservations.count()).toBe(0);
  });

  it("refuses invalid maxInputTokens/maxOutputTokens before permission/key reads or reservation", async () => {
    const credentials = await import("../../src/security/credentials");
    readCredentialSpy = vi.spyOn(credentials, "readCredential");
    await saveLlmProvider(providerRecord());
    for (const bound of ["maxInputTokens", "maxOutputTokens"] as const) {
      for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "50", null, undefined]) {
        const { result, fetch } = send({ [bound]: value });
        await expectGateBlock(result, "request_not_allowed");
        expect(fetch.requests).toHaveLength(0);
      }
    }
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readCredentialSpy).not.toHaveBeenCalled();
    expect(await db.llmReservations.count()).toBe(0);
  });

  it("refuses invalid caller max_tokens and alternate max-token fields without egress", async () => {
    await saveLlmProvider(providerRecord());
    for (const max_tokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "25", null]) {
      const { result, fetch } = send({
        request: { ...validRequest(), max_tokens },
      });
      await expectGateBlock(result, "request_not_allowed");
      expect(fetch.requests).toHaveLength(0);
    }
    for (const field of ["max_completion_tokens", "max_output_tokens", "max_new_tokens"] as const) {
      for (const alternate of [25, 1000]) {
        const { result, fetch } = send({
          request: { ...validRequest(), max_tokens: 25, [field]: alternate },
        });
        await expectGateBlock(result, "request_not_allowed");
        expect(fetch.requests).toHaveLength(0);
      }
    }
    expect(containsSpy).not.toHaveBeenCalled();
    expect(await db.llmReservations.count()).toBe(0);
  });

  it("refuses a model other than the configured one", async () => {
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_explain", ORIGIN);
    const { result, fetch } = send({ request: validRequest("other-model") });
    await expectGateBlock(result, "unlisted_model");
    expect(fetch.requests).toHaveLength(0);
  });

  it("refuses without consent and on a stale-version row — before permission or credential reads", async () => {
    const credentials = await import("../../src/security/credentials");
    readCredentialSpy = vi.spyOn(credentials, "readCredential");
    await saveLlmProvider(providerRecord());
    const { result, fetch } = send();
    await expectGateBlock(result, "no_consent");
    await db.consents.put({
      scope: "llm_explain",
      origin: ORIGIN,
      consentVersion: CONSENT_VERSION - 1,
      acceptedAt: "2020-01-01T00:00:00.000Z",
    } as ConsentRecord);
    const { result: stale, fetch: staleFetch } = send();
    await expectGateBlock(stale, "no_consent");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readCredentialSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
    expect(staleFetch.requests).toHaveLength(0);
  });

  it("refuses missing host permission then missing credential — before the reservation", async () => {
    const credentials = await import("../../src/security/credentials");
    readCredentialSpy = vi.spyOn(credentials, "readCredential");
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_explain", ORIGIN);
    containsSpy.mockResolvedValue(false);
    const { result, fetch } = send();
    await expectGateBlock(result, "no_permission");
    expect(readCredentialSpy).not.toHaveBeenCalled();
    expect(fetch.requests).toHaveLength(0);
    containsSpy.mockResolvedValue(true);
    const { result: noKey, fetch: noKeyFetch } = send();
    await expectGateBlock(noKey, "no_key");
    expect(await db.llmReservations.count()).toBe(0);
    expect(noKeyFetch.requests).toHaveLength(0);
  });
});

describe("sendLlmConsented happy path", () => {
  beforeEach(async () => {
    await saveLlmProvider(providerRecord());
    await grantConsentAtOrigin("llm_explain", ORIGIN);
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
    expect(await db.sentLog.count()).toBe(0);
  });

  it("records both a retried 503 and the successful attempt as metadata only", async () => {
    const server = makeOpenAiServer({ failures: [{ status: 503 }] });
    const { response } = await send({}, { fetchImpl: server.fetch }).result;
    expect(response.status).toBe(200);
    expect(server.requests).toHaveLength(2);
    const rows = await db.sentLog.orderBy(":id").toArray();
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      { destination: ORIGIN, feature: "llm_explain", sentAt: NOW.toISOString(), outcome: "retried" },
      { destination: ORIGIN, feature: "llm_explain", sentAt: NOW.toISOString(), outcome: "ok" },
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["destination", "feature", "fieldNames", "id", "outcome", "sentAt"]);
      expect(row.fieldNames.sort()).toEqual(["max_tokens", "messages", "model"]);
    }
    expect(JSON.stringify(rows)).not.toMatch(/Synthetic article|allowed-site|sk-test|temporarily/);
  });

  it("records an opaque redirect without retrying and settles sent exposure", async () => {
    const fetchImpl: typeof fetch = async () => ({ type: "opaqueredirect", status: 0 }) as Response;
    await expectGateBlock(send({}, { fetchImpl }).result, "transport");
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "redirect" }]);
    expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled"]);
    expect(await db.llmUsage.count()).toBe(1);
  });

  it("refuses signals aborted before dispatch with no attempt row and releases never-sent exposure", async () => {
    for (const when of ["before gate", "during final admission"] as const) {
      await db.llmReservations.clear();
      const controller = new AbortController();
      if (when === "before gate") controller.abort();
      const { result, fetch } = send({}, {
        signal: controller.signal,
        beforeSend: async () => { controller.abort(); },
      });
      await expectGateBlock(result, "aborted");
      expect(fetch.requests).toHaveLength(0);
      expect(await db.sentLog.count()).toBe(0);
      expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["released"]);
      expect(await db.llmUsage.count()).toBe(0);
    }
  });

  it("records dispatch time rather than delayed response time", async () => {
    let time = NOW;
    const server = makeOpenAiServer();
    const fetchImpl: typeof fetch = async (...args) => {
      time = new Date("2026-09-15T12:01:00.000Z");
      return server.fetch(...args);
    };
    await send({}, { now: () => time, fetchImpl }).result;
    expect(await db.sentLog.toArray()).toMatchObject([{ sentAt: "2026-09-15T12:00:00.000Z", outcome: "ok" }]);
  });

  it("records a rejected redirect as one transport attempt without inspecting error text", async () => {
    const server = makeOpenAiServer({ failures: [{ throw: new TypeError("redirect refused: private destination") }] });
    await expectGateBlock(send({}, { fetchImpl: server.fetch, retries: 0 }).result, "transport");
    expect(server.requests).toHaveLength(1);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "transport" }]);
    expect(JSON.stringify(await db.sentLog.toArray())).not.toContain("private destination");
  });

  it("classifies a native deadline as timeout without retrying sent exposure", async () => {
    let requests = 0;
    const fetchImpl: typeof fetch = (_url, init) => {
      requests += 1;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { reject(init!.signal!.reason); }, { once: true });
      });
    };
    await expectGateBlock(send({}, { fetchImpl, timeoutMs: 5, retries: 2 }).result, "timeout");
    expect(requests).toBe(1);
    expect(await db.llmUsage.count()).toBe(1);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "timeout" }]);
    expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled"]);
  });

  it("synchronous audit write failures cannot suppress success or strand its reservation", async () => {
    vi.spyOn(db.sentLog, "add").mockImplementation(() => { throw new Error("private sync storage failure"); });
    const { response, reservation } = await send().result;
    expect(response.status).toBe(200);
    expect((await db.llmReservations.get(reservation.id))?.status).toBe("active");
    expect(await db.llmUsage.count()).toBe(0);
  });

  it.each([
    ["AbortError", "aborted"],
    ["TimeoutError", "timeout"],
    ["private arbitrary reason", "aborted"],
  ])("uses signal reason %s rather than the transport exception", async (name, code) => {
    const controller = new AbortController();
    const reason = name === "private arbitrary reason" ? { secret: name } : new DOMException("BODY_SECRET", name);
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      controller.abort(reason);
      throw new DOMException("PROMPT_SECRET", "AbortError");
    };
    const error = await expectGateBlock(send({}, {
      signal: controller.signal, fetchImpl, retries: 2,
    }).result, code);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toMatch(/BODY_SECRET|PROMPT_SECRET|private arbitrary/);
    expect(requests).toBe(1);
    expect(await db.llmUsage.count()).toBe(1);
    expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled"]);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: code }]);
  });

  it.each(["transport", "http"] as const)("waits with exponential jitter and bounds %s retries", async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const times: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      times.push(Date.now());
      if (failure === "transport") throw new TypeError("private socket");
      return new Response("{}", { status: 503 });
    };
    const result = send({}, { fetchImpl, retries: 2 }).result.catch((error: unknown) => error);
    const waitForBackoff = async (attempt: number) => {
      for (let turn = 0; turn < 1000; turn += 1) {
        if (await db.llmUsage.count() === attempt && vi.getTimerCount() === 1) return;
        await yieldIO();
      }
      throw new Error("Backoff was not scheduled after settlement.");
    };
    await waitForBackoff(1);
    expect(times).toEqual([NOW.getTime()]);
    expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled"]);
    await vi.advanceTimersByTimeAsync(249);
    expect(times).toHaveLength(1);
    expect(await db.llmReservations.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForBackoff(2);
    expect(times).toEqual([NOW.getTime(), NOW.getTime() + 250]);
    await vi.advanceTimersByTimeAsync(499);
    expect(times).toHaveLength(2);
    expect(await db.llmReservations.count()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    const error = await result;
    if (failure === "transport") expect(error).toMatchObject({ code: "transport" });
    else {
      expect(error).toMatchObject({ response: { status: 503 } });
      await settleLlmUsage((error as { reservation: BudgetReservation }).reservation.id, "llm_explain", {}, NOW);
    }
    expect(times).toEqual([NOW.getTime(), NOW.getTime() + 250, NOW.getTime() + 750]);
    expect(await db.llmUsage.count()).toBe(3);
    expect((await db.llmReservations.toArray()).every((row) => row.status === "settled")).toBe(true);
    expect((await db.sentLog.toArray()).map((row) => row.outcome)).toEqual([
      "retried", "retried", failure === "transport" ? "transport" : "http_503",
    ]);
  });

  it.each([
    ["2", 2000],
    ["Tue, 15 Sep 2026 12:00:03 GMT", 3000],
    ["Tue, 15 Sep 2026 12:02:00 GMT", 5000],
    ["120", 5000],
    ["1.5", 250],
  ])("honors Retry-After %s with a bounded wait and fresh consent", async (header, wait) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      return new Response("{}", { status: 429, headers: { "retry-after": header } });
    };
    const result = send({}, { fetchImpl, retries: 1, now: () => new Date() }).result.catch((error: unknown) => error);
    for (let turn = 0; turn < 1000; turn += 1) {
      if (await db.llmUsage.count() === 1 && vi.getTimerCount() === 1) break;
      await yieldIO();
    }
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(requests).toBe(1);
    expect(await db.llmReservations.count()).toBe(1);
    await db.consents.clear();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "no_consent" });
    expect(requests).toBe(1);
    expect(await db.llmReservations.count()).toBe(1);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "retried" }]);
  });

  it("caps exponential jitter at the existing five-second wait ceiling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const times: number[] = [];
    const fetchImpl: typeof fetch = async () => {
      times.push(Date.now() - NOW.getTime());
      throw new TypeError("private socket");
    };
    const result = send({}, { fetchImpl, retries: 5 }).result.catch((error: unknown) => error);
    for (const [index, delay] of [250, 500, 1000, 2000, 2500].entries()) {
      for (let turn = 0; turn < 1000; turn += 1) {
        if (await db.llmUsage.count() === index + 1 && vi.getTimerCount() === 1) break;
        await yieldIO();
      }
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(times).toHaveLength(index + 1);
      expect(await db.llmReservations.count()).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await result).toMatchObject({ code: "transport" });
    expect(times).toEqual([0, 250, 750, 1750, 3750, 6250]);
    expect(await db.llmUsage.count()).toBe(6);
    expect((await db.llmReservations.toArray()).every((row) => row.status === "settled")).toBe(true);
  });

  it("does not relabel a socket failure when the deadline fires during settlement", async () => {
    const controller = new AbortController();
    const original = db.llmUsage.add.bind(db.llmUsage);
    vi.spyOn(db.llmUsage, "add").mockImplementation((...args) => {
      controller.abort(new DOMException("private deadline", "TimeoutError"));
      return original(...args);
    });
    const server = makeOpenAiServer({ failures: [{ throw: new TypeError("private socket") }] });
    await expectGateBlock(send({}, {
      fetchImpl: server.fetch, signal: controller.signal, retries: 0,
    }).result, "transport");
    expect(server.requests).toHaveLength(1);
    expect(await db.llmUsage.count()).toBe(1);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "transport" }]);
  });

  it("persists unknown dispatch metadata while transport is pending", async () => {
    let complete!: (response: Response) => void;
    const fetchImpl: typeof fetch = () => new Promise<Response>((resolve) => { complete = resolve; });
    const { result } = send({}, { fetchImpl });
    await vi.waitFor(async () => expect(await db.sentLog.count()).toBe(1));
    const [row] = await db.sentLog.toArray();
    expect(row).toMatchObject({ destination: ORIGIN, feature: "llm_explain" });
    expect(row).not.toHaveProperty("outcome");
    complete(new Response("{}", { status: 200 }));
    await result;
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "ok" }]);
  });

  it("does not await audit IO after final feature admission", async () => {
    const original = db.sentLog.add.bind(db.sentLog);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(db.sentLog, "add").mockImplementation((...args) => original(...args).then(async (id) => {
      await held;
      return id;
    }));
    let admitted = false;
    let dispatched = false;
    const { result } = send({}, {
      beforeSend: async () => {
        admitted = true;
        queueMicrotask(() => { queueMicrotask(() => { admitted = false; }); });
      },
      fetchImpl: async () => {
        expect(admitted).toBe(true);
        dispatched = true;
        release();
        return new Response("{}", { status: 200 });
      },
    });
    await vi.waitFor(() => expect(dispatched).toBe(true));
    await result;
  });

  it("failed append or outcome update cannot change results or reservation disposition", async () => {
    for (const operation of ["add", "update"] as const) {
      for (const outcome of ["ok", "http", "timeout", "transport", "retry"] as const) {
        vi.restoreAllMocks();
        await db.llmReservations.clear();
        await db.llmUsage.clear();
        await db.sentLog.clear();
        vi.spyOn(db.sentLog, operation).mockRejectedValue(new Error("private log failure"));
        const server = makeOpenAiServer({ failures: outcome === "ok" ? [] : [
          outcome === "http" || outcome === "retry" ? { status: outcome === "http" ? 400 : 503 } :
            { throw: outcome === "timeout" ? new DOMException("private deadline", "TimeoutError") : new TypeError("private reset") },
        ] });
        const { result } = send({}, { fetchImpl: server.fetch, retries: outcome === "retry" ? 1 : 0 });
        if (outcome === "timeout" || outcome === "transport") await expectGateBlock(result, outcome);
        else expect((await result).response.status).toBe(outcome === "http" ? 400 : 200);
        const statuses = (await db.llmReservations.toArray()).map((row) => row.status).sort();
        expect(statuses).toEqual(outcome === "retry" ? ["active", "settled"] :
          outcome === "timeout" || outcome === "transport" ? ["settled"] : ["active"]);
        expect(await db.llmUsage.count()).toBe(outcome === "retry" || outcome === "timeout" || outcome === "transport" ? 1 : 0);
      }
    }
  });

  it("charges prior exposure before budget admission can allow a retry", async () => {
    for (const failure of ["missing", "reported overrun", "transport"] as const) {
      await db.llmUsage.clear();
      await db.llmReservations.clear();
      await saveLlmProvider(providerRecord({ monthlyBudgetUsd: 0.00005 }));
      const server = makeOpenAiServer({
        failures: [failure === "transport"
          ? { throw: new TypeError("synthetic reset") }
          : { status: 503, body: {
            error: { message: "temporarily unavailable" },
            ...(failure === "reported overrun" ? { usage: { completion_tokens: 1000, cost: 0.02 } } : {}),
          } }],
      });
      await expectGateBlock(send({}, { fetchImpl: server.fetch }).result, "budget_exceeded");
      expect(server.requests).toHaveLength(1);
      const rows = await db.llmUsage.toArray();
      expect(rows).toHaveLength(1);
      if (failure === "reported overrun") {
        expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 1000, costUsd: 0.02 });
        expect(rows[0]?.estimatedCostUsd).toBeUndefined();
      } else {
        expect(rows[0]?.estimatedCostUsd).toBeCloseTo(0.000045, 12);
      }
      expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled"]);
    }
  });

  it("reruns current consent, permission and origin admission before a paid retry", async () => {
    for (const change of ["consent", "permission", "origin"] as const) {
      await db.llmUsage.clear();
      await db.llmReservations.clear();
      await grantConsentAtOrigin("llm_explain", ORIGIN);
      containsSpy.mockResolvedValue(true);
      await saveLlmProvider(providerRecord());
      const server = makeOpenAiServer({ failures: [{ status: 503 }] });
      const fetchImpl: typeof fetch = async (...args) => {
        const response = await server.fetch(...args);
        if (change === "consent") await db.consents.clear();
        else if (change === "permission") containsSpy.mockResolvedValue(false);
        else await saveLlmProvider(providerRecord({
          provider: { kind: "custom", baseUrl: "https://changed.example.com/v1", model: MODEL, auth: "none" },
        }));
        return response;
      };
      await expectGateBlock(send({}, { fetchImpl }).result, change === "permission" ? "no_permission" : change === "origin" ? "invalid_provider" : "no_consent");
      expect(server.requests).toHaveLength(1);
      expect(await db.llmUsage.toArray()).toMatchObject([{
        estimatedCostUsd: expect.closeTo(0.000045, 12),
      }]);
    }
  });

  it("uses a fresh matching capped reservation for each admitted retry", async () => {
    const server = makeOpenAiServer({ failures: [{ status: 503 }] });
    const { reservation } = await send({
      request: { ...validRequest(), max_tokens: 25 },
    }, { fetchImpl: server.fetch }).result;
    const reservations = await db.llmReservations.toArray();
    expect(reservations).toHaveLength(2);
    expect(reservations.filter((row) => row.status === "settled")).toHaveLength(1);
    expect(reservations.filter((row) => row.id === reservation.id && row.status === "active")).toHaveLength(1);
    for (const row of reservations) {
      expect(row.maxOutputTokens).toBe(25);
      expect(row.reservedUsd).toBeCloseTo(0.00003, 12);
    }
    expect(server.requests.map((row) => row.body)).toEqual([
      { ...validRequest(), max_tokens: 25 }, { ...validRequest(), max_tokens: 25 },
    ]);
    expect(await db.llmUsage.toArray()).toMatchObject([{
      inputTokens: 100, outputTokens: 25, estimatedCostUsd: expect.closeTo(0.00003, 12),
    }]);
  });

  it("settles prior exposure when admission stops an internal retry", async () => {
    for (const failure of ["429", "transport"] as const) {
      await db.llmReservations.clear();
      await db.llmUsage.clear();
      await db.metadata.delete("decisions:blocklist");
      await saveLlmProvider(providerRecord());
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
      expect(reservations.map((row) => row.status).sort()).toEqual(["released", "settled"]);
      expect(await db.llmUsage.toArray()).toMatchObject([{
        inputTokens: 100, outputTokens: 50,
        estimatedCostUsd: expect.closeTo(0.000045, 10),
      }]);
      await settleLlmUsage(reservations.find((row) => row.status === "settled")!.id, "llm_explain", {
        inputTokens: 100, outputTokens: 50,
      }, NOW);
      expect(await db.llmUsage.count()).toBe(1);
      await saveLlmProvider(providerRecord({ monthlyBudgetUsd: 0.00005 }));
      const next = send();
      await expectGateBlock(next.result, "budget_exceeded");
      expect(next.fetch.requests).toHaveLength(0);
    }
  });

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
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(2);
    for (const row of usage) {
      expect(row).toMatchObject({
        inputTokens: 100, outputTokens: 50, estimatedCostUsd: expect.closeTo(0.000045, 12),
      });
    }
    expect(usage.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)).toBeCloseTo(0.00009, 12);
    expect((await db.llmReservations.toArray()).map((row) => row.status).sort()).toEqual(["released", "settled", "settled"]);
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
    expect((await db.llmReservations.toArray()).map((row) => row.status).sort()).toEqual(["released", "settled"]);
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(usage[0]?.costUsd).toBeUndefined();
    expect(usage[0]?.estimatedCostUsd).toBeUndefined();
  });

  it("preserves the internal retry with an allowed feature callback", async () => {
    for (const failure of ["429", "transport"] as const) {
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
    }
  });

  it("sends exactly one gated POST with bearer auth, no cookies, no redirects", async () => {
    const { result, fetch } = send({ maxOutputTokens: 50 });
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
    expect(reservation.maxOutputTokens).toBe(50);
    expect(req.body).toMatchObject({ max_tokens: 50 });
    // The reservation row is persisted as active.
    const stored = await db.llmReservations.get(reservation.id);
    expect(stored?.status).toBe("active");
    // Audit row: metadata only.
    const log = await db.sentLog.toArray();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      destination: ORIGIN,
      feature: "llm_explain",
    });
    expect(log[0]?.fieldNames.sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(JSON.stringify(log[0])).not.toContain("hello");
  });

  it("clamps caller max_tokens on the wire and in the reservation", async () => {
    for (const [caller, expected, cost] of [
      [1, 1, 0.0000156],
      [25, 25, 0.00003],
      [50, 50, 0.000045],
      [1000, 50, 0.000045],
    ] as const) {
    const request = { ...validRequest(), max_tokens: caller };
    const { result, fetch } = send({ request });
    const { reservation } = await result;
    expect(reservation.maxOutputTokens).toBe(expected);
    expect(reservation.reservedUsd).toBeCloseTo(cost, 10);
    expect((await db.llmReservations.get(reservation.id))?.maxOutputTokens).toBe(expected);
    expect(fetch.requests).toHaveLength(1);
    expect(fetch.requests[0]?.body).toMatchObject({ max_tokens: expected });
    expect(request.max_tokens).toBe(caller);
    }
  });

  it("uses the tighter limit when admitting a request against the monthly cap", async () => {
    await saveLlmProvider(providerRecord({ monthlyBudgetUsd: 0.000031 }));
    const { result, fetch } = send({
      request: { ...validRequest(), max_tokens: 25 },
    });
    const { reservation } = await result;
    expect(reservation.reservedUsd).toBeCloseTo(0.00003, 10);
    expect(reservation.maxOutputTokens).toBe(25);
    expect(fetch.requests[0]?.body).toMatchObject({ max_tokens: 25 });
  });

  it("adds the gate-owned cap after request validation for every consent scope", async () => {
    for (const scope of TEST_LLM_SCOPES) {
      await grantConsentAtOrigin(scope, ORIGIN);
      const { result, fetch } = send({ scope, request: scopeRequest(scope, MODEL) });
      const { reservation } = await result;
      expect(reservation.maxOutputTokens).toBe(scope === "llm_test" ? 16 : 50);
      expect(fetch.requests).toHaveLength(1);
      expect(fetch.requests[0]?.body).toMatchObject({ max_tokens: scope === "llm_test" ? 16 : 50 });
    }
  });

  it("preserves the clamped cap through every actual retry", async () => {
    for (const failure of ["429", "503", "transport"] as const) {
      const server = makeOpenAiServer({
        failures: [failure === "transport"
          ? { throw: new TypeError("reset") }
          : { status: Number(failure) }],
      });
      const { response, reservation } = await send({
        request: { ...validRequest(), max_tokens: 25 },
      }, { fetchImpl: server.fetch }).result;
      expect(response.status).toBe(200);
      expect(reservation.maxOutputTokens).toBe(25);
      expect(server.requests.map((request) => request.body)).toEqual([
        { ...validRequest(), max_tokens: 25 },
        { ...validRequest(), max_tokens: 25 },
      ]);
    }
  });

  it("settles clamped prior exposure when admission prevents the next retry", async () => {
    const server = makeOpenAiServer({ failures: [{ status: 429 }] });
    let admissions = 0;
    const beforeSend = async () => {
      if (++admissions === 2) {
        throw new LlmGateError("request_not_allowed", "Feature admission refused.");
      }
    };
    const { result } = send({
      request: { ...validRequest(), max_tokens: 25 },
    }, { fetchImpl: server.fetch, beforeSend });
    await expectGateBlock(result, "request_not_allowed");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body).toMatchObject({ max_tokens: 25 });
    const reservations = await db.llmReservations.toArray();
    expect(reservations.map((row) => row.status).sort()).toEqual(["released", "settled"]);
    expect(reservations.find((row) => row.status === "settled")).toMatchObject({
      status: "settled", maxOutputTokens: 25,
    });
    expect(await db.llmUsage.toArray()).toMatchObject([{
      inputTokens: 100, outputTokens: 25,
      estimatedCostUsd: expect.closeTo(0.00003, 10),
    }]);
  });

  it("returns a provider cap rejection without retrying, removing the cap or reading its body", async () => {
    const server = makeOpenAiServer({
      failures: [{ status: 400, body: { error: { message: "max_tokens is unsupported" } } }],
    });
    let rejected: Response | undefined;
    const fetchImpl: typeof fetch = async (...args) => {
      rejected = await server.fetch(...args);
      vi.spyOn(rejected, "text");
      vi.spyOn(rejected, "json");
      return rejected;
    };
    const { response } = await send({}, { fetchImpl }).result;
    expect(response.status).toBe(400);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body).toMatchObject({ max_tokens: 50 });
    expect(rejected?.text).not.toHaveBeenCalled();
    expect(rejected?.json).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it("settles the reservation with reported token usage", async () => {
    const { result } = send();
    const { reservation } = await result;
    await settleLlmUsage(
      reservation.id,
      "llm_explain",
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
        request: scopeRequest("llm_explain", "llama-3"),
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
        scope: "llm_explain",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch, unknownCostConfirmed: true },
    );
    expect(response.status).toBe(200);
    expect(server.requests).toHaveLength(2);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "retried" }, { outcome: "ok" }]);
  });

  it("honors retry-after on 429 then succeeds", async () => {
    const server = makeOpenAiServer({
      failures: [{ status: 429, retryAfterSeconds: 0 }],
    });
    const { response } = await sendLlmConsented(
      {
        providerId: PROVIDER_ID,
        scope: "llm_explain",
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
        scope: "llm_explain",
        request: validRequest(),
        maxInputTokens: 100,
        maxOutputTokens: 50,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch, unknownCostConfirmed: true },
    );
    expect(response.status).toBe(400);
    expect(server.requests).toHaveLength(1);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "http_400" }]);
  });

  it("accounts sent exposure and throws aborted on caller abort", async () => {
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
        scope: "llm_explain",
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
    expect(error.code).toBe("aborted");
    const rows = await db.llmReservations.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("settled");
    expect(await db.llmUsage.toArray()).toMatchObject([{
      inputTokens: 100, outputTokens: 50,
      estimatedCostUsd: expect.closeTo(0.000045, 12),
    }]);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "aborted" }]);
  });

  it("accounts missing usage for every exhausted transport attempt", async () => {
    const server = makeOpenAiServer({
      failures: [{ throw: new TypeError("reset") }, { throw: new TypeError("reset") }],
    });
    await expectGateBlock(send({}, { fetchImpl: server.fetch }).result, "transport");
    expect(server.requests).toHaveLength(2);
    expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled", "settled"]);
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(2);
    for (const row of usage) {
      expect(row).toMatchObject({
        inputTokens: 100, outputTokens: 50, estimatedCostUsd: expect.closeTo(0.000045, 12),
      });
    }
    expect(usage.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)).toBeCloseTo(0.00009, 12);
    expect(await db.sentLog.toArray()).toMatchObject([{ outcome: "retried" }, { outcome: "transport" }]);
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
        request: scopeRequest("llm_summary", "llama-3"),
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
        request: scopeRequest("llm_summary", "llama3"),
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

  it("retains stale sent exposure against the cap and accepts one late honest settlement", async () => {
    await saveLlmProvider(providerRecord({ monthlyBudgetUsd: 0.00005 }));
    const { reservation } = await send().result;
    const late = new Date(NOW.getTime() + STALE_RESERVATION_TTL_MS + 1);
    const next = send({}, { now: () => late });
    await expectGateBlock(next.result, "budget_exceeded");
    expect(next.fetch.requests).toHaveLength(0);
    expect((await db.llmReservations.get(reservation.id))?.status).toBe("active");
    expect(await db.llmUsage.count()).toBe(0);

    await Promise.all([
      settleLlmUsage(reservation.id, "llm_explain", { outputTokens: 1000, reportedCostUsd: 0.02 }, late),
      settleLlmUsage(reservation.id, "llm_explain", { outputTokens: 1000, reportedCostUsd: 0.02 }, late),
    ]);
    await settleLlmUsage(reservation.id, "llm_explain", {}, late);
    const rows = await db.llmUsage.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 1000, costUsd: 0.02 });
    expect(rows[0]?.estimatedCostUsd).toBeUndefined();
    expect((await db.llmReservations.get(reservation.id))?.status).toBe("settled");
  });

  it("retains unresolved stale unknown exposure and settles it idempotently without inventing a cost", async () => {
    await saveLlmProvider(providerRecord({
      provider: { kind: "preset", preset: "openai", model: UNPRICED_MODEL },
    }));
    const { reservation } = await send({ request: validRequest(UNPRICED_MODEL) }).result;
    const late = new Date(NOW.getTime() + STALE_RESERVATION_TTL_MS + 1);
    await send({ request: validRequest(UNPRICED_MODEL) }, { now: () => late }).result;
    expect((await db.llmReservations.get(reservation.id))?.status).toBe("active");
    const snapshot = () => Promise.all([db.llmUsage.toArray(), db.llmReservations.toArray()])
      .then(([usage, reservations]) => monthlyBudgetSnapshot({
        providerId: PROVIDER_ID, usage, reservations, now: late,
      }));
    expect(await snapshot()).toMatchObject({ hasUnknownCost: true, unknownCostRequests: 2 });
    await Promise.all([
      settleLlmUsage(reservation.id, "llm_explain", {}, late),
      settleLlmUsage(reservation.id, "llm_explain", {}, late),
    ]);
    const rows = await db.llmUsage.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(rows[0]?.costUsd).toBeUndefined();
    expect(rows[0]?.estimatedCostUsd).toBeUndefined();
    expect(await snapshot()).toMatchObject({ hasUnknownCost: true, unknownCostRequests: 2 });
  });

  it("settles missing usage once using the admitted numeric pricing snapshot", async () => {
    const { reservation } = await send().result;
    await saveLlmProvider(providerRecord({
      provider: { kind: "preset", preset: "openai", model: MODEL,
        pricing: { inputPerMillion: 10, outputPerMillion: 20 } },
    }));
    await Promise.all([
      settleLlmUsage(reservation.id, "llm_explain", { inputTokens: 10 }, NOW),
      settleLlmUsage(reservation.id, "llm_explain", { inputTokens: 10 }, NOW),
    ]);
    await settleLlmUsage(reservation.id, "llm_explain", { reportedCostUsd: 9 }, NOW);
    const rows = await db.llmUsage.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 10, outputTokens: 50 });
    expect(rows[0]?.estimatedCostUsd).toBeCloseTo(0.0000315, 12);
    expect(rows[0]?.costUsd).toBeUndefined();
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
        request: scopeRequest("llm_explain", "llama-3"),
        maxInputTokens: 100,
        maxOutputTokens: 100,
        kind: "manual",
      },
      { now: () => NOW, fetchImpl: server.fetch },
    );
    await expectGateBlock(result, "budget_exceeded");
    expect(server.requests).toHaveLength(0);
    // Pending exposure stays active until explicitly settled or never sent.
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
          request: scopeRequest("llm_explain", "llama-3"),
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
