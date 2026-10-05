import { vi } from "vitest";
import { createLlmClient, type LlmClientConfig } from "../../src/llm/client";
import { sendLlmConsented, type LlmSendInput, type LlmSendOptions } from "../../src/net/llm-send";
import { FEATURE_CONTRACTS, jsonSchemaOf, pingRequest, tierSystemPrompt,
  type FeatureScope } from "../../src/llm/prompt-contracts";
import type { ChatCompletionRequest } from "../../src/llm/wire";
import type { StructuredOutputTier } from "../../src/schemas/llm";

/** Test-only transport installation, synchronous and without queues/locks.
 * Concurrent subjects must share one installed dispatcher, not different
 * transports. Neither production entry point accepts fetchImpl. */
export function sendLlmForTest(
  input: LlmSendInput, options: LlmSendOptions & { fetchImpl?: typeof fetch } = {},
) {
  const { fetchImpl, ...productionOptions } = options;
  if (fetchImpl !== undefined) vi.stubGlobal("fetch", fetchImpl);
  return sendLlmConsented(input, productionOptions);
}
export function createLlmForTest(
  providerId: string, config: LlmClientConfig & { fetchImpl?: typeof fetch },
) {
  const { fetchImpl, ...productionConfig } = config;
  if (fetchImpl !== undefined) vi.stubGlobal("fetch", fetchImpl);
  return createLlmClient(providerId, productionConfig);
}

/** The gate's A04 reserved input bound for a send: the serialized body
 * estimate (chars/4 × 1.25, the Jev planner's heuristic) may only raise the
 * caller's declared bound, never lower it. `maxOutputTokens` is the send's
 * clamped ceiling — the wire `max_tokens` after `min()` clamping. */
export function reservedInputBound(
  request: ChatCompletionRequest,
  declaredMaxInputTokens: number,
  maxOutputTokens: number,
): number {
  const maxTokens = Math.min(request.max_tokens ?? maxOutputTokens, maxOutputTokens);
  const body = JSON.stringify({ ...request, max_tokens: maxTokens });
  return Math.max(
    declaredMaxInputTokens,
    Math.ceil((body.length / 4) * 1.25),
  );
}

export const TEST_LLM_SCOPES = [
  "llm_test", "llm_explain", "llm_escalate", "llm_restructure", "llm_summary",
] as const;

/** Otherwise-sendable synthetic inputs: notes/page data never hide in chat. */
export function scopeRequest(
  scope: FeatureScope | "llm_test", model: string,
  tier: StructuredOutputTier = "prompt_only",
): ChatCompletionRequest {
  if (scope === "llm_test") return pingRequest(model, tier);
  const bookmark = { title: "Synthetic article", url: "https://allowed-site.dev/article",
    domain: "allowed-site.dev" };
  const payloads = {
    llm_explain: {
      question: "Which category?", candidates: ["article", "docs"],
      probabilities: { article: 0.8, docs: 0.2 }, answer: "article", bookmarks: [bookmark],
    },
    llm_escalate: {
      question: "Which category?", options: [{ id: "article", label: "Article" },
        { id: "docs", label: "Documentation" }], probabilities: { article: 0.8, docs: 0.2 },
      jevAnswer: "article", bookmarks: [bookmark],
    },
    llm_restructure: {
      folderPaths: ["Articles"], categories: { article: 1 }, tags: {},
      domains: [{ domain: bookmark.domain, count: 1 }],
      representativeTitles: { Articles: [bookmark.title] }, bookmarkCount: 1,
    },
    llm_summary: {
      url: bookmark.url, title: bookmark.title,
      excerpt: "A synthetic page excerpt.", headings: ["Overview"],
    },
  };
  const contract = FEATURE_CONTRACTS[scope];
  const schema = jsonSchemaOf(contract.output);
  const augmentation = tierSystemPrompt(tier, schema);
  return {
    model, messages: [
      { role: "system", content: augmentation === null ? contract.prompt :
        `${augmentation}\n\n${contract.prompt}` },
      { role: "user", content: JSON.stringify(payloads[scope]) },
    ],
    ...(tier === "json_schema" ? { response_format: {
      type: "json_schema" as const,
      json_schema: { name: contract.name, strict: true as const, schema },
    } } : tier === "json_object" ? { response_format: { type: "json_object" as const } } : {}),
  };
}
