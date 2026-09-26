import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Favicon } from "../../src/ui/components/favicon";

/**
 * The favicon component loads Chrome's built-in `chrome-extension://<id>/
 * _favicon/?pageUrl=...&size=...` renderer (MV3 `favicon` permission — no
 * host access, no network from our code). `chrome.runtime.getURL` is the
 * only chrome surface it touches, stubbed here per the house lazy-slice
 * pattern (resolved at call time, so `vi.stubGlobal` works).
 */
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => cleanup());
afterAll(() => vi.unstubAllGlobals());

let getURLSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getURLSpy = vi.fn(
    (path: string) => `chrome-extension://test-extension-id/${path}`,
  );
  vi.stubGlobal("chrome", { runtime: { getURL: getURLSpy } });
});

function renderFavicon(props?: { size?: number; className?: string }) {
  const utils = render(
    <Favicon pageUrl="https://example.com/a?x=1&y=2" {...props} />,
  );
  return utils.container.querySelector("img") as HTMLImageElement;
}

describe("Favicon src", () => {
  it("builds the _favicon URL from chrome.runtime.getURL(\"_favicon/\")", () => {
    const img = renderFavicon();
    expect(getURLSpy).toHaveBeenCalledWith("_favicon/");
    expect(img.src).toMatch(
      /^chrome-extension:\/\/test-extension-id\/_favicon\/\?/,
    );
  });

  it("URL-encodes pageUrl and passes size, defaulting to 32", () => {
    const img = renderFavicon();
    const [, query] = img.src.split("?");
    const params = new URLSearchParams(query);
    expect(params.get("pageUrl")).toBe("https://example.com/a?x=1&y=2");
    expect(params.get("size")).toBe("32");
    // The raw query must carry the encoded form, not the literal URL.
    expect(query).toContain(
      `pageUrl=${encodeURIComponent("https://example.com/a?x=1&y=2")}`,
    );
  });

  it("honours an explicit size", () => {
    const img = renderFavicon({ size: 16 });
    const [, query] = img.src.split("?");
    expect(new URLSearchParams(query).get("size")).toBe("16");
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);
  });
});

describe("Favicon fallback", () => {
  it("swaps to a placeholder when the img errors", () => {
    const img = renderFavicon();
    fireEvent.error(img);
    expect(screen.getByRole("img", { name: /favicon/i })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });

  it("retries the img when pageUrl changes after an error", () => {
    const { container, rerender } = render(
      <Favicon pageUrl="https://example.com" />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();

    rerender(<Favicon pageUrl="https://other.example" />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain(encodeURIComponent("https://other.example"));
  });
});
