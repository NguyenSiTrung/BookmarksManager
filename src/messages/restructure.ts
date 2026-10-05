import { db } from "../db/database";
import { BlocklistReadError, readBlocklist } from "../decisions/blocklist";
import { domainOf, isSensitiveUrl } from "../decisions/minimize";
import { listMeta } from "../db/meta";
import {
  cancelJob,
  enqueueJob,
  getJob,
  pauseJob,
  resumeJob,
  setJobStatus,
} from "../jobs/queue";
import type { Job } from "../schemas/job";
import { LlmHttpError } from "../llm/client";
import { hasConsentAtOrigin } from "../consent/records";
import {
  FeatureConsentApproval,
  FeatureConsentDisclosure,
  featureConsentDisclosure,
  matchesFeatureConsentApproval,
} from "../schemas/feature-consent";
import { readActiveLlmProvider, readLlmProvider } from "../llm/settings";
import { LlmCapabilityError } from "../llm/structured";
import { LlmGateError } from "../net/llm-send";
import { ApplyError, applyRestructurePlan } from "../restructure/apply";
import { buildRestructureDiff } from "../restructure/diff";
import type { RestructureDiff } from "../restructure/diff";
import { proposeLayout } from "../restructure/propose";
import { buildLibrarySynopsis } from "../restructure/synopsis";
import { getSubTree, ROOT_NODE_ID, type BookmarksTreeNode } from "../sync/chrome-bookmarks";
import { undoRestructurePlan } from "../restructure/apply";
import { z } from "../schemas/z";

/**
 * The worker side of the Phase-5 restructure intents (plan Phase 5 Task 4):
 * start (propose → enqueue → run), pause/resume/cancel, the diff preview,
 * the user-confirmed apply, and undo. Trusted callers are the extension's
 * own pages (the sidepanel's Restructure view); the sender is re-verified.
 *
 * `handleRestructureMessage` returns `undefined` for messages outside this
 * protocol so `background.ts` can chain it; for owned `RESTRUCTURE_*` types
 * the handler is total — every path resolves to a
 * `RestructureMessageResult`, never rejects.
 *
 * Redaction boundary: replies carry job ids, statuses, diff rows, counts —
 * never prompts, response bodies, or key material. The diff rows carry the
 * bookmark title + paths the user already sees locally.
 */
declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/** Messages extension pages may send — validated at the trust boundary. */
export const RestructureMessage = z.discriminatedUnion("type", [
  // Propose a layout, enqueue the assignment job, and start it.
  // `unknownCostConfirmed` is the CostConfirmationDialog resend flag.
  // `providerId` is either a stored provider id or the sentinel "active"
  // (what the sidepanel view sends) — the worker resolves the sentinel to
  // the active provider before any lookup.
  z.strictObject({
    type: z.literal("RESTRUCTURE_START"),
    providerId: z.string().min(1),
    unknownCostConfirmed: z.boolean().optional(),
    consentApproval: FeatureConsentApproval.optional(),
  }),
  // Latest (or named) job state + its diff when completed.
  z.strictObject({
    type: z.literal("RESTRUCTURE_STATUS"),
    jobId: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("RESTRUCTURE_PAUSE"),
    jobId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("RESTRUCTURE_RESUME"),
    jobId: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("RESTRUCTURE_CANCEL"),
    jobId: z.string().min(1),
  }),
  // The explicit user confirmation: apply the completed job's plan.
  // `bookmarkIds` is the reviewed/accepted set from the diff; it filters the
  // resolved rows but never narrows the tree revalidation, so apply and the
  // preview stay on the same full scope (bar + Other + Mobile).
  z.strictObject({
    type: z.literal("RESTRUCTURE_CONFIRM"),
    jobId: z.string().min(1),
    bookmarkIds: z.array(z.string().min(1)).optional(),
  }),
  // Undo the most recent apply (the top `restructure` snapshot).
  z.strictObject({ type: z.literal("RESTRUCTURE_UNDO") }),
]);
export type RestructureMessage = z.infer<typeof RestructureMessage>;

