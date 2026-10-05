import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { readBlocklist } from "../../src/decisions/blocklist";
import { db } from "../../src/db/database";
import { LlmHttpError } from "../../src/llm/client";
import { createLlmForTest as createLlmClient, reservedInputBound, scopeRequest } from "../fakes/llm";
import { LlmGateError, settleLlmUsage } from "../../src/net/llm-send";
import { monthlyBudgetSnapshot } from "../../src/llm/budget";
import { LlmCapabilityError } from "../../src/llm/structured";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { makeOpenAiServer } from "../mock-servers/openai";
import type { LlmProviderRecord } from "../../src/schemas/llm";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";

function installChromeStub() {
  const store: Record<string, unknown> = {};
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
    permissions: { contains: async () => true },
  });
}

const record: LlmProviderRecord = {
  providerId: PROVIDER_ID,
  provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
  configuredAt: "2026-09-15T00:00:00.000Z",
  monthlyBudgetUsd: 5,
};

const REQUEST = scopeRequest("llm_explain", "gpt-4o-mini");

// A04: the serialized REQUEST estimates above the declared 100-token bound,
// so the reservation — and every missing-usage settle — uses this honest
// bound instead. Rate: $0.15/$0.60 per 1M input/output tokens (preset).
const BOUND_INPUT = reservedInputBound(REQUEST, 100, 50);
const rateCost = (input: number, output: number) =>
  (input * 0.15 + output * 0.6) / 1e6;
const BOUND_COST = rateCost(BOUND_INPUT, 50);

function client(fetchImpl: typeof fetch, beforeSend?: () => Promise<void>) {
  return createLlmClient(PROVIDER_ID, {
    scope: "llm_explain",
    kind: "manual",
    maxInputTokens: 100,
    maxOutputTokens: 50,
    unknownCostConfirmed: true,
    fetchImpl,
    ...(beforeSend !== undefined ? { beforeSend } : {}),
  });
}

function errorStream(chunks: Uint8Array[], status = 400) {
  let pulls = 0;
  let offset = 0;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const chunk = chunks[offset++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel,
  }, { highWaterMark: 0 });
  const response = new Response(stream, { status });
  const text = vi.spyOn(response, "text");
  const json = vi.spyOn(response, "json");
  return { response, cancel, text, json, pulls: () => pulls };
}

function expectRedacted(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).cause).toBeUndefined();
  for (const representation of [
    String(error), inspect(error, { depth: null }), JSON.stringify(error),
  ]) {
    expect(representation).not.toContain("BODY_SECRET");
    expect(representation).not.toContain("PROMPT_SECRET");
    expect(representation).not.toContain("sk-test");
  }
}

