import { describe, expect, it } from "vitest";
import { isBlockedScheme } from "../../src/io/netscape";
import {
  isOpenableUrl,
  OPENABLE_URL_SCHEMES,
  urlScheme,
} from "../../src/search/openable";

/**
 * Coverage for the shared scheme policy (D15): ONE normalization (all C0
 * controls + space stripped before the scheme is read) serves both the
 * open guard (`isOpenableUrl` — allowlist `http`/`https`/`mailto`/`ftp`)
 * and the import guard (`isBlockedScheme` — `javascript:`/`data:`/
 * `vbscript:` skipped). The fixture table below is asserted against BOTH
 * guards so a spelling can't slip the fence: every import-blocked URL is
 * never openable, and only allowlisted schemes are ever openable.
 */

/** {url, openable, importBlocked} — the shared fixture table. */
const SCHEME_FIXTURES: {
  url: string;
  openable: boolean;
  importBlocked: boolean;
}[] = [
  // Allowlisted → openable, never import-blocked.
  { url: "https://example.com/", openable: true, importBlocked: false },
  { url: "http://example.com/path?q=1#f", openable: true, importBlocked: false },
  { url: "HTTPS://EXAMPLE.COM/", openable: true, importBlocked: false },
  { url: "mailto:user@example.com", openable: true, importBlocked: false },
  { url: "ftp://ftp.example.com/file", openable: true, importBlocked: false },
  { url: "  https://example.com/  ", openable: true, importBlocked: false },
  // Script sinks → import-blocked AND not openable.
  { url: "javascript:alert(1)", openable: false, importBlocked: true },
  { url: "JAVASCRIPT:alert(1)", openable: false, importBlocked: true },
  { url: "vbscript:msgbox(1)", openable: false, importBlocked: true },
  { url: "data:text/html,<h1>x</h1>", openable: false, importBlocked: true },
  // Obfuscated blocked schemes → still caught on BOTH guards.
  { url: "\x01javascript:alert(1)", openable: false, importBlocked: true },
  { url: "java\tscript:alert(1)", openable: false, importBlocked: true },
  { url: "java script:alert(1)", openable: false, importBlocked: true },
  { url: "javascript :alert(1)", openable: false, importBlocked: true },
  { url: " javascript:alert(1)", openable: false, importBlocked: true },
  { url: "\u00a0javascript:alert(1)", openable: false, importBlocked: false },
  // Non-allowlisted but import-legal → listed, never openable.
  { url: "blob:https://x/1", openable: false, importBlocked: false },
  { url: "view-source:https://x/", openable: false, importBlocked: false },
  { url: "file:///home/user/doc.html", openable: false, importBlocked: false },
  { url: "tel:+15551234567", openable: false, importBlocked: false },
  { url: "about:blank", openable: false, importBlocked: false },
  { url: "chrome://extensions", openable: false, importBlocked: false },
  { url: "chrome-extension://abc/options.html", openable: false, importBlocked: false },
  // Schemeless / unregistered → import-legal, never openable.
  { url: "/relative/path", openable: false, importBlocked: false },
  { url: "page.html", openable: false, importBlocked: false },
  { url: "?query=1", openable: false, importBlocked: false },
  { url: "#fragment", openable: false, importBlocked: false },
  { url: "javascriptx:alert(1)", openable: false, importBlocked: false },
  { url: "xjavascript:alert(1)", openable: false, importBlocked: false },
  { url: "datax:text/plain,hi", openable: false, importBlocked: false },
  // Blank → neither.
  { url: "", openable: false, importBlocked: false },
  { url: "   ", openable: false, importBlocked: false },
  { url: "\t\n", openable: false, importBlocked: false },
];

describe("isOpenableUrl — shared fixture table (D15)", () => {
  it("agrees with the import guard on every fixture row", () => {
    for (const { url, openable, importBlocked } of SCHEME_FIXTURES) {
      expect(isOpenableUrl(url), `isOpenableUrl(${JSON.stringify(url)})`).toBe(
        openable,
      );
      expect(
        isBlockedScheme(url),
        `isBlockedScheme(${JSON.stringify(url)})`,
      ).toBe(importBlocked);
      // The invariant, not just the table: import-blocked ⇒ never openable.
      if (importBlocked) expect(isOpenableUrl(url)).toBe(false);
      // And openable ⇒ never import-blocked.
      if (openable) expect(isBlockedScheme(url)).toBe(false);
    }
  });

  it("allowlists exactly http, https, mailto, ftp", () => {
    expect([...OPENABLE_URL_SCHEMES].sort()).toEqual([
      "ftp",
      "http",
      "https",
      "mailto",
    ]);
  });
});

describe("urlScheme — the shared normalizer", () => {
  it("strips all C0 controls and space before reading the scheme", () => {
    expect(urlScheme("\x00\x01java\tscript:alert(1)")).toBe("javascript");
    expect(urlScheme("java script:alert(1)")).toBe("javascript");
    expect(urlScheme("  HTTPS://x/")).toBe("https");
    expect(urlScheme("javascript :x")).toBe("javascript");
  });

  it("returns undefined for schemeless input", () => {
    for (const url of ["", "   ", "/path", "page.html", "?q", "#f", "java script x"]) {
      expect(urlScheme(url), url).toBeUndefined();
    }
  });
});

describe("isOpenableUrl — guard edges", () => {
  it("rejects near-miss openable spellings", () => {
    for (const url of [
      "httpss://example.com/",
      "htt p://example.com/", // space stripped → "http" — actually openable
      "ftp2://x/",
      "mailto2:user@x.com",
    ]) {
      // "htt p:" normalizes to "http:" and IS allowed; the rest are not.
      expect(isOpenableUrl(url)).toBe(url === "htt p://example.com/");
    }
  });
});
