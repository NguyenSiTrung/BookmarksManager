import type { QuestionSet } from "./index";
import { choice, defineDecision } from "../define";
import type { ChoiceField } from "../define";
import type {
  DecisionState,
  SentBookmark,
} from "../../schemas/decision-state";
import {
  folderChoiceOptions,
  toCandidateFolder,
} from "./placement";
import type { FolderRef } from "./placement";

/**
 * The `misfiled` question set (spec FR4, plan §9.3): the library-scan
 * variant of `placement`. Same folder choice — candidate IDs plus `none` —
 * but the state also carries `folderPath`, the bookmark's current folder
 * path, so the question is "is it filed in the right place, and if not,
 * which candidate fits?". The current folder is expected among the
 * candidates (the `misfiledCandidates` selector guarantees it) and its
 * option is marked " (current folder)".
 */

/** Bump when the goal or question wording changes. */
export const questionSetVersion = "misfiled-v1";

export interface MisfiledInput {
  /** The bookmark under review — already minimized. */
  readonly bookmark: SentBookmark;
  /** The bookmark's current folder path ([] when it lives at root). */
  readonly folderPath: readonly string[];
  /**
   * Ranked candidate folders including the current one marked
   * `current: true` (`misfiledCandidates` output — cap 50 plus the
   * guaranteed current entry).
   */
  readonly folders: readonly FolderRef[];
}

/**
 * Declare the folder choice for `input.folders` and pair it with the state
 * `{ bookmark, folderPath, candidateFolders }`. `run()` yields
 * `values.folder` — the folder id Jev would file in, the current id, or
 * `"none"`; the §10.2 policy turns "different folder at ≥ 0.5" into a
 * review-queue `move`.
 *
 * Throws `TypeError` for an empty candidate list or bad/duplicate ids —
 * the same contract as `placement`.
 */
export function misfiled(
  input: MisfiledInput,
): QuestionSet<{ folder: ChoiceField }> {
  const decision = defineDecision({
    goal: "Decide whether a saved bookmark is filed in the right folder.",
    fields: {
      folder: choice(
        "`bookmark` is currently filed in `folderPath`. Which folder from `candidateFolders` should it be filed in?",
        folderChoiceOptions(input.folders),
      ),
    },
  });
  const state: DecisionState = {
    bookmark: input.bookmark,
    folderPath: [...input.folderPath],
    candidateFolders: input.folders.map(toCandidateFolder),
  };
  return { questionSetVersion, decision, state };
}
