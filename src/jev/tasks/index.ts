import type { Decision, Fields } from "../define";
import type { DecisionState } from "../../schemas/decision-state";
import { questionSetVersion as categorizeV } from "./categorize";
import { questionSetVersion as tagsV } from "./tags";
import { questionSetVersion as placementV } from "./placement";
import { questionSetVersion as misfiledV } from "./misfiled";
import { questionSetVersion as nearDuplicateV } from "./near-duplicate";
import { questionSetVersion as rerankV } from "./rerank";

/**
 * Jev question sets (spec FR4, PROJECT_PLAN.md §9). Each task module pairs a
 * `defineDecision` declaration with the `DecisionState` its questions name,
 * so the request it builds can never reference a field the state lacks.
 * Every module exports a `questionSetVersion` — recorded on
 * `Decision.source.questionSetVersion`, bumped whenever a set's goal or
 * question wording changes (plan §15 / §8.5 model-version guidance).
 *
 * All modules are pure: no `chrome`, DOM, React, or `fetch`; `z` arrives
 * only via `../../schemas/z` through the schema types. Inputs are already
 * minimized — `bookmark`-shaped inputs are `SentBookmark`s whose URLs passed
 * `cleanUrl`/`minimizeBookmark` in `src/decisions/minimize.ts`, and the
 * `jev_decisions` gate re-parses `state` against `DecisionState` before any
 * send. Notes and page text can never enter a state field or a question.
 */

/**
 * One prepared decision run for a subject bookmark: the declared
 * `decision` (`decision.build(state, model)` / `decision.run(client, state)`)
 * plus the conforming `state` its questions reference. `F` is the decision's
 * field map, so `run()` yields per-field typed values and confidence.
 */
export interface QuestionSet<F extends Fields = Fields> {
  /** Recorded on `Decision.source.questionSetVersion`; bump on wording changes. */
  readonly questionSetVersion: string;
  readonly decision: Decision<F>;
  readonly state: DecisionState;
}

/**
 * The six sets' versions by task name. Each module also exports its own
 * `questionSetVersion` const; here they are re-exported as
 * `<set>QuestionSetVersion` since the bare name would collide.
 */
export const questionSetVersions = {
  categorize: categorizeV,
  tags: tagsV,
  placement: placementV,
  misfiled: misfiledV,
  nearDuplicate: nearDuplicateV,
  rerank: rerankV,
} as const;

export { categorize } from "./categorize";
export { tags } from "./tags";
export { placement } from "./placement";
export { misfiled } from "./misfiled";
export { nearDuplicate } from "./near-duplicate";
export { rerank } from "./rerank";

export {
  questionSetVersion as categorizeQuestionSetVersion,
} from "./categorize";
export {
  questionSetVersion as tagsQuestionSetVersion,
} from "./tags";
export {
  questionSetVersion as placementQuestionSetVersion,
} from "./placement";
export {
  questionSetVersion as misfiledQuestionSetVersion,
} from "./misfiled";
export {
  questionSetVersion as nearDuplicateQuestionSetVersion,
} from "./near-duplicate";
export {
  questionSetVersion as rerankQuestionSetVersion,
} from "./rerank";

export {
  folderChoiceOptions,
  toCandidateFolder,
  NONE_FOLDER_KEY,
} from "./placement";

export type { CategorizeInput } from "./categorize";
export type { TagRef, TagsInput } from "./tags";
export type { FolderRef, PlacementInput } from "./placement";
export type { MisfiledInput } from "./misfiled";
export type { NearDuplicateInput } from "./near-duplicate";
export type { RerankInput } from "./rerank";
