import { z } from "../schemas/z";
import type { DecisionRow } from "../decisions/store";
import { getDecision, persistDecisionRationale } from "../decisions/store";
import { minimizeBookmark } from "../decisions/minimize";
import { get } from "../sync/chrome-bookmarks";
import type { SentBookmark } from "../schemas/decision-state";
import type { TokenUsage } from "./wire";
import { createLlmClient } from "./client";
import { runStructured } from "./structured";
import { resolveLlmDestination } from "./providers";
import { LlmGateError } from "../net/llm-send";
import { readLlmProvider } from "./settings";
import type { ChatMessage } from "./wire";

/**
 * Decision explanations (spec FR5). An explicit, manual Explain action on a
 * pending review-queue decision: sends ONLY the minimized decision state —
 * the bookmarks' `{title, url, domain}` triples — plus the question, the
 * candidate labels, the Jev probability distribution, and the selected
 * answer. The provider returns a strict `{rationale ≤ 1,000 chars}` object
 * which is persisted via `persistDecisionRationale`.
 *
 * An explanation NEVER mutates the decision: no status transition, no apply,
 * no undo or audit row — `persistDecisionRationale` is the only write.
 */

/** Refusal codes this module produces itself (provider/gate codes pass through). */
export type ExplainErrorCode =
  /** No decision row exists for the id. */
  | "not_found"
  /** The decision is not in the `pending` review queue. */
  | "not_pending"
  /** Every bookmark the decision references is gone or unsendable. */
  | "stale"
  /** Anything else — kept generic so no upstream detail leaks. */
  | "provider";

/** Rejection for store-level refusals this module produces. */
export class ExplainError extends Error {
  readonly code: ExplainErrorCode;

  constructor(code: ExplainErrorCode, message: string) {
    super(message);
    this.name = "ExplainError";
    this.code = code;
  }
}

export interface ExplainResult {
  readonly decisionId: string;
  readonly rationale: string;
  /** Model identifier the provider reported for the answer. */
  readonly model: string;
  readonly usage?: TokenUsage;
}

export interface ExplainOptions {
  /** One-shot manual confirmation for a provider with no pricing — never persisted. */
  readonly unknownCostConfirmed?: boolean;
  readonly signal?: AbortSignal;
}

const ExplainResponse = z.strictObject({
  rationale: z.string().min(1).max(1_000),
});

/** Conservative admission bounds — the payload is a handful of short fields. */
const MAX_INPUT_TOKENS = 8_192;
const MAX_OUTPUT_TOKENS = 1_024;

const EXPLAIN_SYSTEM_PROMPT =
  "You explain automated bookmark-organizer decisions in plain language. " +
  "Given the question the organizer asked, the candidate labels, the " +
  "probability it assigned to each label, the answer it picked, and the " +
  "minimized bookmark data it saw, explain in one or two sentences why that " +
  "answer is plausible. Do not invent facts about the page; describe only " +
  "what the input shows. Reply with the JSON object the schema requests.";

/** The question wording Jev answered, per decision kind. */
function questionFor(row: DecisionRow): { question: string; answer: string } {
  switch (row.kind) {
    case "set_category":
      return {
        question: "Which single category should this bookmark be filed under?",
        answer: row.category,
      };
    case "add_tags":
      return {
        question: "Which tags should be added to this bookmark?",
        answer: row.tags.join(", "),
      };
    case "move":
      return {
        question: "Which folder should this bookmark live in?",
        answer: `folder id ${row.targetFolderId}`,
      };
    case "mark_dead":
      return {
        question: "Is this bookmark's target unreachable or dead?",
        answer: `yes — evidence: ${row.evidence}`,
      };
    case "merge_duplicates":
      return {
        question: "Should these duplicate bookmarks be merged into one?",
        answer: "yes, keep the indicated bookmark",
      };
    case "rename":
      return {
        question: "Should this bookmark be renamed?",
        answer: row.newTitle,
      };
    case "create_folder":
      return {
        question: "Should a new folder be created for these bookmarks?",
        answer: row.path.join("/"),
      };
  }
}

/**
 * Fetch the decision's live bookmarks and reduce each to its sendable
 * `{title, url, domain}` triple. Bookmarks that vanished, are folders, or are
 * blocklisted are dropped — they were never sendable either.
 */
async function minimizedBookmarks(row: DecisionRow): Promise<SentBookmark[]> {
  const nodes = (
    await Promise.all(
      row.bookmarkIds.map(async (id) => {
        try {
          return await get(id);
        } catch {
          return [];
        }
      }),
    )
  ).flat();
  const bookmarks: SentBookmark[] = [];
  for (const node of nodes) {
    if (node.url === undefined) continue;
    const sent = minimizeBookmark({ title: node.title, url: node.url });
    if (sent !== null) bookmarks.push(sent);
  }
  return bookmarks;
}

/**
 * Explain pending decision `decisionId` through provider `providerId`.
 * Persists the rationale on success and returns it. Throws `ExplainError`
 * (`not_found` / `not_pending` / `stale` / `provider`) for store-level
 * refusals; `LlmGateError`, `LlmHttpError`, `LlmCapabilityError`,
 * `StructuredOutputError`, and `DecisionStoreError` pass through unchanged —
 * their codes are stable and their messages already carry no content.
 */
export async function explainDecision(
  decisionId: string,
  providerId: string,
  options?: ExplainOptions,
): Promise<ExplainResult> {
  const row = await getDecision(decisionId);
  if (row === undefined) {
    throw new ExplainError("not_found", `No decision exists for "${decisionId}".`);
  }
  if (row.status !== "pending") {
    throw new ExplainError(
      "not_pending",
      `Decision "${decisionId}" is "${row.status}" — only pending decisions can be explained.`,
    );
  }
  const bookmarks = await minimizedBookmarks(row);
  if (bookmarks.length === 0) {
    throw new ExplainError(
      "stale",
      `Every bookmark of decision "${decisionId}" is gone or unsendable.`,
    );
  }
  const record = await readLlmProvider(providerId);
  if (record === null) {
    throw new LlmGateError("invalid_provider", "Unknown LLM provider.");
  }
  const { question, answer } = questionFor(row);
  const payload = {
    question,
    candidates: Object.keys(row.probabilities ?? {}).sort(),
    probabilities: row.probabilities ?? {},
    answer,
    bookmarks,
  };
  const messages: ChatMessage[] = [
    { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
  const client = createLlmClient(providerId, {
    scope: "llm_explain",
    kind: "manual",
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(options?.unknownCostConfirmed !== undefined
      ? { unknownCostConfirmed: options.unknownCostConfirmed }
      : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  });
  const run = await runStructured({
    tier: "json_schema",
    model: resolveLlmDestination(record.provider).model,
    schema: ExplainResponse,
    schemaName: "explanation",
    messages,
    send: client.send,
  });
  await persistDecisionRationale(decisionId, run.value.rationale);
  const result: ExplainResult = {
    decisionId,
    rationale: run.value.rationale,
    model: run.model,
    ...(run.usage !== undefined ? { usage: run.usage } : {}),
  };
  return result;
}
