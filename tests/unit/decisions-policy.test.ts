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
import {
  RELEASE_JEV_MODELS,
  RELEASE_THRESHOLDS,
} from "../../src/decisions/release-policy";
import {
  DEFAULT_PROVIDER_MODEL,
  PRESET_MODELS,
} from "../../src/schemas/provider";
import {
  isMovingAlias,
  MOVING_MODEL_ALIASES,
} from "../../src/net/provider-info";

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
  it("add_tags/set_category auto-applies at ≥ 0.85 only when its toggle is on", () => {
    for (const kind of ["add_tags", "set_category"] as const) {
      expect(evaluatePolicy({ kind, confidence: 0.85, settings: ON }), kind).toBe(
        "auto_apply",
      );
      expect(evaluatePolicy({ kind, confidence: 1, settings: ON }), kind).toBe(
        "auto_apply",
      );
      // Inclusive lower edge: exactly 0.85 applies, anything below reviews.
      expect(
        evaluatePolicy({ kind, confidence: 0.85 - 1e-9, settings: ON }),
        kind,
      ).toBe("review");
    }
  });

  it("add_tags/set_category lands in review for [0.5, 0.85) and is unsure below 0.5", () => {
    for (const kind of ["add_tags", "set_category"] as const) {
      expect(evaluatePolicy({ kind, confidence: 0.5, settings: ON }), kind).toBe(
        "review",
      );
      expect(evaluatePolicy({ kind, confidence: 0.7, settings: ON }), kind).toBe(
        "review",
      );
      expect(
        evaluatePolicy({ kind, confidence: 0.5 - 1e-9, settings: ON }),
        kind,
      ).toBe("unsure");
      expect(evaluatePolicy({ kind, confidence: 0, settings: ON }), kind).toBe(
        "unsure",
      );
    }
  });

  it("add_tags/set_category never auto-applies while its toggle is off, even at 1.0", () => {
    for (const kind of ["add_tags", "set_category"] as const) {
      const off = DecisionSettings.parse({});
      for (const confidence of [0.85, 0.9, 0.99, 1]) {
        expect(evaluatePolicy({ kind, confidence, settings: off }), kind).toBe(
          "review",
        );
        expect(evaluatePolicy({ kind, confidence }), kind).toBe("review");
      }
    }
  });

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
  it("merge_duplicates/mark_dead/rename review at ≥ 0.5 and are unsure below, at any confidence", () => {
    for (const kind of ["merge_duplicates", "mark_dead", "rename"] as const) {
      for (const confidence of [0.5, 0.7, 0.85, 1]) {
        expect(evaluatePolicy({ kind, confidence, settings: ON }), kind).toBe(
          "review",
        );
      }
      expect(
        evaluatePolicy({ kind, confidence: 0.5 - 1e-9, settings: ON }),
        kind,
      ).toBe("unsure");
    }
  });

  it("create_folder always lands in review, whatever the confidence", () => {
    for (const confidence of [0, 0.4, 0.5, 0.9, 1]) {
      expect(
        evaluatePolicy({ kind: "create_folder", confidence, settings: ON }),
      ).toBe("review");
    }
  });
});

describe("confidence input validation", () => {
  it("reports out-of-range or NaN confidence as unsure, never throwing (J07)", () => {
    for (const confidence of [
      -0.1,
      1.1,
      1.4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      // Every kind, toggles on or off: an unusable confidence is the
      // always-human band, never a throw, never auto-apply.
      for (const kind of [
        "add_tags",
        "set_category",
        "merge_duplicates",
        "mark_dead",
        "rename",
        "create_folder",
      ] as const) {
        expect(
          evaluatePolicy({ kind, confidence }),
          `kind=${kind} confidence=${confidence}`,
        ).toBe("unsure");
      }
      expect(
        evaluatePolicy({ kind: "move", occasion: "on_save", confidence }),
        `move/on_save confidence=${confidence}`,
      ).toBe("unsure");
      expect(
        evaluatePolicy({
          kind: "move",
          occasion: "misfiled_scan",
          confidence,
        }),
        `move/misfiled_scan confidence=${confidence}`,
      ).toBe("unsure");
    }
  });
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

  it("rejects unknown kinds and keys", () => {
    for (const bad of [
      { autoApply: { delete_everything: true } },
      { autoApply: { move: true } }, // move has no auto-apply toggle at all
      { autoApply: { merge_duplicates: true } },
      { autoApply: { add_tags: true }, unknownTopLevel: 1 },
      { autoApply: { add_tags: "yes" } },
    ]) {
      expect(DecisionSettings.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("release policy pins (Phase 6 Task 4)", () => {
  it("RELEASE_JEV_MODELS owns a fixed request id and response ids per preset", () => {
    expect(RELEASE_JEV_MODELS.typesafe.request).toBe("jev-1.13.0");
    expect(RELEASE_JEV_MODELS.openrouter.request).toBe("typesafe/jev-1.13");
    for (const preset of ["typesafe", "openrouter"] as const) {
      const { request, responseIds } = RELEASE_JEV_MODELS[preset];
      // The request id is selectable — it must be on the preset's allowlist.
      expect(PRESET_MODELS[preset]).toContain(request);
      expect(responseIds).toContain(request);
      for (const id of responseIds) {
        // Every accepted response id is allowlisted and pinned — a moving
        // alias can never satisfy a release-model check.
        expect(PRESET_MODELS[preset]).toContain(id);
        expect(MOVING_MODEL_ALIASES[preset]).not.toContain(id);
      }
    }
  });

  it("RELEASE_THRESHOLDS owns every confidence bar the policy uses", () => {
    expect(RELEASE_THRESHOLDS.reviewFloor).toBe(REVIEW_FLOOR);
    expect(RELEASE_THRESHOLDS.movePreselect).toBe(MOVE_PRESELECT_THRESHOLD);
    expect(RELEASE_THRESHOLDS.autoApply).toBe(AUTO_APPLY_THRESHOLD);
    expect(RELEASE_THRESHOLDS.rerankNoMatchBar).toBe(RERANK_NO_MATCH_BAR);
    expect(RELEASE_THRESHOLDS.tagSelect).toBe(0.5);
  });

  it("defaults each preset's model to the pinned release id, not an alias", () => {
    for (const preset of ["typesafe", "openrouter"] as const) {
      expect(DEFAULT_PROVIDER_MODEL[preset]).toBe(
        RELEASE_JEV_MODELS[preset].request,
      );
      expect(isMovingAlias(preset, DEFAULT_PROVIDER_MODEL[preset])).toBe(
        false,
      );
    }
  });

  it("never auto-applies move, merge, or housekeeping kinds even at 1.0", () => {
    const on = DecisionSettings.parse({
      autoApply: { add_tags: true, set_category: true },
    });
    const band = RELEASE_THRESHOLDS.autoApply;
    expect(band).toBeGreaterThan(0);
    for (const kind of [
      "mark_dead",
      "merge_duplicates",
      "rename",
      "create_folder",
    ] as const) {
      for (const confidence of [band, 1]) {
        expect(
          evaluatePolicy({ kind, confidence, settings: on }),
        ).not.toBe("auto_apply");
      }
    }
    for (const occasion of ["on_save", "misfiled_scan"] as const) {
      expect(
        evaluatePolicy({
          kind: "move",
          occasion,
          confidence: 1,
          settings: on,
        }),
      ).not.toBe("auto_apply");
    }
  });
});
