import type { BulkApproveResult } from "../decisions/apply";
import type {
  AnalysisBookmark,
  AnalyzeBookmarkResult,
} from "../decisions/pipeline";
import { DecisionSettings } from "../decisions/policy";
import type { RerankSearchResult } from "../decisions/rerank";
import type { DecisionRow } from "../decisions/store";
import { Job, JobCostEstimate, JobKind, MAX_JOB_BOOKMARK_IDS } from "../schemas/job";
import type { Job as JobDocument, JobCostEstimate as JobCostEstimateType } from "../schemas/job";
import { z } from "../schemas/z";

/**
 * The worker side of the Phase 4 decisions flow (spec FR9/FR10). The
 * extension's own pages (popup, side panel, Options) send one of these
 * intents; the worker validates it at the trust boundary, dispatches it to
 * the decision services, and answers with a redacted result.
 *
 * Invariants, mirroring `src/messages/provider.ts`:
 *
 * - **Keys and the Jev client stay in the worker.** No intent may carry key
 *   material, and no response may return it — nor any bookmark content. The
 *   UI sends intents and reads the Dexie tables directly (live queries).
 * - **Total.** `handleDecisionsMessage` never throws: every path resolves to
 *   a `DecisionMessageResult`, so the `chrome.runtime.onMessage` adapter can
 *   answer `sendResponse` exactly once.
 * - **Fall-through.** A message this module does not own returns `undefined`
 *   (before the trust check), so the provider handler still receives and
 *   answers it. Dispatch is by the message's `type` discriminator.
 * - **Redacted error mapping.** Failures are mapped by the thrown value's
 *   `.code` — never by `instanceof DecisionPipelineError`, because the rerank
 *   service throws its own `RerankError` (a sibling class that exposes the
 *   same `code`). Any value without a code-shaped `code` collapses to a
 *   static `internal_error`, so a raw error message can never cross.
 *
 * `chrome` is provided by the extension runtime; only the used slice is
 * declared so access stays lazy and `vi.stubGlobal("chrome", ...)` works.
 */
declare const chrome: {
  runtime: {
    getURL(path: string): string;
  };
};

/** The `type` discriminators this module owns, in a stable order. */
export const DECISION_MESSAGE_TYPES = [
  "ANALYZE_BOOKMARK",
  "SAVE_SUGGEST",
  "RERANK",
  "JOB_START",
  "JOB_PAUSE",
  "JOB_RESUME",
  "JOB_CANCEL",
  "APPROVE_DECISION",
  "REJECT_DECISION",
  "REVERT_DECISION",
  "BULK_APPROVE",
  "GET_SETTINGS",
  "SET_SETTINGS",
  "SET_BLOCKLIST",
] as const;

const OWNED_TYPES: ReadonlySet<string> = new Set(DECISION_MESSAGE_TYPES);

/**
 * Intents the extension's own pages may send, validated at the trust
 * boundary. Every field is a plain scalar or id list — never a key, a Jev
 * client, or a bookmark body beyond the save-suggest snapshot the popup
 * already holds. `DecisionSettings` is closed (`strictObject`), so a settings
 * write carrying an extra `key` field fails validation.
 */
