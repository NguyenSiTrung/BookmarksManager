import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { LlmHttpError } from "../../src/llm/client";
import { createLlmForTest as createLlmClient, scopeRequest } from "../fakes/llm";
import { ExplainResponse } from "../../src/llm/prompt-contracts";
import { saveLlmProvider } from "../../src/llm/settings";
import { makeOpenAiServer } from "../mock-servers/openai";
import { z } from "../../src/schemas/z";
import {
  LlmCapabilityError,
  runStructured,
  StructuredOutputError,
} from "../../src/llm/structured";
import {
  ChatCompletionResponse,
  type ChatCompletionRequest,
} from "../../src/llm/wire";

const AnswerSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
});

function response(
  content: string | null,
  overrides: Record<string, unknown> = {},
): ChatCompletionResponse {
  return ChatCompletionResponse.parse({
    model: "returned-model",
    choices: [{ message: { role: "assistant", content } }],
    ...overrides,
  });
}

const MESSAGES = [{ role: "user" as const, content: "Answer the question." }];

function okAnswer(): string {
  return JSON.stringify({ answer: "42", confidence: 0.9 });
}

describe("runStructured", () => {
  it("sends a strict json_schema response_format on the json_schema tier", async () => {
    const send = vi.fn(async (request: ChatCompletionRequest) => {
      expect(request.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { strict: true },
      });
      const schema = (
        request.response_format as {
          json_schema: { schema: Record<string, unknown> };
        }
      ).json_schema.schema;
      expect(schema).toMatchObject({ type: "object" });
      return response(okAnswer());
    });

    const result = await runStructured({
      tier: "json_schema",
      model: "configured-model",
      schema: AnswerSchema,
      schemaName: "answer",
      messages: MESSAGES,
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.value).toEqual({ answer: "42", confidence: 0.9 });
    expect(result.tierUsed).toBe("json_schema");
    expect(result.repairs).toBe(0);
    expect(result.model).toBe("returned-model");
    expect(result.configuredModel).toBe("configured-model");
  });

  it("embeds the JSON Schema in the system prompt on the json_object tier", async () => {
    const send = vi.fn(async (request: ChatCompletionRequest) => {
      expect(request.response_format).toEqual({ type: "json_object" });
      const system = request.messages[0];
      expect(system?.role).toBe("system");
      expect(system?.content).toContain("answer");
      expect(system?.content).toContain("confidence");
      return response(okAnswer());
    });

    const result = await runStructured({
      tier: "json_object",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });
    expect(result.tierUsed).toBe("json_object");
    expect(result.value.answer).toBe("42");
  });

  it("sends no response_format on the prompt_only tier", async () => {
    const send = vi.fn(async (request: ChatCompletionRequest) => {
      expect(request.response_format).toBeUndefined();
      const system = request.messages[0];
      expect(system?.role).toBe("system");
      expect(system?.content).toContain("confidence");
      return response(okAnswer());
    });

    const result = await runStructured({
      tier: "prompt_only",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });
    expect(result.tierUsed).toBe("prompt_only");
    expect(result.value.confidence).toBe(0.9);
  });

  it("accepts a single fenced JSON block on the prompt_only tier", async () => {
    const send = vi.fn(async () => response(`\`\`\`json\n${okAnswer()}\n\`\`\``));
    const result = await runStructured({
      tier: "prompt_only",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });
    expect(result.value.answer).toBe("42");
  });

  it("rejects JSON with trailing prose and repairs on the same tier", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(`${okAnswer()} — hope that helps!`))
      .mockResolvedValueOnce(response(okAnswer()));

    const result = await runStructured({
      tier: "prompt_only",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.repairs).toBe(1);
    expect(result.value.answer).toBe("42");
    // The repair turn echoes the bad assistant output plus a user instruction.
    const secondRequest = send.mock.calls[1]?.[0] as ChatCompletionRequest;
    const roles = secondRequest.messages.map((m) => m.role);
    expect(roles.slice(-2)).toEqual(["assistant", "user"]);
  });

  it("rejects oversized prompt_only output without attempting extraction", async () => {
    const huge = `{"answer":"${"x".repeat(100_000)}","confidence":0.5}`;
    const send = vi.fn(async () => response(huge));
    await expect(
      runStructured({
        tier: "prompt_only",
        model: "m",
        schema: AnswerSchema,
        messages: MESSAGES,
        send,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    expect(send).toHaveBeenCalledTimes(3); // initial + two repairs
  });

  it("falls back to the next tier only on explicit capability rejection", async () => {
    const seenFormats: unknown[] = [];
    const send = vi.fn(async (request: ChatCompletionRequest) => {
      seenFormats.push(request.response_format);
      if (request.response_format !== undefined) {
        throw new LlmCapabilityError("provider rejected response_format");
      }
      return response(okAnswer());
    });

    const result = await runStructured({
      tier: "json_schema",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(seenFormats[0]).toMatchObject({ type: "json_schema" });
    expect(seenFormats[1]).toEqual({ type: "json_object" });
    expect(seenFormats[2]).toBeUndefined();
    expect(result.tierUsed).toBe("prompt_only");
  });

  it("does not treat malformed model output as evidence for fallback", async () => {
    const seenFormats: unknown[] = [];
    const send = vi.fn(async (request: ChatCompletionRequest) => {
      seenFormats.push(request.response_format);
      return response("definitely not json");
    });

    await expect(
      runStructured({
        tier: "json_schema",
        model: "m",
        schema: AnswerSchema,
        messages: MESSAGES,
        send,
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);

    expect(send).toHaveBeenCalledTimes(3);
    for (const format of seenFormats) {
      expect(format).toMatchObject({ type: "json_schema" });
    }
  });

  it("attempts at most two repairs after validation failure", async () => {
    const send = vi.fn(async () => response("still wrong"));
    await expect(
      runStructured({
        tier: "json_object",
        model: "m",
        schema: AnswerSchema,
        messages: MESSAGES,
        send,
      }),
    ).rejects.toMatchObject({ name: "StructuredOutputError" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("propagates non-capability send failures without retry or fallback", async () => {
    const auth = new Error("unauthorized");
    const send = vi.fn(async () => {
      throw auth;
    });
    await expect(
      runStructured({
        tier: "json_schema",
        model: "m",
        schema: AnswerSchema,
        messages: MESSAGES,
        send,
      }),
    ).rejects.toBe(auth);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("repairs null/refusal content like any other invalid output", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(okAnswer()));
    const result = await runStructured({
      tier: "json_schema",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });
    expect(result.repairs).toBe(1);
  });

  it("captures usage from the successful response", async () => {
    const send = vi.fn(async () =>
      response(okAnswer(), {
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const result = await runStructured({
      tier: "json_schema",
      model: "m",
      schema: AnswerSchema,
      messages: MESSAGES,
      send,
    });
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("redacts prompts and raw model output from errors", async () => {
    const send = vi.fn(async () =>
      response("SECRET_MARKER this is not parseable"),
    );
    const error = await runStructured({
      tier: "prompt_only",
      model: "m",
      schema: AnswerSchema,
      messages: [{ role: "user", content: "PROMPT_SECRET do the thing" }],
      send,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as Error).message).not.toContain("SECRET_MARKER");
    expect((error as Error).message).not.toContain("PROMPT_SECRET");
  });
});

describe("structured output caps through the real client and gate", () => {
  const providerId = "custom:http://127.0.0.1:11434";
  const model = "local-test";
  const scope = "llm_explain";
  const messages = scopeRequest(scope, model, "json_schema").messages;
  const okExplanation = () => JSON.stringify({ rationale: "Synthetic explanation." });

  function gatedClient(fetchImpl: typeof fetch) {
    return createLlmClient(providerId, {
      scope,
      kind: "manual",
      maxInputTokens: 100,
      maxOutputTokens: 50,
      fetchImpl,
    });
  }

  function run(send: (request: ChatCompletionRequest) => Promise<unknown>) {
    return runStructured({
      tier: "json_schema",
      model,
      schema: ExplainResponse, schemaName: "explanation",
      messages,
      send,
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("chrome", { permissions: { contains: async () => true } });
    await db.delete();
    await db.open();
    await saveLlmProvider({
      providerId,
      provider: {
        kind: "custom",
        baseUrl: "http://127.0.0.1:11434",
        model,
        auth: "none",
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      },
      configuredAt: "2026-10-01T00:00:00.000Z",
      monthlyBudgetUsd: 5,
    });
    await grantConsentAtOrigin(scope, "http://127.0.0.1:11434");
  });

  afterAll(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  it("caps the initial request and both repairs on every tier", async () => {
    for (const tier of ["json_schema", "json_object", "prompt_only"] as const) {
      await db.llmReservations.clear();
      await db.llmUsage.clear();
      let completions = 0;
      const server = makeOpenAiServer({
        completion: () => response(++completions < 3 ? "invalid json" : okExplanation()),
      });
      const client = gatedClient(server.fetch);
      const result = await runStructured({
        tier, model, schema: ExplainResponse, schemaName: "explanation", messages, send: client.send,
      });
      expect(result.value).toEqual({ rationale: "Synthetic explanation." });
      expect(result.tierUsed).toBe(tier);
      expect(result.repairs).toBe(2);
      expect(server.requests).toHaveLength(3);
      for (const request of server.requests) {
        expect(request.body).toMatchObject({ max_tokens: 50 });
      }
      expect((await db.llmReservations.toArray()).map((row) => row.maxOutputTokens)).toEqual([50, 50, 50]);
    }
  });

  it("caps every transport retry, tier fallback and subsequent repair body", async () => {
    let completions = 0;
    const server = makeOpenAiServer({
      failures: [
        { status: 429 },
        { status: 400, body: { error: { message: "response_format json_schema unsupported" } } },
        { throw: new TypeError("reset") },
        { status: 422, body: { error: { message: "response_format json_object unsupported" } } },
      ],
      completion: () => response(++completions < 3 ? "invalid json" : okExplanation()),
    });
    const client = gatedClient(server.fetch);
    const result = await run(client.send);
    expect(result.value).toEqual({ rationale: "Synthetic explanation." });
    expect(result.tierUsed).toBe("prompt_only");
    expect(result.repairs).toBe(2);
    expect(server.requests).toHaveLength(7);
    const bodies = server.requests.map((request) => request.body as ChatCompletionRequest);
    expect(bodies.map((body) => body.max_tokens)).toEqual([50, 50, 50, 50, 50, 50, 50]);
    expect(bodies.map((body) => body.response_format?.type)).toEqual([
      "json_schema", "json_schema", "json_object", "json_object", undefined, undefined, undefined,
    ]);
    const reservations = await db.llmReservations.toArray();
    expect(reservations.map((row) => row.maxOutputTokens)).toEqual([50, 50, 50, 50, 50, 50, 50]);
    expect(reservations.every((row) => row.status === "settled")).toBe(true);
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(7);
    for (const row of usage) {
      expect(row).toMatchObject({ inputTokens: 100, outputTokens: 50 });
      expect(row.costUsd).toBeUndefined();
      expect(row.estimatedCostUsd).toBeCloseTo(0.0002, 12);
    }
    expect(usage.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)).toBeCloseTo(0.0014, 12);
  });

  it("retains caller limit clamping through fallback and repair", async () => {
    for (const caller of [25, 1000]) {
      await db.llmReservations.clear();
      await db.llmUsage.clear();
      let completions = 0;
    const server = makeOpenAiServer({
      failures: [{ status: 400, body: { error: { message: "response_format unsupported" } } }],
      completion: () => response(++completions < 3 ? "invalid json" : okExplanation()),
    });
    const client = gatedClient(server.fetch);
    const result = await run((request) => client.send({ ...request, max_tokens: caller }));
    expect(result.value.rationale).toBe("Synthetic explanation.");
    expect(result.tierUsed).toBe("json_object");
    expect(result.repairs).toBe(2);
    expect(server.requests).toHaveLength(4);
    const expected = caller === 25 ? 25 : 50;
    expect(server.requests.map((request) => (request.body as ChatCompletionRequest).max_tokens)).toEqual([
      expected, expected, expected, expected,
    ]);
    expect((await db.llmReservations.toArray()).map((row) => row.maxOutputTokens)).toEqual([
      expected, expected, expected, expected,
    ]);
    }
  });

  it("surfaces HTTP token-limit rejections without fallback or repair", async () => {
    for (const [status, param, message] of [
      [400, "max_tokens", "max_tokens unsupported with response_format json_schema"],
      [404, "max_completion_tokens", "max_completion_tokens required instead of max_tokens for json_schema"],
      [422, "max_output_tokens", "structured output requires max_output_tokens, not max_tokens"],
    ] as const) {
      await db.llmReservations.clear();
      await db.llmUsage.clear();
    const server = makeOpenAiServer({
      failures: [{ status, body: { error: { param, message } } }],
      completion: () => response(okExplanation()),
    });
    const client = gatedClient(server.fetch);
    await expect(run(client.send)).rejects.toMatchObject({ name: "LlmHttpError", status });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body).toMatchObject({ max_tokens: 50 });
    expect(await db.llmReservations.count()).toBe(1);
    }
  });

  it("cancels an oversized error stream and refuses fallback with the cap still present", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const chunks = [
      new TextEncoder().encode(JSON.stringify({ error: "response_format unsupported" }).padEnd(4096)),
      new TextEncoder().encode(" "),
      new TextEncoder().encode("UNREAD_TAIL"),
    ];
    const failedResponse = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[reads++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel,
    }, { highWaterMark: 0 }), { status: 400 });
    const requests: unknown[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(init?.body as string));
      return failedResponse;
    };
    await expect(run(gatedClient(fetchImpl).send)).rejects.toBeInstanceOf(LlmHttpError);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ max_tokens: 50 });
    expect(reads).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(failedResponse.body?.locked).toBe(false);
  });

  it("charges a reported token overrun honestly", async () => {
    for (const cost of [undefined, 0.02]) {
      await db.llmReservations.clear();
      await db.llmUsage.clear();
    const server = makeOpenAiServer({
      completion: () => response(okExplanation(), {
        usage: {
          prompt_tokens: 10, completion_tokens: 1000, total_tokens: 1010,
          ...(cost !== undefined ? { cost } : {}),
        },
      }),
    });
    const result = await run(gatedClient(server.fetch).send);
    expect(result.value.rationale).toBe("Synthetic explanation.");
    expect(result.usage?.completionTokens).toBe(1000);
    expect(server.requests[0]?.body).toMatchObject({ max_tokens: 50 });
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 1000,
      ...(cost !== undefined ? { costUsd: 0.02 } : { estimatedCostUsd: expect.closeTo(0.00201, 10) }),
    });
    }
    const reservations = await db.llmReservations.toArray();
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ maxOutputTokens: 50, status: "settled" });
  });
});
