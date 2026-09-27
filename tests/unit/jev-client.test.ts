import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JevClientError,
  createJevClient,
  resetJevClientPools,
} from "../../src/jev/client";
import type { JevTransport } from "../../src/jev/client";
import type {
  Answer,
  Question,
  SystemOneRequest,
} from "../../src/jev/wire";
import { NetworkGateError } from "../../src/net/send";
import { startMockJevServer } from "../mock-servers/jev";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * Hardened Jev client (spec FR3): validation and budget guards happen before
 * any send, batches are sent through an injected transport (or the mock HTTP
 * server), responses are schema-checked and cross-checked against the request,
 * retries honor `retry-after` and jittered backoff, a per-preset concurrency
 * pool is shared across clients, and usage is summed exactly. Errors are
 * typed `JevClientError`s whose messages never carry bodies or key material.
 */

const MODEL = "jev-latest";
const SCOPE = "jev_test";

beforeEach(() => {
  // The per-preset pools are module state — reset them so limits registered
  // by one test cannot leak into the next.
  resetJevClientPools();
});

function noulQuestion(instructions = "Is this relevant?"): Question {
  return { type: "noul", instructions };
}

function requestOf(
  questions: Record<string, Question>,
  state: SystemOneRequest["state"] = "a small state",
  model: string = MODEL,
): SystemOneRequest {
  return { model, state, questions };
}

/** A schema-valid same-type answer, mirroring the mock server's defaults. */
function answerFor(question: Question): Answer {
  switch (question.type) {
    case "noul":
      return { type: "noul", noul: 0.9 };
    case "choice": {
      const keys = Object.keys(question.criteria);
      const picked = keys[0] ?? "";
      return {
        type: "choice",
        choice: picked,
        probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])),
        confidence: 0.75,
      };
    }
    case "score": {
      const levels = question.criteria;
      const legend = Object.fromEntries(
        levels.map((text, i) => [
          String(i + 1),
          typeof text === "string" ? text : JSON.stringify(text),
        ]),
      );
      return {
        type: "score",
        score: Math.ceil(levels.length / 2),
        legend,
        probabilities: Object.fromEntries(
          levels.map((_, i) => [String(i + 1), 1 / levels.length]),
        ),
        confidence: 0.6,
      };
    }
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A 200 response that answers exactly the request's question keys. */
function okResponse(
  request: SystemOneRequest,
  overrides: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
    omitAnswerKeys?: string[];
    answerOverrides?: Record<string, Answer>;
  } = {},
): Response {
  const answers: Record<string, Answer> = Object.fromEntries(
    Object.entries(request.questions).map(([key, q]) => [key, answerFor(q)]),
  );
  for (const key of overrides.omitAnswerKeys ?? []) {
    delete answers[key];
  }
  Object.assign(answers, overrides.answerOverrides ?? {});
  return jsonResponse({
    model: overrides.model ?? request.model,
    answers,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      ...(overrides.usage ?? {}),
    },
  });
}

type Handler = (
  request: SystemOneRequest,
  callIndex: number,
) => Response | Promise<Response>;

/** A transport spy: no scope/consent machinery, just the handler under test. */
function makeTransport(handler: Handler) {
  let calls = 0;
  return vi.fn<JevTransport>((_scope, _preset, _model, request) =>
    Promise.resolve(handler(request, calls++)),
  );
}

function client(
  transport: JevTransport,
  opts: Partial<Parameters<typeof createJevClient>[0]> = {},
) {
  return createJevClient({
    preset: "typesafe",
    model: MODEL,
    scope: SCOPE,
    transport,
    sleep: () => Promise.resolve(),
    ...opts,
  });
}

