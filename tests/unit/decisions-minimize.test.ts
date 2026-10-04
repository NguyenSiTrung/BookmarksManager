import { describe, expect, it } from "vitest";
import {
  addBlocklistEntry,
  BUILTIN_SENSITIVE_SITES,
  cleanUrl,
  domainOf,
  isSensitiveUrl,
  minimizeBookmark,
  normalizeBlocklistEntry,
  removeBlocklistEntry,
} from "../../src/decisions/minimize";
import { SentBookmark } from "../../src/schemas/decision-state";

// minimize.ts is the FR2 data-minimization layer: `cleanUrl` strips query,
// fragment, and userinfo before anything is sent, and `isSensitiveUrl`
// refuses bookmarks on the sensitive-site blocklist.

describe("cleanUrl", () => {
  it("normalizes and sanitizes URLs according to specifications", () => {
    const cases: Array<[string, string, string]> = [
      ["drops query", "https://example.com/p?a=1&b=2", "https://example.com/p"],
      ["drops fragment", "https://example.com/p#frag", "https://example.com/p"],
      [
        "drops query and fragment",
        "https://example.com/p?a=1#frag",
        "https://example.com/p",
      ],
      [
        "drops user:password credentials",
        "https://user:pass@example.com/p",
        "https://example.com/p",
      ],
      [
        "drops bare userinfo",
        "https://user@example.com/p",
        "https://example.com/p",
      ],
      [
        "keeps a non-default port",
        "https://example.com:8443/p?x=1",
        "https://example.com:8443/p",
      ],
      [
        "drops the default https port",
        "https://example.com:443/p?x=1",
        "https://example.com/p",
      ],
      [
        "drops the default http port",
        "http://example.com:80/p?x=1",
        "http://example.com/p",
      ],
      [
        "converts an IDN host to punycode",
        "https://bücher.de/seite?q=x#f",
        "https://xn--bcher-kva.de/seite",
      ],
      [
        "drops a trailing bare ?",
        "https://example.com/?",
        "https://example.com/",
      ],
      [
        "drops a trailing bare #",
        "https://example.com/#",
        "https://example.com/",
      ],
      [
        "drops trailing ?# together",
        "https://example.com/?#",
        "https://example.com/",
      ],
      [
        "keeps an encoded ? inside the path",
        "https://example.com/a%3Fb?x=1",
        "https://example.com/a%3Fb",
      ],
      [
        "lowercases scheme and host, keeps path case",
        "HTTPS://EXAMPLE.COM/Path?x=1",
        "https://example.com/Path",
      ],
      [
        "adds the canonical root slash",
        "https://example.com",
        "https://example.com/",
      ],
      ["cleans file: URLs too", "file:///etc/passwd?x#y", "file:///etc/passwd"],
      [
        "keeps a userinfo-looking path segment",
        "https://example.com/@user",
        "https://example.com/@user",
      ],
    ];

    for (const [, input, expected] of cases) {
      expect(cleanUrl(input)).toBe(expected);
    }
  });

  it("is idempotent and returns null for unparseable URLs", () => {
    const once = cleanUrl("https://user:pass@EXAMPLE.com/p?a=1#f");
    expect(once).not.toBeNull();
    expect(cleanUrl(once as string)).toBe(once);
    const unparseable = ["", "   ", "not a url", "example.com", "example.com/path", "https://"];
    for (const input of unparseable) {
      expect(cleanUrl(input), input).toBeNull();
    }
  });
});

describe("domainOf", () => {
  it("returns the hostname of valid URLs and null for unparseable or hostless input", () => {
    const cases: Array<[string, string]> = [
      ["https://example.com/p?x=1", "example.com"],
      ["https://bücher.de/", "xn--bcher-kva.de"],
      ["http://[2001:db8::1]:8080/p", "[2001:db8::1]"],
      ["HTTPS://EXAMPLE.com./", "example.com."],
    ];
    for (const [input, expected] of cases) {
      expect(domainOf(input)).toBe(expected);
    }
    for (const input of ["not a url", "", "mailto:a@b.c", "file:///x"]) {
      expect(domainOf(input), input).toBeNull();
    }
  });
});