/** Dispatch table membership — messages whose `type` this module owns. */
const RESTRUCTURE_TYPES = new Set([
  "RESTRUCTURE_START",
  "RESTRUCTURE_STATUS",
  "RESTRUCTURE_PAUSE",
  "RESTRUCTURE_RESUME",
  "RESTRUCTURE_CANCEL",
  "RESTRUCTURE_CONFIRM",
  "RESTRUCTURE_UNDO",
]);

/**
 * Machine-readable failure codes. `LlmGateError` codes reach the page
 * verbatim (`confirmation_required` drives the CostConfirmationDialog
 * resend), plus the apply/queue codes and the protocol's own trust codes.
 * `read_failed` is apply's typed refusal for an unreadable live tree — the
 * reviewed scope could not be revalidated, so nothing was touched.
 */
export const RestructureErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "not_found",
  "invalid_job",
  "not_ready",
  "stale",
  "read_failed",
  "mutation_failed",
  "illegal_transition",
  "unregistered_scope",
  "no_provider",
  "invalid_provider",
  "request_not_allowed",
  "unlisted_model",
  "no_consent",
  "consent_required",
  "no_permission",
  "no_key",
  "pricing_required",
  "confirmation_required",
  "budget_exceeded",
  "timeout",
  "aborted",
  "transport",
  "http_error",
  "capability_unsupported",
  "empty",
  "internal_error",
]);
export type RestructureErrorCode = z.infer<typeof RestructureErrorCode>;

/** What a `RESTRUCTURE_STATUS`/`PAUSE`/`RESUME`/`CANCEL` reply carries. */
export const RestructureJobResult = z.object({
  job: z.custom<Job>(),
  /**
   * Present once the job is completed: the live-tree diff of the carried
   * plan. Absent while the job is running (the diff means nothing yet).
   */
  diff: z.custom<RestructureDiff>().optional(),
});

export const RestructureMessageResult = z.union([
  z.object({
    ok: z.literal(true),
    code: z.literal("job_ok"),
    job: z.custom<Job>(),
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("job_state"),
    result: RestructureJobResult,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("applied"),
    moved: z.number().nonnegative(),
    snapshotId: z.number(),
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("undone"),
  }),
  z.object({
    ok: z.literal(false),
    code: RestructureErrorCode,
    message: z.string(),
    /** See llm-features: a target origin, never content. */
    destinationOrigin: z.string().optional(),
    consent: FeatureConsentDisclosure.optional(),
    consentApproval: FeatureConsentApproval.optional(),
  }),
]);
export type RestructureMessageResult = z.infer<
  typeof RestructureMessageResult
>;

/** The subset of `runtime.MessageSender` this protocol inspects. */
export interface RestructureMessageSender {
  url?: string;
}

function failure(
  code: RestructureErrorCode,
  message: string,
): RestructureMessageResult {
  return { ok: false, code, message };
}

class ReplyError extends Error {
  readonly reply: RestructureMessageResult;
  constructor(reply: RestructureMessageResult) {
    super("reply");
    this.reply = reply;
  }
}

function isTrustedExtensionSender(sender: RestructureMessageSender): boolean {
  try {
    const base = chrome.runtime.getURL("");
    return typeof sender.url === "string" && sender.url.startsWith(base);
  } catch {
    return false;
  }
}

/** Injected so the protocol is testable without a live worker. */
export interface RestructureDeps {
  /** Drive a persisted job to completion (production: `runPersistedJob`). */
  runJob(jobId: string): Promise<unknown>;
}

function mapError(cause: unknown): RestructureMessageResult {
  if (cause instanceof ReplyError) return cause.reply;
  if (cause instanceof BlocklistReadError) return failure(cause.code, cause.message);
  if (cause instanceof ApplyError) return failure(cause.code, cause.message);
  if (cause instanceof LlmGateError) return failure(cause.code, cause.message);
  if (cause instanceof LlmCapabilityError) {
    return failure(
      "capability_unsupported",
      "The configured provider rejected structured output.",
    );
  }
  if (cause instanceof LlmHttpError) {
    return failure(
      "http_error",
      `The LLM provider answered HTTP ${cause.status}.`,
    );
  }
  return failure(
    "internal_error",
    "The request failed unexpectedly; nothing was sent or changed on purpose.",
  );
}

