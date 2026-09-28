import type { PresetId } from "../schemas/provider";

/**
 * Release-pinned Jev policy — Phase 6 (store-readiness track). Two frozen
 * records back the 1.0 trusted-tester build:
 *
 * - {@link RELEASE_JEV_MODELS} pins the exact Jev model identifiers the
 *   release is validated against. `request` is the id sent to the provider;
 *   `responseIds` are the only ids the eval harness accepts back (the Jev
 *   client only checks cross-batch consistency, so pinning is enforced by
 *   callers). No moving alias ever appears here — an alias that re-resolves
 *   silently to a newer model would invalidate the tuned thresholds.
 * - {@link RELEASE_THRESHOLDS} owns every confidence bar the decision
 *   policy uses. The values are the §10.2 defaults, retained because the
 *   1.13-baseline evidence is still being gathered (see
 *   `store/evals/jev-1.13-baseline.md`) — where evidence is insufficient the
 *   safer current value stays, and the uncertainty is recorded in the
 *   baseline document rather than guessed.
 *
 * Pure constants: no `chrome`, DOM, React, or I/O. `src/decisions/policy.ts`
 * re-exports the bars under their §10.2 names so existing call sites keep a
 * stable vocabulary; `src/schemas/provider.ts` derives the default picker
 * model from `RELEASE_JEV_MODELS` so the UI defaults to a pinned id.
 */

/** The pinned Jev 1.13 identifiers per preset. */
export const RELEASE_JEV_MODELS = Object.freeze({
  typesafe: Object.freeze({
    request: "jev-1.13.0",
    responseIds: Object.freeze(["jev-1.13.0"]),
  }),
  openrouter: Object.freeze({
    request: "typesafe/jev-1.13",
    responseIds: Object.freeze(["typesafe/jev-1.13"]),
  }),
} as const) satisfies Readonly<
  Record<PresetId, Readonly<{ request: string; responseIds: readonly string[] }>>
>;

/** Every confidence bar used by the decision policy, eval, and UI. */
export const RELEASE_THRESHOLDS = Object.freeze({
  /** Below this confidence every kind except `create_folder` is `unsure`. */
  reviewFloor: 0.5,
  /** `move` on save pre-selects the folder at or above this confidence. */
  movePreselect: 0.7,
  /** `add_tags`/`set_category` auto-apply at or above this confidence while
   * their per-kind toggle is on. */
  autoApply: 0.85,
  /** Below this best-candidate probability the rerank UI reports "no
   * match". */
  rerankNoMatchBar: 0.5,
  /** A tag noul selects at or above this probability. */
  tagSelect: 0.5,
} as const);

export type ReleaseThresholds = typeof RELEASE_THRESHOLDS;
