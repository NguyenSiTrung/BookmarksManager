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
  it.each([
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
  ])("%s", (_label, input, expected) => {
    expect(cleanUrl(input)).toBe(expected);
  });

  it("is idempotent", () => {
    const once = cleanUrl("https://user:pass@EXAMPLE.com/p?a=1#f");
    expect(once).not.toBeNull();
    expect(cleanUrl(once as string)).toBe(once);
  });

  it.each(["", "   ", "not a url", "example.com", "example.com/path", "https://"])(
    "returns null for unparseable %j",
    (input) => {
      expect(cleanUrl(input)).toBeNull();
    },
  );
});

describe("domainOf", () => {
  it.each([
    ["https://example.com/p?x=1", "example.com"],
    ["https://bücher.de/", "xn--bcher-kva.de"],
    ["http://[2001:db8::1]:8080/p", "[2001:db8::1]"],
    ["HTTPS://EXAMPLE.com./", "example.com."],
  ])("returns the hostname of %j", (input, expected) => {
    expect(domainOf(input)).toBe(expected);
  });

  it.each(["not a url", "", "mailto:a@b.c", "file:///x"])(
    "returns null for %j (unparseable or hostless)",
    (input) => {
      expect(domainOf(input)).toBeNull();
    },
  );
});

describe("isSensitiveUrl — built-in list", () => {
  it.each([
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
  ])("blocks sensitive site %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it("matches subdomains of listed domains", () => {
    expect(isSensitiveUrl("https://online.chase.com/")).toBe(true);
    expect(isSensitiveUrl("https://a.b.chase.com/")).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://tokio.rs/tokio/tutorial/async",
    "https://news.ycombinator.com/item?id=1",
    "https://github.com/user/repo",
    "http://8.8.8.8/dns",
    "http://[2001:4860:4860::8888]/",
    "https://chase.com.evil.net/", // look-alike suffix must not match
    "https://notpaypal.com/",
    "http://172.15.0.1/", // just outside 172.16.0.0/12
    "http://172.32.0.1/",
    "http://11.0.0.1/",
    "http://192.167.0.1/",
    "http://169.255.0.1/",
  ])("does not block ordinary site %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(false);
  });
});

describe("isSensitiveUrl — file, IP, and intranet rules", () => {
  it.each([
    "file:///etc/passwd",
    "file:///C:/Users/me/secret.xlsx",
    "FILE:///tmp/x",
  ])("blocks file: URL %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it.each([
    "http://10.0.0.5/admin",
    "http://10.255.255.255/",
    "http://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.168.1.1/router",
    "http://192.168.255.255/",
    "http://127.0.0.1:3000/",
    "http://127.0.0.2/",
    "http://127.1/", // short form canonicalizes to 127.0.0.1
    "http://2130706433/", // decimal form canonicalizes to 127.0.0.1
    "http://0x7f.1/", // hex form canonicalizes to 127.0.0.1
    "http://0.0.0.0/",
    "http://169.254.1.1/", // link-local
    "http://100.64.0.1/", // CGNAT
    "http://198.18.0.1/", // benchmarking range
  ])("blocks private/loopback IPv4 %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it.each([
    "http://[::1]/",
    "http://[::1]:8080/x",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
    "http://[::ffff:10.0.0.1]/", // IPv4-mapped private
    "http://[::ffff:c0a8:1]/", // IPv4-mapped 192.168.0.1
  ])("blocks private/loopback IPv6 %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it.each([
    "http://localhost/",
    "http://localhost:3000/app",
    "http://localhost./", // trailing-dot FQDN spelling
    "http://nas/intranet",
    "http://printer/",
    "http://foo.local/",
    "http://wiki.internal/",
    "http://router.lan/",
    "http://home.arpa/",
    "http://build.corp/",
    "http://host.test/",
    "http://x.invalid/",
    "https://site.onion/", // Tor hidden service
    "http://intranet/",
  ])("blocks intranet hostname %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it.each([
    "mailto:user@example.com",
    "javascript:alert(1)",
    "data:text/html;base64,PGI+",
    "about:blank",
    "chrome://extensions/",
    "blob:https://example.com/uuid",
  ])("blocks hostless scheme %j", (url) => {
    expect(isSensitiveUrl(url)).toBe(true);
  });

  it.each(["", "not a url", "://missing", "https://"])(
    "fails closed on unparseable %j",
    (url) => {
      expect(isSensitiveUrl(url)).toBe(true);
    },
  );
});

