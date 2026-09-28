import { get } from "../sync/chrome-bookmarks";
import { cleanUrl, minimizeBookmark } from "./minimize";
import { extractActivePage, type PageExtract } from "../extract/page";
import { summarizePage } from "../llm/summarize";
import { verifySummaryRun } from "../jev/tasks/verify-summary";
import { createJevClient, type JevTransport } from "../jev/client";
import { SummaryVerificationState } from "../schemas/summary-verification";
import { readActiveLlmProvider, readLlmProvider } from "../llm/settings";
import { hasConsentAtOrigin } from "../consent/records";
import {
  JEV_SUMMARY_VERIFY_SCOPE,
  LLM_SUMMARY_SCOPE,
} from "../schemas/provider";
import { resolveLlmDestination } from "../llm/providers";
import { resolvePreset } from "../net/presets";
import { setBookmarkSummary } from "../db/meta";

/**
 * Summary orchestration (spec FR10): extract the active tab's page → send
 * the bounded extract to the configured LLM under `llm_summary` → ask Jev
 * under `jev_summary_verify` whether the summary is supported → persist
 * ONLY on `supported`. Every hop has its own consent grant; the excerpt
 * never persists (spec FR9.10 — only the verified summary does).
 *
 * Total: every outcome is a typed `SummarizeOutcome`, never a throw —
 * extraction refusals, gate errors, LLM failures, and Jev refusals all map
 * to a discriminated result the UI renders directly.
 */

export interface SummarizeInput {
  /** Tab resolved inside the click handler (the `activeTab` grant). */
  readonly tabId: number;
  /** The saved bookmark this page is claimed to map to. */
  readonly bookmarkId: string;
  /** Override for tests — defaults to the configured active provider. */
  readonly providerId?: string;
  /** One-shot manual confirmation for an unpriced provider. */
  readonly unknownCostConfirmed?: boolean;
  readonly signal?: AbortSignal;
  /** Test seam — production leaves this unset (`sendConsented`). */
  readonly jevTransport?: JevTransport;
}

export type SummarizeOutcome =
  | {
      readonly ok: true;
      /** The summary persisted to `bookmarkMeta.summary`. */
      readonly summary: string;
      readonly model: string;
      readonly verifyConfidence: number;
    }
  | {
      readonly ok: false;
      readonly stage: "extract";
      readonly code:
        | "unavailable"
        | "no_tab"
        | "incognito"
        | "restricted_url"
        | "injection"
        | "empty";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly stage: "match";
      readonly code: "no_bookmark" | "mismatch" | "unsendable";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly stage: "consent";
      readonly code: "no_consent";
      readonly scope: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly stage: "summarize" | "persist";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly stage: "verify";
      readonly code: "not_supported";
      readonly verdict: "unsupported" | "uncertain";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly stage: "verify";
      readonly code: string;
      readonly message: string;
    };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function codeOf(cause: unknown): string {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "internal";
}

/**
 * Run the extract → summarize → verify → persist pipeline for the active
 * tab's bookmark. Never persists an unverified summary; never throws.
 */
export async function summarizeActiveBookmark(
  input: SummarizeInput,
): Promise<SummarizeOutcome> {
  const extracted = await extractActivePage(input.tabId);
  if (!extracted.ok) {
    return {
      ok: false,
      stage: "extract",
      code: extracted.code,
      message: extracted.message,
    };
  }
  return summarizeExtracted(input, extracted.extract);
}

/**
 * The pipeline body once the page extract is in hand — the seam tests and
 * `summarizeActiveBookmark` share.
 */
