import {
  NetworkGateError,
  type NetworkGateErrorCode,
  sendConsentedTest,
} from "../net/send";
import type { PresetId } from "../schemas/provider";
import { SystemOneResponse } from "./wire";

/**
 * The Phase 3 Options Test-connection path (PROJECT_PLAN.md §8.5 step 5).
 * `testJevConnection` sends exactly one fixed synthetic request through the
 * consented gate — it never touches keys, consent, permissions, or `fetch`
 * itself — then validates the response against `SystemOneResponse` and checks
 * that the `test` question was answered with a `noul` variant (a missing or
 * mismatched answer is an error, like Pydantic AI's `UnexpectedModelBehavior`).
 */

/**
 * Machine-readable failure categories for the connection test: the HTTP
 * categories this client maps itself plus every `NetworkGateErrorCode` —
 * gate refusals are relayed with their own code (`no_key`, `no_consent`, …)
 * instead of collapsing to a single "gate" so the UI can show actionable
 * guidance.
 */
export type JevConnectionErrorCode =
  | "auth"
  | "incompatible"
  | "retry_later"
  | "invalid_response"
  | "http_error"
  | NetworkGateErrorCode;

/**
 * Every way the connection test can fail. Messages are deliberately redacted:
 * they never carry key material, request bodies, or response bodies — at most
 * an HTTP status number.
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
  /** Wall-clock milliseconds around the gated send. */
  readonly latencyMs: number;
  /** USD cost reported by `usage.cost` — present for OpenRouter only. */
  readonly cost?: number;
}

/** Map an HTTP failure status to a redacted error; bodies are never read. */
function httpStatusError(status: number): JevConnectionError {
  switch (status) {
    case 401:
      return new JevConnectionError(
        "auth",
        "The provider rejected the API key (HTTP 401). Check the key and reconnect.",
      );
    case 422:
      return new JevConnectionError(
        "incompatible",
        "The provider could not process the request (HTTP 422). The gateway may be incompatible with the System One schema.",
      );
    case 429:
      return new JevConnectionError(
        "retry_later",
        "The provider is rate limiting requests (HTTP 429). Try again later.",
      );
    case 529:
      return new JevConnectionError(
        "retry_later",
        "The provider is overloaded (HTTP 529). Try again later.",
      );
    default:
      return new JevConnectionError(
        "http_error",
        `The provider test request failed with HTTP status ${status}.`,
      );
  }
}

/**
 * Send one synthetic System One request via the consented gate and validate
 * the answer. Throws `JevConnectionError` for every expected failure mode —
 * a `NetworkGateError` is re-thrown carrying the gate's own code — while
 * non-gate errors thrown inside the gate (e.g. `ProviderKeyError`, already
 * redacted) propagate unwrapped.
 */
export async function testJevConnection(
  preset: PresetId,
  model: string,
): Promise<JevConnectionSuccess> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await sendConsentedTest(preset, model);
  } catch (cause) {
    if (cause instanceof NetworkGateError) {
      // Gate codes and messages are already redacted — preserve both
      // verbatim so a refusal like `no_key` reaches the user as itself.
      throw new JevConnectionError(cause.code, cause.message, { cause });
    }
    throw cause;
  }
  const latencyMs = Date.now() - startedAt;

  // For HTTP failures the body is never read, so no response content can
  // leak into an error message.
  if (response.status < 200 || response.status >= 300) {
    throw httpStatusError(response.status);
  }

  let parsed: SystemOneResponse;
  try {
    parsed = SystemOneResponse.parse(await response.json());
  } catch {
    // No `cause` here: a SyntaxError embeds a body snippet and a ZodError's
    // issues carry response `input` values — either would leak provider
    // content into any logger that walks the cause chain.
    throw new JevConnectionError(
      "invalid_response",
      "The provider returned a body that is not a valid System One response.",
    );
  }

  // Every question key must have a same-type answer (PROJECT_PLAN.md §8.2);
  // the synthetic request asks exactly one `noul` question named "test".
  const testAnswer = parsed.answers["test"];
  if (testAnswer === undefined || testAnswer.type !== "noul") {
    throw new JevConnectionError(
      "invalid_response",
      'The provider response did not include a "noul" answer for the "test" question.',
    );
  }

  const result: { model: string; latencyMs: number; cost?: number } = {
    model: parsed.model,
    latencyMs,
  };
  if (parsed.usage.cost !== undefined) {
    result.cost = parsed.usage.cost;
  }
  return result;
}
