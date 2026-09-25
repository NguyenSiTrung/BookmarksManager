import { describe, expect, it } from "vitest";
import {
  Answer,
  ChoiceQuestion,
  NoulQuestion,
  Question,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResponse,
  makeSyntheticRequest,
} from "../../src/jev/wire";
import {
  responseFractionalTokens,
  responseMissingTestAnswer,
  responseMissingUsage,
  responseNoulOutOfRange,
  responseWrongTestAnswerType,
  validOpenRouterResponse,
  validScoreAnswer,
  validTypeSafeResponse,
} from "../fixtures/jev-responses";

/**
 * These tests pin PROJECT_PLAN.md §8.2 verbatim: the Text union, the three
 * question criteria shapes and their size bounds, the Answer discriminated
 * union, and the request/response envelopes including OpenRouter's extras.
 */

describe("NoulQuestion", () => {
  it("accepts instructions with no criteria", () => {
    expect(
      NoulQuestion.safeParse({ type: "noul", instructions: "Is this ok?" })
        .success,
    ).toBe(true);
  });

  it("accepts criteria with true/false Text entries", () => {
    expect(
      NoulQuestion.safeParse({
        type: "noul",
        instructions: "Pick one.",
        criteria: { true: "yes means yes", false: { note: "no" } },
      }).success,
    ).toBe(true);
  });

  it("rejects a missing instructions field", () => {
    expect(NoulQuestion.safeParse({ type: "noul" }).success).toBe(false);
  });

  it("rejects Text that is a bare number", () => {
    expect(
      NoulQuestion.safeParse({ type: "noul", instructions: 42 }).success,
    ).toBe(false);
  });
});

describe("ChoiceQuestion", () => {
  const criteriaOf = (n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`option_${i}`, null]),
    );

  it("accepts a 2-option criteria map with mixed Text/null values", () => {
    expect(
      ChoiceQuestion.safeParse({
        type: "choice",
        instructions: "Which?",
        criteria: { alpha: "the first", beta: null },
      }).success,
    ).toBe(true);
  });

  it("accepts exactly 255 options", () => {
    expect(
      ChoiceQuestion.safeParse({
        type: "choice",
        instructions: "Which?",
        criteria: criteriaOf(255),
      }).success,
    ).toBe(true);
  });

  it.each([1, 256])("rejects %i options (bounds are 2–255)", (n) => {
    expect(
      ChoiceQuestion.safeParse({
        type: "choice",
        instructions: "Which?",
        criteria: criteriaOf(n),
      }).success,
    ).toBe(false);
  });

  it("rejects a missing criteria map", () => {
    expect(
      ChoiceQuestion.safeParse({ type: "choice", instructions: "Which?" })
        .success,
    ).toBe(false);
  });
});

describe("ScoreQuestion", () => {
  it("accepts a 2-level criteria array", () => {
    expect(
      ScoreQuestion.safeParse({
        type: "score",
        instructions: "Rate it.",
        criteria: ["low", "high"],
      }).success,
    ).toBe(true);
  });

  it("accepts exactly 10 levels", () => {
    expect(
      ScoreQuestion.safeParse({
        type: "score",
        instructions: "Rate it.",
        criteria: Array.from({ length: 10 }, (_, i) => `level ${i + 1}`),
      }).success,
    ).toBe(true);
  });

  it.each([1, 11])("rejects %i levels (bounds are 2–10)", (n) => {
    expect(
      ScoreQuestion.safeParse({
        type: "score",
        instructions: "Rate it.",
        criteria: Array.from({ length: n }, (_, i) => `level ${i}`),
      }).success,
    ).toBe(false);
  });
});

describe("Question discriminated union", () => {
  it("rejects an unknown question type", () => {
    expect(
      Question.safeParse({ type: "rank", instructions: "?" }).success,
    ).toBe(false);
  });

  it("routes each known type to its schema", () => {
    expect(
      Question.safeParse({ type: "noul", instructions: "?" }).success,
    ).toBe(true);
    expect(
      Question.safeParse({
        type: "choice",
        instructions: "?",
        criteria: { a: null, b: null },
      }).success,
    ).toBe(true);
    expect(
      Question.safeParse({
        type: "score",
        instructions: "?",
        criteria: ["a", "b"],
      }).success,
    ).toBe(true);
  });
});