describe("isSensitiveUrl — built-in list", () => {
  it("blocks sensitive sites and matches subdomains", () => {
    const sensitiveSites = [
      "https://chase.com/login",
      "https://secure.bankofamerica.com/",
      "https://www.wellsfargo.com/",
      "https://paypal.com/signin",
      "https://mail.google.com/inbox",
      "https://outlook.live.com/mail/",
      "https://mail.yahoo.com/",
      "https://proton.me/inbox",
      "https://mychart.epichosted.com/MyChart/",
      "https://myhealth.va.gov/",
      "https://healthy.kaiserpermanente.org/",
      "https://mail.aol.com/",
      "https://gmail.com/mail/u/0/",
      "https://outlook.com/mail/",
      "https://hotmail.com/",
      "https://www.icloud.com/mail",
      "https://aol.com/",
    ];
    for (const url of sensitiveSites) {
      expect(isSensitiveUrl(url)).toBe(true);
    }
    expect(isSensitiveUrl("https://online.chase.com/")).toBe(true);
    expect(isSensitiveUrl("https://a.b.chase.com/")).toBe(true);
  });

  it("does not block ordinary sites", () => {
    const ordinary = [
      "https://example.com/",
      "https://tokio.rs/tokio/tutorial/async",
      "https://news.ycombinator.com/item?id=1",
      "https://github.com/user/repo",
      "http://8.8.8.8/dns",
      "http://[2001:4860:4860::8888]/",
      "http://[2001:470::1]/",
      "https://chase.com.evil.net/",
      "https://notpaypal.com/",
      "http://172.15.0.1/",
      "http://172.32.0.1/",
      "http://11.0.0.1/",
      "http://192.167.0.1/",
      "http://169.255.0.1/",
      "http://192.0.1.1/",
      "http://223.255.255.255/",
      "http://192.169.0.1/",
    ];
    for (const url of ordinary) {
      expect(isSensitiveUrl(url)).toBe(false);
    }
  });
});

describe("isSensitiveUrl — file, IP, and intranet rules", () => {
  it("blocks file: URLs and intranet-ish inputs", () => {
    const files = [
      "file:///etc/passwd",
      "file:///C:/Users/me/secret.xlsx",
      "FILE:///tmp/x",
    ];
    for (const url of files) {
      expect(isSensitiveUrl(url), url).toBe(true);
    }
    const intranet = [
      "http://localhost/",
      "http://localhost:3000/app",
      "http://localhost./",
      "http://nas/intranet",
      "http://printer/",
      "http://foo.local/",
      "http://wiki.internal/",
      "http://router.lan/",
      "http://home.arpa/",
      "http://build.corp/",
      "http://host.test/",
      "http://x.invalid/",
      "https://site.onion/",
      "http://intranet/",
    ];
    for (const url of intranet) {
      expect(isSensitiveUrl(url), url).toBe(true);
    }
    const schemes = [
      "mailto:user@example.com",
      "javascript:alert(1)",
      "data:text/html;base64,PGI+",
      "about:blank",
      "chrome://extensions/",
      "chrome-extension://abcdef/page.html",
      "blob:https://example.com/uuid",
    ];
    for (const url of schemes) {
      expect(isSensitiveUrl(url), url).toBe(true);
    }
    for (const url of ["", "not a url", "://missing", "https://"]) {
      expect(isSensitiveUrl(url), url).toBe(true);
    }
  });

  it("blocks private/loopback IPv4 and IPv6 addresses", () => {
    const ipv4 = [
      "http://10.0.0.5/admin",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/router",
      "http://192.168.255.255/",
      "http://127.0.0.1:3000/",
      "http://127.0.0.2/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0.0.0.0/",
      "http://169.254.1.1/",
      "http://100.64.0.1/",
      "http://198.18.0.1/",
      "http://192.0.0.9/",
      "http://192.0.2.1/",
      "http://198.51.100.1/",
      "http://203.0.113.1/",
      "http://224.0.0.1/",
      "http://239.255.255.255/",
      "http://240.0.0.1/",
      "http://255.255.255.255/",
    ];
    for (const url of ipv4) {
      expect(isSensitiveUrl(url), url).toBe(true);
    }
    const ipv6 = [
      "http://[::1]/",
      "http://[::1]:8080/x",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:c0a8:1]/",
      "http://[ff02::1]/",
      "http://[2001:db8::1]/",
      "http://[2002::1]/",
      "http://[2002:c0a8:0101::1]/",
      "http://[2001::1]/",
      "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
    ];
    for (const url of ipv6) {
      expect(isSensitiveUrl(url), url).toBe(true);
    }
  });
});

