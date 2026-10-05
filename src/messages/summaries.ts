import { z } from "../schemas/z";
import type { SummarizeOutcome } from "../decisions/summaries";

/**
 * The worker side of the Summarize intent (plan Phase 4 Task 4): the
 * sidepanel asks the worker to extract the active tab's page, summarize it
 * with the configured LLM, verify the draft with Jev, and persist the
 * verified summary to the bookmark's meta row. Trusted callers are the
 * extension's own pages; the sender is re-verified here.
 *
 * `handleSummarizeMessage` returns `undefined` for messages outside this
 * protocol so `background.ts` can chain it; for owned types the handler is
 * total — every path resolves to a `SummarizeMessageResult`, never rejects.
 *
 * Redaction boundary: replies carry the stored summary, codes, and ids —
 * never the extracted page text, prompts, or key material.
 */

declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

const SummaryRecipient = z.strictObject({
  origin: z.url(),
  providerId: z.string().min(1),
  model: z.string().min(1),
  endpoint: z.url(),
});

/** Content-free disclosure binding, echoed only by the affirmative send.
 * Worker dependencies are loaded only inside the worker handlers below. */
export const SummaryConsentApproval = z.strictObject({
  consentVersion: z.number().int().positive(),
  llm: SummaryRecipient,
  jev: SummaryRecipient,
});
export type SummaryConsentApproval = z.infer<typeof SummaryConsentApproval>;
export const SummaryConsentPreflight = z.strictObject({
  approval: SummaryConsentApproval,
  llmGranted: z.boolean(),
  jevGranted: z.boolean(),
});
export type SummaryConsentPreflight = z.infer<typeof SummaryConsentPreflight>;

export const SummarizeMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("LLM_SUMMARY_PREFLIGHT") }),
  // Summarize the saved bookmark the active tab maps to. `unknownCostConfirmed`
  // is ONLY honored on this manual intent — it is the CostConfirmationDialog
  // resend flag (spec FR7.8).
  z.strictObject({
    type: z.literal("LLM_SUMMARIZE"),
    tabId: z.number().int().positive(),
    bookmarkId: z.string().min(1),
    unknownCostConfirmed: z.boolean().optional(),
    consentApproval: SummaryConsentApproval.optional(),
  }),
  z.strictObject({
    type: z.literal("LLM_SUMMARY_READ"),
    bookmarkId: z.string().min(1),
  }),
]);
export type SummarizeMessage = z.infer<typeof SummarizeMessage>;

const SUMMARIZE_TYPES = new Set(["LLM_SUMMARIZE", "LLM_SUMMARY_READ", "LLM_SUMMARY_PREFLIGHT"]);

export const SummarizeErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "no_provider",
  "invalid_provider",
  "no_consent",
  "no_permission",
  "no_key",
  "confirmation_required",
  "budget_exceeded",
  "pricing_required",
  "capability_unsupported",
  "request_not_allowed",
  "unlisted_model",
  "timeout",
  "aborted",
  "transport",
  "http_error",
  "unavailable",
  "no_tab",
  "incognito",
  "restricted_url",
  "injection",
  "empty",
  "no_bookmark",
  "mismatch",
  "unsendable",
  "not_supported",
  "internal_error",
]);
export type SummarizeErrorCode = z.infer<typeof SummarizeErrorCode>;

export const SummarizeMessageResult = z.union([
  z.object({
    ok: z.literal(true),
    code: z.literal("summary_consent"),
    consent: SummaryConsentPreflight,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("summary_ok"),
    summary: z.string(),
    model: z.string(),
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("summary_read"),
    summary: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: SummarizeErrorCode,
    message: z.string(),
    /** Pipeline stage for UI context: extract|match|consent|summarize|verify|persist. */
    stage: z.string().optional(),
    /**
     * On `confirmation_required`: the exact egress origin the resend would
     * hit, so the CostConfirmationDialog can name it. A target, never
     * content.
     */
    destinationOrigin: z.string().optional(),
  }),
]);
export type SummarizeMessageResult = z.infer<typeof SummarizeMessageResult>;

export interface SummarizeMessageSender {
  url?: string;
}

function failure(
  code: SummarizeErrorCode,
  message: string,
  stage?: string,
  destinationOrigin?: string,
): SummarizeMessageResult {
  return {
    ok: false,
    code,
    message,
    ...(stage !== undefined ? { stage } : {}),
    ...(destinationOrigin !== undefined ? { destinationOrigin } : {}),
  };
}

