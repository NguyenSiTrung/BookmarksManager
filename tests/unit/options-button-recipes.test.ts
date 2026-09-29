import { describe, expect, it } from "vitest";
import {
  dangerButtonClass,
  ghostDangerButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
} from "../../src/entrypoints/options/ui";

/**
 * Disabled-state contract (options-popup plan Task 1): a disabled button is
 * visibly disabled — not-allowed cursor, dimmed, desaturated, no shadow —
 * and keeps receiving pointer events so the cursor (and future tooltips)
 * can work. `pointer-events-none` is the bug this pins against.
 */
const DISABLED_TOKENS = [
  "disabled:cursor-not-allowed",
  "disabled:opacity-60",
  "disabled:shadow-none",
  "disabled:saturate-50",
] as const;

describe("options button recipes", () => {
  for (const [name, className] of [
    ["primaryButtonClass", primaryButtonClass],
    ["dangerButtonClass", dangerButtonClass],
    ["secondaryButtonClass", secondaryButtonClass],
    ["ghostDangerButtonClass", ghostDangerButtonClass],
    ["smallButtonClass", smallButtonClass],
  ] as const) {
    it(`${name} renders disabled buttons visibly disabled`, () => {
      for (const token of DISABLED_TOKENS) {
        expect(className).toContain(token);
      }
      expect(className).not.toContain("pointer-events-none");
    });
  }
});
