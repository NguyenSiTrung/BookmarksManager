import { describe, expect, it } from "vitest";
import { answerConfidence, noulMargin } from "../../src/jev/confidence";
import type { Answer } from "../../src/jev/wire";

/**
 * These tests pin PROJECT_PLAN.md §10.1: `choice` and `score` answers carry
 * their own calibrated `confidence` field, while `noul` answers have none —
 * their confidence is the probability's distance from the threshold,
 * normalized to [0, 1] on whichever side it falls (Pydantic AI's formula:
 * `(p − t) / (1 − t)` above `t`, `(t − p) / t` below it).
 */

describe("noulMargin", () => {
  it("returns 0 at p = t and 1 at the extremes (default t = 0.5)", () => {
    expect(noulMargin(0)).toBe(1);
    expect(noulMargin(0.5)).toBe(0);
    expect(noulMargin(1)).toBe(1);
  });

  it("scales above the threshold as (p − t) / (1 − t)", () => {
    expect(noulMargin(0.75)).toBeCloseTo(0.5);
    expect(noulMargin(0.9, 0.7)).toBeCloseTo((0.9 - 0.7) / (1 - 0.7));
  });

  it("scales below the threshold as (t − p) / t", () => {
    expect(noulMargin(0.25)).toBeCloseTo(0.5);
    expect(noulMargin(0.4, 0.7)).toBeCloseTo((0.7 - 0.4) / 0.7);
  });

  it("returns 0 at p = t for a custom threshold", () => {
    expect(noulMargin(0.7, 0.7)).toBe(0);
  });

  it("throws RangeError for p outside [0, 1]", () => {
    for (const p of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => noulMargin(p), `p=${p}`).toThrow(RangeError);
    }
  });

  it("throws RangeError for t outside (0, 1)", () => {
    for (const t of [0, 1, -0.25, 1.5, Number.NaN]) {
      expect(() => noulMargin(0.5, t), `t=${t}`).toThrow(RangeError);
    }
  });
});

describe("answerConfidence", () => {
  it("computes a noul answer's confidence as the margin at t = 0.5", () => {
    const answer: Answer = { type: "noul", noul: 0.9 };
    expect(answerConfidence(answer)).toBeCloseTo(0.8);
  });

  it("applies a custom threshold to noul answers", () => {
    const answer: Answer = { type: "noul", noul: 0.4 };
    expect(answerConfidence(answer, 0.7)).toBeCloseTo((0.7 - 0.4) / 0.7);
  });

  it("propagates the threshold RangeError for noul answers", () => {
    const answer: Answer = { type: "noul", noul: 0.5 };
    expect(() => answerConfidence(answer, 1)).toThrow(RangeError);
  });

  it("returns a choice answer's confidence field untouched, ignoring threshold", () => {
    const answer: Answer = {
      type: "choice",
      choice: "docs",
      probabilities: { docs: 0.8, article: 0.2 },
      confidence: 0.8,
    };
    expect(answerConfidence(answer)).toBe(0.8);
    // A threshold valid for noul must not alter the choice result, and an
    // out-of-(0, 1) value must not raise the noul RangeError either.
    expect(answerConfidence(answer, 0.2)).toBe(0.8);
    expect(answerConfidence(answer, 5)).toBe(0.8);
  });

  it("returns a score answer's confidence field untouched, ignoring threshold", () => {
    const answer: Answer = {
      type: "score",
      score: 4,
      legend: { "1": "strongly disagree", "5": "strongly agree" },
      probabilities: { "1": 0.02, "2": 0.05, "3": 0.13, "4": 0.6, "5": 0.2 },
      confidence: 0.6,
    };
    expect(answerConfidence(answer)).toBe(0.6);
    expect(answerConfidence(answer, 0.2)).toBe(0.6);
    expect(answerConfidence(answer, 5)).toBe(0.6);
  });
});
