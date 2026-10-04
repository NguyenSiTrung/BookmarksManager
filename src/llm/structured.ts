import type { StructuredOutputTier } from "../schemas/llm";
import type { z } from "../schemas/z";
import { extractBoundedJson, jsonSchemaOf, tierSystemPrompt, truncateForEcho,
  repairInstruction, schemaValidationDetail, MAX_OUTPUT_CHARS, MAX_REPAIRS } from "./prompt-contracts";
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  type ChatMessage,
  firstText,
  parseUsage,
  type TokenUsage,
} from "./wire";

export { extractBoundedJson } from "./prompt-contracts";

/**
 * Structured-output engine (spec FR4). Orchestrates a chat-completion request
 * across the three capability tiers — strict `json_schema`, `json_object`
 * with the schema in the system prompt, and prompt-only with bounded JSON
 * extraction — then validates the model output against its Zod schema.
 *
 * Rules per spec:
 *  - Tier fallback happens ONLY when `send` throws `LlmCapabilityError` (the
 *    provider explicitly rejected `response_format`). Malformed model output
 *    is never evidence for fallback — it triggers bounded repair instead.
 *  - At most two repair attempts follow a validation failure; each repair
 *    re-sends the transcript with the bad output echoed back plus a generic
 *    instruction. Repairs do not cross tiers.
 *  - Non-capability `send` failures (auth, transport, aborts) propagate
 *    untouched — transport retry/backoff belongs to the gate's client.
 *  - Errors are redacted: `StructuredOutputError` never carries raw model
 *    output, prompts, or credentials.
 */

/** Provider explicitly rejected a requested capability (e.g. a tier). */
export class LlmCapabilityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmCapabilityError";
  }
}

export type StructuredOutputErrorReason =
  | "malformed_response"
  | "empty_content"
  | "output_too_large"
  | "invalid_json"
  | "schema_validation"
  | "capability_unsupported";

/** Structured output could not be produced/validated. Redacted by contract. */
export class StructuredOutputError extends Error {
  readonly reason: StructuredOutputErrorReason;

  constructor(
    reason: StructuredOutputErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StructuredOutputError";
    this.reason = reason;
  }
}

export interface StructuredRunResult<T> {
  value: T;
  /** Model identifier the provider reported. */
  model: string;
  /** Model identifier we configured and sent. */
  configuredModel: string;
  usage?: TokenUsage;
  tierUsed: StructuredOutputTier;
  /** Number of repair sends used (0–2). */
  repairs: number;
}

export interface RunStructuredParams<T> {
  tier: StructuredOutputTier;
  model: string;
  schema: z.ZodType<T>;
  /** Optional `json_schema.name` (OpenAI identifier rules); default "response". */
  schemaName?: string;
  messages: ChatMessage[];
  /**
   * Injected transport: validates nothing itself; `runStructured` validates
   * the request before it leaves and the response on return.
   */
  send: (request: ChatCompletionRequest) => Promise<unknown>;
}

const TIER_ORDER: readonly StructuredOutputTier[] = [
  "json_schema",
  "json_object",
  "prompt_only",
];

