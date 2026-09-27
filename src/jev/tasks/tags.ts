import type { QuestionSet } from "./index";
import { defineDecision, noul } from "../define";
import type { NoulField } from "../define";
import type {
  CandidateTag,
  DecisionState,
  SentBookmark,
} from "../../schemas/decision-state";

/**
 * The `tags` question set (spec FR4, plan §9.1): one noul per candidate
 * tag — "Is `bookmark` mainly about `tag`?" A choice would force a single
 * pick; tags are yes/no per option, so each gets its own field.
 *
 * §9.1 puts the tag's `{name, description}` inside the question's
 * `instructions`. `defineDecision` fixes instructions to `{goal, question}`,
 * so the tag spec is embedded in the question text itself: each noul first
 * defines `` `tag` `` as the candidate's JSON spec, then asks the canonical
 * question. The same `{name, description}` list also lands in
 * `state.candidateTags` — `nameKey` never leaves the device, per the
 * `DecisionState` schema.
 *
 * Field keys are `tag_<nameKey>` (falling back to the display name), so a
 * `run()` result maps back to `BookmarkMeta.tags` nameKeys without touching
 * the wire.
 */

/** Bump when the goal or question wording changes. */
export const questionSetVersion = "tags-v1";

/**
 * One candidate tag. Minimal structural shape — `TagCandidate` from
 * `src/decisions/candidates.ts` satisfies it (extra fields are ignored).
 */
export interface TagRef {
  /** Display name — sent in `candidateTags` and embedded in the question. */
  readonly name: string;
  /** Stable tag identity — the field key suffix when present. */
  readonly nameKey?: string;
  /** Meaning text — embedded in the question and sent in `candidateTags`. */
  readonly description?: string;
}

export interface TagsInput {
  /** The bookmark being tagged — already minimized. */
  readonly bookmark: SentBookmark;
  /** Ranked candidate tags (cap: 30 — `DecisionState.candidateTags`). */
  readonly tags: readonly TagRef[];
}

const TAG_QUESTION = "Is `bookmark` mainly about `tag`?";

function tagKey(tag: TagRef): string {
  const key = tag.nameKey ?? tag.name;
  if (key.trim() === "") {
    throw new TypeError(
      "A tag candidate needs a non-empty name or nameKey for its field key.",
    );
  }
  return `tag_${key}`;
}

function tagQuestion(tag: TagRef): string {
  const spec: { name: string; description?: string } = { name: tag.name };
  if (tag.description !== undefined) {
    spec.description = tag.description;
  }
  return `\`tag\` is the candidate tag ${JSON.stringify(spec)}. ${TAG_QUESTION}`;
}

/**
 * Declare one noul per `input.tags` entry and pair it with the state
 * `{ bookmark, candidateTags }`. `run()` yields `values["tag_<key>"]`
 * booleans plus per-tag margin confidence (§10.1).
 *
 * Throws `TypeError` for an empty candidate list (a decision needs at least
 * one field) or when two candidates resolve to the same field key.
 */
export function tags(input: TagsInput): QuestionSet<Record<string, NoulField>> {
  const fields: Record<string, NoulField> = {};
  const candidateTags: CandidateTag[] = [];
  for (const tag of input.tags) {
    const key = tagKey(tag);
    if (Object.hasOwn(fields, key)) {
      throw new TypeError(
        `Two tag candidates resolve to the same field key ${JSON.stringify(key)}.`,
      );
    }
    fields[key] = noul(tagQuestion(tag));
    candidateTags.push(
      tag.description === undefined
        ? { name: tag.name }
        : { name: tag.name, description: tag.description },
    );
  }
  const decision = defineDecision({
    goal: "Decide which of a library's existing tags apply to a saved bookmark.",
    fields,
  });
  const state: DecisionState = {
    bookmark: input.bookmark,
    candidateTags,
  };
  return { questionSetVersion, decision, state };
}
