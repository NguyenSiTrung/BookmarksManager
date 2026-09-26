import { describe, expect, it } from "vitest";
import { isOpenableUrl } from "../../src/search/openable";

/**
 * Coverage for the pure openable-URL guard. The denylist is fixed by spec
 * §5–§7: `javascript:` and `data:` bookmarks are indexed and listed but
 * their open actions are disabled on every surface. Everything else —
 * including schemes Chrome itself may refuse — stays openable here and
 * degrades to a typed `api` failure at the tabs boundary.
 */

describe("isOpenableUrl blocked schemes", () => {
  it.each([
    "javascript:alert(1)",
    "javascript:",
    "data:text/html;base64,PGI+aGk8L2I+",
    "data:image/png;base64,iVBORw0KGgo=",
  ])("rejects %s", (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });

  it.each([
    "JAVASCRIPT:alert(1)",
    "JaVaScRiPt:alert(document.cookie)",
    "DATA:text/plain,hi",
    "Data:text/html,<h1>x</h1>",
  ])("rejects the mixed-case scheme %s", (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });

  it.each([
    "  javascript:alert(1)",
    "\tjavascript:alert(1)",
    "\njavascript:alert(1)",
    "  DATA:text/plain,hi  ",
    "\u00a0javascript:alert(1)", // leading NBSP — inert input, blocked anyway
  ])("rejects the whitespace-padded scheme %s", (url) => {
    expect(isOpenableUrl(url)).toBe(false);
  });

  it.each([
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\r\nscript:alert(1)",
    "javascript\t:alert(1)",
  ])(
    "rejects %s — ASCII tab/newline are removed by URL parsing, so they are removed here too",
    (url) => {
      expect(isOpenableUrl(url)).toBe(false);
    },
  );
});

describe("isOpenableUrl blank input", () => {
  it.each(["", "   ", "\t\n"])(
    "rejects %j — there is nothing to navigate to",
    (url) => {
      expect(isOpenableUrl(url)).toBe(false);
    },
  );
});

describe("isOpenableUrl openable input", () => {
  it.each([
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
  ])("accepts %s", (url) => {
    expect(isOpenableUrl(url)).toBe(true);
  });

  it.each([
    "/relative/path",
    "page.html",
    "?query=1",
    "#fragment",
  ])(
    "accepts schemeless %s — the tabs API resolves it against the extension origin",
    (url) => {
      expect(isOpenableUrl(url)).toBe(true);
    },
  );

  it.each([
    "javascriptx:alert(1)", // a different scheme entirely
    "xjavascript:alert(1)", // the scheme is xjavascript, not javascript
    "datax:text/plain,hi",
    "java script:alert(1)", // space inside: not a valid scheme to a browser
    "javascript :alert(1)", // space before colon: not a valid scheme either
    "https://example.com/javascript:foo", // colon later — scheme is https
  ])("accepts near-miss %s", (url) => {
    expect(isOpenableUrl(url)).toBe(true);
  });
});
