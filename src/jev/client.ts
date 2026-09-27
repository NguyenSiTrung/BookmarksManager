import { sendConsented, NetworkGateError } from "../net/send";
import type { NetworkGateErrorCode } from "../net/send";
import type { PresetId } from "../schemas/provider";
import { BudgetError, planBatches } from "./budget";
import {
  isRetryableHttpStatus,
  parseRetryAfter,
  retryDelay,
} from "./retry";
import { UsageMeter } from "./usage";
import { SystemOneRequest, SystemOneResponse } from "./wire";
import type { Answer, SystemOneRequest as SystemOneRequestBody } from "./wire";

/**
 * Hardened Jev client (spec FR3, PROJECT_PLAN.md §8.3). `createJevClient`
 * binds a preset, model, and consent scope; `run()` validates the request,
 * plans budget-conforming batches, sends them through the consented gate
 * (or an injected transport in tests) with bounded concurrency, retries
 * transient failures, validates and cross-checks every response, and returns
 * merged answers plus exact usage accounting.
 *
 * Errors are typed `JevClientError`s. Redaction rules: non-2xx response
 * bodies are never read, `invalid_response` carries no `cause` (a SyntaxError
 * embeds a body snippet and a ZodError's issues carry response values), and
 * mismatch messages name question keys — developer-chosen identifiers — but
 * never instructions, criteria, or state, which may hold bookmark content.
 */

/**
 * Machine-readable failure categories: the HTTP and client-side codes this
 * layer maps itself plus every `NetworkGateErrorCode` — gate refusals are
 * relayed with their own code so callers can act on `no_key`/`no_consent`
 * instead of a generic "gate" error.
 */
export type JevClientErrorCode =
  | "auth"
  | "incompatible"
  | "retry_later"
  | "timeout"
  | "http_error"
  | "invalid_response"
  | "answer_mismatch"
  | "model_mismatch"
  | "too_large"
  | "invalid_request"
  | NetworkGateErrorCode;

/** Every way `run` can fail. Messages are redacted per the module docs. */
export class JevClientError extends Error {
  readonly code: JevClientErrorCode;

  constructor(
    code: JevClientErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "JevClientError";
    this.code = code;
  }
}

/**
 * The send half of the pipeline — the consented gate's signature, minus the
 * fixed fields the client already owns. In tests this is injected (a spy or a
 * thin `fetch` wrapper against the mock server); in production it is
 * `sendConsented`, which re-checks scope, consent, permission, and key on
 * every call.
 */
export type JevTransport = (
  scope: string,
  preset: PresetId,
  model: string,
  request: SystemOneRequestBody,
  options?: { signal?: AbortSignal },
) => Promise<Response>;

export interface JevClientOptions {
  readonly preset: PresetId;
  /** The model id sent in every batch and checked against the allowlist. */
  readonly model: string;
  /** Registered consent scope; today only `"jev_test"` exists. */
  readonly scope: string;
  readonly transport?: JevTransport;
  /** Per-attempt send timeout; the signal is forwarded to the transport. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt (total attempts = 1 + maxRetries). */
  readonly maxRetries?: number;
  /**
   * In-flight send cap, shared per preset across all clients. The first
   * client created for a preset fixes the shared limit — a later client's
   * different value does not change it (reset with `resetJevClientPools`).
   */
  readonly maxConcurrency?: number;
  /** Injectable backoff wait; tests substitute an instant spy. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source for backoff, default `Math.random`. */
  readonly random?: () => number;
  /** Injectable clock for `retry-after` HTTP-date math, default `Date.now`. */
  readonly now?: () => number;
}

export interface JevClient {
  run(request: unknown): Promise<JevRunResult>;
}

export interface JevRunResult {
  /** The versioned model id that answered (consistent across batches). */
  readonly model: string;
  /** Answers merged across batches, in request key order. */
  readonly answers: Record<string, Answer>;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Summed USD cost; absent unless at least one batch reported it. */
    readonly cost?: number;
  };
  /** How many batches the request was split into. */
  readonly batches: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Counting semaphore per preset, shared by every client of that preset so a
 * burst of `run()` calls cannot exceed the provider's concurrency budget.
 * Module state by design — reset between tests via `resetJevClientPools`.
 */
