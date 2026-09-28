import type { QuestionSet } from "./index";
import { choice, defineDecision } from "../define";
import type { ChoiceField } from "../define";
import type {
  CandidateFolder,
  DecisionState,
  SentBookmark,
} from "../../schemas/decision-state";
import type { ProposedFolder } from "../../schemas/restructure";

/**
 * The `restructure` question set (spec FR8.5): "which of the LLM-proposed
 * folders should this bookmark move to?" — one choice over the proposal's
 * synthetic folder ids plus the `none` sentinel ("keep it where it is").
 *
 * Proposed folders are NOT Chrome folders — they have no real ids yet — so
 * the option keys are synthetic `p0`…`pN` ids generated in proposal order;
 * `keyForIndex`/`pathForKey` map between the wire key and the proposal path.
 * Anything answering a key outside `p0`…`pN`/`none` is an `answer_mismatch`
 * the client cross-check already rejects.
 */

/** Bump when the goal or question wording changes. */
export const questionSetVersion = "restructure-v1";

/** Option key that is never a proposal id — the "keep current folder" choice. */
export const KEEP_FOLDER_KEY = "none";

const KEEP_FOLDER_DESCRIPTION = "Keep the bookmark in its current folder.";

/** The synthetic option id for proposal index `i`: `p0`, `p1`, … */
export function keyForIndex(index: number): string {
  return `p${index}`;
}

/** Parse a `p<index>` key back to its proposal index, or null when malformed. */
export function indexForKey(key: string): number | null {
  if (!/^p[0-9]+$/.test(key)) return null;
  const index = Number.parseInt(key.slice(1), 10);
  return Number.isSafeInteger(index) ? index : null;
}

/**
 * The choice options for a restructure question: `p0`…`pN` mapped to the
 * proposal's path (+ its one-line description when present), plus `none`.
 * Mirrors `folderChoiceOptions` — record order is meaningless on the wire
 * (integer-like keys reorder), so answers map back by key only.
 *
 * Throws `TypeError` for an empty proposal — a lone `none` option fails the
 * 2-option minimum — but `RestructureProposal` already requires ≥1 folder.
 */
export function restructureChoiceOptions(
  folders: readonly ProposedFolder[],
): Record<string, string> {
  const options: Record<string, string> = {};
  folders.forEach((folder, index) => {
    options[keyForIndex(index)] =
      folder.description === ""
        ? folder.path
        : `${folder.path} — ${folder.description}`;
  });
  options[KEEP_FOLDER_KEY] = KEEP_FOLDER_DESCRIPTION;
  return options;
}

/** A proposed folder as it appears in `state.candidateFolders`. */
export function toProposedCandidate(folder: ProposedFolder, index: number): CandidateFolder {
  return { id: keyForIndex(index), path: folder.path.split("/") };
}

/**
 * Declare the proposed-folder choice for `input.folders` and pair it with the
 * state `{ bookmark, candidateFolders }`. `run()` yields `values.folder` —
 * the synthetic `p<index>` key or `"none"`.
 */
export function restructure(input: {
  readonly bookmark: SentBookmark;
  readonly folders: readonly ProposedFolder[];
}): QuestionSet<{ folder: ChoiceField }> {
  const decision = defineDecision({
    goal: "Choose which proposed folder this bookmark should move to.",
    fields: {
      folder: choice(
        "Which folder from `candidateFolders` should `bookmark` be moved to? Choose `none` when no proposed folder fits better than its current location.",
        restructureChoiceOptions(input.folders),
      ),
    },
  });
  const state: DecisionState = {
    bookmark: input.bookmark,
    candidateFolders: input.folders.map(toProposedCandidate),
  };
  return { questionSetVersion, decision, state };
}
