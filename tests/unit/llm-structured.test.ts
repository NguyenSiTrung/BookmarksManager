import { describe, expect, it, vi } from "vitest";
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
