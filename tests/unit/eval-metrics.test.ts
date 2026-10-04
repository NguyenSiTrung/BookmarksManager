import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVAL_THRESHOLDS,
  aggregateEval,
  scoreObservation,
  type EvalObservation,
  type EvalThresholds,
} from "../../src/eval/metrics";
import type { EvalCase, EvalCorpus } from "../../src/eval/schema";

const T = DEFAULT_EVAL_THRESHOLDS;

function corpusCase(kind: EvalCase["kind"], overrides = {}): EvalCase {
  const base = { kind, id: `c_${kind}` } as const;
  switch (kind) {
    case "categorize":
      return {
        ...base,
        bookmark: "bm1",
        expect: { category: "docs" },
      } as EvalCase;
    case "tags":
      return {
        ...base,
        bookmark: "bm1",
        tags: [
          { name: "rust" },
          { name: "docs" },
          { name: "video" },
        ],
        expect: { tags: ["rust", "docs"] },
      } as EvalCase;
    case "placement":
      return {
        ...base,
        bookmark: "bm1",
        folders: [
          { id: "f1", path: ["Dev"] },
          { id: "f2", path: ["Hobbies"] },
        ],
        expect: { folder: "f1" },
        ...overrides,
      } as EvalCase;
    case "misfiled":
      return {
        ...base,
        bookmark: "bm1",
        folderPath: ["Hobbies"],
        folders: [
          { id: "f1", path: ["Dev"] },
          { id: "f2", path: ["Hobbies"], current: true },
        ],
        expect: { folder: "f1" },
        ...overrides,
      } as EvalCase;
    case "near_duplicate":
      return {
        ...base,
        a: "bm1",
        b: "bm2",
        expect: { same_content: 3 },
        ...overrides,
      } as EvalCase;
    case "rerank":
      return {
        ...base,
        query: "rust",
        candidates: ["bm1", "bm2", "bm3"],
        expect: { matches: ["bm1", "bm3"] },
        ...overrides,
      } as EvalCase;
  }
}

function obs(
  c: EvalCase,
  answer: EvalObservation["answer"],
  extra: Partial<EvalObservation> = {},
): EvalObservation {
  return { case: c, status: "answered", modelId: "jev-1.13.0", answer, ...extra };
}

