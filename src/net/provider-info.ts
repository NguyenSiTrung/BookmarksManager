import type { PresetId } from "../schemas/provider";

/**
 * Provider/model metadata for the Options UI (PROJECT_PLAN.md §8.5 step 6,
 * spec FR7). Constants only — like `presets.ts`, this module holds frozen
 * data about the permitted destinations and performs no I/O itself.
 */

/**
 * Model ids that re-resolve to a newer Jev version without an id change —
 * "moving" aliases. Keyed by preset because each provider publishes its own
 * alias set: TypeSafe's allowlist has two moving ids (`jev-latest`,
 * `jev-preview`); OpenRouter's has one (`jev-latest`). Every alias listed
 * must come from the owning preset's `PRESET_MODELS` allowlist — the ids not
 * listed here are pinned to one model version and never move. Deeply frozen
 * like the preset registry; callers must never mutate entries.
 */
export const MOVING_MODEL_ALIASES = Object.freeze({
  typesafe: Object.freeze(["jev-latest", "jev-preview"]),
  openrouter: Object.freeze(["jev-latest"]),
} as const) satisfies Readonly<Record<PresetId, readonly string[]>>;

/**
 * Warning shown under the Options model picker while a moving alias is
 * selected (spec FR7). Rendered immediately after the pinned
 * `<code>{model}</code>` id, so it reads "<model> is a moving alias …".
 * The point is the carry-over risk: decision thresholds tuned against one
 * resolved model version may not hold when the alias silently moves to a
 * newer one.
 */
export const MOVING_ALIAS_WARNING =
  "is a moving alias that may resolve to a newer Jev model version without notice — decision thresholds tuned on one version may not carry over. Choose a pinned version id for stable behavior.";

/**
 * Whether `model` is a moving alias under `preset`. The caller already holds
 * a validated `PresetId` (component state), so membership is a plain lookup
 * in the frozen registry — no schema parse is needed here.
 */
export function isMovingAlias(preset: PresetId, model: string): boolean {
  return MOVING_MODEL_ALIASES[preset].some((alias) => alias === model);
}
