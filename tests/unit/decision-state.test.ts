import { describe, expect, it, vi } from "vitest";
import {
  CandidateFolder,
  CandidateTag,
  CleanedUrl,
  DecisionState,
  SentBookmark,
} from "../../src/schemas/decision-state";
import { cleanUrl } from "../../src/decisions/minimize";

// The consent gate strict-parses every outgoing `jev_decisions` request state
// against this schema (spec FR1): unknown keys, dirty URLs, and malformed
// candidate records are refused before consent, permission, or key reads.

const validBookmark = {
  title: "Tokio tutorial: async in depth",
  url: "https://tokio.rs/tokio/tutorial/async",
  domain: "tokio.rs",
};

const validPartner = {
  title: "Async Rust in depth",
  url: "https://blog.example.com/async-rust",
  domain: "blog.example.com",
};

const validState = {
  bookmark: validBookmark,
  folderPath: ["Bookmarks bar", "Programming", "Rust"],
  candidateTags: [
    { name: "rust", description: "The Rust programming language" },
    { name: "async" },
  ],
  candidateFolders: [
    { id: "f_12", path: ["Programming", "Rust"] },
    { id: "f_31", path: ["Programming", "Web"] },
  ],
  candidateBookmarks: [validPartner],
  pairPartner: validPartner,
  query: "rust async executors",
};

describe("CleanedUrl", () => {
  it("accepts valid clean URLs", () => {
    const cleanUrls = [
      "https://example.com",
      "https://example.com/",
      "https://example.com/a/b",
      "https://example.com:8443/p",
      "https://xn--bcher-kva.de/seite",
      "http://[2001:db8::1]:8080/p",
      "https://example.com/@user",
      "https://example.com/a%3Fb",
      "HTTPS://EXAMPLE.COM/Path",
      "file:///etc/passwd",
      "ftp://files.example.com/pub",
    ];
    for (const url of cleanUrls) {
      expect(CleanedUrl.safeParse(url).success).toBe(true);
    }
  });

  it("rejects unclean, credentials, or malformed URLs", () => {
    const dirtyUrls = [
      "https://example.com/p?a=1&b=2",
      "https://example.com/p?q=",
      "https://example.com/p?",
      "https://example.com/p#section",
      "https://example.com/p#",
      "https://example.com/?#f",
      "https://user:pass@example.com/p",
      "https://user@example.com/p",
      "ftp://u:p@files.example.com/",
      "example.com/path",
      "example.com",
      "not a url",
      "",
      "data:text/plain,x?y=1",
      "https://exa\tmple.com/",
      "https://example.com/\n",
      "https://example.com/\r",
      "https://example.com/a b",
      "https://example.com/\u0000",
      "https://example.com/\u007f",
    ];
    for (const url of dirtyUrls) {
      expect(CleanedUrl.safeParse(url).success).toBe(false);
    }
  });

  it.each([
    `/s/${"A".repeat(40)}`, `/s/${"A".repeat(32)}`,
    "/p;jsessionid=synthetic-session", "/;jsessionid=synthetic-session",
    "/p%3Bjsessionid=synthetic-session", "/p%253bjsessionid=synthetic-session",
    "/p%25%33%42jsessionid=synthetic-session", "/bad%ZZ%3Bprivate",
    `/s/${"%41".repeat(32)}`, `/s/${"A".repeat(31)}%41`,
    `/s/${"%2541".repeat(32)}`, `/s/${"%25%34%31".repeat(32)}`,
    `/s/short%2F${"A".repeat(40)}%2fnext`, `/s/short%255C${"A".repeat(40)}`,
    "/p;jsessionid=synthetic-session/../short",
    `/s/${"A".repeat(40)}/../short`,
    "/p%3Bjsessionid=synthetic-session/%2e%2e/short",
    `/s/${"A".repeat(40)}\\..\\short`,
  ])("independently refuses raw path secrets in %s", (path) => {
    const raw = `https://example.com${path}`;
    expect(CleanedUrl.safeParse(raw).success).toBe(false);
    expect(CleanedUrl.safeParse(cleanUrl(raw)).success).toBe(true);
  });

  it("keeps semantic cleanliness rather than requiring byte-canonical URLs", () => {
    for (const url of [
      "HTTPS://EXAMPLE.COM", "HTTPS://EXAMPLE.COM/Short",
      "HTTPS://EXAMPLE.COM/s/_redacted_", "https://example.com/a%3fb",
      `https://example.com/s/${"%41".repeat(31)}`, "https://example.com/a%2Fb",
    ]) {
      expect(CleanedUrl.safeParse(url).success, url).toBe(true);
    }
  });

  it("refuses over-limit input before any URL parsing or path inspection", () => {
    const parse = vi.spyOn(globalThis, "URL").mockImplementation(function () {
      throw new Error("Over-limit admission must not parse a URL.");
    });
    try {
      for (const raw of [
        `https://example.com/${"a/".repeat(1_015)}`,
        `https://example.com/%${"25".repeat(10_000)}41`,
      ]) {
        expect(raw.length).toBeGreaterThan(2_048);
        expect(CleanedUrl.safeParse(raw).success).toBe(false);
      }
      expect(parse.mock.calls.length).toBe(0);
    } finally {
      parse.mockRestore();
    }
  });

  it("retains the exact 2,048-character admission boundary", () => {
    const raw = `https://example.com/${"a/".repeat(1_014)}`;
    expect(raw.length).toBe(2_048);
    expect(CleanedUrl.safeParse(raw).success).toBe(true);
    expect(CleanedUrl.safeParse(`${raw}/`).success).toBe(false);
  });

  it("refuses unresolved nested escapes even below the admission size cap", () => {
    const raw = `https://example.com/%${"25".repeat(1_000)}41`;
    expect(raw.length).toBeLessThan(2_048);
    expect(CleanedUrl.safeParse(raw).success).toBe(false);
    expect(CleanedUrl.safeParse(cleanUrl(raw)).success).toBe(true);
  });
});

