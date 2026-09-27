import type { Question, SystemOneRequest } from "./wire";

/**
 * Pre-send guards and token-budget batch planning — PROJECT_PLAN.md §8.3
 * ("Before sending": enforce the option and level caps, estimate tokens, and
 * split what is too large so nothing is sent that will fail) applied to the
 * §2.1 Jev limits: the state plus the longest single question must fit in
 * 32k tokens, and the state plus all questions in one request must fit in
 * 64k. This module is pure — no chrome, DOM, fetch, or clock access — so the
 * client and its tests can run it anywhere.
 */

/** §2.1/§8.3: `state` plus the longest single question must fit in 32k tokens. */
export const MAX_STATE_PLUS_QUESTION_TOKENS = 32_000;

/** §2.1/§8.3: `state` plus all questions in one request must fit in 64k tokens. */
export const MAX_BATCH_TOTAL_TOKENS = 64_000;

/** Machine-readable failure categories for the pre-send budget checks. */
export type BudgetErrorCode = "too_large" | "invalid_request";

/**
 * Every way the guards and planner can refuse a request. Messages are
 * redacted: they may name the offending question *key* (a developer-chosen
 * field identifier, like `category`) but never question instructions,
 * criteria, or `state` — any of those can carry bookmark content.
 */
export class BudgetError extends Error {
  readonly code: BudgetErrorCode;

  constructor(code: BudgetErrorCode, message: string) {
    super(message);
    this.name = "BudgetError";
    this.code = code;
  }
}

/**
 * Rough token estimate over the JSON wire form: about 4 characters per
 * token plus a 25% margin (§8.3). `JSON.stringify` returns `undefined` for
 * values with no JSON form (bare `undefined`, functions, symbols); those
 * estimate as zero.
 */
export function estimateTokens(value: unknown): number {
  const json = JSON.stringify(value);
  const length = json === undefined ? 0 : json.length;
  return Math.ceil((length / 4) * 1.25);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Defense-in-depth validation run after `SystemOneRequest` parsing and
 * before any send (§8.3). Zod already enforces these bounds on parsed
 * input, so this exists to produce typed `BudgetError`s — never raw
 * ZodErrors or TypeErrors — for anything that reaches the planner without a
 * parse, and to pin the rules independently of the schema.
 *
 * Throws `BudgetError("invalid_request")` when a question key is empty or
 * whitespace-only, keys are not unique, a question is not a noul/choice/
 * score object, a choice question declares fewer than 2 or more than 255
 * options, or a score question declares fewer than 2 or more than 10
 * levels.
 */
export function checkGuards(request: SystemOneRequest): void {
  const questions = isRecord(request) ? request.questions : undefined;
  if (!isRecord(questions)) {
    throw new BudgetError(
      "invalid_request",
      "The request must carry a questions record keyed by question name.",
    );
  }
  const keys = Object.keys(questions);
  // A plain record cannot physically hold duplicate keys — `JSON.parse`
  // and object literals both silently keep the last value — so this cheap
  // Set-size check only matters for non-plain objects reaching the guard.
  if (new Set(keys).size !== keys.length) {
    throw new BudgetError("invalid_request", "Question keys must be unique.");
  }
  for (const key of keys) {
    if (key.trim().length === 0) {
      throw new BudgetError(
        "invalid_request",
        "Question keys must be non-empty, non-whitespace names.",
      );
    }
    const question: unknown = questions[key];
    if (!isRecord(question)) {
      throw new BudgetError(
        "invalid_request",
        `Question ${JSON.stringify(key)} must be a noul, choice, or score object.`,
      );
    }
    switch (question.type) {
      case "noul":
        // Noul criteria carry no bounded collection — nothing to check.
        break;
      case "choice": {
        const options = isRecord(question.criteria)
          ? Object.keys(question.criteria).length
          : 0;
        if (options < 2 || options > 255) {
          throw new BudgetError(
            "invalid_request",
            `Choice question ${JSON.stringify(key)} must declare 2 to 255 options.`,
          );
        }
        break;
      }
      case "score": {
        const levels = Array.isArray(question.criteria)
          ? question.criteria.length
          : 0;
        if (levels < 2 || levels > 10) {
          throw new BudgetError(
            "invalid_request",
            `Score question ${JSON.stringify(key)} must declare 2 to 10 levels.`,
          );
        }
        break;
      }
      default:
        throw new BudgetError(
          "invalid_request",
          `Question ${JSON.stringify(key)} must be a noul, choice, or score object.`,
        );
    }
  }
}

/**
 * Split a validated request into sendable batches (§8.3). Runs
 * `checkGuards` first, then checks every question against the 32k
 * state-plus-single-question budget — one oversized question throws
 * `BudgetError("too_large")` and no batch is produced, so nothing partial
 * is ever sent.
 *
 * Remaining questions are packed greedily in key order: a question joins
 * the open batch while `state` + batch stays under 64k, otherwise it starts
 * a new batch. The returned requests share the input's `model` and `state`;
 * their `questions` records are disjoint, in key order, and cover every
 * question exactly once. A request with no questions yields no batches.
 */
export function planBatches(request: SystemOneRequest): SystemOneRequest[] {
  checkGuards(request);
  const stateTokens = estimateTokens(request.state);
  const entries = Object.entries(request.questions);

  for (const [key, question] of entries) {
    const questionTokens = estimateTokens({ [key]: question });
    if (stateTokens + questionTokens > MAX_STATE_PLUS_QUESTION_TOKENS) {
      throw new BudgetError(
        "too_large",
        `Question ${JSON.stringify(key)} plus the request state exceeds the ${MAX_STATE_PLUS_QUESTION_TOKENS}-token per-question budget.`,
      );
    }
  }

  const batches: SystemOneRequest[] = [];
  let batchQuestions: Record<string, Question> = {};
  for (const [key, question] of entries) {
    const candidate: Record<string, Question> = {
      ...batchQuestions,
      [key]: question,
    };
    // The 32k check above guarantees a lone question always fits a fresh
    // batch, so closing `batchQuestions` here can never strand a question.
    if (stateTokens + estimateTokens(candidate) > MAX_BATCH_TOTAL_TOKENS) {
      batches.push({
        model: request.model,
        state: request.state,
        questions: batchQuestions,
      });
      batchQuestions = { [key]: question };
    } else {
      batchQuestions = candidate;
    }
  }
  if (Object.keys(batchQuestions).length > 0) {
    batches.push({
      model: request.model,
      state: request.state,
      questions: batchQuestions,
    });
  }
  return batches;
}