describe("scoreObservation", () => {
  describe("categorize", () => {
    const c = corpusCase("categorize");
    it("scores a correct answer at each policy band", () => {
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.9 }), T),
      ).toMatchObject({ correct: true, outcome: "auto_apply", autoApplied: true, incorrectAutoApply: false });
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.6 }), T),
      ).toMatchObject({ correct: true, outcome: "review", autoApplied: false });
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.3 }), T),
      ).toMatchObject({ correct: true, outcome: "unsure", autoApplied: false });
    });

    it("flags an incorrect auto-apply and treats the band boundaries exactly", () => {
      const s = scoreObservation(
        obs(c, { kind: "categorize", choice: "video", confidence: 0.95 }),
        T,
      );
      expect(s).toMatchObject({
        correct: false,
        outcome: "auto_apply",
        autoApplied: true,
        incorrectAutoApply: true,
        expected: "docs",
        predicted: "video",
      });
      // floor 0.5 is review; auto-apply 0.85 is auto_apply.
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.5 }), T).outcome,
      ).toBe("review");
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.4999 }), T).outcome,
      ).toBe("unsure");
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.85 }), T).outcome,
      ).toBe("auto_apply");
      expect(
        scoreObservation(obs(c, { kind: "categorize", choice: "docs", confidence: 0.8499 }), T).outcome,
      ).toBe("review");
    });
  });

  describe("tags", () => {
    const c = corpusCase("tags");
    it("selects tags at probability >= tagSelect and scores the set", () => {
      const s = scoreObservation(
        obs(c, { kind: "tags", probabilities: { rust: 0.9, docs: 0.8, video: 0.1 } }),
        T,
      );
      expect(s.correct).toBe(true);
      expect(s.predicted).toEqual(["docs", "rust"]);
      // confidence = min margin among selected: min(0.8, 0.6) = 0.6
      expect(s.outcome).toBe("review");
    });

    it("an imperfect set is never auto_apply-eligible loss-free: wrong extra tag still counts", () => {
      const s = scoreObservation(
        obs(c, { kind: "tags", probabilities: { rust: 0.99, docs: 0.99, video: 0.95 } }),
        T,
      );
      expect(s.correct).toBe(false);
      expect(s.autoApplied).toBe(true);
      expect(s.incorrectAutoApply).toBe(true);
    });

    it("selects nothing → no_suggestion; correct only when expected is empty", () => {
      const none = scoreObservation(
        obs(c, { kind: "tags", probabilities: { rust: 0.1, docs: 0.2, video: 0.3 } }),
        T,
      );
      expect(none.outcome).toBe("no_suggestion");
      expect(none.correct).toBe(false);

      const emptyExpected = corpusCase("tags", {});
      (emptyExpected as { expect: { tags: string[] } }).expect.tags = [];
      const s = scoreObservation(
        obs(emptyExpected, {
          kind: "tags",
          probabilities: { rust: 0.1, docs: 0.2, video: 0.3 },
        }),
        T,
      );
      expect(s.correct).toBe(true);
    });
  });

  describe("placement", () => {
    const c = corpusCase("placement");
    it("preselects at the move on-save band boundary (0.7)", () => {
      expect(
        scoreObservation(obs(c, { kind: "placement", choice: "f1", confidence: 0.7 }), T).outcome,
      ).toBe("preselect");
      expect(
        scoreObservation(obs(c, { kind: "placement", choice: "f1", confidence: 0.6999 }), T).outcome,
      ).toBe("review");
      expect(
        scoreObservation(obs(c, { kind: "placement", choice: "f1", confidence: 0.4 }), T).outcome,
      ).toBe("unsure");
    });

    it("never auto-applies a move — even at max confidence — and scores a correct none", () => {
      expect(
        scoreObservation(obs(c, { kind: "placement", choice: "f1", confidence: 1 }), T).outcome,
      ).toBe("preselect");
      expect(
        scoreObservation(obs(c, { kind: "placement", choice: "f1", confidence: 1 }), T).autoApplied,
      ).toBe(false);
      const noneCase = corpusCase("placement", { expect: { folder: "none" } });
      const s = scoreObservation(
        obs(noneCase, { kind: "placement", choice: "none", confidence: 0.9 }),
        T,
      );
      expect(s.correct).toBe(true);
    });
  });

  describe("misfiled", () => {
    it("uses the misfiled_scan band: review-only, no preselect, no auto-apply", () => {
      const c = corpusCase("misfiled");
      const s = scoreObservation(
        obs(c, { kind: "misfiled", choice: "f1", confidence: 0.99 }),
        T,
      );
      expect(s).toMatchObject({ correct: true, outcome: "review", autoApplied: false });
    });

    it("scores correctly-filed vs misfiled cases by which folder the model picks", () => {
      const filed = corpusCase("misfiled", { expect: { folder: "f2" } });
      for (const choice of ["f2", "none"]) {
        const s = scoreObservation(
          obs(filed, { kind: "misfiled", choice, confidence: 0.9 }),
          T,
        );
        expect(s.correct, `filed:${choice}`).toBe(true);
      }
      const wrong = scoreObservation(
        obs(filed, { kind: "misfiled", choice: "f1", confidence: 0.9 }),
        T,
      );
      expect(wrong.correct).toBe(false);
      expect(wrong.detail).toMatchObject({ flaggedMisfiled: true });
      // A genuinely misfiled case: none or the current folder is wrong.
      const c = corpusCase("misfiled");
      for (const choice of ["f2", "none"]) {
        expect(
          scoreObservation(obs(c, { kind: "misfiled", choice, confidence: 0.9 }), T).correct,
          `misfiled:${choice}`,
        ).toBe(false);
      }
    });
  });

  describe("near_duplicate", () => {
    const c = corpusCase("near_duplicate");
    it("scores exact match with delta 0; a level off is incorrect but within-one", () => {
      const exact = scoreObservation(
        obs(c, { kind: "near_duplicate", score: 3, confidence: 0.8 }),
        T,
      );
      expect(exact).toMatchObject({ correct: true, outcome: "review", predicted: 3 });
      expect(exact.detail).toMatchObject({ delta: 0, withinOne: true });
      const off = scoreObservation(
        obs(c, { kind: "near_duplicate", score: 4, confidence: 0.8 }),
        T,
      );
      expect(off.correct).toBe(false);
      expect(off.detail).toMatchObject({ delta: 1, withinOne: true });
    });

    it("merge never auto-applies; below-floor confidence is unsure", () => {
      expect(
        scoreObservation(obs(c, { kind: "near_duplicate", score: 3, confidence: 1 }), T).outcome,
      ).toBe("review");
      expect(
        scoreObservation(obs(c, { kind: "near_duplicate", score: 3, confidence: 0.4 }), T).outcome,
      ).toBe("unsure");
    });
  });

  describe("rerank", () => {
    const c = corpusCase("rerank");
    it("predicts matches at probability >= noMatchBar and scores set equality", () => {
      const s = scoreObservation(
        obs(c, { kind: "rerank", probabilities: [0.9, 0.2, 0.8] }),
        T,
      );
      expect(s).toMatchObject({ correct: true, predicted: ["bm1", "bm3"] });
    });

    it("treats the bar inclusively: below it is no_match, at it is a weak match", () => {
      const below = scoreObservation(
        obs(c, { kind: "rerank", probabilities: [0.1, 0.2, 0.49] }),
        T,
      );
      expect(below.outcome).toBe("no_match");
      expect(below.correct).toBe(false);
      const at = scoreObservation(
        obs(c, { kind: "rerank", probabilities: [0.5, 0.2, 0.3] }),
        T,
      );
      expect(at.outcome).not.toBe("no_match");
      expect(at.predicted).toEqual(["bm1"]);
    });
  });

  describe("incomplete or failed observations", () => {
    const c = corpusCase("categorize");
    it("counts timeout/error/skipped, answerless, and wrong-kind observations as unanswered", () => {
      for (const status of ["timeout", "error", "skipped"] as const) {
        const s = scoreObservation({ case: c, status }, T);
        expect(s, status).toMatchObject({
          answered: false,
          correct: null,
          outcome: "unanswered",
          autoApplied: false,
          incorrectAutoApply: false,
        });
      }
      const noAnswer = scoreObservation({ case: c, status: "answered", modelId: "m" }, T);
      expect(noAnswer.answered).toBe(false);
      expect(noAnswer.correct).toBe(null);
      const wrongKind = scoreObservation(
        obs(c, { kind: "placement", choice: "f1", confidence: 0.9 }),
        T,
      );
      expect(wrongKind.answered).toBe(false);
    });
  });

  it("respects an injected threshold grid", () => {
    const c = corpusCase("categorize");
    const grid: EvalThresholds = { ...T, autoApply: 0.6 };
    const s = scoreObservation(
      obs(c, { kind: "categorize", choice: "docs", confidence: 0.7 }),
      grid,
    );
    expect(s.outcome).toBe("auto_apply");
  });
});