export const DecisionMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ANALYZE_BOOKMARK"),
    bookmarkId: z.string().min(1),
  }),
  z.object({
    type: z.literal("SAVE_SUGGEST"),
    bookmark: z.object({
      id: z.string().min(1),
      title: z.string(),
      url: z.string().min(1),
      parentId: z.string().min(1).optional(),
      // `notes` is accepted by the pipeline but never sent; the popup does
      // not need to forward it, and it stays on the device if it does.
      notes: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("RERANK"), query: z.string().min(1) }),
  z.object({
    type: z.literal("JOB_START"),
    kind: JobKind,
    bookmarkIds: z.array(z.string().min(1)).min(1).max(MAX_JOB_BOOKMARK_IDS),
  }),
  z.object({ type: z.literal("JOB_PAUSE"), jobId: z.string().min(1) }),
  z.object({ type: z.literal("JOB_RESUME"), jobId: z.string().min(1) }),
  z.object({ type: z.literal("JOB_CANCEL"), jobId: z.string().min(1) }),
  z.object({ type: z.literal("APPROVE_DECISION"), decisionId: z.string().min(1) }),
  z.object({ type: z.literal("REJECT_DECISION"), decisionId: z.string().min(1) }),
  z.object({ type: z.literal("REVERT_DECISION"), decisionId: z.string().min(1) }),
  z.object({
    type: z.literal("BULK_APPROVE"),
    decisionIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({ type: z.literal("GET_SETTINGS") }),
  z.object({ type: z.literal("SET_SETTINGS"), settings: DecisionSettings }),
  z.object({
    type: z.literal("SET_BLOCKLIST"),
    blocklist: z.array(z.string()),
  }),
]);
export type DecisionMessage = z.infer<typeof DecisionMessage>;

/**
 * Machine-readable failure codes for the decisions protocol. Protocol-only
 * codes are `untrusted_sender`/`malformed_message`/`internal_error`; every
 * other code is a service error's own (already redacted) `code` relayed
 * verbatim — the analyze pipeline's, the rerank service's, the store/apply
 * guards', and the job queue/runner's. The token shape is enforced so a
 * value that is not a code-shaped string can never cross.
 */
export const DecisionErrorCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "an error code is a lowercase snake_case token");
export type DecisionErrorCode = z.infer<typeof DecisionErrorCode>;

/** Redacted summary of one analyze/save-suggest run — counts, never content. */
export const AnalyzeSummary = z.object({
  sent: z.boolean(),
  reason: z.enum(["blocklisted"]).optional(),
  model: z.string().nullable().optional(),
  decisionCount: z.number().int().min(0),
});
export type AnalyzeSummary = z.infer<typeof AnalyzeSummary>;

/** Redacted rerank result: candidate ids and probabilities only. */
export const RerankSummary = z.object({
  sent: z.boolean(),
  reason: z.enum(["empty", "blocklisted"]).optional(),
  model: z.string().optional(),
  results: z.array(z.object({ id: z.string(), probability: z.number() })),
  noMatch: z.boolean().optional(),
});
export type RerankSummary = z.infer<typeof RerankSummary>;

/** Redacted decision row: id + status only (no kind, folder, tag, or title). */
export const DecisionSummary = z.object({
  id: z.string(),
  status: z.string(),
});
export type DecisionSummary = z.infer<typeof DecisionSummary>;

/** One bulk-approve failure, carrying the underlying redacted code/message. */
export const BulkApproveFailureSummary = z.object({
  id: z.string(),
  code: z.string(),
  message: z.string(),
});
export type BulkApproveFailureSummary = z.infer<
  typeof BulkApproveFailureSummary
>;

/**
 * Every worker response is one of these shapes. A plain union (not a
 * `z.discriminatedUnion("ok", ...)`) because several success shapes share
 * `ok: true` and are told apart by their `code` literal — Zod rejects
 * duplicate discriminator values. `job` is the persisted `Job` row (ids and
 * counters only; no bookmark content).
 */
export const DecisionMessageResult = z.union([
  z.object({
    ok: z.literal(true),
    code: z.literal("analyze_ok"),
    result: AnalyzeSummary,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("rerank_ok"),
    result: RerankSummary,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("job_ok"),
    job: Job,
    /** A07/FR7: the pre-run estimate JOB_START replies carry. */
    estimate: JobCostEstimate.optional(),
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("decision_ok"),
    decision: DecisionSummary,
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("bulk_ok"),
    applied: z.array(z.string()),
    failed: z.array(BulkApproveFailureSummary),
  }),
  z.object({
    ok: z.literal(true),
    code: z.literal("settings_ok"),
    settings: DecisionSettings,
    blocklist: z.array(z.string()),
  }),
  z.object({
    ok: z.literal(false),
    code: DecisionErrorCode,
    message: z.string(),
  }),
]);
export type DecisionMessageResult = z.infer<typeof DecisionMessageResult>;

/** The subset of `runtime.MessageSender` this protocol inspects. */
export interface DecisionMessageSender {
  url?: string;
}

/** The settings/blocklist snapshot the Options page renders. */
export interface SettingsSnapshot {
  settings: DecisionSettings;
  blocklist: readonly string[];
}

/**
 * The service surface the protocol dispatches to. Production wires the real
 * decision services and the Jev-bound job runner in `background.ts`; tests
 * inject fakes, so the protocol's trust/totality/redaction behavior is
 * verifiable without a network or a live worker. Keeping the Jev client and
 * the provider key behind this boundary is what keeps them in the worker.
 */
export interface DecisionsHandlers {
  /** Analyze a bookmark resolved by id from the live tree. */
  analyzeById(bookmarkId: string): Promise<AnalyzeBookmarkResult>;
  /** Analyze a not-yet-saved bookmark the popup holds (folder suggestion). */
  saveSuggest(bookmark: AnalysisBookmark): Promise<AnalyzeBookmarkResult>;
  /** Rerank the live search results for `query` ("Ask"). */
  rerank(query: string): Promise<RerankSearchResult>;
  approve(id: string): Promise<DecisionRow>;
  reject(id: string): Promise<DecisionRow>;
  revert(id: string): Promise<DecisionRow>;
  bulkApprove(ids: readonly string[]): Promise<BulkApproveResult>;
  /** Enqueue a job and start it running in the background. */
  startJob(
    kind: JobDocument["kind"],
    bookmarkIds: readonly string[],
  ): Promise<{ job: JobDocument; estimate?: JobCostEstimateType }>;
  pauseJob(id: string): Promise<JobDocument>;
  resumeJob(id: string): Promise<JobDocument>;
  cancelJob(id: string): Promise<JobDocument>;
  getSettings(): Promise<SettingsSnapshot>;
  setSettings(settings: DecisionSettings): Promise<SettingsSnapshot>;
  setBlocklist(blocklist: readonly string[]): Promise<SettingsSnapshot>;
}

function failure(
  code: DecisionErrorCode,
  message: string,
): DecisionMessageResult {
  return { ok: false, code, message };
}

/**
 * True only for a page belonging to THIS extension. WXT emits extension pages
 * under `chrome-extension://<id>/`; a content script's `sender.url` is the
 * host page URL and another extension's pages carry a different id, so both
 * fail this comparison. Fail closed on a missing `chrome` surface.
 */
function isTrustedExtensionSender(sender: DecisionMessageSender): boolean {
  try {
    const base = chrome.runtime.getURL("");
    return typeof sender.url === "string" && sender.url.startsWith(base);
  } catch {
    return false;
  }
}

/** The message's discriminator, when it is one this module owns. */
function ownedType(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const type = (message as { readonly type?: unknown }).type;
  return typeof type === "string" && OWNED_TYPES.has(type) ? type : undefined;
}

/** A code-shaped `code` on a thrown value marks a typed, redacted service error. */
const CODE_SHAPE = /^[a-z][a-z0-9_]*$/;

/**
 * Map any thrown cause onto the protocol's error model. Keyed on the value's
 * `.code` — both `DecisionPipelineError` and `RerankError` expose a
 * code-shaped `code`, so a rerank failure is relayed exactly like a pipeline
 * failure (never an `instanceof DecisionPipelineError` test). The service
 * convention is that a code-shaped error's `message` is already redacted; any
 * other throw collapses to a static `internal_error` so an arbitrary message
 * (which could embed content) never crosses.
 */
function mapError(cause: unknown): DecisionMessageResult {
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { readonly code?: unknown }).code;
    if (typeof code === "string" && CODE_SHAPE.test(code)) {
      const message = (cause as { readonly message?: unknown }).message;
      return failure(
        code,
        typeof message === "string" && message !== ""
          ? message
          : "The request failed; nothing was changed on purpose.",
      );
    }
  }
  return failure(
    "internal_error",
    "The request failed unexpectedly; nothing was changed on purpose.",
  );
}

