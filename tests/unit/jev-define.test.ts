import { describe, expect, it, vi } from "vitest";
import { createJevClient, JevClientError } from "../../src/jev/client";
import type { JevTransport } from "../../src/jev/client";
import { choice, defineDecision, noul, score } from "../../src/jev/define";
import type { Answer, SystemOneRequest } from "../../src/jev/wire";
import { startMockJevServer } from "../mock-servers/jev";

/**
 * Typed question-set builder (spec FR5, PROJECT_PLAN.md §8.4): field
 * declarations compile to wire `Question`s whose `instructions` always carry
 * `{ goal, question }`, choice/score options land in `criteria`, and
 * `build(state, model)` returns an exact `SystemOneRequest`.
 */

const GOAL = "Classify a saved bookmark for a personal bookmark library.";

describe("field builders", () => {
  it("rejects an empty or whitespace-only question", () => {
    expect(() => noul("")).toThrow(TypeError);
    expect(() => noul("   ")).toThrow(TypeError);
    expect(() => choice("", { a: null, b: null })).toThrow(TypeError);
    expect(() => score(" ", ["a", "b"])).toThrow(TypeError);
  });

  it("rejects a choice field with too few or too many options", () => {
    expect(() => choice("pick", { only: null })).toThrow(TypeError);
    const tooMany = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`k${i}`, null]),
    );
    expect(() => choice("pick", tooMany)).toThrow(TypeError);
    // Boundaries: 2 and 255 options are legal.
    expect(choice("pick", { a: null, b: null }).options).toEqual({
      a: null,
      b: null,
    });
    expect(() =>
      choice(
        "pick",
        Object.fromEntries(
          Array.from({ length: 255 }, (_, i) => [`k${i}`, null]),
        ),
      ),
    ).not.toThrow();
  });

  it("rejects choice fields with empty option keys", () => {
    expect(() => choice("pick", { "": null, b: null })).toThrow(TypeError);
    expect(() => choice("pick", { "  ": null, b: null })).toThrow(TypeError);
  });

  it("rejects a score field with too few or too many levels", () => {
    expect(() => score("rate", ["only"])).toThrow(TypeError);
    expect(() =>
      score("rate", Array.from({ length: 11 }, (_, i) => `l${i}`)),
    ).toThrow(TypeError);
    expect(score("rate", ["bad", "good"]).levels).toEqual(["bad", "good"]);
    expect(() =>
      score("rate", Array.from({ length: 10 }, (_, i) => `l${i}`)),
    ).not.toThrow();
  });

  it("rejects a noul threshold outside (0, 1)", () => {
    expect(() => noul("q", undefined, 0)).toThrow(TypeError);
    expect(() => noul("q", undefined, 1)).toThrow(TypeError);
    expect(() => noul("q", undefined, Number.NaN)).toThrow(TypeError);
    expect(noul("q", undefined, 0.7).threshold).toBe(0.7);
  });
});

describe("defineDecision", () => {
  it("rejects an empty goal and an empty field set", () => {
    expect(() => defineDecision({ goal: "", fields: { a: noul("q") } })).toThrow(
      TypeError,
    );
    expect(() =>
      defineDecision({ goal: "  ", fields: { a: noul("q") } }),
    ).toThrow(TypeError);
    expect(() => defineDecision({ goal: GOAL, fields: {} })).toThrow(TypeError);
  });

  it("rejects empty or whitespace-only field names", () => {
    expect(() =>
      defineDecision({ goal: GOAL, fields: { "": noul("q") } }),
    ).toThrow(TypeError);
    expect(() =>
      defineDecision({ goal: GOAL, fields: { "  ": noul("q") } }),
    ).toThrow(TypeError);
  });
});

