import { describe, expect, it } from "vitest";
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  firstText,
  parseUsage,
} from "../../src/llm/wire";

describe("ChatCompletionRequest", () => {
  it("accepts a minimal chat request", () => {
    const request = ChatCompletionRequest.parse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(request.model).toBe("gpt-4o-mini");
    expect(request.messages).toHaveLength(1);
  });

  it("accepts the json_schema response format", () => {
    const request = ChatCompletionRequest.parse({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object" },
          strict: true,
        },
      },
    });
    expect(request.response_format).toMatchObject({ type: "json_schema" });
  });

  it("accepts the json_object response format", () => {
    const request = ChatCompletionRequest.parse({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
    expect(request.response_format).toMatchObject({ type: "json_object" });
  });

  it("accepts all message roles", () => {
    const request = ChatCompletionRequest.parse({
      model: "m",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ],
    });
    expect(request.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it.each([1, 50, Number.MAX_SAFE_INTEGER])("accepts positive safe-integer max_tokens %s", (max_tokens) => {
    expect(ChatCompletionRequest.parse({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens,
    }).max_tokens).toBe(max_tokens);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "50", null])(
    "rejects invalid max_tokens %s instead of coercing it",
    (max_tokens) => {
      expect(ChatCompletionRequest.safeParse({
        model: "m", messages: [{ role: "user", content: "x" }], max_tokens,
      }).success).toBe(false);
    },
  );

  it.each(["max_completion_tokens", "max_output_tokens", "max_new_tokens"])(
    "rejects alternate %s alone or alongside max_tokens",
    (field) => {
      for (const max_tokens of [undefined, 25]) {
        expect(ChatCompletionRequest.safeParse({
          model: "m",
          messages: [{ role: "user", content: "x" }],
          ...(max_tokens !== undefined ? { max_tokens } : {}),
          [field]: 25,
        }).success).toBe(false);
      }
    },
  );

  it.each([
    ["empty messages", { model: "m", messages: [] }],
    ["blank model", { model: "  ", messages: [{ role: "user", content: "x" }] }],
    [
      "negative max_tokens",
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        max_tokens: -1,
      },
    ],
    [
      "unknown request key",
      {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        extra: "nope",
      },
    ],
    [
      "unknown role",
      { model: "m", messages: [{ role: "admin", content: "x" }] },
    ],
  ])("rejects %s", (_label, bad) => {
    expect(() => ChatCompletionRequest.parse(bad)).toThrow();
  });
});

describe("ChatCompletionResponse", () => {
  const minimal = {
    model: "gpt-4o-mini-2024-07-18",
    choices: [
      {
        message: { role: "assistant", content: "{\"a\":1}" },
        finish_reason: "stop",
      },
    ],
  };

  it("parses a minimal response and captures the returned model", () => {
    const res = ChatCompletionResponse.parse(minimal);
    expect(res.model).toBe("gpt-4o-mini-2024-07-18");
    expect(firstText(res)).toBe("{\"a\":1}");
  });

  it("tolerates provider-specific extra fields", () => {
    const res = ChatCompletionResponse.parse({
      ...minimal,
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1720000000,
      system_fingerprint: "fp_x",
      provider: "OpenRouter",
    });
    expect(res.model).toBe("gpt-4o-mini-2024-07-18");
  });

  it("parses OpenAI-style token usage", () => {
    const res = ChatCompletionResponse.parse({
      ...minimal,
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
    expect(parseUsage(res)).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  });

  it("parses OpenRouter reported cost when present", () => {
    const res = ChatCompletionResponse.parse({
      ...minimal,
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        cost: 0.00042,
      },
    });
    expect(parseUsage(res)).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      reportedCostUsd: 0.00042,
    });
  });

  it("returns undefined usage when the response omits it", () => {
    const res = ChatCompletionResponse.parse(minimal);
    expect(parseUsage(res)).toBeUndefined();
  });

  it("treats null usage cost as unavailable, never zero", () => {
    const res = ChatCompletionResponse.parse({
      ...minimal,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: null },
    });
    const usage = parseUsage(res);
    expect(usage).toBeDefined();
    expect(usage).not.toHaveProperty("reportedCostUsd");
  });

  it("allows null message content at the wire boundary", () => {
    const res = ChatCompletionResponse.parse({
      model: "m",
      choices: [{ message: { role: "assistant", content: null } }],
    });
    expect(firstText(res)).toBeNull();
  });

  it.each([
    ["missing model", { choices: [{ message: { role: "assistant", content: "x" } }] }],
    ["empty choices", { model: "m", choices: [] }],
    [
      "missing message",
      { model: "m", choices: [{ finish_reason: "stop" }] },
    ],
  ])("rejects %s", (_label, bad) => {
    expect(() => ChatCompletionResponse.parse(bad)).toThrow();
  });
});