describe("validation and budget guards", () => {
  it("rejects a non-System-One request before any send", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    const error = await client(transport)
      .run({ nope: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("invalid_request");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a request whose model differs from the client model", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    const error = await client(transport)
      .run(requestOf({ q: noulQuestion() }, "state", "jev-1.13.0"))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("invalid_request");
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an oversized question as too_large before any send", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    // ~110k chars of JSON ≈ 34k tokens — over the 32k per-question budget.
    const big = { q: noulQuestion("x".repeat(110_000)) };
    const error = await client(transport)
      .run(requestOf(big))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("too_large");
    expect(transport).not.toHaveBeenCalled();
  });

  it("resolves an empty question set without sending", async () => {
    const transport = makeTransport(() => jsonResponse({}));
    const result = await client(transport).run(requestOf({}));
    expect(result).toEqual({
      model: MODEL,
      answers: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      batches: 0,
    });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("send, validate, merge", () => {
  it("returns merged answers, response model, usage, and batch count", async () => {
    const transport = makeTransport((request) => okResponse(request));
    const result = await client(transport).run(
      requestOf({
        relevant: noulQuestion(),
        category: {
          type: "choice",
          instructions: "Pick a kind.",
          criteria: { docs: "docs", other: null },
        },
        quality: {
          type: "score",
          instructions: "Rate it.",
          criteria: ["bad", "ok", "great"],
        },
      }),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.batches).toBe(1);
    expect(result.model).toBe(MODEL);
    expect(Object.keys(result.answers)).toEqual([
      "relevant",
      "category",
      "quality",
    ]);
    expect(result.answers["relevant"]?.type).toBe("noul");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
  });

  it("splits over-budget requests into batches and merges in key order", async () => {
    // ~50k chars per question ≈ 15.6k tokens → 4 fit under the 64k batch cap.
    const filler = "x".repeat(50_000);
    const questions = Object.fromEntries(
      ["q1", "q2", "q3", "q4", "q5"].map((key) => [
        key,
        noulQuestion(filler),
      ]),
    );
    const seen: string[][] = [];
    const transport = makeTransport((request) => {
      seen.push(Object.keys(request.questions));
      return okResponse(request);
    });
    const result = await client(transport).run(requestOf(questions));
    expect(transport).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([["q1", "q2", "q3", "q4"], ["q5"]]);
    expect(result.batches).toBe(2);
    expect(Object.keys(result.answers)).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });

  it("sums reported cost only when a response carries it", async () => {
    const filler = "x".repeat(50_000);
    const questions = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((key) => [key, noulQuestion(filler)]),
    );
    const transport = makeTransport((request) =>
      okResponse(request, { usage: { cost: 0.0025 } }),
    );
    const result = await client(transport).run(requestOf(questions));
    expect(result.usage.cost).toBeCloseTo(0.005);
  });

  it("records the versioned model the provider reports", async () => {
    const transport = makeTransport((request) =>
      okResponse(request, { model: "jev-1.13.0" }),
    );
    const result = await client(transport).run(
      requestOf({ q: noulQuestion() }),
    );
    expect(result.model).toBe("jev-1.13.0");
  });
});

describe("answer cross-checks", () => {
  const request = requestOf({
    first: noulQuestion(),
    second: noulQuestion(),
  });

  it("rejects a missing answer as answer_mismatch", async () => {
    const transport = makeTransport((req) =>
      okResponse(req, { omitAnswerKeys: ["second"] }),
    );
    const error = await client(transport)
      .run(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("answer_mismatch");
    expect((error as JevClientError).message).toContain('"second"');
  });

  it("rejects an unrequested answer key as answer_mismatch", async () => {
    const transport = makeTransport((req) =>
      okResponse(req, {
        answerOverrides: { surprise: { type: "noul", noul: 0.5 } },
      }),
    );
    const error = await client(transport)
      .run(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("answer_mismatch");
    expect((error as JevClientError).message).toContain('"surprise"');
  });

  it("rejects a wrong-type answer as answer_mismatch", async () => {
    const transport = makeTransport((req) =>
      okResponse(req, {
        answerOverrides: {
          first: {
            type: "choice",
            choice: "a",
            probabilities: { a: 1 },
            confidence: 1,
          },
        },
      }),
    );
    const error = await client(transport)
      .run(request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("answer_mismatch");
  });

  it("does not leak instructions or state into mismatch messages", async () => {
    const transport = makeTransport((req) =>
      okResponse(req, { omitAnswerKeys: ["probe"] }),
    );
    const error = await client(transport)
      .run(
        requestOf(
          { probe: noulQuestion("MARKER-INSTRUCTIONS") },
          "MARKER-STATE",
        ),
      )
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).message).not.toContain(
      "MARKER-INSTRUCTIONS",
    );
    expect((error as JevClientError).message).not.toContain("MARKER-STATE");
  });

  it("rejects differing batch models as model_mismatch", async () => {
    const filler = "x".repeat(50_000);
    const questions = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((key) => [key, noulQuestion(filler)]),
    );
    let call = 0;
    const transport = makeTransport((req) =>
      okResponse(req, { model: call++ === 0 ? "jev-a" : "jev-b" }),
    );
    const error = await client(transport)
      .run(requestOf(questions))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("model_mismatch");
  });
});

describe("retries", () => {
  it("retries a retryable 503 and succeeds", async () => {
    const transport = makeTransport((req) =>
      transport.mock.calls.length === 1
        ? jsonResponse("overloaded", 503)
        : okResponse(req),
    );
    const result = await client(transport, { maxRetries: 2 }).run(
      requestOf({ q: noulQuestion() }),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.answers["q"]?.type).toBe("noul");
  });

  it("honors retry-after delta seconds over jitter", async () => {
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const transport = makeTransport((req) =>
      transport.mock.calls.length === 1
        ? jsonResponse("slow down", 429, { "retry-after": "2" })
        : okResponse(req),
    );
    await client(transport, { maxRetries: 1, sleep, now: () => 0 }).run(
      requestOf({ q: noulQuestion() }),
    );
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("caps an honored retry-after at the maximum delay", async () => {
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const transport = makeTransport((req) =>
      transport.mock.calls.length === 1
        ? jsonResponse("slow down", 429, { "retry-after": "120" })
        : okResponse(req),
    );
    await client(transport, { maxRetries: 1, sleep, now: () => 0 }).run(
      requestOf({ q: noulQuestion() }),
    );
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it("honors retry-after HTTP dates", async () => {
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const date = new Date(5_000).toUTCString();
    const transport = makeTransport((req) =>
      transport.mock.calls.length === 1
        ? jsonResponse("slow down", 429, { "retry-after": date })
        : okResponse(req),
    );
    await client(transport, { maxRetries: 1, sleep, now: () => 0 }).run(
      requestOf({ q: noulQuestion() }),
    );
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("uses full-jitter backoff when no retry-after is present", async () => {
    const sleep = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const transport = makeTransport(() => jsonResponse("down", 503));
    const error = await client(transport, {
      maxRetries: 2,
      sleep,
      random: () => 0.5,
    })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("retry_later");
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it.each([
    [401, "auth"],
    [422, "incompatible"],
    [403, "http_error"],
    [404, "http_error"],
  ])(
    "does not retry HTTP %i and maps it to %s",
    async (status, code) => {
      const transport = makeTransport(() => jsonResponse("no", status));
      const error = await client(transport, { maxRetries: 3 })
        .run(requestOf({ q: noulQuestion() }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(JevClientError);
      expect((error as JevClientError).code).toBe(code);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it("maps exhausted retries to retry_later", async () => {
    const transport = makeTransport(() => jsonResponse("down", 503));
    const error = await client(transport, { maxRetries: 1 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("retry_later");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("maps a retryable status to retry_later even with no retry budget", async () => {
    const transport = makeTransport(() => jsonResponse("down", 529));
    const error = await client(transport, { maxRetries: 0 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("retry_later");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries gate transport failures and reports transport when exhausted", async () => {
    const transport = vi.fn<JevTransport>(() =>
      Promise.reject(new NetworkGateError("transport", "Transport failed.")),
    );
    const error = await client(transport, { maxRetries: 1 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("transport");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("times out a hanging send and reports timeout", async () => {
    const aborted = vi.fn();
    const transport = vi.fn<JevTransport>(
      (_s, _p, _m, _r, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted();
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const error = await client(transport, { timeoutMs: 20, maxRetries: 0 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("timeout");
    expect(aborted).toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout and reports timeout when exhausted", async () => {
    const transport = vi.fn<JevTransport>(
      (_s, _p, _m, _r, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const error = await client(transport, { timeoutMs: 10, maxRetries: 1 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("timeout");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("relays gate refusals verbatim and never retries them", async () => {
    const transport = vi.fn<JevTransport>(() =>
      Promise.reject(
        new NetworkGateError("no_consent", "No current consent grant."),
      ),
    );
    const error = await client(transport, { maxRetries: 3 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("no_consent");
    expect((error as JevClientError).message).toBe(
      "No current consent grant.",
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not retry an invalid response", async () => {
    const transport = vi.fn<JevTransport>(() =>
      Promise.resolve(new Response("this is not json {", { status: 200 })),
    );
    const error = await client(transport, { maxRetries: 3 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("invalid_response");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("propagates non-gate errors unwrapped", async () => {
    const boom = new TypeError("connection refused");
    const transport = vi.fn<JevTransport>(() => Promise.reject(boom));
    const error = await client(transport, { maxRetries: 3 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect(error).toBe(boom);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("redaction", () => {
  it("invalid_response carries no cause and no response body", async () => {
    const transport = vi.fn<JevTransport>(() =>
      Promise.resolve(
        new Response("MARKER-BODY not json {", { status: 200 }),
      ),
    );
    const error = await client(transport)
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("invalid_response");
    expect((error as JevClientError).message).not.toContain("MARKER-BODY");
    expect((error as JevClientError).cause).toBeUndefined();
  });

  it("non-2xx failures never read the response body", async () => {
    const body = vi.fn(() => Promise.resolve(""));
    const response = new Response("", { status: 401 });
    vi.spyOn(response, "text").mockImplementation(body);
    vi.spyOn(response, "json").mockImplementation(body);
    const transport = vi.fn<JevTransport>(() => Promise.resolve(response));
    await client(transport)
      .run(requestOf({ q: noulQuestion() }))
      .catch(() => undefined);
    expect(body).not.toHaveBeenCalled();
  });
});

describe("per-preset concurrency pool", () => {
  /**
   * Runs `limits.length` clients (one per maxConcurrency) against a shared
   * tracking transport over a request that splits into `batchCount` batches,
   * and reports the peak number of sends in flight at once.
   */
  async function inflightRun(limits: number[], batchCount: number) {
    const filler = "x".repeat(50_000);
    // ~15.6k tokens per question and 4 per 64k batch → batchCount batches.
    const questionCount = 4 * batchCount - (batchCount - 1);
    const questions = Object.fromEntries(
      Array.from({ length: questionCount }, (_, i) => [
        `q${i}`,
        noulQuestion(filler),
      ]),
    );
    let inflight = 0;
    let maxInflight = 0;
    const transport = vi.fn<JevTransport>(async (_s, _p, _m, request) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inflight -= 1;
      return okResponse(request);
    });
    const clients = limits.map((maxConcurrency) =>
      client(transport, { maxConcurrency }),
    );
    await Promise.all(clients.map((c) => c.run(requestOf(questions))));
    return { transport, maxInflight };
  }

  it("caps in-flight sends at maxConcurrency", async () => {
    const { transport, maxInflight } = await inflightRun([2], 4);
    expect(transport).toHaveBeenCalledTimes(4);
    expect(maxInflight).toBeLessThanOrEqual(2);
    expect(maxInflight).toBeGreaterThan(1); // concurrency actually exercised
  });

  it("shares the per-preset limit across clients", async () => {
    // The first client registered for a preset fixes the shared limit — the
    // second client's higher maxConcurrency must not raise it.
    const { maxInflight } = await inflightRun([2, 4], 2);
    expect(maxInflight).toBeLessThanOrEqual(2);
  });
});

describe("mock Jev server end-to-end", () => {
  let server: MockJevServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function httpClient(opts: Partial<Parameters<typeof createJevClient>[0]> = {}) {
    if (!server) throw new Error("server not started");
    const url = server.url;
    const transport: JevTransport = (_s, _p, _m, request, options) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: options?.signal ?? null,
      });
    return client(transport, opts);
  }

  it("runs a full request through real HTTP", async () => {
    server = await startMockJevServer();
    const result = await httpClient().run(
      requestOf({
        relevant: noulQuestion(),
        category: {
          type: "choice",
          instructions: "Pick a kind.",
          criteria: { docs: "docs", other: null },
        },
      }),
    );
    expect(server.requests).toHaveLength(1);
    expect(result.model).toBe(MODEL);
    expect(Object.keys(result.answers)).toEqual(["relevant", "category"]);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("recovers from a scripted 429 with retry-after", async () => {
    server = await startMockJevServer();
    server.queue({ kind: "status", status: 429, headers: { "retry-after": "0" } });
    const result = await httpClient({ maxRetries: 2 }).run(
      requestOf({ q: noulQuestion() }),
    );
    expect(server.requests).toHaveLength(2);
    expect(result.answers["q"]?.type).toBe("noul");
  });

  it("aborts a scripted hang on the attempt timeout", async () => {
    server = await startMockJevServer();
    server.queue({ kind: "hang" });
    const error = await httpClient({ timeoutMs: 50, maxRetries: 0 })
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("timeout");
  });

  it("maps malformed 200 bodies to invalid_response", async () => {
    server = await startMockJevServer();
    server.queue({ kind: "malformed" });
    const error = await httpClient()
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("invalid_response");
  });

  it("maps a dropped answer to answer_mismatch", async () => {
    server = await startMockJevServer();
    server.queue({ kind: "answer", omitAnswerKeys: ["q"] });
    const error = await httpClient()
      .run(requestOf({ q: noulQuestion() }))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("answer_mismatch");
  });

  it("maps differing batch models to model_mismatch", async () => {
    server = await startMockJevServer();
    const filler = "x".repeat(50_000);
    const questions = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((key) => [key, noulQuestion(filler)]),
    );
    server.queue({ kind: "answer", model: "jev-a" });
    server.queue({ kind: "answer", model: "jev-b" });
    const error = await httpClient()
      .run(requestOf(questions))
      .catch((caught: unknown) => caught);
    expect((error as JevClientError).code).toBe("model_mismatch");
  });
});