describe("SentBookmark", () => {
  it("accepts valid bookmarks, empty titles, and IPv6 domains", () => {
    expect(SentBookmark.safeParse(validBookmark).success).toBe(true);
    expect(SentBookmark.safeParse({ ...validBookmark, title: "" }).success).toBe(true);
    expect(
      SentBookmark.safeParse({
        title: "v6",
        url: "http://[2001:db8::1]/p",
        domain: "[2001:db8::1]",
      }).success,
    ).toBe(true);
  });

  it("rejects mismatched domains, dirty URLs, and stray keys", () => {
    expect(SentBookmark.safeParse({ ...validBookmark, domain: "evil.com" }).success).toBe(false);
    expect(SentBookmark.safeParse({ ...validBookmark, domain: "sub.tokio.rs" }).success).toBe(false);
    expect(SentBookmark.safeParse({ ...validBookmark, domain: "" }).success).toBe(false);
    expect(
      SentBookmark.safeParse({
        title: "x",
        url: "https://tokio.rs/tokio/tutorial/async?utm_source=news",
        domain: "tokio.rs",
      }).success,
    ).toBe(false);

    for (const key of ["notes", "id", "extra"]) {
      expect(SentBookmark.safeParse({ ...validBookmark, [key]: "x" }).success).toBe(false);
    }
  });
});

