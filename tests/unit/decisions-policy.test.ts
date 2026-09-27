import { describe, expect, it } from "vitest";
import {
  AUTO_APPLY_THRESHOLD,
  DecisionSettings,
  escalateToLlm,
  evaluatePolicy,
  isNoMatch,
  MOVE_PRESELECT_THRESHOLD,
  RERANK_NO_MATCH_BAR,
  REVIEW_FLOOR,
} from "../../src/decisions/policy";

/**
 * These tests pin PROJECT_PLAN.md §10.2 / spec FR5: confidence bands are
 * per decision kind, only `add_tags`/`set_category` can ever auto-apply
 * (gated on a per-kind toggle that defaults off), `move` on save
 * pre-selects the folder at ≥ 0.7 instead of auto-moving, and every
 * outcome below the 0.5 review floor is `unsure`.
 */

const ON = DecisionSettings.parse({
  autoApply: { add_tags: true, set_category: true },
});

describe("named band constants", () => {
  it("exports the §10.2 boundaries verbatim", () => {
    expect(REVIEW_FLOOR).toBe(0.5);
    expect(MOVE_PRESELECT_THRESHOLD).toBe(0.7);
    expect(AUTO_APPLY_THRESHOLD).toBe(0.85);
    expect(RERANK_NO_MATCH_BAR).toBe(0.5);
  });
});

describe("add_tags / set_category bands", () => {
  it.each(["add_tags", "set_category"] as const)(
    "%s auto-applies at ≥ 0.85 only when its toggle is on",
    (kind) => {
      expect(evaluatePolicy({ kind, confidence: 0.85, settings: ON })).toBe(
        "auto_apply",
      );
      expect(evaluatePolicy({ kind, confidence: 1, settings: ON })).toBe(
        "auto_apply",
      );
      // Inclusive lower edge: exactly 0.85 applies, anything below reviews.
      expect(
        evaluatePolicy({ kind, confidence: 0.85 - 1e-9, settings: ON }),
      ).toBe("review");
    },
  );

  it.each(["add_tags", "set_category"] as const)(
    "%s lands in review for [0.5, 0.85) and is unsure below 0.5",
    (kind) => {
      expect(evaluatePolicy({ kind, confidence: 0.5, settings: ON })).toBe(
        "review",
      );
      expect(evaluatePolicy({ kind, confidence: 0.7, settings: ON })).toBe(
        "review",
      );
      expect(
        evaluatePolicy({ kind, confidence: 0.5 - 1e-9, settings: ON }),
      ).toBe("unsure");
      expect(evaluatePolicy({ kind, confidence: 0, settings: ON })).toBe(
        "unsure",
      );
    },
  );

  it.each(["add_tags", "set_category"] as const)(
    "%s never auto-applies while its toggle is off, even at 1.0",
    (kind) => {
      const off = DecisionSettings.parse({});
      for (const confidence of [0.85, 0.9, 0.99, 1]) {
        expect(evaluatePolicy({ kind, confidence, settings: off })).toBe(
          "review",
        );
        expect(evaluatePolicy({ kind, confidence })).toBe("review");
      }
    },
  );

  it("honours the toggles per kind, not globally", () => {
    const onlyTags = DecisionSettings.parse({ autoApply: { add_tags: true } });
    expect(
      evaluatePolicy({ kind: "add_tags", confidence: 0.9, settings: onlyTags }),
    ).toBe("auto_apply");
    expect(
      evaluatePolicy({
        kind: "set_category",
        confidence: 0.9,
        settings: onlyTags,
      }),
    ).toBe("review");
  });
});

