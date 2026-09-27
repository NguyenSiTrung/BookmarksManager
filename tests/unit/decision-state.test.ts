import { describe, expect, it } from "vitest";
import {
  CandidateFolder,
  CandidateTag,
  CleanedUrl,
  DecisionState,
  SentBookmark,
} from "../../src/schemas/decision-state";

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
  it.each([
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
  ])("accepts already-clean %j", (url) => {
    expect(CleanedUrl.safeParse(url).success).toBe(true);
  });

  it.each([
    ["query string", "https://example.com/p?a=1&b=2"],
    ["empty-value query", "https://example.com/p?q="],
    ["bare query marker", "https://example.com/p?"],
    ["fragment", "https://example.com/p#section"],
    ["bare fragment marker", "https://example.com/p#"],
    ["query and fragment markers", "https://example.com/?#f"],
    ["user and password", "https://user:pass@example.com/p"],
    ["user only", "https://user@example.com/p"],
    ["credentials in a non-http scheme", "ftp://u:p@files.example.com/"],
    ["relative URL", "example.com/path"],
    ["plain host", "example.com"],
    ["non-URL text", "not a url"],
    ["empty string", ""],
    ["query on a non-hierarchical scheme", "data:text/plain,x?y=1"],
    ["literal tab (parser silently strips it)", "https://exa\tmple.com/"],
    ["literal newline", "https://example.com/\n"],
    ["literal carriage return", "https://example.com/\r"],
    ["literal space in the path", "https://example.com/a b"],
    ["literal NUL", "https://example.com/\u0000"],
    ["literal DEL", "https://example.com/\u007f"],
  ])("rejects %s %j", (_label, url) => {
    expect(CleanedUrl.safeParse(url).success).toBe(false);
  });
});

describe("SentBookmark", () => {
  it("accepts a valid bookmark", () => {
    expect(SentBookmark.safeParse(validBookmark).success).toBe(true);
  });

  it("accepts an empty title (Chrome permits untitled bookmarks)", () => {
    expect(
      SentBookmark.safeParse({ ...validBookmark, title: "" }).success,
    ).toBe(true);
  });

  it("accepts an IPv6 domain matching the bracketed hostname", () => {
    expect(
      SentBookmark.safeParse({
        title: "v6",
        url: "http://[2001:db8::1]/p",
        domain: "[2001:db8::1]",
      }).success,
    ).toBe(true);
  });

  it("rejects a domain that does not equal the url hostname", () => {
    expect(
      SentBookmark.safeParse({ ...validBookmark, domain: "evil.com" }).success,
    ).toBe(false);
    expect(
      SentBookmark.safeParse({ ...validBookmark, domain: "sub.tokio.rs" })
        .success,
    ).toBe(false);
  });

  it("rejects an empty domain", () => {
    expect(
      SentBookmark.safeParse({ ...validBookmark, domain: "" }).success,
    ).toBe(false);
  });

  it("rejects a dirty url even when domain is consistent", () => {
    expect(
      SentBookmark.safeParse({
        title: "x",
        url: "https://tokio.rs/tokio/tutorial/async?utm_source=news",
        domain: "tokio.rs",
      }).success,
    ).toBe(false);
  });

  it.each(["notes", "id", "extra"])("rejects a stray %j key", (key) => {
    expect(
      SentBookmark.safeParse({ ...validBookmark, [key]: "x" }).success,
    ).toBe(false);
  });
});

