import { db } from "../db/database";
import { Category } from "../schemas/bookmark";
import { Decision } from "../schemas/decision";
import type { Decision as DecisionDocument } from "../schemas/decision";
import { DecisionState } from "../schemas/decision-state";
import type { SentBookmark } from "../schemas/decision-state";
import type { TagDef } from "../schemas/meta";
import { UsageRecord } from "../schemas/usage";
import { answerConfidence } from "../jev/confidence";
import { JevClientError, createJevClient } from "../jev/client";
import type { JevClient, JevRunResult, JevTransport } from "../jev/client";
import type { InstructionsText } from "../jev/define";
import { categorize } from "../jev/tasks/categorize";
import { misfiled } from "../jev/tasks/misfiled";
import { placement } from "../jev/tasks/placement";
import { tags } from "../jev/tasks/tags";
import type { Question, SystemOneRequest } from "../jev/wire";
import { NetworkGateError } from "../net/send";
import { ROOT_NODE_ID } from "../sync/chrome-bookmarks";
import type { BookmarkItem, FlattenedTree } from "../sync/tree";
import { DecisionApplyError, approveDecision } from "./apply";
import {
  NONE_FOLDER_OPTION,
  folderCandidates,
  misfiledCandidates,
  tagCandidates,
} from "./candidates";
import type {
  CandidateSubject,
  TagCandidate,
  TagCandidateContext,
} from "./candidates";
import { minimizeBookmark } from "./minimize";
import { evaluatePolicy } from "./policy";
import type {
  DecisionSettings,
  PolicyOccasion,
  PolicyOutcome,
} from "./policy";
import { DecisionStoreError, persistDecision } from "./store";
import type { DecisionRow } from "./store";
import { maybeEscalateDecision } from "../llm/escalate";
import type { EscalationOption } from "../llm/escalate";
import { assertJobAuthority } from "../jobs/queue";
import type { Job } from "../schemas/job";

/**
 * Analyze pipeline (spec FR2–FR6, PROJECT_PLAN.md §6.2/§9.1/§10.2): the
 * orchestration that turns one bookmark into persisted `Decision` rows. It
 *  1. minimizes the bookmark (`minimizeBookmark` — title, cleaned URL, and
 *     domain only; notes never leave the device),
 *  2. computes the candidate shortlists in code (`tagCandidates`,
 *     `folderCandidates`/`misfiledCandidates`),
 *  3. builds the requested question sets and merges them into ONE
 *     `DecisionState` + one `SystemOneRequest` (plan §9.1 "one request, many
 *     questions"),
 *  4. sends it through a `createJevClient` bound to the `jev_decisions`
 *     scope,
 *  5. cross-checks every answer against the candidates that were actually
 *     sent — a choice outside the sent option keys (or an answer of the wrong
 *     type) is an `answer_mismatch`, the FR2 hard boundary,
 *  6. applies the §10.2 policy and persists each decision (with
 *     `source.model` from the response and `source.questionSetVersion` from
 *     the task) plus one `usage` row.
 *
 * A blocklisted/sensitive bookmark is skipped with `{sent: false}` and makes
 * NO request. Auto-apply (only `add_tags`/`set_category`, only with the
 * kind's toggle on) runs the decision through the guarded `approveDecision`
 * apply path behind an undo snapshot; every other outcome lands `pending`
 * (review/pre-select) or `unsure` per the policy bands.
 *
 * Failures are typed `DecisionPipelineError`s. Provider errors relay the
 * client's own (already redacted) code and message; persistence/apply
 * failures are reported with generic, content-free messages — no response
 * body, title, URL, or note ever reaches an error message.
 */

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/** The bookmark under analysis. `notes` is accepted but never sent. */
export interface AnalysisBookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** Chrome parent folder id — used only for the misfiled scan's `folderPath`. */
  readonly parentId?: string;
  /** Stays on the device; accepted so callers can pass a whole bookmark. */
  readonly notes?: string;
}

/** The library data the candidate selectors read. */
export interface AnalysisContext {
  /** Existing tag definitions for the tag shortlist. */
  readonly tagDefs: readonly TagDef[];
  /** Same-domain bookmarks + meta rows for the tag selector's domain signal. */
  readonly corpus: TagCandidateContext;
  /** Flattened bookmark tree for the folder shortlists. */
  readonly tree: FlattenedTree;
  /** §10.2 auto-apply settings; absent means every toggle is off. */
  readonly settings?: DecisionSettings;
}