describe("move bands", () => {
  it("on save pre-selects at ≥ 0.7 and never auto-applies", () => {
    for (const confidence of [0.7, 0.85, 0.99, 1]) {
      expect(
        evaluatePolicy({
          kind: "move",
          occasion: "on_save",
          confidence,
          settings: ON,
        }),
      ).toBe("preselect");
    }
  });

  it("on save reviews for [0.5, 0.7) and is unsure below 0.5", () => {
    expect(
      evaluatePolicy({ kind: "move", occasion: "on_save", confidence: 0.5 }),
    ).toBe("review");
    expect(
      evaluatePolicy({
        kind: "move",
        occasion: "on_save",
        confidence: 0.7 - 1e-9,
      }),
    ).toBe("review");
    expect(
      evaluatePolicy({
        kind: "move",
        occasion: "on_save",
        confidence: 0.5 - 1e-9,
      }),
    ).toBe("unsure");
  });

  it("misfiled scan reviews at ≥ 0.5 and never pre-selects or auto-applies", () => {
    for (const confidence of [0.5, 0.7, 0.85, 1]) {
      expect(
        evaluatePolicy({
          kind: "move",
          occasion: "misfiled_scan",
          confidence,
          settings: ON,
        }),
      ).toBe("review");
    }
    expect(
      evaluatePolicy({
        kind: "move",
        occasion: "misfiled_scan",
        confidence: 0.5 - 1e-9,
      }),
    ).toBe("unsure");
  });
});

describe("never-auto-apply kinds", () => {
  it.each(["merge_duplicates", "mark_dead", "rename"] as const)(
    "%s reviews at ≥ 0.5 and is unsure below, at any confidence",
    (kind) => {
      for (const confidence of [0.5, 0.7, 0.85, 1]) {
        expect(evaluatePolicy({ kind, confidence, settings: ON })).toBe(
          "review",
        );
      }
      expect(
        evaluatePolicy({ kind, confidence: 0.5 - 1e-9, settings: ON }),
      ).toBe("unsure");
    },
  );

  it("create_folder always lands in review, whatever the confidence", () => {
    for (const confidence of [0, 0.4, 0.5, 0.9, 1]) {
      expect(
        evaluatePolicy({ kind: "create_folder", confidence, settings: ON }),
      ).toBe("review");
    }
  });
});

describe("confidence input validation", () => {
  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws RangeError for confidence = %f outside [0, 1]",
    (confidence) => {
      expect(() => evaluatePolicy({ kind: "add_tags", confidence })).toThrow(
        RangeError,
      );
    },
  );
});

describe("isNoMatch (rerank bar)", () => {
  it("reports no match when every candidate probability is below the bar", () => {
    expect(isNoMatch([0.1, 0.3, 0.49])).toBe(true);
    expect(isNoMatch([0.1, 0.3, 0.5])).toBe(false); // 0.5 is not below the bar
    expect(isNoMatch([0.9])).toBe(false);
  });

  it("treats an empty candidate list as no match", () => {
    expect(isNoMatch([])).toBe(true);
  });

  it("accepts a custom bar", () => {
    expect(isNoMatch([0.5, 0.6], 0.7)).toBe(true);
    expect(isNoMatch([0.5, 0.6], 0.6)).toBe(false);
  });
});

describe("escalateToLlm stub", () => {
  it("resolves to 'unsure' until Phase 5 adds the LLM layer", async () => {
    await expect(escalateToLlm()).resolves.toBe("unsure");
  });
});

describe("DecisionSettings schema", () => {
  it("defaults every auto-apply toggle to off", () => {
    expect(DecisionSettings.parse({})).toEqual({
      autoApply: { add_tags: false, set_category: false },
    });
    expect(DecisionSettings.parse({ autoApply: {} })).toEqual({
      autoApply: { add_tags: false, set_category: false },
    });
  });

  it("parses partial toggle overrides", () => {
    expect(
      DecisionSettings.parse({ autoApply: { add_tags: true } }),
    ).toEqual({ autoApply: { add_tags: true, set_category: false } });
  });

  it.each([
    { autoApply: { delete_everything: true } },
    { autoApply: { move: true } }, // move has no auto-apply toggle at all
    { autoApply: { merge_duplicates: true } },
    { autoApply: { add_tags: true }, unknownTopLevel: 1 },
    { autoApply: { add_tags: "yes" } },
  ])("rejects unknown kinds and keys: %j", (bad) => {
    expect(DecisionSettings.safeParse(bad).success).toBe(false);
  });
});
