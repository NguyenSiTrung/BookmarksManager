/**
 * Retry policy for the hardened Jev client (spec FR3, PROJECT_PLAN.md §8.3):
 * exponential backoff with full jitter on `429`, `529`, `5xx`, timeouts, and
 * transport errors, honoring `retry-after` (capped). There is no retry on
 * `401`, `422`, other 4xx, invalid responses, or gate refusals.
 *
 * The module is deliberately pure and dependency-free: the client classifies
 * its own errors (HTTP status, abort, `NetworkGateError` transport code, …)
 * onto `RetryableFailure` rather than this module importing `src/net/send.ts`.
 * Time and randomness are injectable so tests are deterministic.
 */

/**
 * Structural failure classification the client maps its errors onto. Every
 * flag is optional; the combination { permanent: true } wins over any
 * retryable signal that happens to be set alongside it.
 */
export interface RetryableFailure {
  /** HTTP status when the failure carried one. */
  readonly httpStatus?: number;
  /** Aborted or timed-out send. */
  readonly timeout?: boolean;
  /** Fetch-level failure (includes the gate's `transport` code). */
  readonly transport?: boolean;
  /**
   * Auth, 422/other 4xx, invalid response, gate refusals, mismatches —
   * anything a retry cannot fix.
   */
  readonly permanent?: boolean;
}

/** Base of the exponential backoff: the attempt-0 ceiling. */
export const DEFAULT_BASE_DELAY_MS = 500;

/** Ceiling for both the backoff and an honored `retry-after`. */
export const DEFAULT_MAX_DELAY_MS = 30_000;

/** 429, 529, or any 5xx — the HTTP statuses worth retrying. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

/**
 * Whether a classified failure is worth retrying: `permanent` never is;
 * `timeout` and `transport` always are (a retry may land on a healthy
 * connection); otherwise the HTTP status decides. The default is no retry.
 */
export function isRetryable(failure: RetryableFailure): boolean {
  if (failure.permanent === true) {
    return false;
  }
  if (failure.timeout === true || failure.transport === true) {
    return true;
  }
  if (failure.httpStatus !== undefined) {
    return isRetryableHttpStatus(failure.httpStatus);
  }
  return false;
}

/**
 * Parse a `retry-after` header value into a millisecond delay.
 *
 * Per RFC 9110 the value is either delta-seconds (a non-negative integer) or
 * an HTTP-date. Delta-seconds is tried first; the date branch requires a
 * letter so that non-date garbage Date.parse would leniently accept as a
 * year-2001 timestamp (`"1.5"`, `"-5"`, `"+3"`) is rejected instead. A date
 * in the past clamps to 0. Anything unparseable returns `undefined`, telling
 * the caller to fall back to backoff.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (header === null || header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // All three HTTP-date formats (IMF-fixdate, RFC 850, asctime) contain day
  // or month names, so a letterless non-integer value cannot be a date.
  if (!/[a-zA-Z]/.test(trimmed)) {
    return undefined;
  }
  const atMs = Date.parse(trimmed);
  if (Number.isNaN(atMs)) {
    return undefined;
  }
  return Math.max(0, atMs - nowMs);
}

/**
 * Milliseconds to wait before the next attempt (`attempt` is the 0-based
 * retry index).
 *
 * A provided `retryAfterMs` is honored exactly and capped at `maxMs` — the
 * provider's hint beats jitter but cannot push the wait past the ceiling.
 * Otherwise full jitter applies: a uniform draw from
 * `[0, min(maxMs, baseMs * 2 ** attempt))`, so the expected wait is half the
 * exponential bound and competing clients spread out.
 */
export function retryDelay(
  attempt: number,
  opts: {
    retryAfterMs?: number;
    baseMs?: number;
    maxMs?: number;
    random?: () => number;
  } = {},
): number {
  const maxMs = opts.maxMs ?? DEFAULT_MAX_DELAY_MS;
  if (opts.retryAfterMs !== undefined) {
    return Math.min(maxMs, opts.retryAfterMs);
  }
  const baseMs = opts.baseMs ?? DEFAULT_BASE_DELAY_MS;
  const random = opts.random ?? Math.random;
  return random() * Math.min(maxMs, baseMs * 2 ** attempt);
}

/**
 * Longest single in-worker wait (J03): MV3 evicts an idle service worker
 * around 30s, so no one `setTimeout` may park it past that boundary. Job
 * waits use the same cap ({@link BREAKER_WAIT_CHUNK_MS} in the runner).
 */
export const MAX_IN_WORKER_SLEEP_MS = 15_000;

/**
 * Await `ms` through `sleep` in slices no longer than
 * {@link MAX_IN_WORKER_SLEEP_MS}. The total delay is preserved — an honored
 * `retry-after` is still waited in full, just never as one over-long
 * in-worker wait that eviction could cut short.
 */
export async function sleepCapped(
  ms: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_IN_WORKER_SLEEP_MS);
    await sleep(chunk);
    remaining -= chunk;
  }
}