describe("DecisionState", () => {
  it("accepts a fully-populated state", () => {
    expect(DecisionState.safeParse(validState).success).toBe(true);
  });

  it("accepts a minimal bookmark-only state", () => {
    expect(
      DecisionState.safeParse({ bookmark: validBookmark }).success,
    ).toBe(true);
  });

  it("accepts a query-only state (Ask rerank carries candidates per question)", () => {
    expect(DecisionState.safeParse({ query: "rust async" }).success).toBe(
      true,
    );
  });

  it("accepts an empty folderPath (a root-level bookmark)", () => {
    expect(
      DecisionState.safeParse({ bookmark: validBookmark, folderPath: [] })
        .success,
    ).toBe(true);
  });

  it("rejects a completely empty state", () => {
    expect(DecisionState.safeParse({}).success).toBe(false);
    // An undefined-valued key serializes to nothing — still empty.
    expect(
      DecisionState.safeParse({ bookmark: undefined }).success,
    ).toBe(false);
  });

  it.each([
    "notes",
    "page",
    "pageText",
    "excerpt",
    "bookmarkId",
    "history",
    "extra",
  ])("rejects a state carrying unknown key %j", (key) => {
    expect(
      DecisionState.safeParse({ ...validState, [key]: "x" }).success,
    ).toBe(false);
  });

  it("rejects notes at every level", () => {
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
    expect(
      DecisionState.safeParse({
        bookmark: validBookmark,
        notes: "private note",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["bookmark.url query", { bookmark: { ...validBookmark, url: "https://tokio.rs/p?x=1" } }],
    ["bookmark.url fragment", { bookmark: { ...validBookmark, url: "https://tokio.rs/p#f" } }],
    ["bookmark.url userinfo", { bookmark: { ...validBookmark, url: "https://u:p@tokio.rs/p" } }],
    ["pairPartner.url query", { bookmark: validBookmark, pairPartner: { ...validPartner, url: "https://blog.example.com/a?x=1" } }],
    [
      "candidateBookmarks[].url query",
      {
        bookmark: validBookmark,
        candidateBookmarks: [
          { ...validPartner, url: "https://blog.example.com/a#f" },
        ],
      },
    ],
  ])("rejects a dirty url in %s", (_label, state) => {
    expect(DecisionState.safeParse(state).success).toBe(false);
  });

  it("rejects candidateTags over the 30-candidate cap", () => {
    const tags = Array.from({ length: 31 }, (_v, i) => ({ name: `t${i}` }));
    expect(
      DecisionState.safeParse({ bookmark: validBookmark, candidateTags: tags })
        .success,
    ).toBe(false);
    expect(
      DecisionState.safeParse({
        bookmark: validBookmark,
        candidateTags: tags.slice(0, 30),
      }).success,
    ).toBe(true);
  });

  it("rejects candidateFolders over the 50-candidate cap", () => {
    const folders = Array.from({ length: 51 }, (_v, i) => ({
      id: `f_${i}`,
      path: ["a"],
    }));
    expect(
      DecisionState.safeParse({
        bookmark: validBookmark,
        candidateFolders: folders,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty query", () => {
    expect(
      DecisionState.safeParse({ bookmark: validBookmark, query: "" }).success,
    ).toBe(false);
  });

  it("rejects malformed candidates", () => {
    expect(
      CandidateTag.safeParse({ name: "", description: "x" }).success,
    ).toBe(false);
    expect(CandidateTag.safeParse({ name: "t", nameKey: "t" }).success).toBe(
      false,
    );
    expect(
      CandidateFolder.safeParse({ id: "", path: ["a"] }).success,
    ).toBe(false);
    expect(CandidateFolder.safeParse({ id: "f", path: [] }).success).toBe(
      false,
    );
    expect(
      CandidateFolder.safeParse({ id: "f", path: ["a"], notes: "x" }).success,
    ).toBe(false);
  });

  it("bounds candidate folder ids and path segments", () => {
    expect(
      CandidateFolder.safeParse({ id: "f".repeat(64), path: ["a"] }).success,
    ).toBe(true);
    expect(
      CandidateFolder.safeParse({ id: "f".repeat(65), path: ["a"] }).success,
    ).toBe(false);
    expect(
      CandidateFolder.safeParse({ id: "f", path: ["a".repeat(255)] }).success,
    ).toBe(true);
    expect(
      CandidateFolder.safeParse({ id: "f", path: ["a".repeat(256)] }).success,
    ).toBe(false);
  });

  it("bounds folderPath segments", () => {
    expect(
      DecisionState.safeParse({
        bookmark: validBookmark,
        folderPath: ["a".repeat(255)],
      }).success,
    ).toBe(true);
    expect(
      DecisionState.safeParse({
        bookmark: validBookmark,
        folderPath: ["a".repeat(256)],
      }).success,
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
