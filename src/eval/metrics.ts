import { noulMargin } from "../jev/confidence";
import {
  AUTO_APPLY_THRESHOLD,
  MOVE_PRESELECT_THRESHOLD,
  RERANK_NO_MATCH_BAR,
  REVIEW_FLOOR,
} from "../decisions/policy";
import {
  NONE_FOLDER_ID,
  type EvalCase,
  type EvalCorpus,
  type EvalMisfiledCase,
} from "./schema";

/**
 * Deterministic evaluation scoring — Phase 6. Scores one recorded model
 * observation against its corpus case and aggregates a release-quality
 * report. Pure: no network, Chrome, DOM, filesystem, or wall-clock surface
 * (callers inject `generatedAt`).
 *
 * Auto-apply is evaluated as if the `add_tags`/`set_category` toggles were
 * on: the report answers "if we enabled auto-apply at this threshold, how
 * often would it have been wrong?" — that is the evidence the release
 * policy decision is made on.
 */

/** The policy grid a report is scored under. */
export interface EvalThresholds {
  /** Below this confidence an answered case is `unsure`. */
  readonly reviewFloor: number;
  /** At or above this confidence tag/category answers auto-apply. */
  readonly autoApply: number;
  /** At or above this confidence an on-save move preselects. */
  readonly movePreselect: number;
  /** A rerank candidate at or above this probability counts as a match. */
  readonly noMatchBar: number;
  /** A tag candidate at or above this probability is selected. */
  readonly tagSelect: number;
}

/** The shipped §10.2 bands plus the pipeline's 0.5 tag select bar. */
export const DEFAULT_EVAL_THRESHOLDS: EvalThresholds = {
  reviewFloor: REVIEW_FLOOR,
  autoApply: AUTO_APPLY_THRESHOLD,
  movePreselect: MOVE_PRESELECT_THRESHOLD,
  noMatchBar: RERANK_NO_MATCH_BAR,
  tagSelect: 0.5,
};

/** What the eval runner records as the model's answer for a case. */
export type EvalAnswer =
  | { readonly kind: "categorize"; readonly choice: string; readonly confidence: number }
  | { readonly kind: "tags"; readonly probabilities: Record<string, number> }
  | { readonly kind: "placement"; readonly choice: string; readonly confidence: number }
  | { readonly kind: "misfiled"; readonly choice: string; readonly confidence: number }
  | { readonly kind: "near_duplicate"; readonly score: number; readonly confidence: number }
  | { readonly kind: "rerank"; readonly probabilities: readonly number[] };

export type EvalObservationStatus = "answered" | "timeout" | "error" | "skipped";

/** One case's outcome from a live eval run: the case plus what came back. */
export interface EvalObservation {
  /** The corpus case evaluated — carries the expected answers. */
  readonly case: EvalCase;
  readonly status: EvalObservationStatus;
  /** The provider's actual response model id, when it answered. */
  readonly modelId?: string;
  /**
   * A short machine-readable failure code (`JevClientError.code` or
   * `unexpected_model`) — never a message, so no body or key material can
   * leak into report artifacts.
   */
  readonly errorCode?: string;
  readonly answer?: EvalAnswer;
}

export type ScoredOutcome =
  | "auto_apply"
  | "preselect"
  | "review"
  | "unsure"
  | "no_match"
  | "no_suggestion"
  | "unanswered";

export interface ScoredObservation {
  readonly caseId: string;
  readonly kind: EvalCase["kind"];
  readonly status: EvalObservationStatus;
  readonly answered: boolean;
  /** null when the case never produced a usable answer. */
  readonly correct: boolean | null;
  readonly outcome: ScoredOutcome;
  readonly autoApplied: boolean;
  readonly incorrectAutoApply: boolean;
  readonly expected: string | readonly string[] | number;
  readonly predicted: string | readonly string[] | number | null;
  readonly modelId?: string;
  /** Kind-specific extras (tags sets, near-dup delta, misfiled detection). */
  readonly detail?: Record<string, unknown>;
}

