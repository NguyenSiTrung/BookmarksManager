import { JevClientError, createJevClient } from "./client";
import type { JevClientErrorCode } from "./client";
import { makeSyntheticRequest } from "./wire";

/**
 * The Options Test-connection path (PROJECT_PLAN.md §8.5 step 5) built on the
 * hardened client: `testJevConnection` runs exactly one fixed synthetic
 * `jev_test` request through the consented gate — it never touches keys,
 * consent, permissions, or `fetch` itself — with no retries (`maxRetries: 0`).
 * The client already schema-validates the response and cross-checks that the
 * `test` question has a same-typed answer, so a missing or mismatched answer
 * surfaces as `answer_mismatch`, which this layer reports as the established
 * `invalid_response` code to keep the outward contract stable.
 */

/**
 * Machine-readable failure categories for the connection test: every
 * `JevClientErrorCode` — HTTP categories, gate refusals relayed unflattened
 * (`no_key`, `no_consent`, `timeout`, …), and client-side codes
 * (`answer_mismatch`, `model_mismatch`, `too_large`, `invalid_request`).
 * The mismatch codes are mapped to `invalid_response` before they leave
 * `testJevConnection`, so they remain in the union only for totality.
 */
export type JevConnectionErrorCode = JevClientErrorCode;

/**
 * Every way the connection test can fail. Messages are deliberately redacted:
 * they never carry key material, request bodies, or response bodies — at most
 * an HTTP status number or a question key.
 */
export class JevConnectionError extends Error {
  readonly code: JevConnectionErrorCode;

  constructor(
    code: JevConnectionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "JevConnectionError";
    this.code = code;
  }
}

/** What a successful synthetic test reports back to the Options UI. */
export interface JevConnectionSuccess {
  /** The versioned model id the provider says answered the request. */
  readonly model: string;
  /** Wall-clock milliseconds around the client run. */
  readonly latencyMs: number;
  /** USD cost reported by `usage.cost` — present for OpenRouter only. */
  readonly cost?: number;
}

/**
 * Preserve the outward contract: the client's structural answer failures are
 * the "provider returned something unusable" category the connection API has
 * always reported as `invalid_response`. Every other code relays verbatim.
 */
function toConnectionCode(code: JevClientErrorCode): JevConnectionErrorCode {
  switch (code) {
    case "answer_mismatch":
    case "model_mismatch":
      return "invalid_response";
    default:
      return code;
  }
}

/**
 * Send the fixed synthetic System One request through the hardened client
 * (scope `jev_test`, no retries) and return the answering model, latency, and
 * optional reported cost. Throws `JevConnectionError` for every expected
 * failure mode — a `JevClientError` is re-thrown carrying the client's code
 * (mismatches folded to `invalid_response`) — while non-client errors thrown
 * inside the gate (e.g. `ProviderKeyError`, already redacted) propagate
 * unwrapped.
 */
export async function testJevConnection(
  providerId: string,
  model: string,
): Promise<JevConnectionSuccess> {
  const startedAt = Date.now();
  const client = createJevClient({
    providerId,
    model,
    scope: "jev_test",
    maxRetries: 0,
  });
  let result: Awaited<ReturnType<typeof client.run>>;
  try {
    result = await client.run(makeSyntheticRequest(model));
  } catch (cause) {
    if (cause instanceof JevClientError) {
      // Client codes and messages are already redacted — preserve both so a
      // refusal like `no_key` reaches the user as itself.
      throw new JevConnectionError(toConnectionCode(cause.code), cause.message, {
        cause,
      });
    }
    throw cause;
  }
  const latencyMs = Date.now() - startedAt;

  // The client already verified a same-typed "test" answer exists; this
  // reach confirms the success payload carries what the UI reports on.
  const testAnswer = result.answers["test"];
  if (testAnswer === undefined || testAnswer.type !== "noul") {
    throw new JevConnectionError(
      "invalid_response",
      'The provider response did not include a "noul" answer for the "test" question.',
    );
  }

  const success: { model: string; latencyMs: number; cost?: number } = {
    model: result.model,
    latencyMs,
  };
  if (result.usage.cost !== undefined) {
    success.cost = result.usage.cost;
  }
  return success;
}
