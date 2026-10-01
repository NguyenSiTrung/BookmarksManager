import {
  LlmGateError,
  sendLlmConsented,
  settleLlmUsage,
} from "../net/llm-send";
import { LlmCapabilityError } from "./structured";
import { ChatCompletionResponse, parseUsage } from "./wire";
import type { RequestKind } from "./budget";
import type { ConsentScope } from "../schemas/provider";

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
/** Bounded read of an error body — enough to classify, never persisted. */
const MAX_ERROR_BODY_CHARS = 4096;

async function readBoundedBody(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return null;
  }
}

function usageFrom(text: string | null): {
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd?: number;
} {
  if (text !== null) {
    try {
      const parsed = ChatCompletionResponse.safeParse(JSON.parse(text));
      if (parsed.success) {
        const usage = parseUsage(parsed.data);
        if (usage !== undefined) {
          const row: {
            inputTokens: number;
            outputTokens: number;
            reportedCostUsd?: number;
          } = {
            inputTokens: usage.promptTokens ?? 0,
            outputTokens: usage.completionTokens ?? 0,
          };
          if (usage.reportedCostUsd !== undefined) {
            row.reportedCostUsd = usage.reportedCostUsd;
          }
          return row;
        }
      }
    } catch {
      // fall through — unknown usage
    }
  }
  return { inputTokens: 0, outputTokens: 0 };
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
        const text = await readBoundedBody(response);
        await settleLlmUsage(reservation.id, config.scope, usageFrom(text));
        if (
          CAPABILITY_STATUS.has(response.status) &&
          text !== null &&
          CAPABILITY_HINT.test(text)
        ) {
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
      } catch (cause) {
        await settleLlmUsage(reservation.id, config.scope, {
          inputTokens: 0,
          outputTokens: 0,
        });
        throw new LlmGateError(
          "transport",
          "LLM provider returned a non-JSON body.",
          { cause },
        );
      }

      await settleLlmUsage(
        reservation.id,
        config.scope,
        usageFrom(JSON.stringify(raw)),
      );
      return raw;
    },
  };
}
