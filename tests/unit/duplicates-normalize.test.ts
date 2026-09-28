import { describe, expect, it } from "vitest";
import { normalizeUrl, TRACKING_PARAMS } from "../../src/duplicates/normalize";

// Key format under test: `[userinfo@]host[:port][/path][?query]` — the scheme
// is erased so http and https produce the same key.

describe("normalizeUrl — canonical output", () => {
  it("normalizes canonical URLs accurately", () => {
    const cases: Array<[string, string, string]> = [
      ["lowercases scheme and host", "HTTP://EXAMPLE.COM/Path", "example.com/Path"],
      ["keeps path case", "https://Example.com/A/B", "example.com/A/B"],
      ["drops default http port 80", "http://example.com:80/", "example.com"],
      ["drops default https port 443", "https://example.com:443/", "example.com"],
      ["keeps non-default port", "http://example.com:8080/", "example.com:8080"],
      [
        "keeps port that is non-default for the stated scheme",
        "http://example.com:443/",
        "example.com:443",
      ],
      ["drops the fragment", "https://example.com/a#section", "example.com/a"],
      [
        "drops fragment when path and query exist",
        "https://example.com/a?b=1#frag",
        "example.com/a?b=1",
      ],
      ["drops leading www.", "https://www.example.com/", "example.com"],
      [
        "drops www. only once",
        "https://www.www.example.com/",
        "www.example.com",
      ],
      [
        "leaves non-leading www alone",
        "https://a.www.example.com/",
        "a.www.example.com",
      ],
      [
        "leaves host merely containing www alone",
        "https://wwwexample.com/",
        "wwwexample.com",
      ],
      ["strips root slash to empty", "https://example.com/", "example.com"],
      [
        "root without slash equals root with slash",
        "https://example.com",
        "example.com",
      ],
      [
        "strips one trailing slash from a path",
        "https://example.com/a/",
        "example.com/a",
      ],
      [
        "strips repeated trailing slashes",
        "https://example.com/a//",
        "example.com/a",
      ],
      [
        "keeps interior slashes",
        "https://example.com//a",
        "example.com//a",
      ],
      ["sorts query params by name", "https://example.com/?b=2&a=1", "example.com?a=1&b=2"],
      [
        "sorts repeated params by value",
        "https://example.com/?a=2&a=1",
        "example.com?a=1&a=2",
      ],
      [
        "keeps non-tracking params",
        "https://example.com/?page=3&q=x",
        "example.com?page=3&q=x",
      ],
      [
        "keeps userinfo when present",
        "http://user:pass@example.com/",
        "user:pass@example.com",
      ],
      [
        "keeps userinfo without password",
        "http://user@example.com/",
        "user@example.com",
      ],
      [
        "keeps IPv6 host brackets",
        "http://[::1]:8080/a",
        "[::1]:8080/a",
      ],
    ];

    for (const [, input, expected] of cases) {
      expect(normalizeUrl(input)).toBe(expected);
    }
  });

  it("maps http/https variants to the same key", () => {
    const variants = [
      "http://example.com/a",
      "https://example.com/a",
      "HTTPS://EXAMPLE.COM/a",
      "https://www.example.com:443/a/",
      "http://www.example.com:80/a#top",
    ];
    for (const input of variants) {
      expect(normalizeUrl(input)).toBe("example.com/a");
    }
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
    expect(a).toBe("example.com?q=a+b");
    expect(b).toBe(a);
    expect(normalizeUrl("https://example.com/?refsource=x&pref=1")).toBe(
      "example.com?pref=1&refsource=x",
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
        "ref",
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
      "Ref",
    ];
    for (const param of params) {
      expect(normalizeUrl(`https://example.com/?${param}=val&a=1`)).toBe(
        "example.com?a=1",
      );
    }
  });

  it("drops tracking params anywhere in query and collapses equivalent links", () => {
    expect(
      normalizeUrl("https://example.com/p?a=1&utm_source=n&b=2"),
    ).toBe("example.com/p?a=1&b=2");
    expect(normalizeUrl("https://example.com/?fbclid=x")).toBe("example.com");

    const a = normalizeUrl(
      "https://www.example.com/item?utm_source=news&id=42#comments",
    );
    const b = normalizeUrl("http://example.com/item/?id=42&gclid=z");
    expect(a).toBe("example.com/item?id=42");
    expect(a).toBe(b);
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
