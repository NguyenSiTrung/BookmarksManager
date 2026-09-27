import type { QuestionSet } from "./index";
import { defineDecision, noul } from "../define";
import type { NoulField } from "../define";
import type {
  DecisionState,
  SentBookmark,
} from "../../schemas/decision-state";

/**
 * The `rerank` question set (spec FR4, plan §9.4 "Ask"): one noul per
 * MiniSearch shortlist candidate — "Does `bookmark` match what `query` is
 * looking for?" — so one request reranks up to 30 hits.
 *
 * Unlike `tags`, the candidate is *not* embedded in the question text: its
 * `{title, url, domain}` carries a URL, and every URL on the wire must sit
 * behind `CleanedUrl` in `state` — so each noul defines `` `bookmark` `` as
 * a positional reference into `state.candidateBookmarks` instead. Field
 * keys are `candidate_<index>` in `candidateBookmarks` order; Chrome node
 * ids never enter the request (the `DecisionState` schema excludes them
 * from `SentBookmark` and the disclosure does not list them).
 */

/** Bump when the goal or question wording changes. */
export const questionSetVersion = "rerank-v1";

export interface RerankInput {
  /** The "Ask" search string — sent as `state.query`. */
  readonly query: string;
  /**
   * The shortlist (cap: 30 — `DecisionState.candidateBookmarks`), already
   * minimized to `{title, url, domain}` per hit.
   */
  readonly candidates: readonly SentBookmark[];
}

/**
 * Declare one noul per `input.candidates` entry and pair it with the state
 * `{ query, candidateBookmarks }`. `run()` yields
 * `values["candidate_<i>"]` booleans plus per-candidate probabilities —
 * the pipeline sorts by `probabilities["candidate_<i>"].true` and applies
 * the no-match bar (§9.4 / §10.2).
 *
 * Throws `TypeError` on a blank query or an empty shortlist (a decision
 * needs at least one field — a local-only result makes no request).
 */
export function rerank(
  input: RerankInput,
): QuestionSet<Record<string, NoulField>> {
  if (input.query.trim() === "") {
    throw new TypeError("The rerank query must be non-empty text.");
  }
  const fields: Record<string, NoulField> = {};
  for (const [index] of input.candidates.entries()) {
    fields[`candidate_${index}`] = noul(
      `\`bookmark\` is the \`candidateBookmarks\` entry at index ${index}. Does \`bookmark\` match what \`query\` is looking for?`,
    );
  }
  const decision = defineDecision({
    goal: "Decide which bookmarks match a search query.",
    fields,
  });
  const state: DecisionState = {
    query: input.query,
    candidateBookmarks: [...input.candidates],
  };
  return { questionSetVersion, decision, state };
}
