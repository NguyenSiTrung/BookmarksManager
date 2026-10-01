import {
  LlmGateError,
  parseLlmUsage,
  readLlmErrorBody,
  sendLlmConsented,
  settleLlmUsage,
} from "../net/llm-send";
import { LlmCapabilityError } from "./structured";
import type { ActualUsage, RequestKind } from "./budget";
import type { ConsentScope } from "../schemas/provider";
import { z } from "../schemas/z";

/** HTTP-level failure: status code only — response bodies never leak. */
export class LlmHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

/** Configuration for a client's `send`: the scope/kind/cost inputs every
 *  request under this client shares. */
export interface LlmClientConfig {
  readonly scope: ConsentScope;
  readonly kind: RequestKind;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly unknownCostConfirmed?: boolean;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  /** Feature admission rerun by the gate before every fetch attempt. */
  readonly beforeSend?: () => Promise<void>;
}

/** Statuses that may mean "structured output unsupported" — the engine's
 *  tier fallback signal — when the body also names the offending field. */
const CAPABILITY_STATUS = new Set([400, 404, 422]);
const CAPABILITY_HINT = /response_format|json_schema|structured output/i;
const CAPABILITY_FIELDS = new Set(["response_format", "json_schema"]);
const REJECTION_HINT = /unsupported|not[\s_]+supported/i;
const TOKEN_LIMIT_HINT = /max_tokens|max_completion_tokens|max_output_tokens|max_new_tokens/i;
const ErrorEnvelope = z.object({
  error: z.union([
    z.string().min(1),
    z.strictObject({
      message: z.string().min(1),
      param: z.string().nullable().optional(),
      code: z.string().nullable().optional(),
      type: z.string().nullable().optional(),
    }),
  ]),
});
function capabilityRejected(text: string | null): boolean {
  if (text === null || TOKEN_LIMIT_HINT.test(text)) return false;
  try {
    const parsed = ErrorEnvelope.safeParse(JSON.parse(text));
    if (!parsed.success) return false;
    const error = parsed.data.error;
    if (typeof error === "string") {
      return !TOKEN_LIMIT_HINT.test(error) &&
        CAPABILITY_HINT.test(error) && REJECTION_HINT.test(error);
    }
    // An explicit unrelated offending field makes a message mention ambiguous.
    if (error.param != null && !CAPABILITY_FIELDS.has(error.param)) return false;
    const hints = [error.message, error.param, error.code, error.type].join(" ");
    return !TOKEN_LIMIT_HINT.test(hints) &&
      CAPABILITY_HINT.test(hints) && REJECTION_HINT.test(hints);
  } catch {
    return false;
  }
}

/** Raw text lives only inside classification; callers retain booleans/numbers. */
async function errorDetails(response: Response): Promise<{
  capabilityRejected: boolean;
  usage: ActualUsage;
}> {
  const text = await readLlmErrorBody(response);
  let usage: ActualUsage = {};
  if (text !== null) {
    try {
      usage = parseLlmUsage(JSON.parse(text));
    } catch {
      // Malformed JSON has unknown usage; never retain its native cause.
    }
  }
  return {
    capabilityRejected: CAPABILITY_STATUS.has(response.status) && capabilityRejected(text),
    usage,
  };
}

/**
 * An OpenAI-compatible client for one configured provider. Every `send`
 * passes the whole egress gate (consent, exact-origin permission,
 * credential, budget reservation), parses the wire response, settles the
 * reservation with the returned usage, and throws `LlmCapabilityError` only
 * when the response signals unsupported structured output — the structured
 * engine's tier-fallback trigger. All other HTTP failures surface as
 * `LlmHttpError` with a status code and no body text.
 */
export function createLlmClient(
  providerId: string,
  config: LlmClientConfig,
): {
  send: (request: unknown) => Promise<unknown>;
  /** The reservation id of the most recent admitted request — the usage trail. */
  readonly lastReservationId: string | undefined;
} {
  let lastReservationId: string | undefined;
  return {
    get lastReservationId() {
      return lastReservationId;
    },
    async send(request: unknown): Promise<unknown> {
      const { response, reservation } = await sendLlmConsented(
        {
          providerId,
          scope: config.scope,
          request,
          maxInputTokens: config.maxInputTokens,
          maxOutputTokens: config.maxOutputTokens,
          kind: config.kind,
        },
        {
          unknownCostConfirmed: config.unknownCostConfirmed,
          signal: config.signal,
          fetchImpl: config.fetchImpl,
          beforeSend: config.beforeSend,
        },
      );
      lastReservationId = reservation.id;

      if (response.status >= 400) {
        const details = await errorDetails(response);
        await settleLlmUsage(reservation.id, config.scope, details.usage);
        if (details.capabilityRejected) {
          throw new LlmCapabilityError(
            `Provider rejected structured output (HTTP ${response.status}).`,
          );
        }
        throw new LlmHttpError(
          response.status,
          `LLM provider answered HTTP ${response.status}.`,
        );
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        await settleLlmUsage(reservation.id, config.scope, {});
        throw new LlmGateError(
          "transport",
          "LLM provider returned a non-JSON body.",
        );
      }

      await settleLlmUsage(
        reservation.id,
        config.scope,
        parseLlmUsage(raw),
      );
      return raw;
    },
  };
}