/** Which question sets one analysis run asks. */
export type AnalysisCheck = "categorize" | "tags" | "placement" | "misfiled";

/** Every check, in a stable order. */
export const ANALYSIS_CHECKS: readonly AnalysisCheck[] = [
  "categorize",
  "tags",
  "placement",
  "misfiled",
];

/** The default analyze-selection checks: categorize + tags (plan §9.1). */
const DEFAULT_CHECKS: readonly AnalysisCheck[] = ["categorize", "tags"];

export interface AnalyzeBookmarkOptions {
  readonly bookmark: AnalysisBookmark;
  readonly context: AnalysisContext;
  /** Jev provider the client is bound to — a preset id or `"custom"`. */
  readonly providerId: string;
  /** Model id sent in the request; the response may report another. */
  readonly model: string;
  /** Checks to run; defaults to `["categorize", "tags"]`. */
  readonly checks?: readonly AnalysisCheck[];
  /**
   * The user's own blocklist (normalized hosts). A bookmark on a
   * user-blocklisted host is skipped exactly like a built-in-sensitive one
   * (`{sent:false, reason:"blocklisted"}`) and never enters a request. Absent
   * means the user has added no entries.
   */
  readonly userBlocklist?: readonly string[];
  /** An already-built client (tests / reuse). When absent one is created. */
  readonly client?: JevClient;
  /** Transport override when the pipeline creates its own client. */
  readonly transport?: JevTransport;
  /** Local captured runner authority; never serialized in the request. */
  readonly job?: Pick<Job, "id" | "ownerGeneration">;
}

/** A skipped bookmark — no request was made for it. */
export interface AnalysisNotSent {
  readonly sent: false;
  readonly reason: "blocklisted";
}

/** A completed analysis. `model`/`usage` are null when nothing was asked. */
export interface AnalysisSent {
  readonly sent: true;
  /** The model that answered, or null when no request was needed. */
  readonly model: string | null;
  readonly decisions: readonly DecisionRow[];
  readonly usage: UsageRecord | null;
}

export type AnalyzeBookmarkResult = AnalysisNotSent | AnalysisSent;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** `code` values on a failed analysis: the client's codes plus pipeline ones. */
export type DecisionPipelineErrorCode =
  | JevClientError["code"]
  | "invalid_input"
  | "persist_failed"
  | "apply_failed"
  | "provider";

/** Rejection for every failure this module produces. Messages stay redacted. */
export class DecisionPipelineError extends Error {
  readonly code: DecisionPipelineErrorCode;

  constructor(code: DecisionPipelineErrorCode, message: string) {
    super(message);
    this.name = "DecisionPipelineError";
    this.code = code;
  }
}

/** Map any thrown cause onto the pipeline error model (never copies content). */
function toPipelineError(cause: unknown): DecisionPipelineError {
  if (cause instanceof DecisionPipelineError) return cause;
  if (cause instanceof JevClientError) {
    // The client's message is already redacted (no bodies, keys, or state).
    return new DecisionPipelineError(cause.code, cause.message);
  }
  if (cause instanceof NetworkGateError) {
    return new DecisionPipelineError(cause.code, cause.message);
  }
  return new DecisionPipelineError(
    "provider",
    "The analysis request failed before a response could be read.",
  );
}

// ---------------------------------------------------------------------------
// Built checks
// ---------------------------------------------------------------------------

/** The candidate index for a check, used by the answer-ID cross-check. */
type CandidateIndex =
  | { readonly kind: "categorize" }
  | { readonly kind: "tags"; readonly tags: readonly TagCandidate[] }
  | {
      readonly kind: "folder";
      readonly mode: "placement" | "misfiled";
      readonly ids: readonly string[];
      readonly currentId?: string;
    };

/** One prepared question set: its declaration, state, and candidate index. */
interface BuiltCheck {
  readonly check: AnalysisCheck;
  readonly questionSetVersion: string;
  readonly state: DecisionState;
  readonly candidates: CandidateIndex;
  /** The wire question keys, in the order the candidates were passed. */
  readonly fieldKeys: readonly string[];
  readonly build: (state: InstructionsText, model: string) => SystemOneRequest;
}

const TAG_THRESHOLD = 0.5;