export async function summarizeExtracted(
  input: SummarizeInput,
  extract: PageExtract,
): Promise<SummarizeOutcome> {
  // Bookmark + URL match — the page must BE the saved bookmark.
  let node;
  try {
    node = (await get(input.bookmarkId))[0];
  } catch {
    node = undefined;
  }
  if (node === undefined || node.url === undefined) {
    return {
      ok: false,
      stage: "match",
      code: "no_bookmark",
      message: "No saved bookmark found for this page.",
    };
  }
  const cleanedBookmark = cleanUrl(node.url);
  const cleanedPage = cleanUrl(extract.url);
  if (cleanedBookmark === null || cleanedPage === null) {
    return {
      ok: false,
      stage: "match",
      code: "unsendable",
      message: "This page's address cannot be matched to a sendable bookmark URL.",
    };
  }
  if (cleanedBookmark !== cleanedPage) {
    return {
      ok: false,
      stage: "match",
      code: "mismatch",
      message: "The active page's URL does not match this bookmark.",
    };
  }
  const minimized = minimizeBookmark({
    title: node.title,
    url: node.url,
  });
  if (minimized === null) {
    return {
      ok: false,
      stage: "match",
      code: "unsendable",
      message: "This bookmark's URL is sensitive or cannot be cleaned for sending.",
    };
  }

  // Consents — `llm_summary` at the LLM origin and `jev_summary_verify` at
  // the Jev origin are separate grants (spec FR10.2).
  const record = await readActiveLlmProvider();
  const providerId = input.providerId ?? record?.providerId;
  if (providerId === undefined) {
    return {
      ok: false,
      stage: "summarize",
      code: "no_provider",
      message: "No LLM provider is configured for summaries.",
    };
  }
  const provider = await readLlmProvider(providerId);
  if (provider === null) {
    return {
      ok: false,
      stage: "summarize",
      code: "invalid_provider",
      message: "The configured LLM provider is unknown.",
    };
  }
  const llmOrigin = resolveLlmDestination(provider.provider).origin;
  if (
    !(await hasConsentAtOrigin(LLM_SUMMARY_SCOPE, llmOrigin).catch(
      () => false,
    ))
  ) {
    return {
      ok: false,
      stage: "consent",
      code: "no_consent",
      scope: LLM_SUMMARY_SCOPE,
      message: `Page text has not been consented for ${llmOrigin}.`,
    };
  }
  const jevOrigin = resolvePreset("typesafe").origin;
  if (
    !(await hasConsentAtOrigin(JEV_SUMMARY_VERIFY_SCOPE, jevOrigin).catch(
      () => false,
    ))
  ) {
    return {
      ok: false,
      stage: "consent",
      code: "no_consent",
      scope: JEV_SUMMARY_VERIFY_SCOPE,
      message: `Jev verification has not been consented for ${jevOrigin}.`,
    };
  }

  // Summarize — a manual LLM call (`unknownCostConfirmed` honored).
  let summarized;
  try {
    summarized = await summarizePage(providerId, extract, {
      ...(input.unknownCostConfirmed !== undefined
        ? { unknownCostConfirmed: input.unknownCostConfirmed }
        : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    return { ok: false, stage: "summarize", code: codeOf(cause), message: messageOf(cause) };
  }

  // Verify — Jev under its own scope; any transport/Jev failure or a
  // non-"supported" verdict stops before persistence.
  let verdict;
  try {
    const jevClient = createJevClient({
      preset: "typesafe",
      model: "jev-latest",
      scope: JEV_SUMMARY_VERIFY_SCOPE,
      ...(input.jevTransport !== undefined
        ? { transport: input.jevTransport }
        : {}),
    });
    const state = SummaryVerificationState.parse({
      bookmark: minimized,
      excerpt: extract.excerpt,
      headings: extract.headings,
      summary: summarized.summary,
    });
    verdict = await verifySummaryRun(jevClient, state);
  } catch (cause) {
    return { ok: false, stage: "verify", code: codeOf(cause), message: messageOf(cause) };
  }
  if (verdict.verdict !== "supported") {
    return {
      ok: false,
      stage: "verify",
      code: "not_supported",
      verdict: verdict.verdict,
      message: `Jev could not verify this summary (${verdict.verdict}) — it was not saved.`,
    };
  }

  // Persist — only the summary crosses storage; the excerpt dies here.
  try {
    await setBookmarkSummary(input.bookmarkId, summarized.summary);
  } catch (cause) {
    return { ok: false, stage: "persist", code: codeOf(cause), message: messageOf(cause) };
  }
  return {
    ok: true,
    summary: summarized.summary,
    model: summarized.model,
    verifyConfidence: verdict.confidence,
  };
}
