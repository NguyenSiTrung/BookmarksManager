import { z } from "../schemas/z";
import type { Decision } from "../schemas/decision";
import { RELEASE_THRESHOLDS } from "./release-policy";

/**
 * Confidence policy — PROJECT_PLAN.md §10.2 / spec FR5. Given a decision
 * kind and a §10.1 confidence, this module reports what the extension may
 * do with it: auto-apply, pre-select, queue for review, or mark `unsure`.
 * Pure: no `chrome`, DOM, React, or `fetch`.
 */

/** Every decision kind the §7 schema can carry, including the kinds Phase 4
 * never emits (`mark_dead`, `rename`, `create_folder`). */
export type DecisionKind = Decision["kind"];

/** The two `move` occasions from §10.2, which use different bands:
 * `on_save` is the popup folder suggestion (pre-select allowed), while
 * `misfiled_scan` is the library scan (review only). */
export type PolicyOccasion = "on_save" | "misfiled_scan";

/** What the policy allows for one decision at one confidence. `auto_apply`
 * means the pipeline may apply without asking; `preselect` means the save
 * dialog may pre-fill the folder (the user still confirms); `review` puts
 * the decision in the review queue; `unsure` marks it `unsure` after the
 * escalation hook runs. */
export type PolicyOutcome = "auto_apply" | "preselect" | "review" | "unsure";

/** Below this confidence every kind except `create_folder` is `unsure`.
 * The value lives in {@link RELEASE_THRESHOLDS} — the release track owns
 * the bar; this name keeps the §10.2 vocabulary for existing call sites. */
export const REVIEW_FLOOR = RELEASE_THRESHOLDS.reviewFloor;
/** `move` on save pre-selects the folder at or above this confidence. */
export const MOVE_PRESELECT_THRESHOLD = RELEASE_THRESHOLDS.movePreselect;
/** `add_tags`/`set_category` auto-apply at or above this confidence, but
 * only while that kind's toggle is on. */
export const AUTO_APPLY_THRESHOLD = RELEASE_THRESHOLDS.autoApply;
/** When every rerank candidate probability falls below this bar the UI
 * reports "no match" instead of listing weak results. */
export const RERANK_NO_MATCH_BAR = RELEASE_THRESHOLDS.rerankNoMatchBar;

/**
 * Per-kind auto-apply toggles. Only `add_tags` and `set_category` can ever
 * auto-apply (§10.2), so they are the only keys — a toggle for any other
 * kind is meaningless and rejected as an unknown key. Both default off.
 */
export const AutoApplyToggles = z.strictObject({
  add_tags: z.boolean().default(false),
  set_category: z.boolean().default(false),
});
export type AutoApplyToggles = z.infer<typeof AutoApplyToggles>;

/**
 * Persisted decision policy settings. Closed (`strictObject`): unknown
 * kinds and unknown top-level keys are rejected. Persistence is wired by a
 * later task; `DecisionSettings.parse({})` yields all toggles off.
 */
export const DecisionSettings = z.strictObject({
  autoApply: AutoApplyToggles.default({
    add_tags: false,
    set_category: false,
  }),
});
export type DecisionSettings = z.infer<typeof DecisionSettings>;

/** One policy question. `occasion` is required for `kind: "move"` — the
 * on-save and misfiled-scan bands differ — and meaningless otherwise. */
export type PolicyInput =
  | {
      kind: "move";
      occasion: PolicyOccasion;
      confidence: number;
      settings?: DecisionSettings;
    }
  | {
      kind: Exclude<DecisionKind, "move">;
      confidence: number;
      settings?: DecisionSettings;
    };

function assertConfidence(confidence: number): void {
  if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError(
      `confidence must lie within [0, 1]; received ${confidence}`,
    );
  }
}

/**
 * The §10.2 outcome for `input`. Auto-apply requires both
 * `confidence ≥ AUTO_APPLY_THRESHOLD` and the kind's toggle to be on;
 * absent settings mean all toggles off. `move`/`merge_duplicates`,
 * `mark_dead`, `rename`, and `create_folder` never auto-apply at any
 * confidence; `create_folder` always lands in review.
 *
 * @throws {RangeError} unless `confidence` lies within [0, 1].
 */
export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { confidence } = input;
  assertConfidence(confidence);

  switch (input.kind) {
    case "add_tags":
    case "set_category": {
      const enabled = input.settings?.autoApply[input.kind] ?? false;
      if (enabled && confidence >= AUTO_APPLY_THRESHOLD) {
        return "auto_apply";
      }
      return confidence >= REVIEW_FLOOR ? "review" : "unsure";
    }
    case "move": {
      if (input.occasion === "on_save") {
        // Never auto-moves: the best it can do is pre-select the folder.
        if (confidence >= MOVE_PRESELECT_THRESHOLD) {
          return "preselect";
        }
        return confidence >= REVIEW_FLOOR ? "review" : "unsure";
      }
      // misfiled_scan: review only, never preselect, never auto-apply.
      return confidence >= REVIEW_FLOOR ? "review" : "unsure";
    }
    case "create_folder":
      // Structural suggestions always need a human (§10.2).
      return "review";
    case "merge_duplicates":
    case "mark_dead":
    case "rename":
      // Actions that move or alter data always require the user.
      return confidence >= REVIEW_FLOOR ? "review" : "unsure";
  }
}

/**
 * The rerank "no match" bar (§10.2 / FR5): true when every candidate
 * probability falls below `bar` — including an empty candidate list, which
 * is trivially all-below. A candidate exactly at the bar still counts as a
 * (weak) match.
 */
export function isNoMatch(
  candidateProbabilities: readonly number[],
  bar: number = RERANK_NO_MATCH_BAR,
): boolean {
  return candidateProbabilities.every((p) => p < bar);
}

/** The verdict Phase 5's LLM escalation layer will return; matches
 * `Decision.escalation.llmVerdict` in the §7 schema. */
export type EscalationVerdict = "agree" | "disagree" | "unsure";

/**
 * Low-band escalation hook. Phase 5 replaces this stub with the real LLM
 * layer; until then it always resolves to `unsure`, so a sub-floor
 * confidence can never be promoted by escalation. Promise-shaped so the
 * async Phase 5 implementation keeps this signature.
 */
export function escalateToLlm(): Promise<EscalationVerdict> {
  return Promise.resolve("unsure");
}
