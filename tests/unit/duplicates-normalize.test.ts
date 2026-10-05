import { describe, expect, it } from "vitest";
import {
  normalizeUrl,
  REF_TRACKING_HOSTS,
  TRACKING_PARAMS,
} from "../../src/duplicates/normalize";

// Key format under test: `scheme://[userinfo@]host[:port][/path][?query][#route]`
// — http and https are distinct pages, and route-like fragments survive.

describe("normalizeUrl — canonical output", () => {
  it("normalizes canonical URLs accurately", () => {
    const cases: Array<[string, string, string]> = [
      ["lowercases scheme and host", "HTTP://EXAMPLE.COM/Path", "http://example.com/Path"],
      ["keeps path case", "https://Example.com/A/B", "https://example.com/A/B"],
      ["drops default http port 80", "http://example.com:80/", "http://example.com"],
      ["drops default https port 443", "https://example.com:443/", "https://example.com"],
      ["keeps non-default port", "http://example.com:8080/", "http://example.com:8080"],
      [
        "keeps port that is non-default for the stated scheme",
        "http://example.com:443/",
        "http://example.com:443",
      ],
      ["drops a plain anchor fragment", "https://example.com/a#section", "https://example.com/a"],
      [
        "drops a plain fragment when path and query exist",
        "https://example.com/a?b=1#frag",
        "https://example.com/a?b=1",
      ],
      [
        "keeps a route fragment",
        "https://app.com/#/inbox",
        "https://app.com#/inbox",
      ],
      [
        "keeps a hashbang route fragment",
        "https://app.com/#!/old/path",
        "https://app.com#!/old/path",
      ],
      [
        "keeps the route fragment after query",
        "https://app.com/a?b=1#/inbox",
        "https://app.com/a?b=1#/inbox",
      ],
      ["drops leading www.", "https://www.example.com/", "https://example.com"],
      [
        "drops www. only once",
        "https://www.www.example.com/",
        "https://www.example.com",
      ],
      [
        "leaves non-leading www alone",
        "https://a.www.example.com/",
        "https://a.www.example.com",
      ],
      [
        "leaves host merely containing www alone",
        "https://wwwexample.com/",
        "https://wwwexample.com",
      ],
      ["strips root slash to empty", "https://example.com/", "https://example.com"],
      [
        "root without slash equals root with slash",
        "https://example.com",
        "https://example.com",
      ],
      [
        "strips one trailing slash from a path",
        "https://example.com/a/",
        "https://example.com/a",
      ],
      [
        "strips repeated trailing slashes",
        "https://example.com/a//",
        "https://example.com/a",
      ],
      [
        "keeps interior slashes",
        "https://example.com//a",
        "https://example.com//a",
      ],
      ["sorts query params by name", "https://example.com/?b=2&a=1", "https://example.com?a=1&b=2"],
      [
        "sorts repeated params by value",
        "https://example.com/?a=2&a=1",
        "https://example.com?a=1&a=2",
      ],
      [
        "keeps non-tracking params",
        "https://example.com/?page=3&q=x",
        "https://example.com?page=3&q=x",
      ],
      [
        "keeps userinfo when present",
        "http://user:pass@example.com/",
        "http://user:pass@example.com",
      ],
      [
        "keeps userinfo without password",
        "http://user@example.com/",
        "http://user@example.com",
      ],
      [
        "keeps IPv6 host brackets",
        "http://[::1]:8080/a",
        "http://[::1]:8080/a",
      ],
    ];

    for (const [, input, expected] of cases) {
      expect(normalizeUrl(input)).toBe(expected);
    }
  });

  it("keeps http and https as distinct keys (D01)", () => {
    // Scheme-folding can merge two bookmarks that serve different content —
    // or one that is a redirect hop away from the real page.
    expect(normalizeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com/a")).not.toBe(
      normalizeUrl("https://example.com/a"),
    );
    // Same-scheme variants still collapse.
    const variants = [
      "https://example.com/a",
      "HTTPS://EXAMPLE.COM/a",
      "https://www.example.com:443/a/",
      "https://www.example.com/a#top",
    ];
    for (const input of variants) {
      expect(normalizeUrl(input)).toBe("https://example.com/a");
    }
  });

  it("keeps route fragments distinct; drops plain anchors (D01)", () => {
    expect(normalizeUrl("https://app.com/#/inbox")).not.toBe(
      normalizeUrl("https://app.com/#/settings"),
    );
    expect(normalizeUrl("https://app.com/#/inbox")).not.toBe(
      normalizeUrl("https://app.com/"),
    );
    // Plain anchors on the same URL still fold to one key.
    expect(normalizeUrl("https://example.com/a#one")).toBe(
      normalizeUrl("https://example.com/a#two"),
    );
  });

  it("differentiates paths and values, collapsing encodings", () => {
    expect(normalizeUrl("https://example.com/a")).not.toBe(
      normalizeUrl("https://example.com/b"),
    );
    expect(normalizeUrl("https://example.com/?a=1")).not.toBe(
      normalizeUrl("https://example.com/?a=2"),
    );
    const a = normalizeUrl("https://example.com/?q=a%20b");
    const b = normalizeUrl("https://example.com/?q=a+b");
    expect(a).toBe("https://example.com?q=a+b");
    expect(b).toBe(a);
    expect(normalizeUrl("https://example.com/?refsource=x&pref=1")).toBe(
      "https://example.com?pref=1&refsource=x",
    );
  });
});