interface PresetPool {
  running: number;
  readonly limit: number;
  readonly queue: Array<() => void>;
}

const pools = new Map<PresetId, PresetPool>();

/** Test/isolation hook: clears all per-preset pools and their waiters. */
export function resetJevClientPools(): void {
  pools.clear();
}

function poolFor(preset: PresetId, limit: number): PresetPool {
  let pool = pools.get(preset);
  if (pool === undefined) {
    pool = { running: 0, limit, queue: [] };
    pools.set(preset, pool);
  }
  return pool;
}

function acquireSlot(pool: PresetPool): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      pool.running += 1;
      resolve(() => releaseSlot(pool));
    };
    if (pool.running < pool.limit) {
      grant();
    } else {
      pool.queue.push(grant);
    }
  });
}

function releaseSlot(pool: PresetPool): void {
  pool.running -= 1;
  pool.queue.shift()?.();
}

/** A send failure classified for retry and final-error reporting. */
interface ClassifiedFailure {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** The JevClientError to throw when the failure is not (or no longer) retried. */
  readonly error: JevClientError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createJevClient(options: JevClientOptions): JevClient {
  const {
    preset,
    model,
    scope,
    transport = sendConsented,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
  } = options;
  const pool = poolFor(preset, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);

  /**
   * Map a thrown transport error onto a retry decision. Returns `undefined`
   * for non-gate errors (e.g. `ProviderKeyError`, already redacted), which
   * propagate to the caller unwrapped — matching `connection.ts`.
   */
  function classifyThrown(
    cause: unknown,
    timedOut: boolean,
  ): ClassifiedFailure | undefined {
    if (timedOut) {
      return {
        retryable: true,
        error: new JevClientError(
          "timeout",
          `The ${scope} request timed out after ${timeoutMs} ms.`,
        ),
      };
    }
    if (!(cause instanceof NetworkGateError)) {
      return undefined;
    }
    if (cause.code === "timeout") {
      return { retryable: true, error: new JevClientError("timeout", cause.message, { cause }) };
    }
    if (cause.code === "transport") {
      return {
        retryable: true,
        error: new JevClientError("transport", cause.message, { cause }),
      };
    }
    // Every other gate refusal is permanent and relays its code verbatim.
    return {
      retryable: false,
      error: new JevClientError(cause.code, cause.message, { cause }),
    };
  }

  /**
   * Inspect a resolved response. Returns `{ok: true}` with the parsed
   * response on success; otherwise `{ok: false}` with a classified failure.
   * Non-2xx bodies are never read — only the `retry-after` header, which
   * cannot carry response content.
   */
  async function inspectResponse(
    response: Response,
    batch: SystemOneRequestBody,
  ): Promise<SendOutcome> {
    const status = response.status;
    if (status < 200 || status >= 300) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
        now(),
      );
      if (isRetryableHttpStatus(status)) {
        return {
          ok: false,
          failure: {
            retryable: true,
            retryAfterMs,
            error: new JevClientError(
              "retry_later",
              `The provider rate limited or overloaded the request (HTTP ${status}). Try again later.`,
            ),
          },
        };
      }
      const code: JevClientErrorCode =
        status === 401 ? "auth" : status === 422 ? "incompatible" : "http_error";
      const messages: Record<string, string> = {
        auth: "The provider rejected the API key (HTTP 401). Check the key and reconnect.",
        incompatible:
          "The provider could not process the request (HTTP 422). The gateway may be incompatible with the System One schema.",
      };
      return {
        ok: false,
        failure: {
          retryable: false,
          error: new JevClientError(
            code,
            messages[code] ??
              `The provider request failed with HTTP status ${status}.`,
          ),
        },
      };
    }

    let parsed: SystemOneResponse;
    try {
      parsed = SystemOneResponse.parse(await response.json());
    } catch {
      // No `cause`: a SyntaxError embeds a body snippet and a ZodError's
      // issues carry response `input` values — either could leak provider
      // content into a logger walking the cause chain.
      return {
        ok: false,
        failure: {
          retryable: false,
          error: new JevClientError(
            "invalid_response",
            "The provider returned a body that is not a valid System One response.",
          ),
        },
      };
    }

