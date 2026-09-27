import type { NoulQuestion, Question, SystemOneRequest } from "./wire";

/**
 * Typed question-set builder (spec FR5, PROJECT_PLAN.md §8.4) — a Pydantic
 * AI-style declaration layer over the System One wire format. A decision
 * declares a `goal` (the model-docstring role) and named fields built by
 * `noul`, `choice`, and `score`; every field's question compiles into a wire
 * question whose `instructions` is always `{ goal, question }`, and
 * `build(state, model)` returns a `SystemOneRequest` ready for the client.
 *
 * Field declarations are validated eagerly at `defineDecision` time — a bad
 * field name or option set is a programmer error, so those throw `TypeError`
 * before any request exists.
 */

/** The wire `Text` union as inferred from the question schema. */
export type InstructionsText = NoulQuestion["instructions"];

export interface NoulField {
  readonly kind: "noul";
  readonly question: string;
  readonly criteria?: {
    readonly true?: InstructionsText;
    readonly false?: InstructionsText;
  };
  /** Decision threshold for the boolean value; default 0.5. */
  readonly threshold: number;
}

export interface ChoiceField<
  O extends Record<string, InstructionsText | null> = Record<
    string,
    InstructionsText | null
  >,
> {
  readonly kind: "choice";
  readonly question: string;
  readonly options: O;
}

export interface ScoreField {
  readonly kind: "score";
  readonly question: string;
  readonly levels: readonly InstructionsText[];
}

export type Field = NoulField | ChoiceField | ScoreField;
export type Fields = Record<string, Field>;

function requireQuestion(question: string, kind: string): void {
  if (question.trim().length === 0) {
    throw new TypeError(
      `A ${kind} field's question must be non-empty, non-whitespace text.`,
    );
  }
}

/**
 * Declare a yes/no field. `criteria` plays the `BoolCriteria` role — optional
 * `{ true, false }` descriptions of each side. `threshold` (default 0.5) is
 * the probability at or above which the value reads `true`.
 */
export function noul(
  question: string,
  criteria?: NoulField["criteria"],
  threshold = 0.5,
): NoulField {
  requireQuestion(question, "noul");
  if (!(threshold > 0 && threshold < 1) || Number.isNaN(threshold)) {
    throw new TypeError(
      `A noul field's threshold must lie within (0, 1); received ${threshold}.`,
    );
  }
  const field: NoulField = { kind: "noul", question, threshold };
  if (criteria !== undefined) {
    return { ...field, criteria };
  }
  return field;
}

/**
 * Declare a pick-one field. `options` maps each option key to its
 * description (or `null` for none); keys become the wire `criteria` record
 * and the typed value's literal union. 2–255 non-empty keys.
 */
export function choice<O extends Record<string, InstructionsText | null>>(
  question: string,
  options: O,
): ChoiceField<O> {
  requireQuestion(question, "choice");
  const keys = Object.keys(options);
  if (keys.length < 2 || keys.length > 255) {
    throw new TypeError(
      `A choice field needs 2 to 255 options; received ${keys.length}.`,
    );
  }
  for (const key of keys) {
    if (key.trim().length === 0) {
      throw new TypeError(
        "Choice option keys must be non-empty, non-whitespace names.",
      );
    }
  }
  return { kind: "choice", question, options };
}

/**
 * Declare a 1..N rating field. `levels` are the ordered level descriptions,
 * lowest to highest; 2–10 entries.
 */
export function score(
  question: string,
  levels: readonly InstructionsText[],
): ScoreField {
  requireQuestion(question, "score");
  if (levels.length < 2 || levels.length > 10) {
    throw new TypeError(
      `A score field needs 2 to 10 levels; received ${levels.length}.`,
    );
  }
  return { kind: "score", question, levels };
}

export interface Decision<F extends Fields> {
  readonly goal: string;
  readonly fields: F;
  /** Build the System One request for `state` under `model`. */
  build(state: InstructionsText, model: string): SystemOneRequest;
}

/**
 * Declare a decision: a goal plus named fields. Field names must be
 * non-empty, non-whitespace keys (the wire guards them the same way); each
 * field's question joins the goal into the `instructions` object sent with
 * every question — never omitted.
 */
export function defineDecision<F extends Fields>(definition: {
  goal: string;
  fields: F;
}): Decision<F> {
  const { goal, fields } = definition;
  if (goal.trim().length === 0) {
    throw new TypeError(
      "A decision's goal must be non-empty, non-whitespace text.",
    );
  }
  const names = Object.keys(fields);
  if (names.length === 0) {
    throw new TypeError("A decision declares at least one field.");
  }
  for (const name of names) {
    if (name.trim().length === 0) {
      throw new TypeError(
        "Field names must be non-empty, non-whitespace keys.",
      );
    }
  }

  function build(
    state: InstructionsText,
    model: string,
  ): SystemOneRequest {
    const questions: Record<string, Question> = {};
    for (const name of names) {
      const field = fields[name] as Field;
      const instructions = { goal, question: field.question };
      switch (field.kind) {
        case "noul":
          questions[name] =
            field.criteria === undefined
              ? { type: "noul", instructions }
              : { type: "noul", instructions, criteria: field.criteria };
          break;
        case "choice":
          questions[name] = {
            type: "choice",
            instructions,
            criteria: field.options,
          };
          break;
        case "score":
          questions[name] = {
            type: "score",
            instructions,
            criteria: [...field.levels],
          };
          break;
      }
    }
    return { model, state, questions };
  }

  return { goal, fields, build };
}