describe("normalizeUrl — tracking parameters", () => {
  it("exports the documented drop list", () => {
    expect([...TRACKING_PARAMS].sort()).toEqual(
      [
        "dclid",
        "fbclid",
        "gbraid",
        "gclid",
        "mc_eid",
        "msclkid",
        "wbraid",
      ].sort(),
    );
  });

  it("drops tracking and utm parameters case-insensitively", () => {
    const params = [
      ...TRACKING_PARAMS,
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "UTM_SOURCE",
      "Fbclid",
      "GCLID",
    ];
    for (const param of params) {
      expect(normalizeUrl(`https://example.com/?${param}=val&a=1`)).toBe(
        "https://example.com?a=1",
      );
    }
  });

  it("drops tracking params anywhere in query and collapses equivalent links", () => {
    expect(
      normalizeUrl("https://example.com/p?a=1&utm_source=n&b=2"),
    ).toBe("https://example.com/p?a=1&b=2");
    expect(normalizeUrl("https://example.com/?fbclid=x")).toBe("https://example.com");

    const a = normalizeUrl(
      "https://www.example.com/item?utm_source=news&id=42#comments",
    );
    const b = normalizeUrl("https://example.com/item/?id=42&gclid=z");
    expect(a).toBe("https://example.com/item?id=42");
    expect(a).toBe(b);
  });

  it("scopes `ref` stripping to known tracking hosts (D01)", () => {
    // Repo host: `ref` picks the rendered branch — distinct pages.
    expect(normalizeUrl("https://github.com/o/r?ref=a")).not.toBe(
      normalizeUrl("https://github.com/o/r?ref=b"),
    );
    expect(normalizeUrl("https://github.com/o/r?ref=main")).toBe(
      "https://github.com/o/r?ref=main",
    );
    // Any unlisted host keeps it too — fail closed toward distinctness.
    expect(normalizeUrl("https://blog.example/x?ref=a")).toBe(
      "https://blog.example/x?ref=a",
    );
    // Listed tracking hosts drop it — those bookmarks still group.
    for (const host of REF_TRACKING_HOSTS) {
      expect(
        normalizeUrl(`https://www.${host}/x?ref=sponsored&id=1`),
        host,
      ).toBe(`https://${host}/x?id=1`);
      // Subdomains inherit the rule.
      expect(
        normalizeUrl(`https://shop.${host}/x?ref=y`),
        `shop.${host}`,
      ).toBe(`https://shop.${host}/x`);
    }
  });
});

describe("normalizeUrl — non-http(s) and invalid input", () => {
  it("returns null for non-http(s) inputs", () => {
    const nonHttp = [
      "chrome://extensions/",
      "chrome-extension://abc/page.html",
      "file:///tmp/notes.txt",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "mailto:a@b.c",
      "about:blank",
      "ftp://example.com/file",
    ];
    for (const input of nonHttp) {
      expect(normalizeUrl(input)).toBeNull();
    }
  });

  it("returns null for unparseable input", () => {
    const unparseable = [
      "",
      "   ",
      "not a url",
      "example.com",
      "example.com/path",
      "/relative/path",
      "https://",
      "http://",
      "://missing-scheme",
    ];
    for (const input of unparseable) {
      expect(normalizeUrl(input)).toBeNull();
    }
  });

  it("never throws", () => {
    expect(() => normalizeUrl("%%%")).not.toThrow();
    expect(() => normalizeUrl("http://[bad")).not.toThrow();
  });
});
