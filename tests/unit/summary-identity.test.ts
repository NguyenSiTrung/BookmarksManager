import { describe, expect, it } from "vitest";
import { sameSummaryResource, summaryResourceKey } from "../../src/decisions/summary-identity";

describe("summary resource identity", () => {
  it.each([
    ["https://video.dev/watch?v=A", "https://video.dev/watch?v=B", false],
    ["https://ref.dev/p?utm_source=x", "https://ref.dev/p", true],
    ["https://ref.dev/p?utm=x&utm_medium=y&gclid=z&fbclid=x&msclkid=z", "https://ref.dev/p", true],
    ["https://ref.dev/p?%75tm_source=x&id=A", "https://ref.dev/p?id=A", true],
    ["https://ref.dev/p?utmish=x", "https://ref.dev/p", false],
    ["https://ref.dev/p?ref=x", "https://ref.dev/p", false],
    ["https://ref.dev/p?id=A&id=B", "https://ref.dev/p?id=B&id=A", false],
    ["https://ref.dev/p?a=1&b=2", "https://ref.dev/p?b=2&a=1", false],
    ["https://ref.dev/p?q=a%20b", "https://ref.dev/p?q=a+b", false],
    ["https://ref.dev/p?flag", "https://ref.dev/p?flag=", false],
    ["https://app.dev/#/item/A", "https://app.dev/#/item/B", false],
    ["https://app.dev/#!/item/A", "https://app.dev/#!/item/B", false],
    ["https://ref.dev/p#section", "https://ref.dev/p#other", false],
    ["https://ref.dev/p#section", "https://ref.dev/p#section", true],
    ["https://REF.dev:443/a/../p", "https://ref.dev/p", true],
    ["https://ref.dev:444/p", "https://ref.dev/p", false],
    ["http://ref.dev/p", "https://ref.dev/p", false],
    ["https://ref.dev/p", "https://other.dev/p", false],
    ["https://ref.dev/p/", "https://ref.dev/p", false],
    ["https://ref.dev/p?utm_source=x#same", "https://ref.dev/p#same", true],
  ] as const)("matches %s against %s as %s", (saved, active, expected) => {
    expect(sameSummaryResource(saved, active)).toBe(expected);
  });

  it.each([
    "not-a-url", "javascript:alert(1)", "file:///page",
    "ftp://ref.dev/page", "https://127.0.0.1/page", "https://host.local/page",
  ])("refuses unsupported or unsendable identity %s", (url) => {
    expect(summaryResourceKey(url)).toBeNull();
    expect(sameSummaryResource(url, url)).toBe(false);
  });

  it("removes only tracking parameters without rewriting remaining query data", () => {
    expect(summaryResourceKey("https://REF.dev:443/p?utm_source=x&id=A&id=B&q=a%20b#route"))
      .toBe("https://ref.dev/p?id=A&id=B&q=a%20b#route");
  });
});
