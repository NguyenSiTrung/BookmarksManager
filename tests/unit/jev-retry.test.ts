import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  isRetryable,
  isRetryableHttpStatus,
  parseRetryAfter,
  retryDelay,
} from "../../src/jev/retry";

/**
 * Pure retry-policy tests (spec FR3 / PROJECT_PLAN.md §8.3). Everything is
 * deterministic because randomness is injected — no fake timers are needed.
 */

describe("isRetryableHttpStatus", () => {
  it("retries 429 and 529", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(529)).toBe(true);
  });

  it("retries 5xx statuses", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it("does not retry 2xx, 3xx, or other 4xx statuses", () => {
    for (const status of [200, 204, 301, 400, 401, 403, 404, 422]) {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  });
});

describe("isRetryable", () => {
  it("retries retryable HTTP statuses", () => {
    for (const httpStatus of [429, 500, 503, 529]) {
      expect(isRetryable({ httpStatus })).toBe(true);
    }
  });

  it("retries timeout and transport failures", () => {
    expect(isRetryable({ timeout: true })).toBe(true);
    expect(isRetryable({ transport: true })).toBe(true);
    expect(isRetryable({ timeout: true, transport: true })).toBe(true);
  });

  it("does not retry 401, 404, or 422", () => {
    for (const httpStatus of [401, 404, 422]) {
      expect(isRetryable({ httpStatus })).toBe(false);
    }
  });

  it("never retries permanent failures, even beside retryable signals", () => {
    expect(isRetryable({ permanent: true })).toBe(false);
    expect(isRetryable({ permanent: true, httpStatus: 503 })).toBe(false);
    expect(isRetryable({ permanent: true, timeout: true })).toBe(false);
  });

  it("does not retry an empty failure", () => {
    expect(isRetryable({})).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  // Fixed instant, divisible by 1000 so HTTP-date's second granularity is exact.
  const NOW = 1_700_000_000_000;

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("3", NOW)).toBe(3000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter(" 12 ", NOW)).toBe(12_000);
  });

  it("parses an HTTP-date relative to now", () => {
    const inTenSeconds = new Date(NOW + 10_000).toUTCString();
    expect(parseRetryAfter(inTenSeconds, NOW)).toBe(10_000);
  });

  it("clamps a past HTTP-date to zero", () => {
    const tenSecondsAgo = new Date(NOW - 10_000).toUTCString();
    expect(parseRetryAfter(tenSecondsAgo, NOW)).toBe(0);
  });

  it("rejects missing and garbage values", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter("", NOW)).toBeUndefined();
    expect(parseRetryAfter("   ", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    // Neither delta-seconds (non-negative integers per RFC 9110) nor
    // HTTP-dates — even though Date.parse would leniently read some of
    // these as year-2001 dates.
    expect(parseRetryAfter("-5", NOW)).toBeUndefined();
    expect(parseRetryAfter("1.5", NOW)).toBeUndefined();
    expect(parseRetryAfter("3.0", NOW)).toBeUndefined();
  });
});

describe("retryDelay", () => {
  it("returns 0 when the injected random is 0", () => {
    expect(retryDelay(0, { random: () => 0 })).toBe(0);
    expect(retryDelay(5, { random: () => 0 })).toBe(0);
  });

  it("approaches the full bound when random nears 1", () => {
    // attempt 0 → ceiling = baseMs = 500; random() * ceiling with random()=1.
    expect(retryDelay(0, { random: () => 1 })).toBe(DEFAULT_BASE_DELAY_MS);
  });

  it("grows exponentially with the attempt index", () => {
    const ceilingAt = (attempt: number) =>
      retryDelay(attempt, { random: () => 1 });
    expect(ceilingAt(0)).toBe(500);
    expect(ceilingAt(1)).toBe(1000);
    expect(ceilingAt(2)).toBe(2000);
    expect(ceilingAt(3)).toBe(4000);
  });

  it("scales linearly inside the bound", () => {
    expect(retryDelay(2, { random: () => 0.5 })).toBe(1000);
  });

  it("caps the exponential bound at maxMs", () => {
    // attempt 12 → 500 * 2**12 = 2_048_000, capped to the 30 s default.
    expect(retryDelay(12, { random: () => 1 })).toBe(DEFAULT_MAX_DELAY_MS);
    expect(retryDelay(12, { random: () => 0.5 })).toBe(DEFAULT_MAX_DELAY_MS / 2);
    expect(retryDelay(3, { random: () => 1, maxMs: 2500 })).toBe(2500);
  });

  it("honors retryAfterMs exactly, ignoring jitter", () => {
    expect(retryDelay(0, { retryAfterMs: 5000, random: () => 0 })).toBe(5000);
    expect(retryDelay(2, { retryAfterMs: 750 })).toBe(750);
  });

  it("caps retryAfterMs at maxMs", () => {
    expect(retryDelay(0, { retryAfterMs: 60_000 })).toBe(DEFAULT_MAX_DELAY_MS);
    expect(retryDelay(0, { retryAfterMs: 60_000, maxMs: 10_000 })).toBe(10_000);
  });

  it("honors a custom baseMs", () => {
    expect(retryDelay(2, { random: () => 1, baseMs: 100 })).toBe(400);
  });
});