describe("isSensitiveUrl — user blocklist entries", () => {
  it("matches normalized entries, skips unrelated hosts, ignores malformed ones", () => {
    const entries = ["mycorp.io", "portal.internal.mycorp.org"];
    expect(isSensitiveUrl("https://mycorp.io/", entries)).toBe(true);
    expect(isSensitiveUrl("https://intranet.mycorp.io/", entries)).toBe(true);
    expect(
      isSensitiveUrl("https://portal.internal.mycorp.org/login", entries),
    ).toBe(true);
    // Raw input is normalized before matching.
    expect(isSensitiveUrl("https://mybank.com/", ["  MyBank.COM  "])).toBe(true);
    expect(
      isSensitiveUrl("https://portal.example.org/x", [
        "https://portal.example.org/login",
      ]),
    ).toBe(true);
    expect(isSensitiveUrl("http://[2001:db8::9]/", ["2001:db8::9"])).toBe(true);
    expect(isSensitiveUrl("http://8.8.8.8/", ["8.8.8.8"])).toBe(true);
    // Suffix lookalikes and unrelated hosts pass.
    const single = ["mycorp.io"];
    expect(isSensitiveUrl("https://notmycorp.io/", single)).toBe(false);
    expect(isSensitiveUrl("https://mycorp.io.evil.com/", single)).toBe(false);
    expect(isSensitiveUrl("https://example.com/", single)).toBe(false);
    // Malformed entries are ignored, never thrown.
    expect(
      isSensitiveUrl("https://example.com/", ["not a host!!", "???"]),
    ).toBe(false);
  });
});

describe("isSensitiveUrl — opaque-scheme hosts are case-folded", () => {
  it("blocks opaque-scheme hosts", () => {
    const opaqueUrls = [
      "foo://CHASE.COM/",
      "foo://Chase.Com/login",
      "web+x://MYHOST.LOCAL/",
      "foo://LOCALHOST/",
      "foo://N A S/",
      "foo://192.168.1.1/",
      "foo://127.1/",
      "foo://0x7f.1/",
    ];
    for (const url of opaqueUrls) {
      expect(isSensitiveUrl(url)).toBe(true);
    }
  });

  it("allows ordinary opaque-scheme hosts and folds mixed-case user entries", () => {
    expect(isSensitiveUrl("foo://EXAMPLE.COM/")).toBe(false);
    expect(isSensitiveUrl("foo://example.com/path")).toBe(false);
    expect(isSensitiveUrl("foo://tokio.rs/")).toBe(false);
    expect(normalizeBlocklistEntry("foo://MyCorp.IO")).toBe("mycorp.io");
    expect(isSensitiveUrl("foo://mycorp.io/", ["MyCorp.IO"])).toBe(true);
    expect(isSensitiveUrl("foo://MYCORP.IO/", ["mycorp.io"])).toBe(true);
    // An entry added mixed-case matches lower-case hosts afterwards.
    const entries = addBlocklistEntry([], "foo://MyCorp.IO");
    expect(entries).toEqual(["mycorp.io"]);
    expect(isSensitiveUrl("foo://mycorp.io/", entries)).toBe(true);
    expect(isSensitiveUrl("https://mycorp.io/", entries)).toBe(true);
  });
});

