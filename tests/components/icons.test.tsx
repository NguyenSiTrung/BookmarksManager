import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as icons from "../../src/ui/components/icons";

/**
 * The Options icon set is decorative-only: every export must render an svg
 * that is hidden from assistive technology and unfocusable, so the host
 * control keeps sole ownership of the accessible name.
 */
describe("icons", () => {
  afterEach(cleanup);

  const exports = Object.entries(icons).filter(
    (entry): entry is [string, (props: { className?: string }) => React.ReactElement] =>
      typeof entry[1] === "function",
  );

  it("exports a non-empty icon set", () => {
    expect(exports.length).toBeGreaterThanOrEqual(12);
  });

  it.each(exports.map(([name]) => name))(
    "%s renders an aria-hidden, unfocusable svg",
    (name) => {
      const Icon = icons[name as keyof typeof icons];
      const { container } = render(<Icon />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("fill")).toBe("none");
      expect(svg?.getAttribute("stroke-width")).toBe("2");
    },
  );

  it("honors a className override for sizing", () => {
    const Icon = icons.CheckIcon;
    const { container } = render(<Icon className="size-6 text-primary" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("size-6");
  });
});