function bandOutcome(
  kind: "set_category" | "add_tags" | "move",
  confidence: number,
  t: EvalThresholds,
  occasion?: "on_save" | "misfiled_scan",
): ScoredOutcome {
  if (kind === "move") {
    if (occasion === "on_save" && confidence >= t.movePreselect) {
      return "preselect";
    }
    return confidence >= t.reviewFloor ? "review" : "unsure";
  }
  if (confidence >= t.autoApply) return "auto_apply";
  return confidence >= t.reviewFloor ? "review" : "unsure";
}

function unanswered(observation: EvalObservation): ScoredObservation {
  return {
    caseId: observation.case.id,
    kind: observation.case.kind,
    status: observation.status,
    answered: false,
    correct: null,
    outcome: "unanswered",
    autoApplied: false,
    incorrectAutoApply: false,
    expected: expectedSummary(observation.case),
    predicted: null,
    ...(observation.modelId === undefined ? {} : { modelId: observation.modelId }),
  };
}

function expectedSummary(c: EvalCase): string | readonly string[] | number {
  switch (c.kind) {
    case "categorize":
      return c.expect.category;
    case "tags":
      return [...c.expect.tags].sort();
    case "placement":
    case "misfiled":
      return c.expect.folder;
    case "near_duplicate":
      return c.expect.same_content;
    case "rerank":
      return [...c.expect.matches].sort();
  }
}

function score(
  observation: EvalObservation,
  partial: Pick<ScoredObservation, "correct" | "outcome" | "predicted"> & {
    detail?: Record<string, unknown>;
  },
): ScoredObservation {
  const autoApplied = partial.outcome === "auto_apply";
  return {
    caseId: observation.case.id,
    kind: observation.case.kind,
    status: observation.status,
    answered: true,
    correct: partial.correct,
    outcome: partial.outcome,
    autoApplied,
    incorrectAutoApply: autoApplied && partial.correct === false,
    expected: expectedSummary(observation.case),
    predicted: partial.predicted,
    ...(observation.modelId === undefined ? {} : { modelId: observation.modelId }),
    ...(partial.detail === undefined ? {} : { detail: partial.detail }),
  };
}