function jobStateReply(job: Job, diff?: RestructureDiff): RestructureMessageResult {
  const result: { job: Job; diff?: RestructureDiff } = { job };
  if (diff !== undefined) result.diff = diff;
  return { ok: true, code: "job_state", result };
}

/**
 * The full start path: live synopsis → gated proposal → enqueue → mark
 * running → fire-and-forget the persisted runner (the sidepanel polls
 * `RESTRUCTURE_STATUS`; a `paused`/terminal row the flip raced is left alone
 * because `runPersistedJob` re-reads status before driving).
 */
async function startRestructure(
  providerId: string,
  unknownCostConfirmed: boolean | undefined,
  consentApproval: FeatureConsentApproval | undefined,
  deps: RestructureDeps,
): Promise<RestructureMessageResult> {
  // The sidepanel view sends the sentinel "active" — resolve it to the
  // active provider's record here so every downstream lookup (consent
  // origin, proposal, reservations) uses the record's own id.
  const record =
    providerId === "active"
      ? await readActiveLlmProvider()
      : await readLlmProvider(providerId);
  if (record === null) {
    return failure("no_provider", "No LLM provider is configured for restructure.");
  }
  const consent = featureConsentDisclosure("llm_restructure", record);
  // Admission precedes every tree/metadata/blocklist read and all side effects.
  // The worker never creates or refreshes grants, even on a bound retry.
  if (
    (consentApproval !== undefined &&
      !matchesFeatureConsentApproval(consentApproval, consent.approval)) ||
    (unknownCostConfirmed === true && consentApproval === undefined) ||
    !(await hasConsentAtOrigin(consent.scope, consent.approval.origin))
  ) {
    return {
      ok: false,
      code: "consent_required",
      message: "Review and accept the restructure disclosure for the current provider.",
      consent,
    };
  }
  const [tree, metas, userBlocklist] = await Promise.all([
    getSubTree(ROOT_NODE_ID),
    listMeta(),
    readBlocklist(),
  ]);
  const leafIds: string[] = [];
  // Complete LOCAL provenance, before any synopsis caps. Even a host omitted
  // from `domains` can contribute counts/tags/titles and ancestor folder paths.
  // Already-blocked leaves contributed nothing and must not poison later sends.
  const sourceUrls: string[] = [];
  const pending: BookmarksTreeNode[] = [...tree].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.url !== undefined) {
      leafIds.push(node.id);
      if (!isSensitiveUrl(node.url, userBlocklist) && domainOf(node.url) !== null) {
        sourceUrls.push(node.url);
      }
    }
    for (const child of [...(node.children ?? [])].reverse()) pending.push(child);
  }
  if (leafIds.length === 0) {
    return failure("not_found", "The library has no bookmarks to restructure.");
  }
  const synopsis = buildLibrarySynopsis(tree, metas, { userBlocklist });
  const beforeSend = () => db.transaction("r", db.metadata, db.consents, async () => {
    // Read policy and recipient/consent in one local snapshot, then re-admit
    // every original contributing URL. No source identifiers reach the wire.
    const currentBlocklist = await readBlocklist();
    if (sourceUrls.some((url) => isSensitiveUrl(url, currentBlocklist))) {
      throw new LlmGateError(
        "request_not_allowed",
        "A source bookmark is no longer allowed for restructure sending.",
      );
    }
    const current = providerId === "active"
      ? await readActiveLlmProvider()
      : await readLlmProvider(providerId);
    if (current === null) {
      throw new ReplyError(failure("no_provider", "No LLM provider is configured for restructure."));
    }
    const currentConsent = featureConsentDisclosure("llm_restructure", current);
    if (
      !matchesFeatureConsentApproval(consent.approval, currentConsent.approval) ||
      !(await hasConsentAtOrigin(currentConsent.scope, currentConsent.approval.origin))
    ) {
      throw new ReplyError({
        ok: false,
        code: "consent_required",
        message: "Review and accept the restructure disclosure for the current provider.",
        consent: currentConsent,
      });
    }
  });
  try {
    const { proposal } = await proposeLayout(record.providerId, synopsis, {
      beforeSend,
      ...(unknownCostConfirmed !== undefined ? { unknownCostConfirmed } : {}),
    }).catch(async (cause: unknown) => {
      // Retry preflight may short-circuit before its dispatch callback.
      // Prefer the renewed authority/policy refusal over a stale gate code.
      if (cause instanceof LlmGateError) await beforeSend();
      throw cause;
    });
    const job = await enqueueJob({
      kind: "restructure",
      bookmarkIds: leafIds,
      restructureProposal: proposal,
    });
    await setJobStatus(job.id, "running");
    void deps.runJob(job.id).catch(() => {
      // Best-effort; resumeJobs on the next worker start retries.
    });
    return { ok: true, code: "job_ok", job: { ...job, status: "running" } };
  } catch (cause) {
    const reply = mapError(cause);
    if (!reply.ok && reply.code === "confirmation_required") {
      return {
        ...reply,
        destinationOrigin: consent.approval.origin,
        consentApproval: consent.approval,
      };
    }
    return reply;
  }
}

