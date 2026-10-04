import { describe, expect, it } from "vitest";
import { cleanUrl } from "../../src/decisions/minimize";
import { sameSummaryResource, summaryResourceKey } from "../../src/decisions/summary-identity";

describe("path minimization never defines local summary identity", () => {
  it.each([
    ["https://example.com/p;jsessionid=synthetic-A", "https://example.com/p;jsessionid=synthetic-B"],
    ["https://example.com/p%3Bjsessionid=synthetic-A", "https://example.com/p%3Bjsessionid=synthetic-B"],
    [`https://example.com/s/${"A".repeat(40)}`, `https://example.com/s/${"B".repeat(40)}`],
    [`https://example.com/s/${"%41".repeat(40)}`, `https://example.com/s/${"%42".repeat(40)}`],
  ])("keeps distinct raw resources distinct: %s vs %s", (saved, active) => {
    expect(cleanUrl(saved)).toBe(cleanUrl(active));
    expect(summaryResourceKey(saved)).toBe(saved);
    expect(summaryResourceKey(active)).toBe(active);
    expect(sameSummaryResource(saved, active)).toBe(false);
    expect(sameSummaryResource(saved, saved)).toBe(true);
  });

  it("still removes only permitted local tracking parameters", () => {
    const raw = `https://example.com/s/${"A".repeat(40)};jsessionid=synthetic-session`;
    expect(summaryResourceKey(`${raw}?utm_source=synthetic&id=A#route`)).toBe(`${raw}?id=A#route`);
    expect(sameSummaryResource(`${raw}?utm_source=synthetic&id=A#route`, `${raw}?id=A#route`)).toBe(true);
    expect(sameSummaryResource(`${raw}?id=A#route`, `${raw}?id=B#route`)).toBe(false);
  });
});
