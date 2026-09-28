import { describe, expect, it } from "vitest";
import { isOpenableUrl } from "../../src/search/openable";

/**
 * Coverage for the pure openable-URL guard. The denylist is fixed by spec
 * §5–§7: `javascript:` and `data:` bookmarks are indexed and listed but
 * their open actions are disabled on every surface. Everything else —
 * including schemes Chrome itself may refuse — stays openable here and
 * degrades to a typed `api` failure at the tabs boundary.
 */

describe("isOpenableUrl", () => {
  it("rejects blocked schemes across casing, whitespace, and internal delimiters", () => {
    const blocked = [
      "javascript:alert(1)",
      "javascript:",
      "data:text/html;base64,PGI+aGk8L2I+",
      "data:image/png;base64,iVBORw0KGgo=",
      "JAVASCRIPT:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "DATA:text/plain,hi",
      "Data:text/html,<h1>x</h1>",
      "  javascript:alert(1)",
      "\tjavascript:alert(1)",
      "\njavascript:alert(1)",
      "  DATA:text/plain,hi  ",
      "\u00a0javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java\r\nscript:alert(1)",
      "javascript\t:alert(1)",
    ];
    for (const url of blocked) {
      expect(isOpenableUrl(url)).toBe(false);
    }
  });

  it("rejects blank or whitespace-only inputs", () => {
    for (const url of ["", "   ", "\t\n"]) {
      expect(isOpenableUrl(url)).toBe(false);
    }
  });

  it("accepts valid schemes, relative URLs, and near-miss strings", () => {
    const openable = [
      "https://example.com/",
      "http://example.com/path?q=1#f",
      "chrome-extension://abcdefgh/options.html",
      "chrome://extensions",
      "about:blank",
      "file:///home/user/doc.html",
      "ftp://ftp.example.com/file",
      "mailto:user@example.com",
      "tel:+15551234567",
      "view-source:https://example.com/",
      "/relative/path",
      "page.html",
      "?query=1",
      "#fragment",
      "javascriptx:alert(1)",
      "xjavascript:alert(1)",
      "datax:text/plain,hi",
      "java script:alert(1)",
      "javascript :alert(1)",
      "https://example.com/javascript:foo",
    ];
    for (const url of openable) {
      expect(isOpenableUrl(url)).toBe(true);
    }
  });
});
