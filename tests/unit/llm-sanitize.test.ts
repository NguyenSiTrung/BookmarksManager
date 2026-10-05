import { describe, expect, it } from "vitest";
import { stripUrlsAndMarkdown } from "../../src/llm/sanitize";

describe("stripUrlsAndMarkdown (H05)", () => {
  it("keeps the visible label of markdown links and drops the target", () => {
    expect(stripUrlsAndMarkdown("See [the docs](https://evil.example/x)."))
      .toBe("See the docs.");
    expect(stripUrlsAndMarkdown("![image](https://tracker.example/i.png)"))
      .toBe("image");
  });

  it("removes bare URLs of any scheme, protocol-relative and www. forms", () => {
    expect(stripUrlsAndMarkdown("go to https://evil.example/p now"))
      .toBe("go to now");
    expect(stripUrlsAndMarkdown("ftp://files.example/a chrome-extension://id/x"))
      .toBe("");
    expect(stripUrlsAndMarkdown("check //cdn.example/lib.js and www.evil.example/x"))
      .toBe("check and");
  });

  it("strips structural markdown, emphasis, and leftover brackets", () => {
    expect(
      stripUrlsAndMarkdown("## Title\n> quote\n- item\n* **bold** _it_ `code` ~x~"),
    ).toBe("Title\nquote\nitem\nbold it code x");
    expect(stripUrlsAndMarkdown("a (stray) [bracket]")).toBe("a stray bracket");
  });

  it("strips control characters but keeps tabs/newlines", () => {
    expect(stripUrlsAndMarkdown("a\u0000b\u001fc")).toBe("abc");
    expect(stripUrlsAndMarkdown("line1\nline2\tcol")).toBe("line1\nline2\tcol");
  });

  it("collapses whitespace runs without joining lines", () => {
    expect(stripUrlsAndMarkdown("a   b\n\n\n\nc")).toBe("a b\n\nc");
    expect(stripUrlsAndMarkdown("  padded  ")).toBe("padded");
  });

  it("is idempotent on already-clean text", () => {
    const clean = "A plain summary about caching layers.";
    expect(stripUrlsAndMarkdown(clean)).toBe(clean);
    const once = stripUrlsAndMarkdown("[x](https://e) **b** https://f.io");
    expect(stripUrlsAndMarkdown(once)).toBe(once);
  });

  it("leaves ordinary punctuation and unicode untouched", () => {
    expect(stripUrlsAndMarkdown("Café — 50% faster, yes/no!")).toBe(
      "Café — 50% faster, yes/no!",
    );
  });
});