function validateChecks(checks: readonly AnalysisCheck[]): void {
  if (checks.length === 0) {
    throw new DecisionPipelineError(
      "invalid_input",
      "An analysis needs at least one check.",
    );
  }
  for (const check of checks) {
    if (!ANALYSIS_CHECKS.includes(check)) {
      throw new DecisionPipelineError(
        "invalid_input",
        `Unknown analysis check ${JSON.stringify(check)}.`,
      );
    }
  }
  const folderChecks = checks.filter(
    (check) => check === "placement" || check === "misfiled",
  );
  if (folderChecks.length > 1) {
    throw new DecisionPipelineError(
      "invalid_input",
      "placement and misfiled cannot run in the same analysis.",
    );
  }
}

/** Build the requested question sets, skipping any with no candidates. */
function buildChecks(
  checks: readonly AnalysisCheck[],
  context: AnalysisContext,
  bookmark: AnalysisBookmark,
  sent: SentBookmark,
): BuiltCheck[] {
  const subject: CandidateSubject = { title: sent.title, url: sent.url };
  const built: BuiltCheck[] = [];
  for (const check of checks) {
    switch (check) {
      case "categorize": {
        const set = categorize({ bookmark: sent });
        built.push({
          check,
          questionSetVersion: set.questionSetVersion,
          state: set.state,
          candidates: { kind: "categorize" },
          fieldKeys: Object.keys(set.decision.fields),
          build: set.decision.build,
        });
        break;
      }
      case "tags": {
        const candidates = tagCandidates(
          subject,
          context.tagDefs,
          context.corpus,
        );
        if (candidates.length === 0) break;
        const set = tags({
          bookmark: sent,
          tags: candidates.map((candidate) => ({
            name: candidate.name,
            nameKey: candidate.nameKey,
            ...(candidate.description === undefined
              ? {}
              : { description: candidate.description }),
          })),
        });
        built.push({
          check,
          questionSetVersion: set.questionSetVersion,
          state: set.state,
          candidates: { kind: "tags", tags: candidates },
          fieldKeys: Object.keys(set.decision.fields),
          build: set.decision.build,
        });
        break;
      }
      case "placement": {
        const candidates = folderCandidates(subject, context.tree);
        if (candidates.candidates.length === 0) break;
        const set = placement({
          bookmark: sent,
          folders: candidates.candidates,
        });
        built.push({
          check,
          questionSetVersion: set.questionSetVersion,
          state: set.state,
          candidates: {
            kind: "folder",
            mode: "placement",
            ids: candidates.candidates.map((candidate) => candidate.id),
          },
          fieldKeys: Object.keys(set.decision.fields),
          build: set.decision.build,
        });
        break;
      }
      case "misfiled": {
        const candidates = misfiledCandidates(
          toBookmarkItem(bookmark),
          context.tree,
        );
        if (candidates.candidates.length === 0) break;
        const set = misfiled({
          bookmark: sent,
          folderPath: currentFolderPath(bookmark, context.tree),
          folders: candidates.candidates,
        });
        built.push({
          check,
          questionSetVersion: set.questionSetVersion,
          state: set.state,
          candidates: {
            kind: "folder",
            mode: "misfiled",
            ids: candidates.candidates.map((candidate) => candidate.id),
            ...(bookmark.parentId === undefined
              ? {}
              : { currentId: bookmark.parentId }),
          },
          fieldKeys: Object.keys(set.decision.fields),
          build: set.decision.build,
        });
        break;
      }
    }
  }
  return built;
}

/** Minimal `BookmarkItem` for `misfiledCandidates` (it reads title/url/parentId). */
function toBookmarkItem(bookmark: AnalysisBookmark): BookmarkItem {
  return {
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    path: [],
    isRoot: false,
    isManaged: false,
    depth: 0,
    kind: "bookmark",
    ...(bookmark.parentId === undefined ? {} : { parentId: bookmark.parentId }),
  };
}

/** The bookmark's current folder path ([] at root), for the misfiled state. */
function currentFolderPath(
  bookmark: AnalysisBookmark,
  tree: FlattenedTree,
): string[] {
  const parentId = bookmark.parentId;
  if (parentId === undefined || parentId === ROOT_NODE_ID) return [];
  const folder = tree.folders.get(parentId);
  return folder === undefined ? [] : [...folder.path, folder.title];
}

/** Merge every check's state into one `DecisionState`, then validate it. */
function mergeStates(built: readonly BuiltCheck[]): DecisionState {
  const state: Record<string, unknown> = {};
  for (const check of built) {
    for (const [key, value] of Object.entries(check.state)) {
      if (value !== undefined) state[key] = value;
    }
  }
  return DecisionState.parse(state);
}

