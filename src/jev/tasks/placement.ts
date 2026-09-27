import type { QuestionSet } from "./index";
import { choice, defineDecision } from "../define";
import type { ChoiceField } from "../define";
import type {
  CandidateFolder,
  DecisionState,
  SentBookmark,
} from "../../schemas/decision-state";

/**
 * The `placement` question set (spec FR4, plan §9.1): "which folder should
 * this new bookmark be filed in?" — one choice over the candidate folder
 * IDs plus the `none` sentinel, asked when a bookmark is saved.
 *
 * Folder IDs are the option keys and joined paths are the option
 * descriptions (plan §9.1: "Folder IDs are option keys; paths … are the
 * descriptions"), so answers map straight back to Chrome folder ids.
 *
 * `folderChoiceOptions` is shared with `misfiled` — the only difference is
 * the marker it appends for the bookmark's current folder.
 */

/** Bump when the goal or question wording changes. */
export const questionSetVersion = "placement-v1";

/** Option key that is never a folder id — the "no fit" escape (plan §9.1). */
export const NONE_FOLDER_KEY = "none";

const NONE_FOLDER_DESCRIPTION = "None of these folders fits.";

/**
 * One candidate folder. Minimal structural shape — `FolderCandidate` from
 * `src/decisions/candidates.ts` satisfies it.
 */
export interface FolderRef {
  /** Chrome folder id — becomes the choice option key. */
  readonly id: string;
  /** Ancestor titles topmost-first plus the folder's own title. */
  readonly path: readonly string[];
  /**
   * `true` when this is the bookmark's current folder (misfiled scan) — its
   * option description is marked " (current folder)".
   */
  readonly current?: boolean;
}

export interface PlacementInput {
  /** The bookmark being filed — already minimized. */
  readonly bookmark: SentBookmark;
  /** Ranked candidate folders (cap: 50 — `DecisionState.candidateFolders`). */
  readonly folders: readonly FolderRef[];
}

/** A folder candidate as it appears in `state.candidateFolders`. */
export function toCandidateFolder(folder: FolderRef): CandidateFolder {
  return { id: folder.id, path: [...folder.path] };
}

/**
 * The choice options for a folder question: `{folderId: "A / B / C", …}` plus
 * the `none` option. The current folder's description carries a
 * " (current folder)" marker.
 *
 * **The criteria record is unordered.** Chrome folder ids are integer-like
 * strings, and JS reorders integer-like object keys ascending, so insertion
 * (rank) order is *not* preserved in the wire `criteria` record. The
 * model-facing order is carried by the ordered `state.candidateFolders`
 * array; answers map back by option *key*, never by position.
 *
 * Throws `TypeError` when a folder id is empty or collides with `none`, or
 * when two candidates share an id.
 */
export function folderChoiceOptions(
  folders: readonly FolderRef[],
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const folder of folders) {
    const { id } = folder;
    if (id.trim() === "") {
      throw new TypeError(
        "A folder candidate needs a non-empty id for its option key.",
      );
    }
    if (id === NONE_FOLDER_KEY) {
      throw new TypeError(
        `A folder candidate id cannot be the reserved ${JSON.stringify(NONE_FOLDER_KEY)} option.`,
      );
    }
    if (Object.hasOwn(options, id)) {
      throw new TypeError(
        `Two folder candidates share id ${JSON.stringify(id)}.`,
      );
    }
    options[id] =
      folder.path.join(" / ") + (folder.current === true ? " (current folder)" : "");
  }
  options[NONE_FOLDER_KEY] = NONE_FOLDER_DESCRIPTION;
  return options;
}

/**
 * Declare the folder choice for `input.folders` and pair it with the state
 * `{ bookmark, candidateFolders }`. `run()` yields `values.folder` — the
 * chosen folder id or `"none"`.
 *
 * Throws `TypeError` for an empty candidate list (the lone `none` option
 * fails the 2-option minimum) or for bad/duplicate folder ids.
 */
export function placement(
  input: PlacementInput,
): QuestionSet<{ folder: ChoiceField }> {
  const decision = defineDecision({
    goal: "Choose the best existing folder for a newly saved bookmark.",
    fields: {
      folder: choice(
        "Which folder from `candidateFolders` should `bookmark` be filed in?",
        folderChoiceOptions(input.folders),
      ),
    },
  });
  const state: DecisionState = {
    bookmark: input.bookmark,
    candidateFolders: input.folders.map(toCandidateFolder),
  };
  return { questionSetVersion, decision, state };
}
