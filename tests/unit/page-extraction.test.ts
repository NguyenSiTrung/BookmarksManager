// @vitest-environment jsdom
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
  url: TAB_URL,
  documentIdentity: 1000,
  title: "An article",
  excerpt: "A bounded page excerpt.",
  description: "meta description",
  siteName: "a-site",
  byline: "Author",
  headings: ["Intro", "Body"],
};

describe("extractActivePage", () => {
  it("refuses navigation after tabs.get but before the injected result returns", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, GOOD_RESULT);
    executeScript.mockImplementationOnce(async () => {
      tabsGet.mockResolvedValue({ id: 7, incognito: false, url: "https://other-site.dev/private" });
      return [{ result: GOOD_RESULT }];
    });
    expect(await extractActivePage(7)).toMatchObject({ ok: false, code: "mismatch" });
  });

  it("refuses a result without the injected document identity", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, {
      title: "An article", excerpt: "Readable text", headings: [],
    });
    expect(await extractActivePage(7)).toMatchObject({ ok: false, code: "empty" });
  });

  it.each([
    ["title", "x".repeat(301)],
    ["excerpt", "x".repeat(20_001)],
    ["description", "x".repeat(1_001)],
    ["siteName", "x".repeat(201)],
    ["byline", "x".repeat(201)],
    ["headings", ["x".repeat(201)]],
    ["headings", Array.from({ length: 51 }, () => "Heading")],
  ])("rejects an oversized injected %s before accepting it", async (field, value) => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, { ...GOOD_RESULT, [field]: value });
    expect(await extractActivePage(7)).toMatchObject({ ok: false, code: "empty" });
  });

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

  it("keeps Chrome document identity local and pins content-free rechecks to it", async () => {
    const { extractActivePage, verifyExtractedDocument } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, GOOD_RESULT);
    executeScript.mockResolvedValue([{ result: GOOD_RESULT, frameId: 0, documentId: "synthetic-document-id" }]);
    const result = await extractActivePage(7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extract.documentId).toBe("synthetic-document-id");
    expect(result.extract.documentIdentity).toBe(1000);
    expect(await verifyExtractedDocument(7, result.extract)).toEqual({ ok: true });
    expect(executeScript).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { tabId: 7, documentIds: ["synthetic-document-id"] },
      func: expect.any(Function),
    }));
    executeScript.mockResolvedValue([{ result: GOOD_RESULT, frameId: 0, documentId: "replacement-document" }]);
    expect(await verifyExtractedDocument(7, result.extract)).toMatchObject({ ok: false, code: "mismatch" });
  });

  it("refuses subframe results and a pending navigation without accepting page text", async () => {
    const { extractActivePage } = await import("../../src/extract/page");
    stubChrome({ id: 7, incognito: false, url: TAB_URL }, GOOD_RESULT);
    executeScript.mockResolvedValue([{ result: GOOD_RESULT, frameId: 3 }]);
    expect(await extractActivePage(7)).toMatchObject({ ok: false, code: "mismatch" });
    executeScript.mockResolvedValue([{ result: GOOD_RESULT, frameId: 0 }]);
    tabsGet.mockResolvedValue({ id: 7, url: TAB_URL, pendingUrl: "https://other-site.dev/private" });
    expect(await extractActivePage(7)).toMatchObject({ ok: false, code: "mismatch" });
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

  it("refuses restricted or non-http URLs", async () => {
    for (const url of [
      "chrome://extensions/",
      "chrome-extension://otherext/page.html",
      "file:///home/user/secret.pdf",
      "about:blank",
      "chrome.google.com/webstore",
    ]) {
      const { extractActivePage } = await import("../../src/extract/page");
      stubChrome({ id: 7, incognito: false, url }, GOOD_RESULT);
      const result = await extractActivePage(7);
      expect(result.ok, url).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code, url).toBe("restricted_url");
      expect(executeScript, url).not.toHaveBeenCalled();
    }
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

  it("admits fields exactly at the in-page size caps", async () => {
    const { extractActivePage, PAGE_EXTRACT_LIMITS } = await import(
      "../../src/extract/page"
    );
    stubChrome(
      { id: 7, incognito: false, url: TAB_URL },
      {
        url: TAB_URL,
        documentIdentity: 1000,
        title: "x".repeat(PAGE_EXTRACT_LIMITS.title),
        excerpt: "y".repeat(PAGE_EXTRACT_LIMITS.excerpt),
        description: "z".repeat(PAGE_EXTRACT_LIMITS.description),
        siteName: "s".repeat(PAGE_EXTRACT_LIMITS.siteName),
        headings: Array.from(
          { length: PAGE_EXTRACT_LIMITS.headings },
          () => "h".repeat(PAGE_EXTRACT_LIMITS.heading),
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
        "documentIdentity",
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
      } else if (key === "documentIdentity") {
        expect(typeof value).toBe("number");
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
  it("caps a multi-megabyte article in the page before crossing the worker boundary", async () => {
    const { runReadabilityExtract } = await import("../../src/extract/readability");
    const { PAGE_EXTRACT_LIMITS } = await import("../../src/extract/page");
    const doc = makeDoc(`<head><title>${"T".repeat(600)}</title>
      <meta name="description" content="${"D".repeat(2_000)}">
      <meta property="og:site_name" content="${"S".repeat(400)}"></head>
      <body><article>${Array.from({ length: 60 }, () => `<h2>${"H".repeat(400)}</h2>`).join("")}
      <p>${"Readable article content. ".repeat(100_000)}</p></article></body>`);
    const out = runReadabilityExtract(doc);
    expect(out).not.toBeNull();
    expect(out?.excerpt.length).toBeLessThanOrEqual(PAGE_EXTRACT_LIMITS.excerpt);
    expect(out?.title.length).toBeLessThanOrEqual(PAGE_EXTRACT_LIMITS.title);
    expect(out?.description?.length).toBeLessThanOrEqual(PAGE_EXTRACT_LIMITS.description);
    expect(out?.siteName?.length).toBeLessThanOrEqual(PAGE_EXTRACT_LIMITS.siteName);
    expect(out?.headings.length).toBeLessThanOrEqual(PAGE_EXTRACT_LIMITS.headings);
    expect(out?.headings.every((heading) => heading.length <= PAGE_EXTRACT_LIMITS.heading)).toBe(true);
  }, 20_000);

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
