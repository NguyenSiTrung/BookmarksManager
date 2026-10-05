import { z } from "../schemas/z";

/**
 * Jev System One wire schemas — PROJECT_PLAN.md §8.2 verbatim. These validate
 * the only payload shape the extension sends (the fixed synthetic `jev_test`
 * request built by `makeSyntheticRequest`) and every provider response before
 * the client trusts it. `z` comes from `src/schemas/z.ts` so all schemas run
 * under jitless (MV3 CSP-safe) compilation.
 */

const Text = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
]);

export const NoulQuestion = z.object({
  type: z.literal("noul"),
  instructions: Text,
  criteria: z
    .object({ true: Text.optional(), false: Text.optional() })
    .optional(),
});
export const ChoiceQuestion = z.object({
  type: z.literal("choice"),
  instructions: Text,
  criteria: z
    .record(z.string(), Text.nullable())
    .refine(
      (c) => {
        const n = Object.keys(c).length;
        return n >= 2 && n <= 255;
      },
      "2 to 255 options",
    ),
});
export const ScoreQuestion = z.object({
  type: z.literal("score"),
  instructions: Text,
  criteria: z.array(Text).min(2).max(10),
});
export const Question = z.discriminatedUnion("type", [
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
]);

export const SystemOneRequest = z.object({
  model: z.string(),
  state: Text,
  questions: z.record(z.string(), Question),
});

/** Record fields use key-count refines — the same bound style as the
 *  criteria options guard above (`2 to 255 options`). */
const boundedRecord = <V extends z.ZodType>(value: V, max = 256) =>
  z.record(z.string(), value).refine(
    (r) => Object.keys(r).length <= max,
    `at most ${max} entries`,
  );

export const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal("choice"),
    choice: z.string().max(1_024),
    probabilities: boundedRecord(z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: boundedRecord(z.string().max(1_024)),
    probabilities: boundedRecord(z.number()),
    confidence: z.number(),
  }),
]);

export const SystemOneResponse = z.object({
  model: z.string().max(300), // versioned id that answered
  answers: boundedRecord(Answer),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().max(1_000_000_000),
    output_tokens: z.number().int().nonnegative().max(1_000_000_000),
    cost: z.number().nonnegative().max(1_000_000).optional(), // OpenRouter only
  }),
  id: z.string().max(300).optional(), // OpenRouter only
  provider: z.string().max(300).optional(), // OpenRouter only
});

export type NoulQuestion = z.infer<typeof NoulQuestion>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestion>;
export type ScoreQuestion = z.infer<typeof ScoreQuestion>;
export type Question = z.infer<typeof Question>;
export type SystemOneRequest = z.infer<typeof SystemOneRequest>;
export type Answer = z.infer<typeof Answer>;
export type SystemOneResponse = z.infer<typeof SystemOneResponse>;

/**
 * The fixed `jev_test` payload. Only `model` varies; the signature admits no
 * caller-supplied state or questions, so no bookmark content can enter the
 * request. `src/net/send.ts` parses the return value through
 * `SystemOneRequest` before it reaches the wire.
 */
export function makeSyntheticRequest(model: string): SystemOneRequest {
  const request = {
    model,
    state: "This is a synthetic connection test with no bookmark content.",
    questions: {
      test: {
        type: "noul",
        instructions: "Is this a synthetic connection test?",
      },
    },
  } as const;
  return request;
}