describe("SystemOneRequest", () => {
  it("accepts the synthetic request and multi-question sets", () => {
    expect(SystemOneRequest.safeParse(makeSyntheticRequest("m")).success).toBe(
      true,
    );
    expect(
      SystemOneRequest.safeParse({
        model: "jev-latest",
        state: { bookmark: { title: "t", url: "https://x.test" } },
        questions: {
          category: {
            type: "choice",
            instructions: "Which?",
            criteria: { a: null, b: null },
          },
          quality: {
            type: "score",
            instructions: "Rate.",
            criteria: ["bad", "good"],
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each(["model", "state", "questions"])("rejects a missing %s", (key) => {
    const request = { ...makeSyntheticRequest("m") } as Record<
      string,
      unknown
    >;
    delete request[key];
    expect(SystemOneRequest.safeParse(request).success).toBe(false);
  });
});

describe("Answer discriminated union", () => {
  it.each([0, 0.5, 1])("accepts noul=%f within [0, 1]", (noul) => {
    expect(Answer.safeParse({ type: "noul", noul }).success).toBe(true);
  });

  it.each([-0.1, 1.4])("rejects noul=%f outside [0, 1]", (noul) => {
    expect(Answer.safeParse({ type: "noul", noul }).success).toBe(false);
  });

  it("accepts a choice answer with probabilities and confidence", () => {
    expect(
      Answer.safeParse({
        type: "choice",
        choice: "docs",
        probabilities: { docs: 0.8, article: 0.2 },
        confidence: 0.8,
      }).success,
    ).toBe(true);
  });

  it("rejects a choice answer missing probabilities", () => {
    expect(
      Answer.safeParse({ type: "choice", choice: "docs", confidence: 0.8 })
        .success,
    ).toBe(false);
  });

  it("accepts a score answer with legend, probabilities, confidence", () => {
    expect(Answer.safeParse(validScoreAnswer).success).toBe(true);
  });

  it("rejects a score answer missing its legend", () => {
    const withoutLegend: Record<string, unknown> = { ...validScoreAnswer };
    delete withoutLegend["legend"];
    expect(Answer.safeParse(withoutLegend).success).toBe(false);
  });

  it("rejects an unknown answer type", () => {
    expect(Answer.safeParse({ type: "rank", rank: 1 }).success).toBe(false);
  });
});

describe("SystemOneResponse", () => {
  it("accepts the minimal TypeSafe response (no id/provider/cost)", () => {
    const parsed = SystemOneResponse.parse(validTypeSafeResponse);
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.id).toBeUndefined();
    expect(parsed.provider).toBeUndefined();
    expect(parsed.usage.cost).toBeUndefined();
    expect(parsed.answers["test"]).toEqual({ type: "noul", noul: 1 });
  });

  it("accepts the OpenRouter response with id, provider, and usage.cost", () => {
    const parsed = SystemOneResponse.parse(validOpenRouterResponse);
    expect(parsed.id).toBe("gen-01jfrt8q5m0n2b3v4c");
    expect(parsed.provider).toBe("typesafe");
    expect(parsed.usage.cost).toBe(0.000041);
  });

  it("accepts responses that omit the test answer or mismatch its type — the client checks that", () => {
    // These parse fine; the missing/mismatched `test` answer is a
    // client-level (UnexpectedModelBehavior-style) failure, not schema-level.
    expect(SystemOneResponse.safeParse(responseMissingTestAnswer).success).toBe(
      true,
    );
    expect(
      SystemOneResponse.safeParse(responseWrongTestAnswerType).success,
    ).toBe(true);
  });

  it.each([
    ["missing usage", responseMissingUsage],
    ["noul out of range", responseNoulOutOfRange],
    ["fractional tokens", responseFractionalTokens],
  ])("rejects a response with %s", (_label, body) => {
    expect(SystemOneResponse.safeParse(body).success).toBe(false);
  });
});

describe("makeSyntheticRequest", () => {
  it("returns the fixed synthetic payload verbatim; only model varies", () => {
    const request = makeSyntheticRequest("jev-1.13.0");
    expect(request).toEqual({
      model: "jev-1.13.0",
      state: "This is a synthetic connection test with no bookmark content.",
      questions: {
        test: {
          type: "noul",
          instructions: "Is this a synthetic connection test?",
        },
      },
    });
    expect(makeSyntheticRequest("other-model").model).toBe("other-model");
  });

  it("produces output that parses through SystemOneRequest unchanged", () => {
    const request = makeSyntheticRequest("jev-latest");
    expect(SystemOneRequest.parse(request)).toEqual(request);
  });

  it("carries no bookmark fields — top-level and question keys are exactly the synthetic set", () => {
    const request = makeSyntheticRequest("jev-latest");
    expect(Object.keys(request)).toEqual(["model", "state", "questions"]);
    expect(Object.keys(request.questions)).toEqual(["test"]);
    expect(request.questions["test"]).not.toHaveProperty("criteria");
    // No bookmark-shaped data can be injected: the only text is the constant.
    expect(typeof request.state).toBe("string");
    expect(request.state).toBe(
      "This is a synthetic connection test with no bookmark content.",
    );
    const serialized = JSON.stringify(request);
    for (const field of ["folderId", "createdAt", "chrome.bookmarks"]) {
      expect(serialized).not.toContain(field);
    }
  });
});