describe("aggregateEval", () => {
  const corpus = {
    version: "1.0.0",
    questionSetVersions: {
      categorize: "categorize-v1",
      tags: "tags-v1",
      placement: "placement-v1",
      misfiled: "misfiled-v1",
      nearDuplicate: "near-duplicate-v1",
      rerank: "rerank-v1",
    },
    bookmarks: [
      { id: "bm1", title: "a", url: "https://example.com/a", excluded: false },
      { id: "bm2", title: "b", url: "https://example.com/b", excluded: false },
      { id: "bm3", title: "c", url: "https://example.com/c", excluded: false },
    ],
    cases: [
      corpusCase("categorize"),
      corpusCase("tags"),
      corpusCase("placement"),
      corpusCase("misfiled"),
      corpusCase("near_duplicate"),
      corpusCase("rerank"),
    ],
  } satisfies EvalCorpus;

  const observations: EvalObservation[] = [
    obs(corpus.cases[0] as EvalCase, { kind: "categorize", choice: "docs", confidence: 0.9 }),
    obs(corpus.cases[1] as EvalCase, { kind: "tags", probabilities: { rust: 0.9, docs: 0.8, video: 0.9 } }),
    obs(corpus.cases[2] as EvalCase, { kind: "placement", choice: "f1", confidence: 0.8 }),
    obs(corpus.cases[3] as EvalCase, { kind: "misfiled", choice: "f1", confidence: 0.8 }),
    obs(corpus.cases[4] as EvalCase, { kind: "near_duplicate", score: 4, confidence: 0.8 }),
    { case: corpus.cases[5] as EvalCase, status: "timeout" },
  ];

  it("aggregates counts, coverage, accuracy, and policy rates", () => {
    const report = aggregateEval(corpus, observations, T, "2026-09-28T00:00:00Z");
    expect(report.totals).toMatchObject({
      cases: 6,
      answered: 5,
      correct: 3,
      coverage: 5 / 6,
      accuracy: 3 / 5,
    });
    // Only categorize (0.9) auto-applies: tags min margin is 0.6 → review.
    expect(report.totals.autoApply).toBe(1);
    expect(report.totals.incorrectAutoApply).toBe(0);
    expect(report.corpusVersion).toBe("1.0.0");
    expect(report.generatedAt).toBe("2026-09-28T00:00:00Z");
    expect(report.modelIds).toEqual(["jev-1.13.0"]);
  });

  it("breaks metrics down per kind", () => {
    const report = aggregateEval(corpus, observations, T, "g");
    expect(report.perKind.categorize).toMatchObject({ cases: 1, correct: 1, accuracy: 1 });
    expect(report.perKind.tags.microPrecision).toBeCloseTo(2 / 3); // predicted {rust,docs,video}, truth {rust,docs}
    expect(report.perKind.tags.microRecall).toBeCloseTo(1);
    expect(report.perKind.near_duplicate).toMatchObject({
      accuracy: 0,
      withinOneAccuracy: 1,
      meanAbsoluteError: 1,
    });
    expect(report.perKind.rerank.answered).toBe(0);
    expect(report.perKind.misfiled).toMatchObject({ cases: 1, correct: 1 });
  });

  it("treats corpus cases with no observation as unanswered", () => {
    const sparse = aggregateEval(corpus, [observations[0] as EvalObservation], T, "g");
    expect(sparse.totals.answered).toBe(1);
    expect(sparse.totals.cases).toBe(6);
    expect(sparse.scored).toHaveLength(6);
  });

  it("sorts by case id, rejects unknown cases, and rejects duplicate observations", () => {
    const reversed = [...observations].reverse();
    const report = aggregateEval(corpus, reversed, T, "g");
    const ids = report.scored.map((s) => s.caseId);
    expect(ids).toEqual([...ids].sort());
    const foreign: EvalObservation = {
      ...obs(corpusCase("categorize"), {
        kind: "categorize",
        choice: "docs",
        confidence: 0.9,
      }),
      case: { ...corpusCase("categorize"), id: "c_foreign" } as EvalCase,
    };
    expect(() => aggregateEval(corpus, [foreign], T, "g")).toThrow(/unknown/i);
    expect(() =>
      aggregateEval(corpus, [observations[0] as EvalObservation, observations[0] as EvalObservation], T, "g"),
    ).toThrow(/duplicate/i);
  });
});