/** Merge every check's questions into one request over `state`. */
function buildRequest(
  built: readonly BuiltCheck[],
  state: DecisionState,
  model: string,
): SystemOneRequest {
  const questions: Record<string, Question> = {};
  for (const check of built) {
    Object.assign(questions, check.build(state, model).questions);
  }
  return { model, state, questions };
}

// ---------------------------------------------------------------------------
// Answer-ID cross-check
// ---------------------------------------------------------------------------

function mismatch(key: string): DecisionPipelineError {
  return new DecisionPipelineError(
    "answer_mismatch",
    `The answer for question ${JSON.stringify(key)} is not one of the candidates that were sent.`,
  );
}

/**
 * FR2 hard boundary: every answer must match a candidate that was actually
 * sent. Choice answers must name a sent option key (`none` is always sent for
 * folder questions); noul answers must be noul. A violation is an
 * `answer_mismatch` and stops the run before anything is persisted.
 */
function crossCheckAnswers(
  built: readonly BuiltCheck[],
  answers: Record<string, { type: string; choice?: string }>,
): void {
  for (const check of built) {
    const key = check.fieldKeys[0];
    switch (check.candidates.kind) {
      case "categorize": {
        const answer = answers[key ?? ""];
        if (answer?.type !== "choice" || key === undefined) {
          throw mismatch(key ?? "category");
        }
        if (!Category.options.includes(answer.choice as Category)) {
          throw mismatch(key);
        }
        break;
      }
      case "tags": {
        for (const fieldKey of check.fieldKeys) {
          if (answers[fieldKey]?.type !== "noul") throw mismatch(fieldKey);
        }
        break;
      }
      case "folder": {
        const answer = answers[key ?? ""];
        if (answer?.type !== "choice" || key === undefined) {
          throw mismatch(key ?? "folder");
        }
        const allowed =
          answer.choice === NONE_FOLDER_OPTION ||
          check.candidates.ids.includes(answer.choice as string);
        if (!allowed) throw mismatch(key);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Answer interpretation → decision drafts
// ---------------------------------------------------------------------------

/** What a second opinion may see, carried alongside the draft it describes. */
interface EscalationDraftInput {
  readonly question: string;
  /** The allowed options: the model may only echo one of these ids. */
  readonly options: readonly EscalationOption[];
  readonly jevAnswer: string;
}

/** A decision ready to be persisted, before its status is decided. */
type DecisionDraft =
  | {
      readonly kind: "set_category";
      readonly category: Category;
      readonly confidence: number;
      readonly probabilities: Record<string, number>;
      readonly questionSetVersion: string;
      readonly escalation: EscalationDraftInput;
    }
  | {
      readonly kind: "add_tags";
      readonly tags: readonly string[];
      readonly confidence: number;
      readonly probabilities: Record<string, number>;
      readonly questionSetVersion: string;
      readonly escalation: EscalationDraftInput;
    }
  | {
      readonly kind: "move";
      readonly targetFolderId: string;
      readonly confidence: number;
      readonly probabilities: Record<string, number>;
      readonly questionSetVersion: string;
      readonly occasion: PolicyOccasion;
      readonly escalation: EscalationDraftInput;
    };

interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

function choiceAnswer(
  answers: Record<string, { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }>,
  key: string,
): ChoiceAnswer {
  const answer = answers[key];
  if (answer?.type !== "choice" || answer.choice === undefined) {
    throw mismatch(key);
  }
  return {
    choice: answer.choice,
    confidence: answer.confidence ?? 0,
    probabilities: answer.probabilities ?? {},
  };
}

/** Interpret the validated answers of every check into decision drafts. */
function interpret(
  built: readonly BuiltCheck[],
  answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }>,
): DecisionDraft[] {
  const drafts: DecisionDraft[] = [];
  for (const check of built) {
    switch (check.candidates.kind) {
      case "categorize": {
        const answer = choiceAnswer(answers, check.fieldKeys[0] ?? "category");
        drafts.push({
          kind: "set_category",
          category: answer.choice as Category,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          questionSetVersion: check.questionSetVersion,
          escalation: {
            question:
              "Which single category should this bookmark be filed under?",
            options: Category.options.map((id) => ({ id, label: id })),
            jevAnswer: answer.choice,
          },
        });
        break;
      }
      case "tags": {
        const selected: string[] = [];
        const probabilities: Record<string, number> = {};
        let confidence = Number.POSITIVE_INFINITY;
        check.candidates.tags.forEach((candidate, index) => {
          const key = check.fieldKeys[index] ?? `tag_${candidate.nameKey}`;
          const answer = answers[key];
          if (answer?.type !== "noul" || answer.noul === undefined) {
            throw mismatch(key);
          }
          probabilities[candidate.nameKey] = answer.noul;
          if (answer.noul >= TAG_THRESHOLD) {
            selected.push(candidate.nameKey);
            confidence = Math.min(
              confidence,
              answerConfidence({ type: "noul", noul: answer.noul }, TAG_THRESHOLD),
            );
          }
        });
        if (selected.length > 0) {
          drafts.push({
            kind: "add_tags",
            tags: selected,
            confidence,
            probabilities,
            questionSetVersion: check.questionSetVersion,
            escalation: {
              question: "Which of the offered tags apply to this bookmark?",
              options: check.candidates.tags.map((tag) => ({
                id: tag.nameKey,
                label: tag.name,
                ...(tag.description !== undefined
                  ? { description: tag.description }
                  : {}),
              })),
              jevAnswer: selected.join(", "),
            },
          });
        }
        break;
      }
      case "folder": {
        const answer = choiceAnswer(answers, check.fieldKeys[0] ?? "folder");
        if (
          answer.choice === NONE_FOLDER_OPTION ||
          answer.choice === check.candidates.currentId
        ) {
          break; // no move: nothing better than the status quo
        }
        drafts.push({
          kind: "move",
          targetFolderId: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
          questionSetVersion: check.questionSetVersion,
          occasion:
            check.candidates.mode === "misfiled" ? "misfiled_scan" : "on_save",
          escalation: {
            question: "Which folder should this bookmark live in?",
            options: (check.state.candidateFolders ?? []).map((folder) => ({
              id: folder.id,
              label: folder.path.join(" / "),
            })),
            jevAnswer: answer.choice,
          },
        });
        break;
      }
    }
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Policy + persistence
// ---------------------------------------------------------------------------

function policyOutcome(
  draft: DecisionDraft,
  settings: DecisionSettings | undefined,
): PolicyOutcome {
  if (draft.kind === "move") {
    return evaluatePolicy({
      kind: "move",
      occasion: draft.occasion,
      confidence: draft.confidence,
      ...(settings === undefined ? {} : { settings }),
    });
  }
  return evaluatePolicy({
    kind: draft.kind,
    confidence: draft.confidence,
    ...(settings === undefined ? {} : { settings }),
  });
}

/** Build the §7 `Decision` document for a draft at the policy-derived status. */
function toDocument(
  draft: DecisionDraft,
  options: AnalyzeBookmarkOptions,
  model: string,
  status: DecisionDocument["status"],
): DecisionDocument {
  const base = {
    id: crypto.randomUUID(),
    bookmarkIds: [options.bookmark.id],
    confidence: draft.confidence,
    probabilities: draft.probabilities,
    status,
    source: {
      engine: "jev" as const,
      providerId: options.providerId,
      model,
      questionSetVersion: draft.questionSetVersion,
    },
    createdAt: new Date().toISOString(),
  };
  switch (draft.kind) {
    case "set_category":
      return Decision.parse({
        ...base,
        kind: "set_category",
        category: draft.category,
      });
    case "add_tags":
      return Decision.parse({ ...base, kind: "add_tags", tags: [...draft.tags] });
    case "move":
      return Decision.parse({
        ...base,
        kind: "move",
        targetFolderId: draft.targetFolderId,
      });
  }
}

/**
 * Persist one draft and, when the policy says so, run it through the guarded
 * apply path (`approveDecision`, actor `policy`) behind an undo snapshot. A
 * non-auto outcome lands `pending` (review/pre-select) or `unsure`.
 */
async function persistDraft(
  draft: DecisionDraft,
  options: AnalyzeBookmarkOptions,
  model: string,
  sent: SentBookmark,
): Promise<DecisionRow> {
  const outcome = policyOutcome(draft, options.context.settings);
  const status: DecisionDocument["status"] =
    outcome === "unsure" ? "unsure" : "pending";
  const document = toDocument(draft, options, model, status);
  // Second opinion (spec FR6): only the unsure band is eligible, and the
  // result never changes the outcome — it rides the row as advisory
  // escalation fields plus the rationale. `null` = ordinary review.
  if (outcome === "unsure") {
    const escalation = await maybeEscalateDecision(document, {
      bookmarks: [sent],
      question: draft.escalation.question,
      options: draft.escalation.options,
      probabilities: draft.probabilities,
      jevAnswer: draft.escalation.jevAnswer,
      ...(options.job === undefined ? {} : { beforeSend: () => assertJobAuthority(options.job!) }),
    });
    if (escalation !== null) {
      document.escalation = {
        llmVerdict: escalation.verdict,
        llmModel: escalation.model,
        ...(escalation.alternative !== undefined
          ? { llmAlternative: escalation.alternative }
          : {}),
      };
      document.rationale = escalation.rationale;
    }
  }
  let row: DecisionRow;
  try {
    row = await persistDecision(document);
  } catch (cause) {
    if (cause instanceof DecisionStoreError) {
      throw new DecisionPipelineError(
        "persist_failed",
        `Failed to persist the ${draft.kind} decision.`,
      );
    }
    throw cause;
  }
  if (outcome !== "auto_apply") return row;
  try {
    return await approveDecision(row.id, "policy", "auto_applied");
  } catch (cause) {
    if (cause instanceof DecisionApplyError) {
      throw new DecisionPipelineError(
        "apply_failed",
        `Failed to auto-apply the ${draft.kind} decision.`,
      );
    }
    throw cause;
  }
}

/** Persist one `usage` row for the completed request. */
async function recordUsage(result: JevRunResult, jobId?: string): Promise<UsageRecord> {
  const record = UsageRecord.parse({
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    ...(result.usage.cost === undefined ? {} : { costUsd: result.usage.cost }),
    recordedAt: new Date().toISOString(),
    ...(jobId === undefined ? {} : { jobId }),
  });
  try {
    const id = await db.usage.add(record);
    return { ...record, id };
  } catch {
    throw new DecisionPipelineError(
      "persist_failed",
      "Failed to record request usage.",
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Analyze one bookmark: minimize → candidates → question sets → one
 * `jev_decisions` request → answer-ID cross-check → §10.2 policy → persisted
 * `Decision` rows + one `usage` row. Returns `{sent: false}` for a
 * blocklisted/sensitive bookmark (no request). Throws
 * `DecisionPipelineError` for every failure, with a redacted message.
 */
export async function analyzeBookmark(
  options: AnalyzeBookmarkOptions,
): Promise<AnalyzeBookmarkResult> {
  // Outer boundary: task builders can throw raw `TypeError`s and
  // `DecisionState.parse`/`mergeStates` can throw a raw `ZodError` (whose
  // `issues` may embed state values). Map EVERY throw through
  // `toPipelineError` so callers only ever see typed, redacted errors — an
  // already-typed `DecisionPipelineError` is preserved, anything else becomes a
  // generic content-free `provider` error. No `cause` or state is attached.
  try {
    return await runAnalysis(options);
  } catch (cause) {
    throw toPipelineError(cause);
  }
}

async function runAnalysis(
  options: AnalyzeBookmarkOptions,
): Promise<AnalyzeBookmarkResult> {
  const checks = options.checks ?? DEFAULT_CHECKS;
  validateChecks(checks);

  const sent = minimizeBookmark(options.bookmark, options.userBlocklist);
  if (sent === null) {
    return { sent: false, reason: "blocklisted" };
  }

  const built = buildChecks(checks, options.context, options.bookmark, sent);
  if (built.length === 0) {
    return { sent: true, model: null, decisions: [], usage: null };
  }

  const mergedState = mergeStates(built);
  const client =
    options.client ??
    createJevClient({
      providerId: options.providerId,
      model: options.model,
      scope: "jev_decisions",
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    });

  const request = buildRequest(built, mergedState, client.model);
  let result: JevRunResult;
  try {
    result = await client.run(request, {
      ...(options.job === undefined ? {} : { beforeSend: () => assertJobAuthority(options.job!) }),
      onPartialUsage: async (partial) => { await recordUsage(partial, options.job?.id); },
    });
  } catch (cause) {
    throw toPipelineError(cause);
  }

  const answers = result.answers as Record<
    string,
    { type: string; noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }
  >;
  crossCheckAnswers(built, answers);

  const drafts = interpret(built, answers);
  // Record the usage row BEFORE persisting decisions: the request already left
  // the device (cost incurred), so a decision that fails to persist/apply must
  // not drop the per-request cost accounting. Exactly one row per call.
  const usage = await recordUsage(result, options.job?.id);
  const decisions: DecisionRow[] = [];
  for (const draft of drafts) {
    decisions.push(await persistDraft(draft, options, result.model, sent));
  }

  return { sent: true, model: result.model, decisions, usage };
}
