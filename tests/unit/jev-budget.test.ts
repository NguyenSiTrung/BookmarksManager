import { describe, expect, it } from "vitest";
import {
  BudgetError,
  MAX_BATCH_TOTAL_TOKENS,
  MAX_STATE_PLUS_QUESTION_TOKENS,
  checkGuards,
  estimateTokens,
  planBatches,
} from "../../src/jev/budget";
import type { Question, SystemOneRequest } from "../../src/jev/wire";

/**
 * These tests pin FR2 / PROJECT_PLAN.md §8.3 pre-send behavior: the ~4
 * chars-per-token + 25% margin estimate, the defense-in-depth guards
 * (2–255 choice options, 2–10 score levels, unique non-empty keys), the
 * 32k state-plus-longest-question limit that fails the whole call, and the
 * greedy key-order packing under the 64k state-plus-batch limit.
 */

const noul = (instructions = "?"): Question => ({
  type: "noul",
  instructions,
});

const choice = (options: number): Question => ({
  type: "choice",
  instructions: "?",
  criteria: Object.fromEntries(
    Array.from({ length: options }, (_, i) => [`opt_${i}`, null]),
  ),
});

const score = (levels: number): Question => ({
  type: "score",
  instructions: "?",
  criteria: Array.from({ length: levels }, (_, i) => `level ${i}`),
});

const request = (
  questions: Record<string, Question>,
  state: SystemOneRequest["state"] = "s",
): SystemOneRequest => ({ model: "jev-test", state, questions });

/**
 * `estimateTokens` is `ceil(jsonLength * 5 / 16)`, so the exact JSON length
 * that yields `targetTokens` is `floor(16 * target / 5)` — always inside the
 * `(16(t-1)/5, 16t/5]` window. Use it to size a wrapped `{ key: question }`
 * or a string state to an exact token count.
 */
const jsonLengthFor = (tokens: number) => Math.floor((16 * tokens) / 5);

const sizedNoul = (key: string, targetTokens: number): Question => {
  const overhead = JSON.stringify({ [key]: noul("") }).length;
  const question = noul("x".repeat(jsonLengthFor(targetTokens) - overhead));
  const estimate = estimateTokens({ [key]: question });
  if (estimate !== targetTokens) {
    throw new Error(`sizedNoul missed: got ${estimate}, want ${targetTokens}`);
  }
  return question;
};

const sizedState = (targetTokens: number): string =>
  "x".repeat(jsonLengthFor(targetTokens) - JSON.stringify("").length);

const expectBudgetError = (
  fn: () => unknown,
  code: "too_large" | "invalid_request",
): BudgetError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BudgetError);
    expect(error).toBeInstanceOf(Error);
    const budgetError = error as BudgetError;
    expect(budgetError.name).toBe("BudgetError");
    expect(budgetError.code).toBe(code);
    return budgetError;
  }
  throw new Error(`expected BudgetError(${code}) but nothing was thrown`);
};

describe("estimateTokens", () => {
  it("is ~4 chars per token plus a 25% margin over the JSON text", () => {
    // JSON.stringify("aaa…a" ×14) is 16 chars → 16/4*1.25 = exactly 5.
    expect(estimateTokens("a".repeat(14))).toBe(5);
    // 100 JSON chars → ceil(100/4*1.25) = ceil(31.25) = 32.
    expect(estimateTokens("a".repeat(98))).toBe(32);
    // `{"a":1}` is 7 chars → ceil(2.1875) = 3.
    expect(estimateTokens({ a: 1 })).toBe(3);
    // `null` is 4 chars → ceil(1.25) = 2.
    expect(estimateTokens(null)).toBe(2);
  });

  it("returns 0 when JSON.stringify has no output (undefined, functions)", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(() => undefined)).toBe(0);
  });

  it("serializes records and arrays like the wire format does", () => {
    const json = JSON.stringify({ k: { type: "noul", instructions: "?" } });
    expect(estimateTokens({ k: noul("?") })).toBe(
      Math.ceil((json.length / 4) * 1.25),
    );
  });
});