beforeEach(async () => {
  installChromeStub();
  await db.delete();
  await db.open();
  await saveLlmProvider(record);
  await grantConsentAtOrigin("llm_explain", ORIGIN);
  await saveCredential(PROVIDER_ID, "sk-test");
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("createLlmClient", () => {
  it.each([
    ["AbortError", "aborted"],
    ["TimeoutError", "timeout"],
  ])("preserves a gate %s through the client without retrying", async (name, code) => {
    const controller = new AbortController();
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      controller.abort(new DOMException("BODY_SECRET", name));
      throw new DOMException("PROMPT_SECRET", "AbortError");
    };
    const sender = createLlmClient(PROVIDER_ID, {
      scope: "llm_explain", kind: "manual", maxInputTokens: 100,
      maxOutputTokens: 50, signal: controller.signal, fetchImpl,
    });
    const error: unknown = await sender.send(REQUEST).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code });
    expectRedacted(error);
    expect(requests).toBe(1);
    expect(await db.llmUsage.count()).toBe(1);
    expect((await db.llmReservations.toArray()).map((row) => row.status)).toEqual(["settled"]);
  });

  it("carries feature admission through an internal retry and accounts prior exposure", async () => {
    for (const failure of ["429", "transport"] as const) {
      await db.llmReservations.clear();
      await db.llmUsage.clear();
      await db.metadata.delete("decisions:blocklist");
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
      await expect(client(fetchImpl, beforeSend).send(REQUEST)).rejects.toMatchObject({
        code: "request_not_allowed",
      });
      expect(server.requests).toHaveLength(1);
      expect((await db.llmReservations.toArray()).map((row) => row.status).sort()).toEqual(["released", "settled"]);
      expect(await db.llmUsage.toArray()).toMatchObject([{
        feature: "llm_explain", inputTokens: BOUND_INPUT, outputTokens: 50,
        estimatedCostUsd: expect.closeTo(BOUND_COST, 10),
      }]);
    }
  });

  it("returns the parsed completion JSON and settles usage", async () => {
    const { fetch } = makeOpenAiServer({
      completion: (body) => ({
        id: "c1",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "{}" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    });
    const raw = await client(fetch).send(REQUEST);
    expect(raw).toMatchObject({ model: "gpt-4o-mini" });
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      providerId: PROVIDER_ID,
      feature: "llm_explain",
      configuredModel: "gpt-4o-mini",
      inputTokens: 12,
      outputTokens: 8,
    });
    // The reservation was settled, not left active.
    const reservations = await db.llmReservations.toArray();
    expect(reservations[0]?.status).toBe("settled");
  });

  it("throws LlmCapabilityError when the provider rejects response_format", async () => {
    const { fetch } = makeOpenAiServer({
      failures: [
        {
          status: 400,
          body: {
            error: { message: "response_format is not supported by this model" },
          },
        },
      ],
    });
    await expect(client(fetch).send(REQUEST)).rejects.toBeInstanceOf(
      LlmCapabilityError,
    );
  });

  it("throws LlmHttpError for ordinary 4xx without a capability hint", async () => {
    const { fetch } = makeOpenAiServer({
      failures: [{ status: 401, body: { error: { message: "bad key" } } }],
    });
    const error = (await client(fetch)
      .send(REQUEST)
      .catch((caught: unknown) => caught)) as LlmHttpError;
    expect(error).toBeInstanceOf(LlmHttpError);
    expect(error.status).toBe(401);
    // The message carries the status only — never the provider's body.
    expect(error.message).not.toContain("bad key");
  });

  it("classifies validated known capability envelopes from their bounded stream", async () => {
    for (const body of [
      { error: "response_format unsupported" },
      { error: { message: "response_format is not supported by this model", param: null, type: "invalid_request_error", code: null } },
      { error: { message: "response_format json_schema not supported" } },
      { error: { message: "response_format json_object unsupported" } },
      { error: { message: "unsupported", param: "response_format" } },
      { error: { message: "not supported", param: "json_schema" } },
      { error: { message: "structured output unsupported" } },
    ]) {
      const encoded = new TextEncoder().encode(JSON.stringify(body));
      const wire = errorStream([encoded.slice(0, 8), encoded.slice(8)]);
      const error = await client(async () => wire.response).send(REQUEST).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmCapabilityError);
      expect(wire.text).not.toHaveBeenCalled();
      expect(wire.json).not.toHaveBeenCalled();
      expect(wire.response.body?.locked).toBe(false);
    }
  });

  it("vetoes capability fallback for every token field in every recognized error field", async () => {
    for (const tokenField of ["max_tokens", "max_completion_tokens", "max_output_tokens", "max_new_tokens"] as const) {
      const envelopes = [
        { error: { param: tokenField, message: "response_format json_schema unsupported" } },
        { error: { param: "response_format", message: `${tokenField} unsupported with json_schema` } },
        { error: { code: tokenField, message: "response_format unsupported" } },
        { error: { type: tokenField, message: "response_format unsupported" } },
        { error: `${tokenField} unsupported with response_format json_schema` },
        { error: { message: "response_format unsupported", [tokenField]: 50 } },
      ];
      for (const body of envelopes) {
        const server = makeOpenAiServer({ failures: [{ status: 400, body }] });
        const error = await client(server.fetch).send(REQUEST).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LlmHttpError);
        expect(error).toMatchObject({ status: 400 });
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]?.body).toMatchObject({ max_tokens: 50 });
      }
    }
  });

  it("surfaces malformed or ambiguous envelopes as status-only HTTP failure", async () => {
    for (const body of [
      "response_format unsupported",
      JSON.stringify({ message: "response_format unsupported" }),
      JSON.stringify({ error: ["response_format unsupported"] }),
      JSON.stringify({ error: { message: 5, param: "response_format" } }),
      JSON.stringify({ error: { message: "response_format unsupported", param: 5 } }),
      JSON.stringify({ error: { message: "response_format unsupported", code: {} } }),
      JSON.stringify({ error: { message: "response_format is invalid" } }),
      JSON.stringify({ error: { message: "response_format unsupported", param: "model" } }),
      JSON.stringify({ error: { message: "bad key" }, metadata: "response_format unsupported" }),
      JSON.stringify({ error: { message: "model unavailable" }, response_format: "unsupported" }),
      '{"error":{"message":"response_format unsupported"',
    ]) {
      const wire = errorStream([new TextEncoder().encode(body)]);
      const error = await client(async () => wire.response).send(REQUEST).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmHttpError);
      expect(error).toMatchObject({ status: 400 });
      expectRedacted(error);
      expect(wire.response.body?.locked).toBe(false);
    }
  });

  it("classifies a complete 4096-byte envelope without bulk body consumption", async () => {
    const body = JSON.stringify({ error: "response_format unsupported" }).padEnd(4096);
    const wire = errorStream([new TextEncoder().encode(body)]);
    const error = await client(async () => wire.response).send(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmCapabilityError);
    expect(wire.text).not.toHaveBeenCalled();
    expect(wire.json).not.toHaveBeenCalled();
  });

  it("cancels an oversized error without classifying a truncated capability prefix", async () => {
    for (const mode of ["one large chunk", "multiple chunks", "multibyte bytes"] as const) {
      const encoder = new TextEncoder();
      const validPrefix = JSON.stringify({ error: "response_format unsupported BODY_SECRET" }).padEnd(4096);
      const chunks = mode === "one large chunk"
        ? [encoder.encode(validPrefix + " "), encoder.encode("UNREAD_TAIL")]
        : mode === "multiple chunks"
          ? [encoder.encode(validPrefix), encoder.encode(" "), encoder.encode("UNREAD_TAIL")]
          : [encoder.encode(JSON.stringify({ error: `response_format unsupported ${"\u00e9".repeat(2100)}` })), encoder.encode("UNREAD_TAIL")];
      const wire = errorStream(chunks);
      const error = await client(async () => wire.response).send(REQUEST).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlmHttpError);
      expect(error).toMatchObject({ status: 400 });
      expect(wire.cancel).toHaveBeenCalledTimes(1);
      expect(wire.pulls()).toBe(mode === "multiple chunks" ? 2 : 1);
      expect(wire.text).not.toHaveBeenCalled();
      expect(wire.json).not.toHaveBeenCalled();
      expect(wire.response.body?.locked).toBe(false);
      expectRedacted(error);
    }
  });

  it("decodes valid UTF-8 across chunk boundaries and refuses invalid UTF-8", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      error: "response_format unsupported \u00e9",
    }));
    const split = bytes.indexOf(0xc3) + 1;
    const valid = errorStream([bytes.slice(0, split), bytes.slice(split)]);
    await expect(client(async () => valid.response).send(REQUEST)).rejects.toBeInstanceOf(LlmCapabilityError);
    const invalid = errorStream([new Uint8Array([
      ...new TextEncoder().encode('{"error":"response_format unsupported '),
      0xff, ...new TextEncoder().encode('"}'),
    ])]);
    await expect(client(async () => invalid.response).send(REQUEST)).rejects.toBeInstanceOf(LlmHttpError);
  });

  it("fails visibly without a native cause when the error body is already locked or consumed", async () => {
    for (const state of ["locked", "consumed"] as const) {
      const response = new Response(JSON.stringify({ error: "response_format unsupported BODY_SECRET" }), { status: 400 });
      const heldReader = state === "locked" ? response.body!.getReader() : undefined;
      if (state === "consumed") await response.text();
      try {
        const error = await client(async () => response).send(REQUEST).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LlmHttpError);
        expect(error).toMatchObject({ status: 400 });
        expectRedacted(error);
      } finally {
        heldReader?.releaseLock();
      }
    }
  });

  it("does not expose a native stream cancellation failure", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4097));
      },
      cancel() {
        throw new Error("BODY_SECRET PROMPT_SECRET sk-test");
      },
    }, { highWaterMark: 0 }), { status: 400 });
    const error = await client(async () => response).send(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmHttpError);
    expectRedacted(error);
    expect(response.body?.locked).toBe(false);
  });

  it("does not leak bodies, prompts or native causes into errors, logs or persistence", async () => {
    for (const failure of ["capability", "token", "parse", "stream"] as const) {
      const logs = ["log", "info", "warn", "error", "debug"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation(() => {}),
      );
      try {
        const body = failure === "capability"
          ? JSON.stringify({ error: "response_format unsupported BODY_SECRET sk-test PROMPT_SECRET" })
          : failure === "token"
            ? JSON.stringify({ error: { message: "max_tokens unsupported with response_format BODY_SECRET sk-test PROMPT_SECRET" } })
            : '{"error":"response_format unsupported BODY_SECRET sk-test PROMPT_SECRET"';
        const response = failure === "stream"
          ? new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("BODY_SECRET sk-test PROMPT_SECRET"));
            },
          }), { status: 400 })
          : errorStream([new TextEncoder().encode(body)]).response;
        const error = await client(async () => response).send({
          ...REQUEST, messages: [REQUEST.messages[0]!, { role: "user",
            content: JSON.stringify({ ...JSON.parse(REQUEST.messages[1]!.content) as object, answer: "PROMPT_SECRET" }) }],
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(failure === "capability" ? LlmCapabilityError : LlmHttpError);
        expectRedacted(error);
        expect(response.body?.locked).toBe(false);
        const persisted = JSON.stringify({
          reservations: await db.llmReservations.toArray(),
          usage: await db.llmUsage.toArray(),
          sentLog: await db.sentLog.toArray(),
        });
        expect(persisted).not.toContain("BODY_SECRET");
        expect(persisted).not.toContain("PROMPT_SECRET");
        expect(persisted).not.toContain("sk-test");
        for (const log of logs) expect(log).not.toHaveBeenCalled();
      } finally {
        for (const log of logs) log.mockRestore();
      }
    }
  });

  it("does not attach the native JSON parse cause to a malformed success response", async () => {
    const response = new Response("BODY_SECRET sk-test PROMPT_SECRET", { status: 200 });
    const error = await client(async () => response).send(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmGateError);
    expectRedacted(error);
  });

  it("retains reported usage on a bounded HTTP error without treating it as capability evidence", async () => {
    const server = makeOpenAiServer({
      failures: [{
        status: 400,
        body: {
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "response_format unsupported" } }],
          usage: { prompt_tokens: 10, completion_tokens: 1000, cost: 0.02 },
        },
      }],
    });
    await expect(client(server.fetch).send(REQUEST)).rejects.toBeInstanceOf(LlmHttpError);
    expect(await db.llmUsage.toArray()).toMatchObject([{
      inputTokens: 10, outputTokens: 1000, costUsd: 0.02,
    }]);
    expect((await db.llmReservations.toArray())[0]?.status).toBe("settled");
  });

  it("settles conservatively on a non-JSON body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const error = await client(fetchImpl)
      .send(REQUEST)
      .catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: BOUND_INPUT, outputTokens: 50 });
    expect(usage[0]?.estimatedCostUsd).toBeCloseTo(BOUND_COST, 12);
  });

  // These exercise wire -> real client -> gate -> Dexie accounting. Zero
  // substitution, ignoring error-envelope usage, or accepting negative costs
  // would reduce the observed spend below these hand-derived values.
  describe.each([200, 400])("usage settlement for HTTP %s", (status) => {
    it("preserves missing versus explicit zero usage across field variants", async () => {
      for (const { usage, input, output, cost } of [
        { usage: undefined, input: BOUND_INPUT, output: 50, cost: BOUND_COST },
        { usage: {}, input: BOUND_INPUT, output: 50, cost: BOUND_COST },
        { usage: { total_tokens: 20 }, input: BOUND_INPUT, output: 50, cost: BOUND_COST },
        { usage: { prompt_tokens: 10 }, input: 10, output: 50, cost: 0.0000315 },
        { usage: { completion_tokens: 5 }, input: BOUND_INPUT, output: 5, cost: rateCost(BOUND_INPUT, 5) },
        { usage: { prompt_tokens: 0 }, input: 0, output: 50, cost: 0.00003 },
        { usage: { completion_tokens: 0 }, input: BOUND_INPUT, output: 0, cost: rateCost(BOUND_INPUT, 0) },
        { usage: { prompt_tokens: 0, completion_tokens: 0 }, input: 0, output: 0, cost: 0 },
        { usage: { prompt_tokens: 10, cost: null }, input: 10, output: 50, cost: 0.0000315 },
        { usage: { prompt_tokens: 10, cost: -1 }, input: 10, output: 50, cost: 0.0000315 },
        { usage: { prompt_tokens: null, completion_tokens: 1000 }, input: BOUND_INPUT, output: 1000, cost: rateCost(BOUND_INPUT, 1000) },
        { usage: { prompt_tokens: -1, completion_tokens: 1000 }, input: BOUND_INPUT, output: 1000, cost: rateCost(BOUND_INPUT, 1000) },
        { usage: { prompt_tokens: 10, cost: "unavailable" }, input: 10, output: 50, cost: 0.0000315 },
        { usage: { prompt_tokens: 10, total_tokens: null }, input: 10, output: 50, cost: 0.0000315 },
      ] as const) {
        await db.llmUsage.clear();
        await db.llmReservations.clear();
      const body = status === 400
        ? { error: { message: "request refused" }, usage }
        : { model: "gpt-4o-mini", choices: [{ message: { content: "{}" } }], usage };
      const server = makeOpenAiServer({
        ...(status === 400
          ? { failures: [{ status, body }] }
          : { completion: () => body }),
      });
      const call = client(server.fetch).send(REQUEST);
      if (status === 400) await expect(call).rejects.toBeInstanceOf(LlmHttpError);
      else expect(await call).toMatchObject({ model: "gpt-4o-mini" });
      expect(server.requests).toHaveLength(1);
      const rows = await db.llmUsage.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ inputTokens: input, outputTokens: output });
      expect(rows[0]?.estimatedCostUsd).toBeCloseTo(cost, 12);
      expect(rows[0]?.costUsd).toBeUndefined();
      expect((await db.llmReservations.toArray())[0]?.status).toBe("settled");
      }
    });

    it("retains reported cost over estimates without token counts", async () => {
      for (const cost of [0, 0.02]) {
        await db.llmUsage.clear();
        await db.llmReservations.clear();
      const body = status === 400
        ? { error: { message: "request refused" }, usage: { cost } }
        : { model: "gpt-4o-mini", choices: [{ message: { content: "{}" } }], usage: { cost } };
      const response = new Response(JSON.stringify(body), { status });
      const call = client(async () => response).send(REQUEST);
      if (status === 400) await expect(call).rejects.toBeInstanceOf(LlmHttpError);
      else await call;
      const rows = await db.llmUsage.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ inputTokens: BOUND_INPUT, outputTokens: 50, costUsd: cost });
      expect(rows[0]?.estimatedCostUsd).toBeUndefined();
      }
    });

    it("retains reported cost when another usage field is invalid", async () => {
      for (const cost of [0, 0.02]) {
        await db.llmUsage.clear();
        await db.llmReservations.clear();
      const response = new Response(JSON.stringify({
        error: { message: "request refused" },
        usage: { prompt_tokens: null, completion_tokens: 1000, cost },
      }), { status });
      const call = client(async () => response).send(REQUEST);
      if (status === 400) await expect(call).rejects.toBeInstanceOf(LlmHttpError);
      else await call;
      const rows = await db.llmUsage.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ inputTokens: BOUND_INPUT, outputTokens: 1000, costUsd: cost });
      expect(rows[0]?.estimatedCostUsd).toBeUndefined();
      }
    });

    it("charges missing usage after a malformed JSON or body read failure", async () => {
      for (const failure of ["malformed JSON", "body read failure"] as const) {
        await db.llmUsage.clear();
        await db.llmReservations.clear();
      const response = failure === "malformed JSON"
        ? new Response("{", { status })
        : new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.error(new Error("synthetic read failure")); },
        }), { status });
      const error = await client(async () => response).send(REQUEST).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(status === 400 ? LlmHttpError : LlmGateError);
      expectRedacted(error);
      const rows = await db.llmUsage.toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ inputTokens: BOUND_INPUT, outputTokens: 50 });
      expect(rows[0]?.estimatedCostUsd).toBeCloseTo(BOUND_COST, 12);
      }
    });
  });

  it("blocks subsequent priced admission after a successful missing-usage response", async () => {
    await saveLlmProvider({ ...record, monthlyBudgetUsd: 0.0001 });
    const server = makeOpenAiServer({
      completion: () => ({ model: "gpt-4o-mini", choices: [{ message: { content: "{}" } }] }),
    });
    await client(server.fetch).send(REQUEST);
    await expect(client(server.fetch).send(REQUEST)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(server.requests).toHaveLength(1);
    expect(await db.llmUsage.count()).toBe(1);
  });

  // Losing an earlier attempt or applying the final reported zero to the whole
  // send would understate committed spend and admit the third provider send.
  it("settles retry-to-success attempts separately and blocks subsequent admission", async () => {
    for (const { prior, final, estimated, reported } of [
      { prior: undefined, final: undefined, estimated: 2 * BOUND_COST, reported: 0 },
      { prior: { prompt_tokens: 10 }, final: { completion_tokens: 5 }, estimated: rateCost(10, 50) + rateCost(BOUND_INPUT, 5), reported: 0 },
      { prior: undefined, final: { cost: 0 }, estimated: BOUND_COST, reported: 0 },
      { prior: { completion_tokens: 1000 }, final: { cost: 0 }, estimated: rateCost(BOUND_INPUT, 1000), reported: 0 },
      { prior: { prompt_tokens: 10, completion_tokens: 1000, cost: 0.02 }, final: { cost: 0 }, estimated: 0, reported: 0.02 },
    ] as const) {
      await db.llmUsage.clear();
      await db.llmReservations.clear();
    const cap = estimated + reported + 0.00001;
    await saveLlmProvider({ ...record, monthlyBudgetUsd: cap + 0.00009 });
    const server = makeOpenAiServer({
      failures: [{ status: 503, body: { error: { message: "temporarily unavailable" }, usage: prior } }],
      completion: () => ({
        model: "gpt-4o-mini", choices: [{ message: { content: "{}" } }], usage: final,
      }),
    });
    const llm = client(server.fetch);
    expect(await llm.send(REQUEST)).toMatchObject({ model: "gpt-4o-mini" });
    expect(server.requests).toHaveLength(2);
    const reservations = await db.llmReservations.toArray();
    expect(reservations).toHaveLength(2);
    expect(reservations.every((row) => row.status === "settled")).toBe(true);
    const finalReservation = reservations.find((row) => row.id === llm.lastReservationId);
    expect(finalReservation).toBeDefined();
    await Promise.all(reservations.map((row) => settleLlmUsage(row.id, "llm_explain", { reportedCostUsd: 0 })));
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(2);
    const snap = monthlyBudgetSnapshot({ providerId: PROVIDER_ID, usage, reservations, now: new Date() });
    expect(snap.estimatedCostUsd).toBeCloseTo(estimated, 12);
    expect(snap.reportedCostUsd).toBe(reported);
    expect(snap.reservedUsd).toBe(0);
    if (final?.cost === 0) {
      expect(usage.filter((row) => row.costUsd === 0)).toHaveLength(1);
      expect(usage.find((row) => row.costUsd === 0)?.estimatedCostUsd).toBeUndefined();
    }
    // Tighten the cap after inspecting both settlements; zeroed/missing prior
    // exposure would incorrectly leave room for this new reservation.
    await saveLlmProvider({ ...record, monthlyBudgetUsd: cap });
    await expect(llm.send(REQUEST)).rejects.toMatchObject({ code: "budget_exceeded" });
    expect(server.requests).toHaveLength(2);
    }
  });

  it("keeps confirmed unpriced retry exposure unknown beside a final reported zero", async () => {
    const model = "gpt-4o-mini-2024-07-18";
    await saveLlmProvider({ ...record, provider: { ...record.provider, model } });
    const server = makeOpenAiServer({
      failures: [{ status: 503 }],
      completion: () => ({ model, choices: [{ message: { content: "{}" } }], usage: { cost: 0 } }),
    });
    await createLlmClient(PROVIDER_ID, {
      scope: "llm_explain", kind: "manual", maxInputTokens: 100, maxOutputTokens: 50,
      unknownCostConfirmed: true, fetchImpl: server.fetch,
    }).send({ ...REQUEST, model });
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(2);
    expect(usage.filter((row) => row.costUsd === undefined && row.estimatedCostUsd === undefined)).toHaveLength(1);
    expect(usage.filter((row) => row.costUsd === 0)).toHaveLength(1);
    expect(server.requests).toHaveLength(2);
  });

  it("accounts a failed transport attempt before settling a missing-usage success", async () => {
    const server = makeOpenAiServer({
      failures: [{ throw: new TypeError("synthetic reset") }],
      completion: () => ({ model: "gpt-4o-mini", choices: [{ message: { content: "{}" } }] }),
    });
    await client(server.fetch).send(REQUEST);
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(2);
    expect(usage.every((row) => row.costUsd === undefined)).toBe(true);
    expect(usage.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)).toBeCloseTo(2 * BOUND_COST, 12);
    expect(server.requests).toHaveLength(2);
  });

  it("settles a confirmed manual unpriced success as unknown while refusing automatic egress", async () => {
    const model = "gpt-4o-mini-2024-07-18";
    await saveLlmProvider({ ...record, provider: { ...record.provider, model } });
    const server = makeOpenAiServer({
      completion: () => ({ model, choices: [{ message: { content: "{}" } }] }),
    });
    const config = {
      scope: "llm_explain" as const, maxInputTokens: 100, maxOutputTokens: 50,
      unknownCostConfirmed: true, fetchImpl: server.fetch,
    };
    await createLlmClient(PROVIDER_ID, { ...config, kind: "manual" }).send({ ...REQUEST, model });
    await expect(createLlmClient(PROVIDER_ID, { ...config, kind: "automatic" }).send({ ...REQUEST, model }))
      .rejects.toMatchObject({ code: "pricing_required" });
    expect(server.requests).toHaveLength(1);
    const rows = await db.llmUsage.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inputTokens: reservedInputBound({ ...REQUEST, model }, 100, 50),
      outputTokens: 50,
    });
    expect(rows[0]?.costUsd).toBeUndefined();
    expect(rows[0]?.estimatedCostUsd).toBeUndefined();
  });
});

