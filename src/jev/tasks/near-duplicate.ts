import type { QuestionSet } from "./index";
import { defineDecision, score } from "../define";
import type { SentBookmark } from "../../schemas/decision-state";

/**
 * The `nearDuplicate` question set (spec FR4, plan §9.2): one score per
 * near-duplicate pair — the pairs `nearDuplicatePairs` emits are exactly
 * the same-domain, similar-titled ones the local URL-normalizing detector
 * cannot settle. `bookmark` is the pair's `a` side and `pairPartner` the
 * `b` side, so one pair fits one request.
 *
 * The four levels are §9.2's, lowest to highest: *unrelated*, *same topic
 * but different content*, *same content at a different URL or version*,
 * *identical page*. `values.same_content` is the 1–4 level number; the
 * §10.2 policy decides what counts as a merge proposal.
 */

/** Bump when the goal, question wording, or level descriptions change. */
export const questionSetVersion = "near-duplicate-v1";

export interface NearDuplicateInput {
  /** One side of the pair (`pair.a`) — already minimized. */
  readonly a: SentBookmark;
  /** The other side (`pair.b`) — already minimized. */
  readonly b: SentBookmark;
}

const SAME_CONTENT_LEVELS = [
  "Unrelated — the pages are not about the same thing.",
  "Same topic but different content — the pages overlap in subject but are distinct pages.",
  "Same content at a different URL or version — one is a copy, move, or update of the other.",
  "Identical page — the same content.",
] as const;

const decision = defineDecision({
  goal: "Decide whether two saved bookmarks point to the same content.",
  fields: {
    same_content: score(
      "Do `bookmark` and `pairPartner` point to the same content?",
      SAME_CONTENT_LEVELS,
    ),
  },
});

/**
 * Pair the shared near-duplicate decision with the state
 * `{ bookmark: a, pairPartner: b }`. `run()` yields `values.same_content`
 * (1–4) plus API confidence.
 */
export function nearDuplicate(
  input: NearDuplicateInput,
): QuestionSet<typeof decision.fields> {
  return {
    questionSetVersion,
    decision,
    state: { bookmark: input.a, pairPartner: input.b },
  };
}