describe("BUILTIN_SENSITIVE_SITES", () => {
  it("is a frozen, non-empty list of lowercase host suffixes", () => {
    expect(Object.isFrozen(BUILTIN_SENSITIVE_SITES)).toBe(true);
    expect(BUILTIN_SENSITIVE_SITES.length).toBeGreaterThan(0);
    for (const entry of BUILTIN_SENSITIVE_SITES) {
      expect(entry).toBe(entry.toLowerCase());
      expect(entry).not.toMatch(/[\s/?#@]/);
    }
  });
});

describe("normalizeBlocklistEntry / add / remove", () => {
  it("normalizes various valid blocklist entries", () => {
    const cases: Array<[string, string]> = [
      ["Example.COM", "example.com"],
      ["  spaced.example.org  ", "spaced.example.org"],
      ["https://portal.example.org/login?q=1", "portal.example.org"],
      ["*.example.org", "example.org"],
      ["localhost:8080", "localhost"],
      ["bücher.de", "xn--bcher-kva.de"],
      ["example.com.", "example.com"],
      ["[::1]", "::1"],
      ["::1", "::1"],
      ["::ffff:127.0.0.1", "::ffff:7f00:1"],
      ["foo://MyCorp.IO", "mycorp.io"],
      ["foo://B%C3%BCcher.de/", "xn--bcher-kva.de"],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeBlocklistEntry(input)).toBe(expected);
    }
  });

  it("rejects invalid blocklist entries", () => {
    const rejects = ["", "   ", "not a host", "a/b/c", "x?y", "x#y", "u@h", "http://"];
    for (const input of rejects) {
      expect(normalizeBlocklistEntry(input), input).toBeNull();
    }
  });

  it("adds normalized entries without duplicates, throws on invalid, removes normalized", () => {
    let entries = addBlocklistEntry([], "Example.COM");
    expect(entries).toEqual(["example.com"]);
    entries = addBlocklistEntry(entries, "example.com");
    expect(entries).toEqual(["example.com"]);
    entries = addBlocklistEntry(entries, "https://other.org/x");
    expect(entries).toEqual(["example.com", "other.org"]);
    expect(() => addBlocklistEntry([], "not a host")).toThrow(TypeError);
    expect(removeBlocklistEntry(entries, "Example.COM")).toEqual([
      "other.org",
    ]);
    expect(removeBlocklistEntry(entries, "missing.org")).toEqual(entries);
  });
});

describe("minimizeBookmark", () => {
  it("produces a SentBookmark-conforming triple", () => {
    const result = minimizeBookmark({
      title: "Tokio tutorial",
      url: "https://tokio.rs/tutorial?utm_source=x#top",
    });
    expect(result).toEqual({
      title: "Tokio tutorial",
      url: "https://tokio.rs/tutorial",
      domain: "tokio.rs",
    });
    expect(SentBookmark.safeParse(result).success).toBe(true);
  });

  it("never carries notes or any other input keys", () => {
    const result = minimizeBookmark({
      title: "T",
      url: "https://example.com/",
      notes: "very private note",
    });
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual([
      "domain",
      "title",
      "url",
    ]);
    expect("notes" in (result ?? {})).toBe(false);
  });

  it("truncates over-long titles and returns null past the CleanedUrl bound", () => {
    const result = minimizeBookmark({
      title: "t".repeat(600),
      url: "https://example.com/",
    });
    expect(result?.title).toHaveLength(500);
    expect(SentBookmark.safeParse(result).success).toBe(true);
    const url = `https://example.com/${"a".repeat(2_048)}`;
    expect(url.length).toBeGreaterThan(2_048);
    expect(minimizeBookmark({ title: "x", url })).toBeNull();
  });

  it("returns null for unparseable, sensitive, or user-blocklisted URLs", () => {
    const urls = [
      "https://chase.com/login",
      "file:///etc/passwd",
      "http://192.168.1.1/",
      "http://localhost:8080/app",
      "http://nas/",
      "mailto:a@b.c",
      "not a url",
      "",
    ];
    for (const url of urls) {
      expect(minimizeBookmark({ title: "x", url }), url).toBeNull();
    }
    const input = { title: "portal", url: "https://portal.example.org/" };
    expect(minimizeBookmark(input)).not.toBeNull();
    expect(
      minimizeBookmark(input, ["example.org"]),
    ).toBeNull();
  });
});