describe("input estimate and not-billed provenance (A04/A05)", () => {
  it("reserves max(declared, estimate) when the serialized prompt exceeds the declared bound", async () => {
    const declared = 100;
    const server = makeOpenAiServer({});
    const payload = JSON.parse(REQUEST.messages[1]!.content as string) as Record<string, unknown>;
    const request = {
      ...REQUEST,
      messages: [
        REQUEST.messages[0]!,
        { role: "user", content: JSON.stringify({ ...payload, question: `Which category? ${"x".repeat(20_000)}` }) },
      ],
    };

    await client(server.fetch).send(request);

    const expected = Math.ceil(
      (JSON.stringify(server.requests[0]!.body).length / 4) * 1.25,
    );
    expect(expected).toBeGreaterThan(declared);
    const reservations = await db.llmReservations.toArray();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.maxInputTokens).toBe(expected);
    // The send still completes; reported usage wins at settle as usual.
    expect((await db.llmUsage.toArray())[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(reservations[0]?.status).toBe("settled");
  });

  it("settles a capability-probe rejection as not billed — excluded from the cap", async () => {
    const server = makeOpenAiServer({
      failures: [
        { status: 400, body: { error: { message: "response_format is not supported by this model" } } },
      ],
    });

    await expect(client(server.fetch).send(REQUEST)).rejects.toBeInstanceOf(LlmCapabilityError);

    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ notBilled: true, inputTokens: 0, outputTokens: 0 });
    expect(usage[0]?.costUsd).toBeUndefined();
    expect(usage[0]?.estimatedCostUsd).toBeUndefined();
    expect((await db.llmReservations.toArray())[0]?.status).toBe("settled");
    // Egressed traffic is recorded but contributes nothing to the monthly
    // cap: no reported/estimated figure and not an "unknown cost" either.
    const snap = monthlyBudgetSnapshot({
      providerId: PROVIDER_ID,
      usage,
      reservations: await db.llmReservations.toArray(),
      now: new Date(),
      monthlyBudgetUsd: 5,
    });
    expect(snap.requestCount).toBe(1);
    expect(snap.committedUsd).toBe(0);
    expect(snap.unknownCostRequests).toBe(0);
    expect(snap.hasUnknownCost).toBe(false);
  });

  it("keeps conservative billing for every non-capability failure shape", async () => {
    for (const mode of ["other_4xx", "5xx_then_success", "non_json_200"] as const) {
      await db.llmUsage.clear();
      await db.llmReservations.clear();
      const fetchImpl: typeof fetch =
        mode === "other_4xx"
          ? makeOpenAiServer({ failures: [{ status: 401, body: { error: { message: "bad key" } } }] }).fetch
          : mode === "5xx_then_success"
            ? makeOpenAiServer({ failures: [{ status: 500, body: { error: { message: "upstream" } } }] }).fetch
            : (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
      await client(fetchImpl).send(REQUEST).catch(() => {});

      const rows = await db.llmUsage.toArray();
      expect(rows.length).toBeGreaterThan(0);
      // No row may be marked not billed; the first row is the settled failure
      // (for 5xx a second settled row belongs to the retried success).
      for (const row of rows) expect(row.notBilled).toBeUndefined();
      expect(rows[0]?.estimatedCostUsd).toBeCloseTo(BOUND_COST, 12);
    }
  });
});
