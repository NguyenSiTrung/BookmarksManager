import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("../../src/ui/styles.css", import.meta.url),
  "utf8",
);

/** Every `:root { … }` block, including the one inside the dark media query. */
const rootBlocks = [...css.matchAll(/^\s*:root\s*\{([^}]*)\}/gm)].map(
  (match) => match[1] ?? "",
);

describe("global theme", () => {
  it("defines the teal primary and warm background on :root", () => {
    const all = rootBlocks.join("\n");
    expect(all).toContain("--primary: oklch(0.52 0.11 198)");
    expect(all).toContain("--background: oklch(0.975 0.004 90)");
  });

  it("has a dark-mode :root carrying the teal primary", () => {
    expect(rootBlocks.join("\n")).toContain("--primary: oklch(0.76 0.11 190)");
  });

  it("no longer scopes color tokens to .popup-root / .options-root", () => {
    expect(css).not.toMatch(/\.(options|popup)-root[^{]*\{[^}]*--background/);
  });

  it("defines the row tokens and exposes them as utilities", () => {
    expect(css).toContain("--row-hover:");
    expect(css).toContain("--row-selected:");
    expect(css).toContain("--color-row-hover: var(--row-hover)");
    expect(css).toContain("--color-row-selected: var(--row-selected)");
  });

  it("uses the standard font theme names", () => {
    expect(css).toContain('--font-sans: "Geist"');
    expect(css).toContain('--font-mono: "Geist Mono"');
    expect(css).not.toContain("font-options");
  });
});
