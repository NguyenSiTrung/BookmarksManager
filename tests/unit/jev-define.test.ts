import { describe, expect, it } from "vitest";
import { choice, defineDecision, noul, score } from "../../src/jev/define";

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