function analyzeResult(result: AnalyzeBookmarkResult): DecisionMessageResult {
  if (!result.sent) {
    return {
      ok: true,
      code: "analyze_ok",
      result: { sent: false, reason: result.reason, decisionCount: 0 },
    };
  }
  return {
    ok: true,
    code: "analyze_ok",
    result: {
      sent: true,
      model: result.model,
      decisionCount: result.decisions.length,
    },
  };
}

function rerankResult(result: RerankSearchResult): DecisionMessageResult {
  if (!result.sent) {
    return {
      ok: true,
      code: "rerank_ok",
      result: { sent: false, reason: result.reason, results: [] },
    };
  }
  return {
    ok: true,
    code: "rerank_ok",
    result: {
      sent: true,
      model: result.model,
      results: result.results.map((entry) => ({
        id: entry.id,
        probability: entry.probability,
      })),
      noMatch: result.noMatch,
    },
  };
}

function decisionResult(row: DecisionRow): DecisionMessageResult {
  return {
    ok: true,
    code: "decision_ok",
    decision: { id: row.id, status: row.status },
  };
}

function settingsResult(snapshot: SettingsSnapshot): DecisionMessageResult {
  return {
    ok: true,
    code: "settings_ok",
    settings: snapshot.settings,
    blocklist: [...snapshot.blocklist],
  };
}