describe("build(state, model)", () => {
  it("produces the exact System One request JSON for all three field kinds", () => {
    const decision = defineDecision({
      goal: GOAL,
      fields: {
        category: choice("Which kind of resource is `bookmark`?", {
          article: "A blog post, news story, essay, or tutorial.",
          docs: "Official documentation or an API reference.",
          tool: "A web app or online utility.",
          other: null,
        }),
        is_evergreen: noul("Will `page` still be useful a year from now?", {
          true: "Reference material or tools that do not go out of date.",
          false: "News or version-specific notes likely to go stale.",
        }),
        quality: score("Rate the page's overall quality.", [
          "poor",
          "average",
          "excellent",
        ]),
      },
    });

    expect(
      decision.build({ bookmark: { title: "T" } }, "jev-1.13.0"),
    ).toEqual({
      model: "jev-1.13.0",
      state: { bookmark: { title: "T" } },
      questions: {
        category: {
          type: "choice",
          instructions: {
            goal: GOAL,
            question: "Which kind of resource is `bookmark`?",
          },
          criteria: {
            article: "A blog post, news story, essay, or tutorial.",
            docs: "Official documentation or an API reference.",
            tool: "A web app or online utility.",
            other: null,
          },
        },
        is_evergreen: {
          type: "noul",
          instructions: {
            goal: GOAL,
            question: "Will `page` still be useful a year from now?",
          },
          criteria: {
            true: "Reference material or tools that do not go out of date.",
            false: "News or version-specific notes likely to go stale.",
          },
        },
        quality: {
          type: "score",
          instructions: {
            goal: GOAL,
            question: "Rate the page's overall quality.",
          },
          criteria: ["poor", "average", "excellent"],
        },
      },
    });
  });

  it("omits the criteria key for a noul field declared without criteria", () => {
    const decision = defineDecision({
      goal: GOAL,
      fields: { relevant: noul("Is this worth keeping?") },
    });
    const request = decision.build("state", "jev-latest");
    expect(request.questions["relevant"]).toEqual({
      type: "noul",
      instructions: { goal: GOAL, question: "Is this worth keeping?" },
    });
    expect("criteria" in (request.questions["relevant"] ?? {})).toBe(false);
  });

  it("keeps field order in the questions record", () => {
    const decision = defineDecision({
      goal: GOAL,
      fields: {
        zeta: noul("z?"),
        alpha: score("a?", ["lo", "hi"]),
        mid: choice("m?", { x: null, y: null }),
      },
    });
    expect(Object.keys(decision.build("s", "m").questions)).toEqual([
      "zeta",
      "alpha",
      "mid",
    ]);
  });
});