describe("checkGuards", () => {
  it("accepts a well-formed mixed request", () => {
    expect(() =>
      checkGuards(
        request({
          category: choice(3),
          quality: score(4),
          relevant: noul(),
        }),
      ),
    ).not.toThrow();
  });

  it.each([0, 1, 256])(
    "rejects a choice question with %i options (bounds 2–255)",
    (options) => {
      expectBudgetError(
        () => checkGuards(request({ pick: choice(options) })),
        "invalid_request",
      );
    },
  );

  it.each([2, 255])("accepts a choice question with %i options", (options) => {
    expect(() =>
      checkGuards(request({ pick: choice(options) })),
    ).not.toThrow();
  });

  it.each([0, 1, 11])(
    "rejects a score question with %i levels (bounds 2–10)",
    (levels) => {
      expectBudgetError(
        () => checkGuards(request({ rate: score(levels) })),
        "invalid_request",
      );
    },
  );

  it.each([2, 10])("accepts a score question with %i levels", (levels) => {
    expect(() =>
      checkGuards(request({ rate: score(levels) })),
    ).not.toThrow();
  });

  it.each(["", "   ", " \t\n "])(
    "rejects an empty or whitespace-only question key (%j)",
    (key) => {
      expectBudgetError(
        () => checkGuards(request({ [key]: noul() })),
        "invalid_request",
      );
    },
  );

  it("cannot see duplicate keys: JSON.parse and object literals dedupe them", () => {
    // A Record<string, Question> cannot hold duplicate keys — the later
    // value silently wins — so the uniqueness guard is unreachable for any
    // input that exists as a JS object. It stays as a cheap Set-size check
    // in case a non-plain object ever reaches the guard.
    const parsed = JSON.parse('{"dup":1,"dup":2}') as Record<string, number>;
    expect(Object.keys(parsed)).toEqual(["dup"]);
    const questions = JSON.parse(
      '{"dup":{"type":"noul","instructions":"?"},"dup":{"type":"noul","instructions":"?"}}',
    ) as Record<string, Question>;
    expect(() => checkGuards(request(questions))).not.toThrow();
  });

  it.each([
    ["a null question", { bad: null }],
    ["a non-object question", { bad: "nope" }],
    ["an unknown question type", { bad: { type: "rank", instructions: "?" } }],
    [
      "a choice question without a criteria map",
      { bad: { type: "choice", instructions: "?" } },
    ],
    [
      "a score question without a criteria array",
      { bad: { type: "score", instructions: "?" } },
    ],
  ])("rejects %s as invalid_request", (_label, questions) => {
    expectBudgetError(
      () =>
        checkGuards(
          request(questions as unknown as Record<string, Question>),
        ),
      "invalid_request",
    );
  });

  it("rejects a non-record questions bag instead of throwing a TypeError", () => {
    for (const questions of [null, [], "nope"]) {
      expectBudgetError(
        () =>
          checkGuards({
            model: "jev-test",
            state: "s",
            questions,
          } as unknown as SystemOneRequest),
        "invalid_request",
      );
    }
  });

  it("never embeds state or question content in the message", () => {
    const error = expectBudgetError(
      () =>
        checkGuards({
          model: "jev-test",
          state: "SENSITIVE_BOOKMARK_STATE",
          questions: {
            "  ": {
              type: "choice",
              instructions: "SENSITIVE_QUESTION_TEXT",
              criteria: { only: null },
            },
          } as unknown as Record<string, Question>,
        }),
      "invalid_request",
    );
    expect(error.message).not.toContain("SENSITIVE_BOOKMARK_STATE");
    expect(error.message).not.toContain("SENSITIVE_QUESTION_TEXT");
  });
});

