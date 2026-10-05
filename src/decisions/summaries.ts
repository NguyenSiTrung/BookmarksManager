import { get } from "../sync/chrome-bookmarks";
import { minimizeBookmark } from "./minimize";
import { sameSummaryResource } from "./summary-identity";
import { readBlocklist } from "./blocklist";
import { extractActivePage, verifyExtractedDocument, type PageExtract } from "../extract/page";
import { summarizePage } from "../llm/summarize";
import { verifySummaryRun } from "../jev/tasks/verify-summary";
import { createJevClient, type JevTransport } from "../jev/client";
import { SummaryVerificationState } from "../schemas/summary-verification";
import { readActiveLlmProvider, readLlmProvider } from "../llm/settings";
import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
  CONSENT_VERSION,
} from "../consent/records";
import type {
  SummaryConsentApproval,
  SummaryConsentPreflight,
} from "../messages/summaries";
import {
  CONSENT_SCOPE,
  JEV_SUMMARY_VERIFY_SCOPE,
  LLM_SUMMARY_SCOPE,
} from "../schemas/provider";
import { resolveLlmDestination } from "../llm/providers";
import { readActiveJevProvider, type ActiveJevProvider } from "../jev/settings";
import { setBookmarkSummary } from "../db/meta";
import { sendConsented } from "../net/send";

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
  /** Only an affirmative disclosed send supplies this exact binding. */
  readonly consentApproval?: SummaryConsentApproval;
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
        | "mismatch"
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

type SummaryAdmissionCode = "no_bookmark" | "mismatch" | "unsendable";

/** Feature-local refusal; no URLs, page text, or native error causes. */
class SummaryAdmissionError extends Error {
  constructor(readonly code: SummaryAdmissionCode, message: string) {
    super(message);
    this.name = "SummaryAdmissionError";
  }
}

/** Admit both the captured page and the current saved bookmark before egress. */
async function admitSummary(bookmarkId: string, extract: PageExtract, tabId?: number) {
  if (tabId !== undefined && extract.documentIdentity !== undefined) {
    const document = await verifyExtractedDocument(tabId, extract);
    if (!document.ok) {
      throw new SummaryAdmissionError("mismatch", "The captured page document changed before sending.");
    }
  }
  let node;
  try {
    node = (await get(bookmarkId))[0];
  } catch {
    node = undefined;
  }
  if (node === undefined || node.url === undefined) {
    throw new SummaryAdmissionError(
      "no_bookmark", "No saved bookmark found for this page.",
    );
  }
  const blocklist = await readBlocklist();
  const minimized = minimizeBookmark({ title: node.title, url: node.url }, blocklist);
  const page = minimizeBookmark({ title: extract.title, url: extract.url }, blocklist);
  if (minimized === null || page === null) {
    throw new SummaryAdmissionError(
      "unsendable", "This page or its saved bookmark is blocked from summary sending.",
    );
  }
  if (!sameSummaryResource(node.url, extract.url)) {
    throw new SummaryAdmissionError(
      "mismatch", "The active page's URL does not match this bookmark.",
    );
  }
  return minimized;
}

/**
 * Run the extract → summarize → verify → persist pipeline for the active
 * tab's bookmark. Never persists an unverified summary; never throws.
 */
export async function summarizeActiveBookmark(
  input: SummarizeInput,
): Promise<SummarizeOutcome> {
  // A cost-confirmation resend is not renewed feature consent. If revoked
  // meanwhile, it must return to the disclosure instead of restoring grants.
  const authorized = await authorizeSummary(input, input.unknownCostConfirmed !== true);
  if (!authorized.ok) return authorized;
  const extracted = await extractActivePage(input.tabId);
  if (!extracted.ok) {
    return {
      ok: false,
      stage: "extract",
      code: extracted.code,
      message: extracted.message,
    };
  }
  return summarizeExtracted({
    ...input,
    // Pin the same approved providers through extraction and both hops.
    consentApproval: authorized.consent.approval,
  }, extracted.extract);
}

type SummaryConsentContext =
  | { readonly ok: true; readonly consent: SummaryConsentPreflight; readonly jev: ActiveJevProvider; readonly providerId: string }
  | Exclude<SummarizeOutcome, { ok: true }>;

/** Read-only: no extraction, keys, consent writes, or provider requests. */
export async function readSummaryConsent(providerId?: string): Promise<SummaryConsentContext> {
  const record = providerId === undefined
    ? await readActiveLlmProvider() : await readLlmProvider(providerId);
  if (record === null) {
    return { ok: false, stage: "summarize", code: "no_provider", message: "No LLM provider is configured for summaries." };
  }
  const llm = resolveLlmDestination(record.provider);
  const jev = await readActiveJevProvider(CONSENT_SCOPE);
  if (jev === null) {
    return { ok: false, stage: "verify", code: "no_provider", message: "No Jev provider is enabled for summary verification." };
  }
  return {
    ok: true, providerId: record.providerId, jev,
    consent: {
      approval: {
        consentVersion: CONSENT_VERSION,
        llm: { origin: llm.origin, providerId: record.providerId, model: llm.model, endpoint: llm.chatCompletionsUrl },
        jev: { origin: jev.destination.origin, providerId: jev.providerId, model: jev.model, endpoint: jev.destination.url },
      },
      llmGranted: await hasConsentAtOrigin(LLM_SUMMARY_SCOPE, llm.origin),
      jevGranted: await hasConsentAtOrigin(JEV_SUMMARY_VERIFY_SCOPE, jev.destination.origin),
    },
  };
}