function currentFolderId(c: EvalMisfiledCase): string {
  const current = c.folders.find((f) => f.current === true);
  // The schema guarantees exactly one current candidate.
  return current === undefined ? NONE_FOLDER_ID : current.id;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Score one observation: correctness plus the §10.2 outcome its confidence
 * would have produced. Unanswered, malformed, or kind-mismatched answers
 * score as `unanswered` (never as incorrect — they are a coverage gap).
 */
export function scoreObservation(
  observation: EvalObservation,
  thresholds: EvalThresholds = DEFAULT_EVAL_THRESHOLDS,
): ScoredObservation {
  const c = observation.case;
  const answer = observation.answer;
  if (
    observation.status !== "answered" ||
    answer === undefined ||
    answer.kind !== c.kind
  ) {
    return unanswered(observation);
  }

  switch (c.kind) {
    case "categorize": {
      const a = answer as Extract<EvalAnswer, { kind: "categorize" }>;
      return score(observation, {
        correct: a.choice === c.expect.category,
        predicted: a.choice,
        outcome: bandOutcome("set_category", a.confidence, thresholds),
      });
    }
    case "tags": {
      const a = answer as Extract<EvalAnswer, { kind: "tags" }>;
      const keys = c.tags.map((tag) => tag.nameKey ?? tag.name);
      const selected: string[] = [];
      let confidence = Number.POSITIVE_INFINITY;
      for (const key of keys) {
        const p = a.probabilities[key];
        if (p !== undefined && p >= thresholds.tagSelect) {
          selected.push(key);
          confidence = Math.min(confidence, noulMargin(p, thresholds.tagSelect));
        }
      }
      const expected = c.expect.tags;
      if (selected.length === 0) {
        return score(observation, {
          correct: expected.length === 0,
          predicted: [],
          outcome: "no_suggestion",
        });
      }
      selected.sort();
      return score(observation, {
        correct: sameSet(selected, [...expected].sort()),
        predicted: selected,
        outcome: bandOutcome("add_tags", confidence, thresholds),
        detail: { expectedTags: [...expected].sort(), selected },
      });
    }
    case "placement": {
      const a = answer as Extract<EvalAnswer, { kind: "placement" }>;
      return score(observation, {
        correct: a.choice === c.expect.folder,
        predicted: a.choice,
        outcome: bandOutcome("move", a.confidence, thresholds, "on_save"),
      });
    }
    case "misfiled": {
      const a = answer as Extract<EvalAnswer, { kind: "misfiled" }>;
      const currentId = currentFolderId(c);
      const actuallyMisfiled = c.expect.folder !== currentId;
      // Production treats answering the current folder or "none" as
      // "no move" — both are correct only when the bookmark is filed right.
      const noMove = a.choice === currentId || a.choice === NONE_FOLDER_ID;
      const correct =
        a.choice === c.expect.folder ||
        (!actuallyMisfiled && a.choice === NONE_FOLDER_ID);
      return score(observation, {
        correct,
        predicted: a.choice,
        outcome: bandOutcome("move", a.confidence, thresholds, "misfiled_scan"),
        detail: {
          currentId,
          actuallyMisfiled,
          flaggedMisfiled: !noMove,
        },
      });
    }
    case "near_duplicate": {
      const a = answer as Extract<EvalAnswer, { kind: "near_duplicate" }>;
      const delta = Math.abs(a.score - c.expect.same_content);
      return score(observation, {
        correct: delta === 0,
        predicted: a.score,
        outcome:
          a.confidence >= thresholds.reviewFloor ? "review" : "unsure",
        detail: { delta, withinOne: delta <= 1 },
      });
    }
    case "rerank": {
      const a = answer as Extract<EvalAnswer, { kind: "rerank" }>;
      const predicted = c.candidates.filter(
        (_, i) => (a.probabilities[i] ?? 0) >= thresholds.noMatchBar,
      );
      const matches = sameSet(predicted, c.expect.matches);
      return score(observation, {
        correct: matches,
        predicted: [...predicted].sort(),
        outcome: predicted.length === 0 ? "no_match" : "review",
        detail: {
          expectedMatches: [...c.expect.matches].sort(),
          predicted: [...predicted].sort(),
        },
      });
    }
  }
}

/** Per-kind (or totals) counters and rates. Rates divide by answered. */
export interface KindMetrics {
  readonly cases: number;
  readonly answered: number;
  readonly coverage: number;
  readonly correct: number;
  readonly accuracy: number | null;
  readonly review: number;
  readonly unsure: number;
  readonly preselect: number;
  readonly autoApply: number;
  readonly incorrectAutoApply: number;
  readonly reviewRate: number;
  readonly unsureRate: number;
  readonly autoApplyRate: number;
  readonly incorrectAutoApplyRate: number;
}

export interface TagsMetrics extends KindMetrics {
  readonly microPrecision: number | null;
  readonly microRecall: number | null;
  readonly microF1: number | null;
  readonly exactMatches: number;
}

export interface NearDuplicateMetrics extends KindMetrics {
  readonly withinOneAccuracy: number | null;
  readonly meanAbsoluteError: number | null;
}

export interface MisfiledMetrics extends KindMetrics {
  readonly detectionPrecision: number | null;
  readonly detectionRecall: number | null;
}

export interface RerankMetrics extends KindMetrics {
  readonly microPrecision: number | null;
  readonly microRecall: number | null;
  readonly microF1: number | null;
  readonly noMatch: number;
}

export interface EvalReport {
  readonly generatedAt: string;
  readonly corpusVersion: string;
  readonly questionSetVersions: EvalCorpus["questionSetVersions"];
  /** Every distinct response model id observed, sorted. */
  readonly modelIds: readonly string[];
  readonly thresholds: EvalThresholds;
  readonly totals: KindMetrics;
  readonly perKind: {
    readonly categorize: KindMetrics;
    readonly tags: TagsMetrics;
    readonly placement: KindMetrics;
    readonly misfiled: MisfiledMetrics;
    readonly near_duplicate: NearDuplicateMetrics;
    readonly rerank: RerankMetrics;
  };
  /** Scored observations sorted by caseId for stable serialization. */
  readonly scored: readonly ScoredObservation[];
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function ratioOrNull(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function f1(p: number | null, r: number | null): number | null {
  if (p === null || r === null || p + r === 0) return p === 0 || r === 0 ? 0 : null;
  return (2 * p * r) / (p + r);
}

function baseMetrics(scored: readonly ScoredObservation[]): KindMetrics {
  const answered = scored.filter((s) => s.answered);
  const correct = answered.filter((s) => s.correct === true).length;
  const review = answered.filter((s) => s.outcome === "review").length;
  const unsure = answered.filter((s) => s.outcome === "unsure").length;
  const preselect = answered.filter((s) => s.outcome === "preselect").length;
  const autoApply = answered.filter((s) => s.autoApplied).length;
  const incorrectAutoApply = answered.filter((s) => s.incorrectAutoApply).length;
  const n = answered.length;
  return {
    cases: scored.length,
    answered: n,
    coverage: rate(n, scored.length),
    correct,
    accuracy: ratioOrNull(correct, n),
    review,
    unsure,
    preselect,
    autoApply,
    incorrectAutoApply,
    reviewRate: rate(review, n),
    unsureRate: rate(unsure, n),
    autoApplyRate: rate(autoApply, n),
    incorrectAutoApplyRate: rate(incorrectAutoApply, n),
  };
}

function setCounts(
  predicted: readonly string[],
  expected: readonly string[],
): { tp: number; fp: number; fn: number } {
  const e = new Set(expected);
  const tp = predicted.filter((p) => e.has(p)).length;
  return { tp, fp: predicted.length - tp, fn: expected.length - tp };
}

function tagsMetrics(
  cases: readonly EvalCase[],
  scored: readonly ScoredObservation[],
  observations: readonly EvalObservation[],
): TagsMetrics {
  const byId = new Map(observations.map((o) => [o.case.id, o]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let exact = 0;
  for (const s of scored) {
    if (!s.answered) continue;
    const c = cases.find((k) => k.id === s.caseId);
    const o = byId.get(s.caseId);
    if (c?.kind !== "tags" || o?.answer?.kind !== "tags") continue;
    const predicted = Array.isArray(s.predicted) ? s.predicted : [];
    const counts = setCounts(predicted, c.expect.tags);
    tp += counts.tp;
    fp += counts.fp;
    fn += counts.fn;
    if (s.correct === true) exact += 1;
  }
  const microPrecision = ratioOrNull(tp, tp + fp);
  const microRecall = ratioOrNull(tp, tp + fn);
  return {
    ...baseMetrics(scored),
    microPrecision,
    microRecall,
    microF1: f1(microPrecision, microRecall),
    exactMatches: exact,
  };
}

function rerankMetrics(
  cases: readonly EvalCase[],
  scored: readonly ScoredObservation[],
  observations: readonly EvalObservation[],
): RerankMetrics {
  const byId = new Map(observations.map((o) => [o.case.id, o]));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let noMatch = 0;
  for (const s of scored) {
    if (!s.answered) continue;
    const c = cases.find((k) => k.id === s.caseId);
    const o = byId.get(s.caseId);
    if (c?.kind !== "rerank" || o?.answer?.kind !== "rerank") continue;
    if (s.outcome === "no_match") noMatch += 1;
    const predicted = Array.isArray(s.predicted) ? s.predicted : [];
    const counts = setCounts(predicted, c.expect.matches);
    tp += counts.tp;
    fp += counts.fp;
    fn += counts.fn;
  }
  const microPrecision = ratioOrNull(tp, tp + fp);
  const microRecall = ratioOrNull(tp, tp + fn);
  return {
    ...baseMetrics(scored),
    microPrecision,
    microRecall,
    microF1: f1(microPrecision, microRecall),
    noMatch,
  };
}

function nearDuplicateMetrics(scored: readonly ScoredObservation[]): NearDuplicateMetrics {
  const answered = scored.filter((s) => s.answered);
  let withinOne = 0;
  let error = 0;
  let n = 0;
  for (const s of answered) {
    const delta = s.detail?.delta;
    if (typeof delta !== "number") continue;
    n += 1;
    error += delta;
    if (delta <= 1) withinOne += 1;
  }
  return {
    ...baseMetrics(scored),
    withinOneAccuracy: ratioOrNull(withinOne, n),
    meanAbsoluteError: n === 0 ? null : error / n,
  };
}

function misfiledMetrics(scored: readonly ScoredObservation[]): MisfiledMetrics {
  let flaggedCorrect = 0;
  let flaggedTotal = 0;
  let misfiledTotal = 0;
  let misfiledDetected = 0;
  for (const s of scored) {
    if (!s.answered) continue;
    const flagged = s.detail?.flaggedMisfiled === true;
    const actual = s.detail?.actuallyMisfiled === true;
    if (flagged) flaggedTotal += 1;
    if (actual) misfiledTotal += 1;
    // A flagged case detects a misfiled bookmark correctly only when the
    // predicted folder equals the expected one.
    if (flagged && actual && s.correct === true) {
      flaggedCorrect += 1;
      misfiledDetected += 1;
    }
  }
  return {
    ...baseMetrics(scored),
    detectionPrecision: ratioOrNull(flaggedCorrect, flaggedTotal),
    detectionRecall: ratioOrNull(misfiledDetected, misfiledTotal),
  };
}

/**
 * Score every corpus case against its observation (absent observations
 * count as unanswered) under `thresholdGrid`, and fold the scored rows into
 * a report. `generatedAt` is injected so reports stay reproducible.
 *
 * @throws {Error} on a duplicate caseId or an observation for a case the
 *   corpus does not contain.
 */
export function aggregateEval(
  corpus: EvalCorpus,
  observations: readonly EvalObservation[],
  thresholdGrid: EvalThresholds = DEFAULT_EVAL_THRESHOLDS,
  generatedAt = "",
): EvalReport {
  const caseIds = new Set(corpus.cases.map((c) => c.id));
  const seen = new Set<string>();
  const byCase = new Map<string, EvalObservation>();
  for (const o of observations) {
    if (!caseIds.has(o.case.id)) {
      throw new Error(`observation for unknown case ${JSON.stringify(o.case.id)}`);
    }
    if (seen.has(o.case.id)) {
      throw new Error(`duplicate observation for case ${JSON.stringify(o.case.id)}`);
    }
    seen.add(o.case.id);
    byCase.set(o.case.id, o);
  }

  const scored: ScoredObservation[] = corpus.cases
    .map((c) => {
      const o = byCase.get(c.id);
      return o === undefined
        ? unanswered({ case: c, status: "skipped" })
        : scoreObservation(o, thresholdGrid);
    })
    .sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));

  const byKind = (kind: EvalCase["kind"]) =>
    scored.filter((s) => s.kind === kind);
  const casesOf = (kind: EvalCase["kind"]) =>
    corpus.cases.filter((c) => c.kind === kind);

  const modelIds = [
    ...new Set(
      scored
        .map((s) => s.modelId)
        .filter((m): m is string => typeof m === "string"),
    ),
  ].sort();

  return {
    generatedAt,
    corpusVersion: corpus.version,
    questionSetVersions: corpus.questionSetVersions,
    modelIds,
    thresholds: thresholdGrid,
    totals: baseMetrics(scored),
    perKind: {
      categorize: baseMetrics(byKind("categorize")),
      tags: tagsMetrics(casesOf("tags"), byKind("tags"), observations),
      placement: baseMetrics(byKind("placement")),
      misfiled: misfiledMetrics(byKind("misfiled")),
      near_duplicate: nearDuplicateMetrics(byKind("near_duplicate")),
      rerank: rerankMetrics(casesOf("rerank"), byKind("rerank"), observations),
    },
    scored,
  };
}
