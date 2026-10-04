import { PROPOSE_SYSTEM_PROMPT } from "../llm/prompt-contracts";
import { createLlmClient } from "../llm/client";
import { runStructured } from "../llm/structured";
import { resolveLlmDestination } from "../llm/providers";
import { LlmGateError } from "../net/llm-send";
import { readLlmProvider } from "../llm/settings";
import { LLM_RESTRUCTURE_SCOPE } from "../schemas/provider";
import { LibrarySynopsis, RestructureProposal } from "../schemas/restructure";
import type { TokenUsage, ChatMessage } from "../llm/wire";

/**
 * The LLM half of spec FR8 — propose a bounded folder layout from a bounded
 * library synopsis. Runs under the `llm_restructure` scope as a `manual`
 * request (Restructure is an explicit workflow): the synopsis's folder paths,
 * category/tag counts, top domains, and capped representative titles go to
 * the provider; a strict `RestructureProposal` comes back. Nothing persists —
 * the orchestrator and job layer own proposal storage.
 */

export interface ProposeResult {
  readonly proposal: RestructureProposal;
  /** The model id the provider actually answered with. */
  readonly model: string;
  readonly usage?: TokenUsage;
}

export interface ProposeOptions {
  /** One-shot manual confirmation for an unpriced provider. */
  readonly unknownCostConfirmed?: boolean;
  readonly signal?: AbortSignal;
  /** Internal recipient/source authority, checked before provider rereads and
   * forwarded to the gate before every dispatch, including retries. */
  readonly beforeSend?: () => Promise<void>;
}

const MAX_INPUT_TOKENS = 16_000;
const MAX_OUTPUT_TOKENS = 1_500;

/**
 * Propose a folder layout for `synopsis` with the configured provider.
 * `synopsis` is re-validated against `LibrarySynopsis` before it enters a
 * message — defense-in-depth, the builder already produces it. Throws
 * `LlmGateError` for gate refusals (consent/permission/key/budget) and
 * `invalid_provider` for an unknown provider id; a proposal that fails the
 * `RestructureProposal` limits surfaces as the structured engine's error.
 */
export async function proposeLayout(
  providerId: string,
  synopsis: LibrarySynopsis,
  options?: ProposeOptions,
): Promise<ProposeResult> {
  await options?.beforeSend?.();
  const record = await readLlmProvider(providerId);
  if (record === null) {
    throw new LlmGateError("invalid_provider", "Unknown LLM provider.");
  }
  const messages: ChatMessage[] = [
    { role: "system", content: PROPOSE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(LibrarySynopsis.parse(synopsis)) },
  ];
  const client = createLlmClient(providerId, {
    scope: LLM_RESTRUCTURE_SCOPE,
    kind: "manual",
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(options?.unknownCostConfirmed !== undefined
      ? { unknownCostConfirmed: options.unknownCostConfirmed }
      : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    ...(options?.beforeSend !== undefined ? { beforeSend: options.beforeSend } : {}),
  });
  const run = await runStructured({
    tier: "json_schema",
    model: resolveLlmDestination(record.provider).model,
    schema: RestructureProposal,
    schemaName: "restructure_proposal",
    messages,
    send: async (request) => {
      // Fallbacks/repairs must fail with a renewed disclosure before a gate
      // model-pin refusal can obscure a changed accepted recipient.
      await options?.beforeSend?.();
      return client.send(request);
    },
  });
  return {
    proposal: run.value,
    model: run.model,
    ...(run.usage !== undefined ? { usage: run.usage } : {}),
  };
}