function sameApproval(a: SummaryConsentApproval, b: SummaryConsentApproval): boolean {
  return a.consentVersion === b.consentVersion &&
    (["llm", "jev"] as const).every((hop) =>
      (["origin", "providerId", "model", "endpoint"] as const).every((key) => a[hop][key] === b[hop][key]),
    );
}

function consentRefusal(scope: string): Exclude<SummarizeOutcome, { ok: true }> {
  return { ok: false, stage: "consent", code: "no_consent", scope, message: "Review the current summary recipients and disclosure before sending." };
}

async function authorizeSummary(input: SummarizeInput, allowGrant = true): Promise<SummaryConsentContext> {
  try {
    const current = await readSummaryConsent(input.providerId);
    if (!current.ok) return current;
    if (input.consentApproval !== undefined) {
      const approval = input.consentApproval;
      // The message trust boundary strict-parses the approval. Compare every
      // disclosed binding field again against freshly resolved providers.
      if (!sameApproval(approval, current.consent.approval)) {
        return consentRefusal(LLM_SUMMARY_SCOPE);
      }
      if (allowGrant) {
        if (!current.consent.llmGranted) await grantConsentAtOrigin(LLM_SUMMARY_SCOPE, approval.llm.origin);
        if (!current.consent.jevGranted) await grantConsentAtOrigin(JEV_SUMMARY_VERIFY_SCOPE, approval.jev.origin);
      }
    }
    const checked = await readSummaryConsent(input.providerId);
    if (!checked.ok || !sameApproval(current.consent.approval, checked.consent.approval)) return consentRefusal(LLM_SUMMARY_SCOPE);
    if (!checked.consent.llmGranted) return consentRefusal(LLM_SUMMARY_SCOPE);
    if (!checked.consent.jevGranted) return consentRefusal(JEV_SUMMARY_VERIFY_SCOPE);
    return checked;
  } catch {
    return consentRefusal(LLM_SUMMARY_SCOPE);
  }
}

/**
 * The pipeline body once the page extract is in hand — the seam tests and
 * `summarizeActiveBookmark` share.
 */
export async function summarizeExtracted(
  input: SummarizeInput,
  extract: PageExtract,
): Promise<SummarizeOutcome> {
  const authorized = await authorizeSummary(input, false);
  if (!authorized.ok) return authorized;
  // Bookmark + URL match — the page must BE the saved bookmark.
  let minimized;
  try {
    minimized = await admitSummary(input.bookmarkId, extract, input.tabId);
  } catch (cause) {
    return {
      ok: false,
      stage: "match",
      code: cause instanceof SummaryAdmissionError ? cause.code : "unsendable",
      message: cause instanceof SummaryAdmissionError
        ? cause.message : "Summary admission could not be checked.",
    };
  }
  const beforeSend = async () => {
    await admitSummary(input.bookmarkId, extract, input.tabId);
    const current = await authorizeSummary({
      ...input, consentApproval: authorized.consent.approval,
    }, false);
    if (!current.ok) {
      // No grants are refreshed on fallback/repair/retry, even after revoke.
      const error = new Error("Summary consent or provider changed before sending.");
      Object.assign(error, { code: "no_consent" });
      throw error;
    }
  };

  const { providerId, jev } = authorized;

  // Summarize — a manual LLM call (`unknownCostConfirmed` honored).
  // Egress gets its own minimized copy; admission retains the original
  // captured page URL and rechecks it with the live bookmark at every send.
  const outboundExtract: PageExtract = { ...extract, url: minimized.url };
  let summarized;
  try {
    summarized = await summarizePage(providerId, outboundExtract, {
      beforeSend,
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
    const transport = input.jevTransport ?? sendConsented;
    const jevClient = createJevClient({
      providerId: jev.providerId,
      model: jev.model,
      scope: JEV_SUMMARY_VERIFY_SCOPE,
      transport,
      // The client reruns this after slots/retry waits and forwards it to
      // the real gate after its asynchronous consent/permission/key checks.
      beforeSend,
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
  // J14: re-admit the bookmark first — a delete or retarget between the
  // verify hop and this write must not receive the summary (or orphan a
  // `bookmarkMeta` row). The admission codes surface as the persist code.
  try {
    await admitSummary(input.bookmarkId, extract, input.tabId);
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