describe("run(client, state)", () => {
  const decision = defineDecision({
    goal: GOAL,
    fields: {
      category: choice("Which kind of resource is `bookmark`?", {
        article: "A blog post or essay.",
        docs: "Documentation or API reference.",
        other: null,
      }),
      is_evergreen: noul("Will `page` still be useful a year from now?", {
        true: "Reference material.",
        false: "Time-sensitive.",
      }),
      quality: score("Rate the page.", ["poor", "average", "excellent"]),
    },
  });
  const state = { bookmark: { title: "T", url: "https://example.test" } };

  function fakeClient(answers: Record<string, Answer>, model = "jev-1.13.0") {
    const run = vi.fn(async () => ({
      model,
      answers,
      usage: { inputTokens: 120, outputTokens: 40, cost: 0.0003 },
      batches: 1,
    }));
    return { model: "jev-latest", run };
  }

  it("returns typed values, confidence, probabilities, model, and usage", async () => {
    const client = fakeClient({
      category: {
        type: "choice",
        choice: "docs",
        probabilities: { article: 0.2, docs: 0.7, other: 0.1 },
        confidence: 0.7,
      },
      is_evergreen: { type: "noul", noul: 0.9 },
      quality: {
        type: "score",
        score: 3,
        legend: { "1": "poor", "2": "average", "3": "excellent" },
        probabilities: { "1": 0.1, "2": 0.2, "3": 0.7 },
        confidence: 0.8,
      },
    });

    const result = await decision.run(client, state);

    // The client was handed exactly build(state, client.model).
    expect(client.run).toHaveBeenCalledWith(
      decision.build(state, "jev-latest"),
    );

    // Typed values: option-key union, boolean at threshold, number.
    const category: "article" | "docs" | "other" = result.values.category;
    const evergreen: boolean = result.values.is_evergreen;
    const quality: number = result.values.quality;
    expect(category).toBe("docs");
    expect(evergreen).toBe(true);
    expect(quality).toBe(3);

    // §10.1 confidence: choice/score pass the API value through; noul uses
    // the margin (p=0.9, t=0.5 → 0.8).
    expect(result.confidence).toEqual({
      category: 0.7,
      is_evergreen: 0.8,
      quality: 0.8,
    });
    expect(result.confidence.is_evergreen).toBeCloseTo(0.8);

    // Raw probabilities ride along; noul exposes p as {true, false}.
    expect(result.probabilities.category).toEqual({
      article: 0.2,
      docs: 0.7,
      other: 0.1,
    });
    expect(result.probabilities.is_evergreen).toEqual({
      true: 0.9,
      false: 0.09999999999999998,
    });
    expect(result.probabilities.quality["3"]).toBeCloseTo(0.7);

    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cost: 0.0003,
    });
  });

  it("honors a noul field's custom threshold for value and confidence", async () => {
    const strict = defineDecision({
      goal: GOAL,
      fields: { keep: noul("Keep?", undefined, 0.8) },
    });
    // p=0.75 < t=0.8 → value false; margin = (t−p)/t = 0.05/0.8 = 0.0625.
    const client = fakeClient({ keep: { type: "noul", noul: 0.75 } });
    const result = await strict.run(client, "s");
    expect(result.values.keep).toBe(false);
    expect(result.confidence.keep).toBeCloseTo(0.0625);
  });

  it("propagates a client error unchanged", async () => {
    const failure = new JevClientError("retry_later", "rate limited");
    const client = {
      model: "jev-latest",
      run: vi.fn(async () => {
        throw failure;
      }),
    };
    const error = await decision
      .run(client, state)
      .catch((caught: unknown) => caught);
    expect(error).toBe(failure);
  });

  it("rejects a choice answer outside the declared options", async () => {
    const client = fakeClient({
      category: {
        type: "choice",
        choice: "surprise",
        probabilities: { surprise: 1 },
        confidence: 1,
      },
      is_evergreen: { type: "noul", noul: 0.5 },
      quality: {
        type: "score",
        score: 2,
        legend: { "1": "poor", "2": "average", "3": "excellent" },
        probabilities: { "1": 0, "2": 1, "3": 0 },
        confidence: 1,
      },
    });
    const error = await decision
      .run(client, state)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("answer_mismatch");
    expect((error as JevClientError).message).toContain('"category"');
  });

  it("rejects a score answer outside the declared levels", async () => {
    const client = fakeClient({
      category: {
        type: "choice",
        choice: "docs",
        probabilities: { docs: 1 },
        confidence: 1,
      },
      is_evergreen: { type: "noul", noul: 0.9 },
      quality: {
        type: "score",
        score: 9,
        legend: { "1": "poor", "2": "average", "3": "excellent" },
        probabilities: { "1": 0, "2": 0, "3": 1 },
        confidence: 1,
      },
    });
    const error = await decision
      .run(client, state)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("answer_mismatch");
    expect((error as JevClientError).message).toContain('"quality"');
  });

  it("end-to-end through the hardened client and mock server", async () => {
    const server = await startMockJevServer();
    try {
      const transport: JevTransport = (_s, _p, _m, request, options) =>
        fetch(server.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: options?.signal ?? null,
        });
      const jev = createJevClient({
        preset: "typesafe",
        model: "jev-latest",
        scope: "jev_test",
        transport,
      });
      const result = await decision.run(jev, state);
      // Mock defaults: choice picks the first key, noul p=0.9 → true,
      // score picks the middle level (2 of 3).
      expect(result.values.category).toBe("article");
      expect(result.values.is_evergreen).toBe(true);
      expect(result.values.quality).toBe(2);
      expect(result.model).toBe("jev-latest");
      expect(result.confidence.quality).toBeCloseTo(0.6);
      expect(server.requests).toHaveLength(1);
      // The wire request really is the builder output — instructions and all.
      const body = server.requests[0]?.json as SystemOneRequest;
      expect(body.questions["category"]).toEqual(
        decision.build(state, "jev-latest").questions["category"],
      );
    } finally {
      await server.close();
    }
  });
});