function isTrustedExtensionSender(sender: SummarizeMessageSender): boolean {
  try {
    const base = chrome.runtime.getURL("");
    return typeof sender.url === "string" && sender.url.startsWith(base);
  } catch {
    return false;
  }
}

/** Map a `SummarizeOutcome` onto the wire reply — total over the union. */
function outcomeToReply(outcome: SummarizeOutcome): SummarizeMessageResult {
  if (outcome.ok) {
    return {
      ok: true,
      code: "summary_ok",
      summary: outcome.summary,
      model: outcome.model,
    };
  }
  switch (outcome.stage) {
    case "extract":
      return failure(outcome.code, outcome.message, "extract");
    case "match":
      return failure(outcome.code, outcome.message, "match");
    case "consent":
      return failure("no_consent", outcome.message, "consent");
    case "verify":
      if (outcome.code === "not_supported") {
        return failure("not_supported", outcome.message, "verify");
      }
      return failure(
        isSummarizeErrorCode(outcome.code) ? outcome.code : "internal_error",
        outcome.message,
        "verify",
      );
    default:
      return failure(
        isSummarizeErrorCode(outcome.code) ? outcome.code : "internal_error",
        outcome.message,
        outcome.stage,
      );
  }
}

function isSummarizeErrorCode(code: string): code is SummarizeErrorCode {
  return SummarizeErrorCode.safeParse(code).success;
}

async function summarize(message: {
  tabId: number;
  bookmarkId: string;
  unknownCostConfirmed?: boolean;
  consentApproval?: SummaryConsentApproval;
}): Promise<SummarizeMessageResult> {
  const { summarizeActiveBookmark, readSummaryConsent } = await import("../decisions/summaries");
  const current = await readSummaryConsent();
  if (!current.ok) return outcomeToReply(current);
  if (message.consentApproval === undefined) {
    return failure("no_consent", "Review both summary recipients before agreeing to send.", "consent");
  }
  const outcome = await summarizeActiveBookmark({
    tabId: message.tabId,
    bookmarkId: message.bookmarkId,
    ...(message.consentApproval !== undefined ? { consentApproval: message.consentApproval } : {}),
    ...(message.unknownCostConfirmed !== undefined
      ? { unknownCostConfirmed: message.unknownCostConfirmed }
      : {}),
  });
  const reply = outcomeToReply(outcome);
  if (
    reply.ok === false &&
    reply.code === "confirmation_required" &&
    reply.destinationOrigin === undefined
  ) {
    // The orchestrator surfaces the raw gate code — reattach the named
    // destination so the dialog can say where the resend goes.
    return { ...reply, destinationOrigin: message.consentApproval.llm.origin };
  }
  return reply;
}

async function readSummary(bookmarkId: string): Promise<SummarizeMessageResult> {
  const { getMeta } = await import("../db/meta");
  const meta = await getMeta(bookmarkId);
  return {
    ok: true,
    code: "summary_read",
    ...(meta?.summary !== undefined ? { summary: meta.summary } : {}),
  };
}

/**
 * Validate and dispatch one summaries message. `undefined` when
 * `message.type` is not owned so `background.ts` can chain handlers; total
 * otherwise.
 */
export async function handleSummarizeMessage(
  message: unknown,
  sender: SummarizeMessageSender,
): Promise<SummarizeMessageResult | undefined> {
  const type =
    typeof message === "object" && message !== null
      ? (message as { type?: unknown }).type
      : undefined;
  if (typeof type !== "string" || !SUMMARIZE_TYPES.has(type)) {
    return undefined;
  }
  try {
    if (!isTrustedExtensionSender(sender)) {
      return failure(
        "untrusted_sender",
        "Summarize messages are only handled from this extension's own pages.",
      );
    }
    const parsed = SummarizeMessage.safeParse(message);
    if (!parsed.success) {
      return failure(
        "malformed_message",
        "The message did not match the summaries protocol.",
      );
    }
    switch (parsed.data.type) {
      case "LLM_SUMMARY_PREFLIGHT": {
        const { readSummaryConsent } = await import("../decisions/summaries");
        const current = await readSummaryConsent();
        return current.ok
          ? { ok: true, code: "summary_consent", consent: current.consent }
          : outcomeToReply(current);
      }
      case "LLM_SUMMARIZE":
        return await summarize(parsed.data);
      case "LLM_SUMMARY_READ":
        return await readSummary(parsed.data.bookmarkId);
    }
  } catch {
    return failure(
      "internal_error",
      "The request failed unexpectedly; nothing was sent or changed on purpose.",
    );
  }
}
