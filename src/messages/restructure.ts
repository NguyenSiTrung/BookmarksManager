import { db } from "../db/database";
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
import { grantConsentAtOrigin } from "../consent/records";
import { resolveLlmDestination } from "../llm/providers";
import { readActiveLlmProvider, readLlmProvider } from "../llm/settings";
import { LlmCapabilityError } from "../llm/structured";
import { LlmGateError } from "../net/llm-send";
import { ApplyError, applyRestructurePlan } from "../restructure/apply";
import { buildRestructureDiff } from "../restructure/diff";
import type { RestructureDiff } from "../restructure/diff";
import { proposeLayout } from "../restructure/propose";
import { buildLibrarySynopsis } from "../restructure/synopsis";
import { getSubTree, ROOT_NODE_ID } from "../sync/chrome-bookmarks";
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
 */
export const RestructureErrorCode = z.enum([
  "untrusted_sender",
  "malformed_message",
  "not_found",
  "invalid_job",
  "not_ready",
  "stale",
  "mutation_failed",
  "illegal_transition",
  "unregistered_scope",
  "no_provider",
  "invalid_provider",
  "request_not_allowed",
  "unlisted_model",
  "no_consent",
  "no_permission",
  "no_key",
  "pricing_required",
  "confirmation_required",
  "budget_exceeded",
  "timeout",
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
  const [tree, metas] = await Promise.all([
    getSubTree(ROOT_NODE_ID),
    listMeta(),
  ]);
  const leafIds: string[] = [];
  const walk = (nodes: readonly { id: string; url?: string; children?: readonly unknown[] }[]) => {
    for (const n of nodes) {
      if (n.url !== undefined) leafIds.push(n.id);
      if (n.children !== undefined) {
        walk(n.children as typeof nodes);
      }
    }
  };
  walk(tree);
  if (leafIds.length === 0) {
    return failure("not_found", "The library has no bookmarks to restructure.");
  }
  const synopsis = buildLibrarySynopsis(tree, metas);
  try {
    // The affirmative "Propose a layout" click is the consent trigger for
    // this scope — write the grant so the gate's per-scope check passes.
    await grantConsentAtOrigin(
      "llm_restructure",
      resolveLlmDestination(record.provider).origin,
    );
    const { proposal } = await proposeLayout(record.providerId, synopsis, {
      ...(unknownCostConfirmed !== undefined ? { unknownCostConfirmed } : {}),
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
        destinationOrigin: resolveLlmDestination(record.provider).origin,
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
