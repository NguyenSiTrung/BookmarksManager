import { z } from "../schemas/z";

/**
 * OpenAI-compatible `/chat/completions` wire schemas. Requests we send are
 * strict — the schema doubles as a pre-send guard so a caller bug cannot add
 * arbitrary fields. Provider responses are loose (extra fields ignored):
 * they are untrusted input, and we validate only what we consume.
 *
 * This module never performs I/O — `send` is injected by the LLM egress gate
 * (Phase 2) so every request crosses `src/net/llm-send.ts`.
 */

export const ChatRole = z.enum(["system", "user", "assistant"]);
export type ChatRole = z.infer<typeof ChatRole>;

export const ChatMessage = z.strictObject({
  role: ChatRole,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Structured `response_format` variants this layer can request. */
export const ResponseFormat = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("json_schema"),
    json_schema: z.strictObject({
      name: z.string().min(1).max(64),
      schema: z.record(z.string(), z.unknown()),
      strict: z.literal(true),
    }),
  }),
  z.strictObject({ type: z.literal("json_object") }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormat>;

/** Positive safe-integer reservation/wire bounds; never coerce caller values. */
export const TokenBound = z.number().int().positive();

export const ChatCompletionRequest = z.strictObject({
  model: z.string().trim().min(1),
  messages: z.array(ChatMessage).min(1),
  response_format: ResponseFormat.optional(),
  // The gate supplies this when omitted; alternate limit keys stay forbidden.
  max_tokens: TokenBound.optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

export const ChatCompletionResponse = z.looseObject({
  model: z.string().min(1).max(300),
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          role: z.string().max(32).optional(),
          // Providers may return null content on refusals/tool calls.
          content: z.string().max(262_144).nullable(),
        }),
        finish_reason: z.string().max(64).nullable().optional(),
      }),
    )
    .min(1)
    .max(8),
  usage: z
    .looseObject({
      prompt_tokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
      completion_tokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
      total_tokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
      // OpenRouter reports per-request USD cost; absent elsewhere.
      cost: z.number().max(1_000_000).nullable().optional(),
    })
    .optional(),
});
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponse>;

/** Token usage in extension-native naming. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Provider-reported USD cost (OpenRouter). Absent means unknown — never 0. */
  reportedCostUsd?: number;
}

/** First choice's text content, or null for refusals/empty responses. */
export function firstText(response: ChatCompletionResponse): string | null {
  return response.choices[0]?.message.content ?? null;
}

/** Normalize provider usage; `undefined` when the provider omitted it. */
export function parseUsage(
  response: ChatCompletionResponse,
): TokenUsage | undefined {
  const usage = response.usage;
  if (usage === undefined) {
    return undefined;
  }
  return {
    ...(usage.prompt_tokens !== undefined
      ? { promptTokens: usage.prompt_tokens }
      : {}),
    ...(usage.completion_tokens !== undefined
      ? { completionTokens: usage.completion_tokens }
      : {}),
    ...(usage.total_tokens !== undefined
      ? { totalTokens: usage.total_tokens }
      : {}),
    // `null` cost is "unavailable", never zero — skip it entirely.
    ...(typeof usage.cost === "number"
      ? { reportedCostUsd: usage.cost }
      : {}),
  };
}
