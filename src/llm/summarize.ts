import { SUMMARIZE_SYSTEM_PROMPT, SummaryDraft } from "./prompt-contracts";
import { createLlmClient } from "./client";
import { runStructured } from "./structured";
import { resolveLlmDestination } from "./providers";
import { LlmGateError } from "../net/llm-send";
import { readLlmProvider } from "./settings";
import { stripUrlsAndMarkdown } from "./sanitize";
import { minimizeBookmark } from "../decisions/minimize";
import { readBlocklist } from "../decisions/blocklist";
import type { PageExtract } from "../extract/page";
import type { TokenUsage, ChatMessage } from "./wire";

/**
 * The LLM half of spec FR10 — summarize a bounded page extract. Runs under
 * the `llm_summary` scope as a `manual` request (the Summarize action is an
 * explicit click): the page's title, cleaned URL, excerpt, headings, and
 * optional description/site name go to the provider; a strict
 * `{summary ≤ 2,000 chars}` object comes back.
 * Nothing here persists — the orchestrator in `src/decisions/summaries.ts`
 * routes the draft through Jev verification first.
 */

export { SummaryDraft } from "./prompt-contracts";

export interface SummarizeResult {
  readonly summary: string;
  readonly model: string;
  readonly usage?: TokenUsage;
}

export interface SummarizeOptions {
  /** One-shot manual confirmation for an unpriced provider. */
  readonly unknownCostConfirmed?: boolean;
  readonly signal?: AbortSignal;
  /** Feature admission before initial/fallback/repair sends and internal
   * transport retries. Throw a typed, content-free refusal to stop egress. */
  readonly beforeSend?: () => Promise<void>;
}

const MAX_INPUT_TOKENS = 24_000;
const MAX_OUTPUT_TOKENS = 1_024;

/**
 * Summarize `extract` with the configured provider. Throws `LlmGateError`
 * for gate refusals (consent/permission/key/budget) and `invalid_provider`
 * for an unknown provider id — callers surface these to the user verbatim.
 */
export async function summarizePage(
  providerId: string,
  extract: PageExtract,
  options?: SummarizeOptions,
): Promise<SummarizeResult> {
  const record = await readLlmProvider(providerId);
  if (record === null) {
    throw new LlmGateError("invalid_provider", "Unknown LLM provider.");
  }
  // Defense in depth for direct callers: never serialize a raw extraction
  // URL, even when the orchestrator has already supplied a minimized copy.
  // Keep the original extraction untouched for feature-local admission.
  const minimized = minimizeBookmark(extract, await readBlocklist());
  if (
    minimized === null ||
    !["http:", "https:"].includes(new URL(minimized.url).protocol)
  ) {
    throw new LlmGateError(
      "request_not_allowed", "This page cannot be sent for summarization.",
    );
  }
  const payload = {
    url: minimized.url,
    title: extract.title,
    excerpt: extract.excerpt,
    headings: extract.headings,
    ...(extract.description !== undefined
      ? { description: extract.description }
      : {}),
    ...(extract.siteName !== undefined ? { siteName: extract.siteName } : {}),
  };
  const messages: ChatMessage[] = [
    { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
  const client = createLlmClient(providerId, {
    scope: "llm_summary",
    kind: "manual",
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(options?.beforeSend !== undefined ? { beforeSend: options.beforeSend } : {}),
    ...(options?.unknownCostConfirmed !== undefined
      ? { unknownCostConfirmed: options.unknownCostConfirmed }
      : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  });
  const run = await runStructured({
    tier: "json_schema",
    model: resolveLlmDestination(record.provider).model,
    schema: SummaryDraft,
    schemaName: "page_summary",
    messages,
    send: async (request) => {
      await options?.beforeSend?.();
      return client.send(request);
    },
  });
  // H05: the provider's text is untrusted — strip URLs/markdown before the
  // draft reaches Jev verification, the UI, or `bookmarkMeta.summary`.
  const summary = stripUrlsAndMarkdown(run.value.summary);
  if (summary === "") {
    // A draft that was nothing but URLs/markdown has no usable text to
    // verify or persist — fail the summarize stage honestly rather than
    // let the meta schema's min(1) throw an opaque Zod error at persist.
    const error = new Error("The provider's summary contained no usable text.");
    Object.assign(error, { code: "empty_summary" });
    throw error;
  }
  return {
    summary,
    model: run.model,
    ...(run.usage !== undefined ? { usage: run.usage } : {}),
  };
}
