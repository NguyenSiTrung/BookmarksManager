import type { Answer } from "./wire";

/**
 * Per-answer confidence reading — PROJECT_PLAN.md §10.1. `choice` and
 * `score` answers arrive with a calibrated `confidence` field the API
 * derives from the probability distribution; `noul` answers carry only the
 * probability `p`, so their confidence is the margin: how far `p` sits from
 * the decision threshold `t`, normalized to [0, 1] on whichever side it
 * falls. The §10.2 bands and actions that consume these values are out of
 * scope for this module.
 */

/**
 * The normalized margin of a noul probability `p` from threshold `t`
 * (default 0.5), using Pydantic AI's formula: `(p − t) / (1 − t)` when
 * `p ≥ t`, `(t − p) / t` when `p < t`. The result is 0 at `p === t` and 1
 * when `p` is 0 or 1.
 *
 * @throws {RangeError} unless `0 ≤ p ≤ 1` and `0 < t < 1` — NaN is rejected
 *   for both, and infinities fail the same bounds.
 */
export function noulMargin(p: number, t = 0.5): number {
  if (Number.isNaN(p) || p < 0 || p > 1) {
    throw new RangeError(
      `noul probability must lie within [0, 1]; received ${p}`,
    );
  }
  if (Number.isNaN(t) || t <= 0 || t >= 1) {
    throw new RangeError(
      `noul threshold must lie within (0, 1); received ${t}`,
    );
  }
  return p >= t ? (p - t) / (1 - t) : (t - p) / t;
}

/**
 * The §10.1 confidence of a single answer. `choice` and `score` answers
 * return their `confidence` field untouched — `threshold` does not apply to
 * them and is never validated for them. `noul` answers return
 * `noulMargin(answer.noul, threshold)`, so an out-of-range or NaN threshold
 * surfaces as that function's `RangeError`.
 */
export function answerConfidence(answer: Answer, threshold?: number): number {
  if (answer.type === "noul") {
    return noulMargin(answer.noul, threshold);
  }
  return answer.confidence;
}