async function statusReply(jobId?: string): Promise<RestructureMessageResult> {
  let job: Job | undefined;
  if (jobId !== undefined) {
    job = await getJob(jobId);
  } else {
    job = await latestRestructureJob();
  }
  if (job === undefined || job.kind !== "restructure") {
    return failure("not_found", "No such restructure job.");
  }
  if (job.status === "completed" && job.restructure !== undefined) {
    const tree = await getSubTree(ROOT_NODE_ID);
    return jobStateReply(job, buildRestructureDiff(tree, job.restructure));
  }
  return jobStateReply(job);
}

async function latestRestructureJob(): Promise<Job | undefined> {
  // Latest restructure job by creation time — the view's resume target.
  // Restructure jobs are few and this runs only when the view opens, so a
  // filtered scan is fine.
  const rows = await db.jobs.toArray();
  return rows
    .filter((j) => j.kind === "restructure")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export async function handleRestructureMessage(
  message: unknown,
  sender: RestructureMessageSender,
  deps: RestructureDeps,
): Promise<RestructureMessageResult | undefined> {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    !RESTRUCTURE_TYPES.has((message as { type: unknown }).type as string)
  ) {
    return undefined;
  }
  if (!isTrustedExtensionSender(sender)) {
    return failure("untrusted_sender", "Only extension pages may call this.");
  }
  const parsed = RestructureMessage.safeParse(message);
  if (!parsed.success) {
    return failure("malformed_message", "The message failed validation.");
  }
  try {
    switch (parsed.data.type) {
      case "RESTRUCTURE_START":
        return await startRestructure(
          parsed.data.providerId,
          parsed.data.unknownCostConfirmed,
          parsed.data.consentApproval,
          deps,
        );
      case "RESTRUCTURE_STATUS":
        return await statusReply(parsed.data.jobId);
      case "RESTRUCTURE_PAUSE": {
        const job = await pauseJob(parsed.data.jobId);
        return { ok: true, code: "job_ok", job };
      }
      case "RESTRUCTURE_RESUME": {
        const job = await resumeJob(parsed.data.jobId);
        void deps.runJob(job.id).catch(() => {});
        return { ok: true, code: "job_ok", job };
      }
      case "RESTRUCTURE_CANCEL": {
        const job = await cancelJob(parsed.data.jobId);
        return { ok: true, code: "job_ok", job };
      }
      case "RESTRUCTURE_CONFIRM": {
        const result = await applyRestructurePlan(
          parsed.data.jobId,
          parsed.data.bookmarkIds,
        );
        return {
          ok: true,
          code: "applied",
          moved: result.moved,
          snapshotId: result.snapshotId,
        };
      }
      case "RESTRUCTURE_UNDO": {
        const result = await undoRestructurePlan();
        if (!result.ok) {
          return failure(
            result.code === "empty" ? "empty" : "internal_error",
            result.message,
          );
        }
        return { ok: true, code: "undone" };
      }
    }
  } catch (cause) {
    return mapError(cause);
  }
}
