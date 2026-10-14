import { EXPLAIN_SYSTEM_PROMPT, ExplainResponse } from "./prompt-contracts";
import type { DecisionRow } from "../decisions/store";
import { getDecision, persistDecisionRationale } from "../decisions/store";
import { minimizeBookmark } from "../decisions/minimize";
import { readBlocklist } from "../decisions/blocklist";
import { get, ROOT_NODE_ID } from "../sync/chrome-bookmarks";
import type { SentBookmark } from "../schemas/decision-state";
import type { TokenUsage, ChatMessage } from "./wire";
import { createLlmClient } from "./client";
import { runStructured } from "./structured";
import { resolveLlmDestination } from "./providers";
import { LlmGateError } from "../net/llm-send";
import { readLlmProvider } from "./settings";
import { stripUrlsAndMarkdown } from "./sanitize";
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
  /** No live bookmarks remain, or a referenced/captured bookmark is unsendable. */
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
  /** Internal caller authority, composed with bookmark admission and rerun
   * at the gate's actual dispatch boundary for every paid attempt. */
  readonly beforeSend?: () => Promise<void>;
}
/** Conservative admission bounds — the payload is a handful of short fields. */
const MAX_INPUT_TOKENS = 8_192;
const MAX_OUTPUT_TOKENS = 1_024;

async function resolveFolderPath(folderId: string): Promise<string> {
  const segments: string[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = folderId;
  while (
    currentId !== undefined &&
    currentId !== ROOT_NODE_ID &&
    !seen.has(currentId)
  ) {
    seen.add(currentId);
    let node;
    try {
      node = (await get(currentId))[0];
    } catch {
      break;
    }
    if (node === undefined) break;
    if (node.title !== "") {
      segments.unshift(node.title);
    }
    currentId = node.parentId;
  }
  return segments.length > 0 ? segments.join("/") : folderId;
}

/** The question wording Jev answered, per decision kind. */
async function questionFor(
  row: DecisionRow,
): Promise<{ question: string; answer: string }> {
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
        answer: await resolveFolderPath(row.targetFolderId),
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
 * `{title, url, domain}` triple. A blocked reference refuses the WHOLE
 * explanation: its answer/probabilities may derive from that bookmark even
 * if the bookmark itself were dropped. Also admit captured outbound URLs
 * when rechecking a later send, since the transcript retains them.
 */
async function minimizedBookmarks(
  row: DecisionRow,
  captured: readonly SentBookmark[] = [],
): Promise<SentBookmark[]> {
  const entries = await Promise.all(
    row.bookmarkIds.map(async (id) => {
      try {
        const fetched = await get(id);
        return { id, nodes: fetched };
      } catch {
        // An unreadable reference may itself be blocked; dropping it
        // would still leak the decision derived from it.
        throw new ExplainError(
          "stale",
          "A referenced bookmark cannot be checked for explanation sending.",
        );
      }
    }),
  );
  const blocklist = await readBlocklist();
  function refuseBlocked(): never {
    throw new ExplainError(
      "stale",
      "A referenced bookmark is blocked from explanation sending.",
    );
  }
  function refuseStale(): never {
    throw new ExplainError(
      "stale",
      "A referenced bookmark moved or changed since the decision was created.",
    );
  }
  for (const bookmark of captured) {
    if (minimizeBookmark(bookmark, blocklist) === null) refuseBlocked();
  }
  const bookmarks: SentBookmark[] = [];
  for (const { id, nodes } of entries) {
    if (nodes.length === 0) refuseStale();
    for (const node of nodes) {
      if (row.guard !== undefined) {
        const snapshot = row.guard.snapshots?.[id];
        const hasBookmarkEntry =
          "bookmarks" in row.guard &&
          typeof row.guard.bookmarks === "object" &&
          row.guard.bookmarks !== null &&
          id in row.guard.bookmarks;
        const expectedParent = row.guard.placements[id];
        if (
          (expectedParent === undefined &&
            snapshot === undefined &&
            !hasBookmarkEntry) ||
          (expectedParent !== undefined && node.parentId !== expectedParent)
        ) {
          refuseStale();
        }
        if (
          snapshot !== undefined &&
          ((node.url ?? "") !== snapshot.url || node.title !== snapshot.title)
        ) {
          refuseStale();
        }
        if (hasBookmarkEntry && "bookmarks" in row.guard) {
          const entry: unknown = Reflect.get(
            Object(row.guard.bookmarks),
            id,
          );
          if (typeof entry === "object" && entry !== null) {
            const expUrl: unknown = Reflect.get(entry, "url");
            const expTitle: unknown = Reflect.get(entry, "title");
            if (
              (typeof expUrl === "string" && (node.url ?? "") !== expUrl) ||
              (typeof expTitle === "string" && node.title !== expTitle)
            ) {
              refuseStale();
            }
          }
        }
      }
      if (node.url === undefined) continue;
      const sent = minimizeBookmark(
        { title: node.title, url: node.url },
        blocklist,
      );
      if (sent === null) refuseBlocked();
      bookmarks.push(sent);
    }
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
  await options?.beforeSend?.();
  const record = await readLlmProvider(providerId);
  if (record === null) {
    throw new LlmGateError("invalid_provider", "Unknown LLM provider.");
  }
  const { question, answer } = await questionFor(row);
  const rawProbabilities = row.probabilities ?? {};
  const probabilities: Record<string, number> = {};
  for (const [key, prob] of Object.entries(rawProbabilities)) {
    const resolvedKey =
      row.kind === "move" && key !== "none"
        ? await resolveFolderPath(key)
        : key;
    probabilities[resolvedKey] = prob;
  }
  const payload = {
    question,
    candidates: Object.keys(probabilities).sort(),
    probabilities,
    answer,
    bookmarks,
  };
  const messages: ChatMessage[] = [
    { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) },
  ];
  const beforeSend = async () => {
    const live = await minimizedBookmarks(row, bookmarks);
    if (live.length === 0) {
      throw new ExplainError("stale", "No referenced bookmark remains sendable.");
    }
    // Last: native/blocklist IO must not outlive the accepted recipient check.
    await options?.beforeSend?.();
  };
  const client = createLlmClient(providerId, {
    scope: "llm_explain",
    kind: "manual",
    maxInputTokens: MAX_INPUT_TOKENS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    beforeSend,
    ...(options?.unknownCostConfirmed !== undefined
      ? { unknownCostConfirmed: options.unknownCostConfirmed }
      : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
  });
  const run = await runStructured({
    tier: record.tier ?? "json_schema",
    model: resolveLlmDestination(record.provider).model,
    schema: ExplainResponse,
    schemaName: "explanation",
    messages,
    send: async (request) => {
      // runStructured invokes this for every initial, fallback, and repair
      // send. Native references and the retained transcript both need admission.
      await beforeSend();
      return client.send(request);
    },
  });
  const rationale = stripUrlsAndMarkdown(run.value.rationale);
  if (rationale === "") {
    throw new ExplainError(
      "provider",
      "The provider's explanation contained no usable text.",
    );
  }
  await persistDecisionRationale(decisionId, rationale);
  const result: ExplainResult = {
    decisionId,
    rationale,
    model: run.model,
    ...(run.usage !== undefined ? { usage: run.usage } : {}),
  };
  return result;
}