describe("DecisionState", () => {
  it("accepts valid, minimal, query-only, and root-level states", () => {
    expect(DecisionState.safeParse(validState).success).toBe(true);
    expect(DecisionState.safeParse({ bookmark: validBookmark }).success).toBe(true);
    expect(DecisionState.safeParse({ query: "rust async" }).success).toBe(true);
    expect(DecisionState.safeParse({ bookmark: validBookmark, folderPath: [] }).success).toBe(true);
  });

  it("rejects empty states and states with unknown keys or notes", () => {
    expect(DecisionState.safeParse({}).success).toBe(false);
    expect(DecisionState.safeParse({ bookmark: undefined }).success).toBe(false);

    for (const key of ["notes", "page", "pageText", "excerpt", "bookmarkId", "history", "extra"]) {
      expect(DecisionState.safeParse({ ...validState, [key]: "x" }).success).toBe(false);
    }

    expect(
      DecisionState.safeParse({
        bookmark: { ...validBookmark, notes: "private note" },
      }).success,
    ).toBe(false);
    expect(
      DecisionState.safeParse({
        bookmark: validBookmark,
        pairPartner: { ...validPartner, notes: "private note" },
      }).success,
    ).toBe(false);
  });

  it("rejects dirty URLs at every position", () => {
    const dirtyCases = [
      { bookmark: { ...validBookmark, url: "https://tokio.rs/p?x=1" } },
      { bookmark: { ...validBookmark, url: "https://tokio.rs/p#f" } },
      { bookmark: { ...validBookmark, url: "https://u:p@tokio.rs/p" } },
      { bookmark: validBookmark, pairPartner: { ...validPartner, url: "https://blog.example.com/a?x=1" } },
      {
        bookmark: validBookmark,
        candidateBookmarks: [{ ...validPartner, url: "https://blog.example.com/a#f" }],
      },
    ];
    for (const state of dirtyCases) {
      expect(DecisionState.safeParse(state).success).toBe(false);
    }
  });

  it("refuses path secrets in bookmark, candidate and partner positions", () => {
    for (const url of [
      `https://example.com/s/${"A".repeat(40)}`,
      "https://example.com/p%3Bjsessionid=synthetic-session",
    ]) {
      const bookmark = { title: "Synthetic page", url, domain: "example.com" };
      for (const state of [
        { bookmark },
        { candidateBookmarks: [bookmark] },
        { pairPartner: bookmark },
      ]) {
        expect(DecisionState.safeParse(state).success).toBe(false);
      }
    }
  });

  it("enforces candidate list bounds and rejects empty queries", () => {
    const tags31 = Array.from({ length: 31 }, (_v, i) => ({ name: `t${i}` }));
    expect(DecisionState.safeParse({ bookmark: validBookmark, candidateTags: tags31 }).success).toBe(false);
    expect(DecisionState.safeParse({ bookmark: validBookmark, candidateTags: tags31.slice(0, 30) }).success).toBe(true);

    const folders52 = Array.from({ length: 52 }, (_v, i) => ({ id: `f_${i}`, path: ["a"] }));
    expect(DecisionState.safeParse({ bookmark: validBookmark, candidateFolders: folders52.slice(0, 51) }).success).toBe(true);
    expect(DecisionState.safeParse({ bookmark: validBookmark, candidateFolders: folders52 }).success).toBe(false);

    expect(DecisionState.safeParse({ bookmark: validBookmark, query: "" }).success).toBe(false);
  });

  it("validates CandidateTag and CandidateFolder constraints", () => {
    expect(CandidateTag.safeParse({ name: "", description: "x" }).success).toBe(false);
    expect(CandidateTag.safeParse({ name: "t", nameKey: "t" }).success).toBe(false);
    expect(CandidateFolder.safeParse({ id: "", path: ["a"] }).success).toBe(false);
    expect(CandidateFolder.safeParse({ id: "f", path: [] }).success).toBe(false);
    expect(CandidateFolder.safeParse({ id: "f", path: ["a"], notes: "x" }).success).toBe(false);

    expect(CandidateFolder.safeParse({ id: "f".repeat(64), path: ["a"] }).success).toBe(true);
    expect(CandidateFolder.safeParse({ id: "f".repeat(65), path: ["a"] }).success).toBe(false);
    expect(CandidateFolder.safeParse({ id: "f", path: ["a".repeat(255)] }).success).toBe(true);
    expect(CandidateFolder.safeParse({ id: "f", path: ["a".repeat(256)] }).success).toBe(false);

    expect(
      DecisionState.safeParse({ bookmark: validBookmark, folderPath: ["a".repeat(255)] }).success,
    ).toBe(true);
    expect(
      DecisionState.safeParse({ bookmark: validBookmark, folderPath: ["a".repeat(256)] }).success,
    ).toBe(false);
  });

  it("round-trips through JSON unchanged", () => {
    const parsed = DecisionState.safeParse(
      JSON.parse(JSON.stringify(validState)),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(validState);
  });
});
