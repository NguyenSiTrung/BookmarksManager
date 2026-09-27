import type { QuestionSet } from "./index";
import { choice, defineDecision } from "../define";
import type { Category } from "../../schemas/bookmark";
import type { SentBookmark } from "../../schemas/decision-state";

/**
 * The `categorize` question set (spec FR4, plan §8.4/§9.1): a single choice
 * over the nine `Category` values for one bookmark. Option descriptions are
 * the §8.4 enum-docstring texts verbatim.
 *
 * The decision is declared once at module level — its field shape does not
 * depend on the candidates — so `categorize(input)` only pairs it with the
 * bookmark's state.
 */

/** Bump when the goal, question wording, or option descriptions change. */
export const questionSetVersion = "categorize-v1";

export interface CategorizeInput {
  /** The bookmark being classified — already minimized. */
  readonly bookmark: SentBookmark;
}

/**
 * §8.4 option descriptions ("enum member docstrings"). `satisfies` keeps the
 * literal keys as the typed value union — `values.category` is `Category`.
 */
const CATEGORY_OPTIONS = {
  article: "A blog post, news story, essay, or tutorial meant to be read.",
  docs: "Official documentation or an API reference for a product or library.",
  tool: "A web app or online utility the user interacts with.",
  video: "A page whose main content is a video or a video channel.",
  repo: "A source code repository or package registry page.",
  reference: "A wiki, dictionary, cheat sheet, or other lookup resource.",
  shopping: "A product page or online store.",
  social: "A social media profile, post, or discussion thread.",
  other: "None of the above describes it well.",
} satisfies Record<Category, string>;

const decision = defineDecision({
  goal: "Classify a saved bookmark for a personal bookmark library.",
  fields: {
    category: choice("Which kind of resource is `bookmark`?", CATEGORY_OPTIONS),
  },
});

/**
 * Pair the shared categorize decision with the state for `input.bookmark`:
 * `{ bookmark }`. `run()` yields `values.category` as the typed `Category`.
 */
export function categorize(
  input: CategorizeInput,
): QuestionSet<typeof decision.fields> {
  return {
    questionSetVersion,
    decision,
    state: { bookmark: input.bookmark },
  };
}