describe("planBatches", () => {
  it("returns a single batch equal to the input shape when everything fits", () => {
    const req = request({
      category: choice(3),
      quality: score(3),
      relevant: noul("Is it useful?"),
    });
    const batches = planBatches(req);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      model: req.model,
      state: req.state,
      questions: req.questions,
    });
  });

  it("returns no batches for a request with zero questions", () => {
    expect(planBatches(request({}))).toEqual([]);
  });

  it("runs the guards first — invalid input is invalid_request, not a plan", () => {
    expectBudgetError(
      () => planBatches(request({ pick: choice(1) })),
      "invalid_request",
    );
  });

  it("accepts a question landing exactly on the 32k state-plus-question limit", () => {
    const state = sizedState(1);
    const req = request({ big: sizedNoul("big", 31_999) }, state);
    const batches = planBatches(req);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toEqual(["big"]);
  });

  it("throws too_large one token past the 32k state-plus-question limit", () => {
    const state = sizedState(1);
    const req = request({ big: sizedNoul("big", 32_000) }, state);
    expectBudgetError(() => planBatches(req), "too_large");
  });

  it("throws too_large when the state alone leaves no room for a question", () => {
    const req = request({ small: noul() }, sizedState(32_000));
    expectBudgetError(() => planBatches(req), "too_large");
  });

  it("fails the whole call when any later question is oversized — nothing partial", () => {
    const req = request(
      { fine: noul(), huge: sizedNoul("huge", 32_000) },
      sizedState(1),
    );
    const questionsBefore = req.questions;
    expectBudgetError(() => planBatches(req), "too_large");
    // The request is untouched and no batch list escapes.
    expect(req.questions).toBe(questionsBefore);
  });

  it("does not embed question content in too_large messages", () => {
    const marker = "UNIQUE_INSTRUCTION_MARKER";
    const big = sizedNoul("big", 32_000);
    big.instructions = marker + big.instructions;
    const req = request({ big }, sizedState(1));
    const error = expectBudgetError(() => planBatches(req), "too_large");
    expect(error.message).not.toContain(marker);
    expect(error.message).not.toContain("x".repeat(64));
  });

  it("packs greedily in key order: a known split point produces exact batches", () => {
    // state "" estimates to 1 token; each batch may carry 63_999 tokens of
    // questions. qa+qb ≈ 60_000 fits, adding qc ≈ 5_000 would exceed 64k.
    const req = request(
      {
        qa: sizedNoul("qa", 30_000),
        qb: sizedNoul("qb", 30_000),
        qc: sizedNoul("qc", 5_000),
      },
      "",
    );
    const batches = planBatches(req);
    expect(batches).toHaveLength(2);
    expect(Object.keys(batches[0]!.questions)).toEqual(["qa", "qb"]);
    expect(Object.keys(batches[1]!.questions)).toEqual(["qc"]);
  });

  it("closes a batch only when the next question would push it past 64k", () => {
    // Four ~20k questions: three pack into ≈60k, the fourth starts batch 2.
    const req = request(
      {
        qa: sizedNoul("qa", 20_000),
        qb: sizedNoul("qb", 20_000),
        qc: sizedNoul("qc", 20_000),
        qd: sizedNoul("qd", 20_000),
      },
      "",
    );
    const batches = planBatches(req);
    expect(batches).toHaveLength(2);
    expect(Object.keys(batches[0]!.questions)).toEqual(["qa", "qb", "qc"]);
    expect(Object.keys(batches[1]!.questions)).toEqual(["qd"]);
  });

  it("produces disjoint batches whose union covers every question exactly once", () => {
    const questions: Record<string, Question> = {};
    for (let i = 0; i < 7; i += 1) {
      questions[`q${i}`] = sizedNoul(`q${i}`, 15_000);
    }
    const req = request(questions, "small state");
    const batches = planBatches(req);
    expect(batches.length).toBeGreaterThan(1);

    const seen: string[] = [];
    for (const batch of batches) {
      expect(batch.model).toBe(req.model);
      expect(batch.state).toBe(req.state);
      // Every emitted batch still satisfies the 64k invariant.
      expect(
        estimateTokens(batch.state) + estimateTokens(batch.questions),
      ).toBeLessThanOrEqual(MAX_BATCH_TOTAL_TOKENS);
      for (const [key, question] of Object.entries(batch.questions)) {
        expect(question).toBe(req.questions[key]);
        seen.push(key);
      }
    }
    // Disjoint, in order, covering all keys once.
    expect(seen).toEqual(Object.keys(req.questions));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("respects the exported budget constants", () => {
    expect(MAX_STATE_PLUS_QUESTION_TOKENS).toBe(32_000);
    expect(MAX_BATCH_TOTAL_TOKENS).toBe(64_000);
    expect(MAX_BATCH_TOTAL_TOKENS).toBeGreaterThan(
      MAX_STATE_PLUS_QUESTION_TOKENS,
    );
  });
});