/** Merge our tier instruction into a leading system message, else unshift. */
function augmentMessages(
  messages: ChatMessage[],
  systemPrompt: string | null,
): ChatMessage[] {
  if (systemPrompt === null) {
    return [...messages];
  }
  const first = messages[0];
  if (first?.role === "system") {
    return [
      { role: "system", content: `${systemPrompt}\n\n${first.content}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: "system", content: systemPrompt }, ...messages];
}

function buildRequest(
  tier: StructuredOutputTier,
  model: string,
  messages: ChatMessage[],
  jsonSchema: Record<string, unknown>,
  schemaName: string,
): ChatCompletionRequest {
  const request: {
    model: string;
    messages: ChatMessage[];
    response_format?: unknown;
  } = {
    model,
    messages: augmentMessages(messages, tierSystemPrompt(tier, jsonSchema)),
  };
  if (tier === "json_schema") {
    request.response_format = {
      type: "json_schema",
      json_schema: { name: schemaName, schema: jsonSchema, strict: true },
    };
  } else if (tier === "json_object") {
    request.response_format = { type: "json_object" };
  }
  return ChatCompletionRequest.parse(request);
}

interface TierOutcome<T> {
  result?: StructuredRunResult<T>;
}

async function attemptTier<T>(
  tier: StructuredOutputTier,
  params: RunStructuredParams<T>,
  jsonSchema: Record<string, unknown>,
): Promise<TierOutcome<T>> {
  const schemaName = params.schemaName ?? "response";
  let transcript = [...params.messages];
  let lastReason: StructuredOutputErrorReason = "schema_validation";
  let lastDetail = "model output failed schema validation";

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const request = buildRequest(
      tier,
      params.model,
      transcript,
      jsonSchema,
      schemaName,
    );

    // LlmCapabilityError propagates to the outer loop (tier fallback);
    // auth, transport, and abort failures propagate untouched — transport
    // retry/backoff belongs to the egress gate's client.
    const raw: unknown = await params.send(request);

    let response: ChatCompletionResponse;
    try {
      response = ChatCompletionResponse.parse(raw);
    } catch (cause) {
      throw new StructuredOutputError(
        "malformed_response",
        "Provider response did not match the chat-completions wire schema.",
        { cause },
      );
    }

    const text = firstText(response);
    let extracted: unknown = null;
    if (text === null) {
      lastReason = "empty_content";
      lastDetail = "model returned empty content";
    } else if (text.length > MAX_OUTPUT_CHARS) {
      lastReason = "output_too_large";
      lastDetail = "model output exceeded the extraction limit";
    } else {
      extracted = extractBoundedJson(text);
      if (extracted === null) {
        lastReason = "invalid_json";
        lastDetail = "model output was not a JSON value";
      }
    }

    if (extracted !== null) {
      const parsed = params.schema.safeParse(extracted);
      if (parsed.success) {
        const usage = parseUsage(response);
        return {
          result: {
            value: parsed.data,
            model: response.model,
            configuredModel: params.model,
            ...(usage !== undefined ? { usage } : {}),
            tierUsed: tier,
            repairs: attempt,
          },
        };
      }
      lastReason = "schema_validation";
      lastDetail = schemaValidationDetail(parsed.error.issues[0]);
    }

    if (attempt === MAX_REPAIRS) {
      break;
    }
    transcript = [
      ...transcript,
      { role: "assistant", content: truncateForEcho(text ?? "") },
      { role: "user", content: repairInstruction(lastDetail) },
    ];
  }

  throw new StructuredOutputError(
    lastReason,
    `Structured output failed on tier "${tier}" after ${MAX_REPAIRS} repair attempts: ${lastDetail}.`,
  );
}

/**
 * Run a structured chat completion across the allowed tiers. Starts at
 * `params.tier` and descends only while providers explicitly reject the
 * capability (`LlmCapabilityError`); validation failures repair in place and
 * eventually throw `StructuredOutputError`.
 */
export async function runStructured<T>(
  params: RunStructuredParams<T>,
): Promise<StructuredRunResult<T>> {
  const startIndex = TIER_ORDER.indexOf(params.tier);
  const jsonSchema = jsonSchemaOf(params.schema);

  for (const tier of TIER_ORDER.slice(Math.max(startIndex, 0))) {
    try {
      const outcome = await attemptTier(tier, params, jsonSchema);
      if (outcome.result !== undefined) {
        return outcome.result;
      }
    } catch (cause) {
      if (cause instanceof LlmCapabilityError) {
        continue;
      }
      throw cause;
    }
  }

  throw new StructuredOutputError(
    "capability_unsupported",
    "The provider rejected every supported structured-output tier.",
  );
}