describe("isSensitiveUrl — user blocklist entries", () => {
  it("blocks hosts matching a user entry", () => {
    const entries = ["mycorp.io", "portal.internal.mycorp.org"];
    expect(isSensitiveUrl("https://mycorp.io/", entries)).toBe(true);
    expect(isSensitiveUrl("https://intranet.mycorp.io/", entries)).toBe(true);
    expect(
      isSensitiveUrl("https://portal.internal.mycorp.org/login", entries),
    ).toBe(true);
  });

  it("normalizes raw user input before matching", () => {
    expect(isSensitiveUrl("https://mybank.com/", ["  MyBank.COM  "])).toBe(
      true,
    );
    expect(
      isSensitiveUrl("https://portal.example.org/x", [
        "https://portal.example.org/login",
      ]),
    ).toBe(true);
    expect(isSensitiveUrl("http://[2001:db8::9]/", ["2001:db8::9"])).toBe(true);
    expect(isSensitiveUrl("http://8.8.8.8/", ["8.8.8.8"])).toBe(true);
  });

  it("does not block unrelated hosts", () => {
    const entries = ["mycorp.io"];
    expect(isSensitiveUrl("https://notmycorp.io/", entries)).toBe(false);
    expect(isSensitiveUrl("https://mycorp.io.evil.com/", entries)).toBe(false);
    expect(isSensitiveUrl("https://example.com/", entries)).toBe(false);
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(
      isSensitiveUrl("https://example.com/", ["not a host!!", "???"]),
    ).toBe(false);
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
  it.each([
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
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeBlocklistEntry(input)).toBe(expected);
  });

  it.each(["", "   ", "not a host", "a/b/c", "x?y", "x#y", "u@h", "http://"])(
    "rejects %j",
    (input) => {
      expect(normalizeBlocklistEntry(input)).toBeNull();
    },
  );

  it("adds normalized entries without duplicates", () => {
    let entries = addBlocklistEntry([], "Example.COM");
    expect(entries).toEqual(["example.com"]);
    entries = addBlocklistEntry(entries, "example.com");
    expect(entries).toEqual(["example.com"]);
    entries = addBlocklistEntry(entries, "https://other.org/x");
    expect(entries).toEqual(["example.com", "other.org"]);
  });

  it("throws on an invalid entry", () => {
    expect(() => addBlocklistEntry([], "not a host")).toThrow(TypeError);
  });

  it("removes entries by normalized value", () => {
    const entries = ["example.com", "other.org"];
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

  it("truncates over-long titles to the SentBookmark bound", () => {
    const result = minimizeBookmark({
      title: "t".repeat(600),
      url: "https://example.com/",
    });
    expect(result?.title).toHaveLength(500);
    expect(SentBookmark.safeParse(result).success).toBe(true);
  });

  it.each([
    "https://chase.com/login",
    "file:///etc/passwd",
    "http://192.168.1.1/",
    "http://localhost:8080/app",
    "http://nas/",
    "mailto:a@b.c",
    "not a url",
    "",
  ])("returns null for unparseable or sensitive %j", (url) => {
    expect(minimizeBookmark({ title: "x", url })).toBeNull();
  });

  it("honors the user blocklist", () => {
    const input = { title: "portal", url: "https://portal.example.org/" };
    expect(minimizeBookmark(input)).not.toBeNull();
    expect(
      minimizeBookmark(input, ["example.org"]),
    ).toBeNull();
  });
});