async function dispatch(
  message: DecisionMessage,
  handlers: DecisionsHandlers,
): Promise<DecisionMessageResult> {
  switch (message.type) {
    case "ANALYZE_BOOKMARK":
      return analyzeResult(await handlers.analyzeById(message.bookmarkId));
    case "SAVE_SUGGEST":
      return analyzeResult(await handlers.saveSuggest(message.bookmark));
    case "RERANK":
      return rerankResult(await handlers.rerank(message.query));
    case "JOB_START": {
      const { job, estimate } = await handlers.startJob(
        message.kind,
        message.bookmarkIds,
      );
      return {
        ok: true,
        code: "job_ok",
        job,
        ...(estimate === undefined ? {} : { estimate }),
      };
    }
    case "JOB_PAUSE":
      return { ok: true, code: "job_ok", job: await handlers.pauseJob(message.jobId) };
    case "JOB_RESUME":
      return { ok: true, code: "job_ok", job: await handlers.resumeJob(message.jobId) };
    case "JOB_CANCEL":
      return { ok: true, code: "job_ok", job: await handlers.cancelJob(message.jobId) };
    case "APPROVE_DECISION":
      return decisionResult(await handlers.approve(message.decisionId));
    case "REJECT_DECISION":
      return decisionResult(await handlers.reject(message.decisionId));
    case "REVERT_DECISION":
      return decisionResult(await handlers.revert(message.decisionId));
    case "BULK_APPROVE": {
      const result = await handlers.bulkApprove(message.decisionIds);
      return {
        ok: true,
        code: "bulk_ok",
        applied: result.applied.map((row) => row.id),
        failed: result.failed.map((entry) => ({
          id: entry.id,
          code: entry.code,
          message: entry.message,
        })),
      };
    }
    case "GET_SETTINGS":
      return settingsResult(await handlers.getSettings());
    case "SET_SETTINGS":
      return settingsResult(await handlers.setSettings(message.settings));
    case "SET_BLOCKLIST":
      return settingsResult(await handlers.setBlocklist(message.blocklist));
  }
}

/**
 * Validate and dispatch one decisions-protocol message. Returns `undefined`
 * for a message this module does not own (a no-op the adapter forwards to the
 * provider handler), otherwise a `DecisionMessageResult`. Total: it never
 * throws — the trust check runs first, validation failures become
 * `malformed_message`, and any handler rejection is mapped through
 * {@link mapError}.
 */
export async function handleDecisionsMessage(
  message: unknown,
  sender: DecisionMessageSender,
  handlers: DecisionsHandlers,
): Promise<DecisionMessageResult | undefined> {
  if (ownedType(message) === undefined) return undefined;
  try {
    if (!isTrustedExtensionSender(sender)) {
      return failure(
        "untrusted_sender",
        "Decision messages are only handled from this extension's own pages.",
      );
    }
    const parsed = DecisionMessage.safeParse(message);
    if (!parsed.success) {
      return failure(
        "malformed_message",
        "The message did not match the decisions protocol.",
      );
    }
    return await dispatch(parsed.data, handlers);
  } catch (cause) {
    return mapError(cause);
  }
}