    // Cross-check: every requested question answered with the same type, and
    // no unrequested keys — per PROJECT_PLAN.md §8.2.
    const wanted = batch.questions;
    for (const key of Object.keys(parsed.answers)) {
      if (!(key in wanted)) {
        return {
          ok: false,
          failure: {
            retryable: false,
            error: new JevClientError(
              "answer_mismatch",
              `The response answered unrequested question ${JSON.stringify(key)}.`,
            ),
          },
        };
      }
    }
    for (const [key, question] of Object.entries(wanted)) {
      const answer = parsed.answers[key];
      if (answer === undefined) {
        return {
          ok: false,
          failure: {
            retryable: false,
            error: new JevClientError(
              "answer_mismatch",
              `The response is missing an answer for question ${JSON.stringify(key)}.`,
            ),
          },
        };
      }
      if (answer.type !== question.type) {
        return {
          ok: false,
          failure: {
            retryable: false,
            error: new JevClientError(
              "answer_mismatch",
              `The answer for question ${JSON.stringify(key)} has type "${answer.type}" but the question is "${question.type}".`,
            ),
          },
        };
      }
    }
    return { ok: true, response: parsed };
  }

  /** Send one batch with the attempt timeout and the retry policy. */
  async function sendBatch(
    batch: SystemOneRequestBody,
  ): Promise<SystemOneResponse> {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let failure: ClassifiedFailure;
      try {
        const response = await transport(scope, preset, model, batch, {
          signal: controller.signal,
        });
        const outcome = await inspectResponse(response, batch);
        if (outcome.ok) {
          return outcome.response;
        }
        failure = outcome.failure;
      } catch (cause) {
        const classified = classifyThrown(cause, controller.signal.aborted);
        if (classified === undefined) {
          throw cause;
        }
        failure = classified;
      } finally {
        clearTimeout(timer);
      }
      if (!failure.retryable || attempt >= maxRetries) {
        throw failure.error;
      }
      await sleep(
        retryDelay(attempt, { retryAfterMs: failure.retryAfterMs, random }),
      );
      attempt += 1;
    }
  }

  return {
    async run(request: unknown): Promise<JevRunResult> {
      const parsed = SystemOneRequest.safeParse(request);
      if (!parsed.success) {
        // No `cause` — the ZodError's issues would carry the invalid input.
        throw new JevClientError(
          "invalid_request",
          "The request is not a valid System One payload.",
        );
      }
      if (parsed.data.model !== model) {
        throw new JevClientError(
          "invalid_request",
          `Request model ${JSON.stringify(parsed.data.model)} does not match the client's model ${JSON.stringify(model)}.`,
        );
      }
      let batches: SystemOneRequestBody[];
      try {
        batches = planBatches(parsed.data);
      } catch (cause) {
        if (cause instanceof BudgetError) {
          throw new JevClientError(cause.code, cause.message, { cause });
        }
        throw cause;
      }

      const responses = await Promise.all(
        batches.map(async (batch) => {
          const release = await acquireSlot(pool);
          try {
            return await sendBatch(batch);
          } finally {
            release();
          }
        }),
      );

      const meter = new UsageMeter();
      const answers: Record<string, Answer> = {};
      for (const response of responses) {
        meter.add(response.usage, response.model);
        Object.assign(answers, response.answers);
      }
      const models = meter.models;
      if (models.length > 1) {
        throw new JevClientError(
          "model_mismatch",
          `Batches were answered by different models: ${models.join(", ")}.`,
        );
      }
      const usage: { inputTokens: number; outputTokens: number; cost?: number } =
        { inputTokens: meter.inputTokens, outputTokens: meter.outputTokens };
      if (meter.costUsd !== undefined) {
        usage.cost = meter.costUsd;
      }
      return {
        model: models[0] ?? model,
        answers,
        usage,
        batches: batches.length,
      };
    },
  };
}
/** Outcome of inspecting one resolved response. */
type SendOutcome =
  | { readonly ok: true; readonly response: SystemOneResponse }
  | { readonly ok: false; readonly failure: ClassifiedFailure };
