import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * spec FR9 — on-demand page extraction:
 *
 * - `activeTab` + `chrome.scripting`, injection only after an explicit
 *   action (the caller passes a tabId resolved inside a click handler);
 * - never incognito, never restricted/non-http URLs, never persisted DOM;
 * - Readability output treated as hostile and capped deterministically;
 * - every failure is a redacted typed refusal — the function is total.
 */

const TAB_URL = "https://a-site.com/article/one";

interface ChromeTabStub {
  id?: number;
  incognito?: boolean;
  url?: string;
}

let tabsGet: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;

function stubChrome(tab: ChromeTabStub, scriptResult: unknown): void {
  tabsGet = vi.fn(async () => tab);
  executeScript = vi.fn(async () => [{ result: scriptResult }]);
  vi.stubGlobal("chrome", {
    tabs: { get: tabsGet },
    scripting: { executeScript },
    runtime: { getURL: (p: string) => `chrome-extension://testext/${p}` },
  });
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const GOOD_RESULT = {
  title: "An article",
  excerpt: "A bounded page excerpt.",
  description: "meta description",
  siteName: "a-site",
  byline: "Author",
  headings: ["Intro", "Body"],
};

describe("extractActivePage", () => {
  it("extracts a bounded page representation for an http(s) tab", async () => {
    const { extractActivePage } = await import(
      "../../src/extract/page"
    );
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, GOOD_RESULT);
    const result = await extractActivePage(7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.extract.title).toBe("An article");
    expect(result.extract.excerpt).toBe("A bounded page excerpt.");
    expect(result.extract.headings).toEqual(["Intro", "Body"]);
    expect(result.extract.url).toBe(TAB_URL);
    // Injection targeted the tab through the bundled unlisted script —
    // never a caller-supplied function, never a content script in the
    // manifest.
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        files: [expect.stringMatching(/extract/)],
      }),
    );
    const arg = executeScript.mock.calls[0]?.[0] as { func?: unknown };
    expect(arg.func).toBeUndefined();
  });

  it("refuses incognito tabs before touching scripting", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: true, url: TAB_URL }, GOOD_RESULT);
    const result = await extractActivePage(7);
    expect(result).toEqual({
      ok: false,
      code: "incognito",
      message: expect.any(String),
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it.each([
    "chrome://extensions/",
    "chrome-extension://otherext/page.html",
    "file:///home/user/secret.pdf",
    "about:blank",
    "chrome.google.com/webstore",
  ])("refuses restricted or non-http URLs (%s)", async (url) => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url }, GOOD_RESULT);
    const result = await extractActivePage(7);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("restricted_url");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("refuses a tab with no readable URL", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: undefined }, GOOD_RESULT);
    const result = await extractActivePage(7);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("restricted_url");
  });

  it("reports a missing tab without throwing", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    tabsGet = vi.fn(async () => {
      throw new Error("No tab with id: 7");
    });
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { get: tabsGet },
      scripting: { executeScript },
      runtime: { getURL: (p: string) => `chrome-extension://testext/${p}` },
    });
    const result = await extractActivePage(7);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(["no_tab", "unavailable"]).toContain(result.code);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("reports injection failure without throwing", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, null);
    executeScript.mockRejectedValue(new Error("Cannot access contents"));
    const result = await extractActivePage(7);
    expect(result).toEqual({
      ok: false,
      code: "injection",
      message: expect.any(String),
    });
  });

  it("rejects a missing or malformed script result", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, undefined);
    const result = await extractActivePage(7);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("empty");
    // Same for a result with junk shape.
    executeScript.mockResolvedValue([{ result: { nope: 1 } }]);
    const again = await extractActivePage(7);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.code).toBe("empty");
  });

  it("caps every field deterministically — title, excerpt, headings", async () => {
    const { extractActivePage, PAGE_EXTRACT_LIMITS } = await import(
      "../../src/extract/page"
    );
    stubChrome(
      { id: 7, incognito: false, url: TAB_URL },
      {
        title: "x".repeat(PAGE_EXTRACT_LIMITS.title + 50),
        excerpt: "y".repeat(PAGE_EXTRACT_LIMITS.excerpt + 100),
        description: "z".repeat(PAGE_EXTRACT_LIMITS.description + 10),
        siteName: "s".repeat(PAGE_EXTRACT_LIMITS.siteName + 5),
        headings: Array.from(
          { length: PAGE_EXTRACT_LIMITS.headings + 10 },
          () => "h".repeat(PAGE_EXTRACT_LIMITS.heading + 20),
        ),
      },
    );
    const result = await extractActivePage(7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.extract.title.length).toBeLessThanOrEqual(
      PAGE_EXTRACT_LIMITS.title,
    );
    expect(result.extract.excerpt.length).toBeLessThanOrEqual(
      PAGE_EXTRACT_LIMITS.excerpt,
    );
    expect(result.extract.description?.length).toBeLessThanOrEqual(
      PAGE_EXTRACT_LIMITS.description,
    );
    expect(result.extract.headings.length).toBeLessThanOrEqual(
      PAGE_EXTRACT_LIMITS.headings,
    );
    for (const h of result.extract.headings) {
      expect(h.length).toBeLessThanOrEqual(PAGE_EXTRACT_LIMITS.heading);
    }
  });

  it("returns only bounded strings — no DOM nodes, no unlisted keys", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, GOOD_RESULT);
    const result = await extractActivePage(7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.extract).sort()).toEqual(
      [
        "byline",
        "description",
        "excerpt",
        "headings",
        "siteName",
        "title",
        "url",
      ].sort(),
    );
    for (const [key, value] of Object.entries(result.extract)) {
      if (key === "headings") {
        expect(Array.isArray(value)).toBe(true);
      } else {
        expect(typeof value).toBe("string");
      }
    }
  });
});

/** A fresh detached Document per test — the vitest env is jsdom, so
 * `document.implementation.createHTMLDocument` stands in for the page the
 * injected script would see. */
function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument("");
  doc.documentElement.innerHTML = html;
  return doc;
}

describe("runReadabilityExtract", () => {
  it("derives a page representation through Readability on hostile markup", async () => {
    const { runReadabilityExtract } = await import(
      "../../src/extract/readability"
    );
    const out = runReadabilityExtract(
      makeDoc(
        `<head><title>T</title><meta name="description" content="d">
         </head><body><article><h1>Title H1</h1><h2>Section</h2>
         <p>Readable body content long enough for the parser to keep.</p>
         <p>Second paragraph with more words for Readability to score.</p>
         </article><script>steal()</script></body>`,
      ),
    );
    expect(out).not.toBeNull();
    expect(out?.title).toBeTruthy();
    expect(out?.excerpt).toContain("Readable body content");
    // Script bodies never leak into the excerpt.
    expect(out?.excerpt).not.toContain("steal");
    expect(out?.headings.join(" ")).toContain("Section");
  });

  it("returns null when Readability cannot parse the page", async () => {
    const { runReadabilityExtract } = await import(
      "../../src/extract/readability"
    );
    expect(runReadabilityExtract(makeDoc("<body></body>"))).toBeNull();
  });

  it("tolerates a null article without throwing", async () => {
    const { runReadabilityExtract } = await import(
      "../../src/extract/readability"
    );
    expect(() =>
      runReadabilityExtract(makeDoc("<body><div></div></body>")),
    ).not.toThrow();
  });
});
