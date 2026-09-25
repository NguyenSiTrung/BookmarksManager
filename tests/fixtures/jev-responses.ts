import type { z } from "../../src/schemas/z";
import type { SystemOneResponse } from "../../src/jev/wire";

/**
 * A minimal valid System One response as TypeSafe returns it: the versioned
 * model id that answered, one answer per question key, and integer token
 * usage. TypeSafe adds no `id`, `provider`, or `usage.cost` fields.
 */
export const validTypeSafeResponse = {
  model: "jev-1.13.0",
  answers: {
    test: { type: "noul", noul: 1 },
  },
  usage: { input_tokens: 312, output_tokens: 6 },
} satisfies z.input<typeof SystemOneResponse>;

/**
 * OpenRouter's response carries the same shape plus its extras: a generation
 * `id`, the upstream `provider`, and `usage.cost` in USD (PROJECT_PLAN.md
 * §8.1).
 */
export const validOpenRouterResponse = {
  id: "gen-01jfrt8q5m0n2b3v4c",
  provider: "typesafe",
  model: "typesafe/jev-1.13",
  answers: {
    test: { type: "noul", noul: 1 },
  },
  usage: { input_tokens: 312, output_tokens: 6, cost: 0.000041 },
} satisfies z.input<typeof SystemOneResponse>;

/**
 * Schema-valid but useless for the synthetic test: every question key must
 * have a same-type answer, and this response answers a different key. The
 * client treats this like Pydantic AI's `UnexpectedModelBehavior`.
 */
export const responseMissingTestAnswer = {
  model: "jev-1.13.0",
  answers: {
    unrelated: { type: "noul", noul: 0 },
  },
  usage: { input_tokens: 312, output_tokens: 6 },
} satisfies z.input<typeof SystemOneResponse>;

/**
 * Schema-valid but mismatched: the `test` key is present yet answered with a
 * `choice` variant while the request asked a `noul` question.
 */
export const responseWrongTestAnswerType = {
  model: "jev-1.13.0",
  answers: {
    test: {
      type: "choice",
      choice: "yes",
      probabilities: { yes: 0.9, no: 0.1 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 312, output_tokens: 6 },
} satisfies z.input<typeof SystemOneResponse>;

/**
 * A valid score-variant answer, for wire-schema coverage of the third
 * discriminated-union member.
 */
export const validScoreAnswer = {
  type: "score",
  score: 4,
  legend: { "1": "strongly disagree", "5": "strongly agree" },
  probabilities: { "1": 0.02, "2": 0.05, "3": 0.13, "4": 0.6, "5": 0.2 },
  confidence: 0.8,
} satisfies z.input<typeof SystemOneResponse>["answers"][string];

// --- Malformed variants below intentionally violate the wire schema, so they
// are plain literals with no `satisfies` check. ---

/** Missing `usage` entirely — fails `SystemOneResponse` parsing. */
export const responseMissingUsage = {
  model: "jev-1.13.0",
  answers: {
    test: { type: "noul", noul: 1 },
  },
};

/** `noul` outside the 0–1 range — fails `Answer` parsing. */
export const responseNoulOutOfRange = {
  model: "jev-1.13.0",
  answers: {
    test: { type: "noul", noul: 1.4 },
  },
  usage: { input_tokens: 312, output_tokens: 6 },
};

/** Non-integer token counts — fails `usage` parsing. */
export const responseFractionalTokens = {
  model: "jev-1.13.0",
  answers: {
    test: { type: "noul", noul: 1 },
  },
  usage: { input_tokens: 312.5, output_tokens: 6 },
};
