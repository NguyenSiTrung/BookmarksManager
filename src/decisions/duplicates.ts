import { db } from "../db/database";
import { Decision } from "../schemas/decision";
import type { Decision as DecisionDocument } from "../schemas/decision";
import type { SentBookmark } from "../schemas/decision-state";
import type { PresetId } from "../schemas/provider";
import { UsageRecord } from "../schemas/usage";
import { JevClientError, createJevClient } from "../jev/client";
import type { JevClient, JevRunResult, JevTransport } from "../jev/client";
import { nearDuplicate } from "../jev/tasks/near-duplicate";
import { nearDuplicateQuestionSetVersion } from "../jev/tasks";
import { NetworkGateError } from "../net/send";
import { nearDuplicatePairs } from "./candidates";
import type { NearDuplicatePair, NearDuplicateSource } from "./candidates";
import { minimizeBookmark } from "./minimize";
import { evaluatePolicy } from "./policy";
import type { PolicyOutcome } from "./policy";
import { DecisionStoreError, persistDecision } from "./store";
import type { DecisionRow } from "./store";

/**
 * Near-duplicate scan service (spec FR3–FR5, FR7, PROJECT_PLAN.md §9.2/§10.2):
 * the orchestration that turns a scan's bookmarks into persisted
 * `merge_duplicates` decisions. It
 *  1. computes the same-domain, similar-titled pairs the local duplicate
 *     detector cannot settle (`nearDuplicatePairs`, FR3),
 *  2. minimizes each pair's two sides to `SentBookmark`s — title, cleaned
 *     URL, and domain only; notes never leave the device and a
 *     blocklisted/sensitive side skips the whole pair,
 *  3. sends ONE `nearDuplicate` question set per pair through a
 *     `createJevClient` bound to the `jev_decisions` scope (caller may inject
 *     `client`/`transport`; production defaults to `sendConsented`), with
 *     state `{bookmark, pairPartner}` — Chrome node ids never enter a request,
 *  4. cross-checks the `same_content` answer (the only field; a `score`
 *     answer in 1–4) — anything else is an `answer_mismatch`, the FR2 hard
 *     boundary,
 *  5. maps the level onto a §10.1 confidence ({@link levelToConfidence}) and
 *     applies the §10.2 `merge_duplicates` policy — always `review` (≥ 0.5)
 *     or `unsure`, NEVER auto-applied,
 *  6. persists one `merge_duplicates` decision per pair (with `keepId` set to
 *     the pair's canonical `a` side) and records exactly one `usage` row per
 *     egress.
 *
 * An empty pair list makes NO request (`{sent:false, reason:"empty"}`); a list
 * whose every pair is blocklisted also makes no request
 * (`{sent:false, reason:"blocklisted"}`). Failures are typed
 * `DuplicateScanError`s: provider errors relay the client's own (already
 * redacted) code and message; persistence failures use generic, content-free
 * messages — no response body, title, or URL ever reaches an error message.
 */

// ---------------------------------------------------------------------------
// Level → confidence
// ---------------------------------------------------------------------------

/**
 * The `same_content` levels `nearDuplicate` declares, lowest to highest
 * (`src/jev/tasks/near-duplicate.ts`): 1 unrelated, 2 same topic but
 * different content, 3 same content at a different URL or version, 4
 * identical page.
 */
export const SAME_CONTENT_MIN_LEVEL = 1;
export const SAME_CONTENT_MAX_LEVEL = 4;

/**
 * Map a `same_content` level (1–4) onto a §10.1 confidence, so the §10.2
 * `merge_duplicates` band can be applied:
 *
 * | level | meaning                              | confidence | outcome |
 * | ----- | ------------------------------------ | ---------- | ------- |
 * | 1     | unrelated                            | 0.0        | unsure  |
 * | 2     | same topic, different content        | 0.4        | unsure  |
 * | 3     | same content at a different URL      | 0.75       | review  |
 * | 4     | identical page                       | 1.0        | review  |
 *
 * `REVIEW_FLOOR` is 0.5, so the two "same content" levels clear it (the user
 * reviews a merge proposal) and the two weaker levels fall below it (marked
 * `unsure`). Pure and total over the declared range; a level outside 1–4
 * throws `RangeError`.
 */
export function levelToConfidence(level: number): number {
  if (
    !Number.isInteger(level) ||
    level < SAME_CONTENT_MIN_LEVEL ||
    level > SAME_CONTENT_MAX_LEVEL
  ) {
    throw new RangeError(
      `same_content level must be an integer ${SAME_CONTENT_MIN_LEVEL}–${SAME_CONTENT_MAX_LEVEL}; received ${level}`,
    );
  }
  switch (level) {
    case 1:
      return 0;
    case 2:
      return 0.4;
    case 3:
      return 0.75;
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

interface ScanCommonOptions {
  /** Jev preset the client is bound to. */
  readonly preset: PresetId;
  /** Model id sent in the request; the response may report another. */
  readonly model: string;
  /** An already-built client (tests / reuse). When absent one is created. */
  readonly client?: JevClient;
  /** Transport override when the service creates its own client. */
  readonly transport?: JevTransport;
}

/** The end-to-end scan input: the scan's bookmarks. */
export interface ScanNearDuplicatesOptions extends ScanCommonOptions {
  /** The scan's bookmarks; pairs are computed from them (`nearDuplicatePairs`). */
  readonly bookmarks: readonly NearDuplicateSource[];
}

/** The per-batch input: an already-computed pair list (the runner's slice). */
export interface ScanDuplicatePairsOptions extends ScanCommonOptions {
  readonly pairs: readonly NearDuplicatePair[];
}

/** One pair's persisted outcome. */
export interface DuplicatePairResult {
  /** The pair's local Chrome ids, `[a.id, b.id]` (never sent to Jev). */
  readonly ids: readonly [string, string];
  /** The `same_content` level the model answered (1–4). */
  readonly level: number;
  /** The level mapped onto a §10.1 confidence. */
  readonly confidence: number;
  /** The §10.2 outcome for a `merge_duplicates` at that confidence. */
  readonly outcome: PolicyOutcome;
  /** The persisted `merge_duplicates` decision row. */
  readonly decision: DecisionRow;
}

/** A completed scan: one result per sendable pair plus one usage row each. */
export interface DuplicateScanSent {
  readonly sent: true;
  /** Every pair considered (sendable + skipped). */
  readonly pairs: number;
  /** Pairs skipped because a side was blocklisted/sensitive. */
  readonly skipped: number;
  readonly results: readonly DuplicatePairResult[];
  /** Exactly one row per pair egress, in pair order. */
  readonly usage: readonly UsageRecord[];
}

/** A scan that made no request: no pairs, or every pair blocklisted. */
export interface DuplicateScanNotSent {
  readonly sent: false;
  readonly reason: "empty" | "blocklisted";
}

export type DuplicateScanResult = DuplicateScanSent | DuplicateScanNotSent;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** `code` values on a failed scan: the client's codes plus service ones. */
export type DuplicateScanErrorCode =
  | JevClientError["code"]
  | "invalid_input"
  | "persist_failed"
  | "provider";

/** Rejection for every failure this module produces. Messages stay redacted. */
export class DuplicateScanError extends Error {
  readonly code: DuplicateScanErrorCode;

  constructor(code: DuplicateScanErrorCode, message: string) {
    super(message);
    this.name = "DuplicateScanError";
    this.code = code;
  }
}

/** Map any thrown cause onto the scan error model (never copies content). */
function toDuplicateScanError(cause: unknown): DuplicateScanError {
  if (cause instanceof DuplicateScanError) return cause;
  if (cause instanceof JevClientError) {
    // The client's message is already redacted (no bodies, keys, or state).
    return new DuplicateScanError(cause.code, cause.message);
  }
  if (cause instanceof NetworkGateError) {
    return new DuplicateScanError(cause.code, cause.message);
  }
  return new DuplicateScanError(
    "provider",
    "The near-duplicate request failed before a response could be read.",
  );
}

// ---------------------------------------------------------------------------
// Answer cross-check
// ---------------------------------------------------------------------------

function mismatch(): DuplicateScanError {
  return new DuplicateScanError(
    "answer_mismatch",
    "The answer for the near-duplicate question is not a declared same_content level.",
  );
}

/**
 * FR2 hard boundary: the one field `same_content` must be answered with a
 * `score` level inside the declared 1–4 range, and no other answer key may be
 * present. Returns the level; a violation throws `answer_mismatch` before
 * anything is persisted or recorded.
 */
function crossCheckLevel(
  answers: Record<string, { type: string; score?: number }>,
): number {
  const keys = Object.keys(answers);
  if (keys.length !== 1 || keys[0] !== "same_content") throw mismatch();
  const answer = answers.same_content;
  if (
    answer?.type !== "score" ||
    typeof answer.score !== "number" ||
    !Number.isInteger(answer.score) ||
    answer.score < SAME_CONTENT_MIN_LEVEL ||
    answer.score > SAME_CONTENT_MAX_LEVEL
  ) {
    throw mismatch();
  }
  return answer.score;
}

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

/** Persist one `usage` row for the completed request (mirrors the pipeline). */
async function recordUsage(result: JevRunResult): Promise<UsageRecord> {
  const record = UsageRecord.parse({
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    ...(result.usage.cost === undefined ? {} : { costUsd: result.usage.cost }),
    recordedAt: new Date().toISOString(),
  });
  try {
    const id = await db.usage.add(record);
    return { ...record, id };
  } catch {
    throw new DuplicateScanError(
      "persist_failed",
      "Failed to record request usage.",
    );
  }
}

// ---------------------------------------------------------------------------
// Decision document
// ---------------------------------------------------------------------------

/** Build the §7 `merge_duplicates` document for one pair at `status`. */
function toMergeDocument(
  entry: SendablePair,
  options: ScanCommonOptions,
  model: string,
  confidence: number,
  probabilities: Record<string, number> | undefined,
  status: DecisionDocument["status"],
): DecisionDocument {
  return Decision.parse({
    id: crypto.randomUUID(),
    kind: "merge_duplicates",
    // The pair's two sides; §10.2 never auto-applies a merge, so the user
    // confirms (or overrides `keepId`) in review.
    bookmarkIds: [entry.pair.a.id, entry.pair.b.id],
    keepId: entry.pair.a.id,
    confidence,
    ...(probabilities === undefined ? {} : { probabilities }),
    status,
    source: {
      engine: "jev" as const,
      providerId: options.preset,
      model,
      questionSetVersion: nearDuplicateQuestionSetVersion,
    },
    createdAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface SendablePair {
  readonly pair: NearDuplicatePair;
  readonly a: SentBookmark;
  readonly b: SentBookmark;
}

/**
 * Scan an already-computed pair list: minimize both sides, send one
 * `nearDuplicate` request per sendable pair, cross-check the level, map it to
 * a confidence, apply the §10.2 `merge_duplicates` policy, persist a decision,
 * and record one `usage` row per egress.
 */
export async function scanNearDuplicatePairs(
  options: ScanDuplicatePairsOptions,
): Promise<DuplicateScanResult> {
  // Outer boundary: the task builder and schema parses can throw raw errors
  // whose values may embed state. Map EVERY throw through the error model so
  // callers only ever see typed, redacted errors.
  try {
    return await runPairs(options);
  } catch (cause) {
    throw toDuplicateScanError(cause);
  }
}

/**
 * The end-to-end scan service: compute the near-duplicate pairs for the
 * scan's bookmarks (`nearDuplicatePairs`) and scan them all. See
 * {@link scanNearDuplicatePairs} for the per-pair discipline.
 */
export async function scanNearDuplicates(
  options: ScanNearDuplicatesOptions,
): Promise<DuplicateScanResult> {
  try {
    const pairs = nearDuplicatePairs(options.bookmarks);
    return await runPairs({ ...options, pairs });
  } catch (cause) {
    throw toDuplicateScanError(cause);
  }
}

async function runPairs(
  options: ScanDuplicatePairsOptions,
): Promise<DuplicateScanResult> {
  const { pairs } = options;
  if (pairs.length === 0) {
    return { sent: false, reason: "empty" };
  }

  // Minimize each side; a blocklisted/sensitive URL skips the WHOLE pair
  // (never send one side of a pair without the other).
  const sendable: SendablePair[] = [];
  let skipped = 0;
  for (const pair of pairs) {
    const a = minimizeBookmark({ title: pair.a.title, url: pair.a.url });
    const b = minimizeBookmark({ title: pair.b.title, url: pair.b.url });
    if (a === null || b === null) {
      skipped += 1;
      continue;
    }
    sendable.push({ pair, a, b });
  }
  if (sendable.length === 0) {
    return { sent: false, reason: "blocklisted" };
  }

  const client =
    options.client ??
    createJevClient({
      preset: options.preset,
      model: options.model,
      scope: "jev_decisions",
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    });

  const results: DuplicatePairResult[] = [];
  const usage: UsageRecord[] = [];
  for (const entry of sendable) {
    const set = nearDuplicate({ a: entry.a, b: entry.b });
    const request = set.decision.build(set.state, client.model);
    let result: JevRunResult;
    try {
      result = await client.run(request);
    } catch (cause) {
      throw toDuplicateScanError(cause);
    }

    const answers = result.answers as Record<
      string,
      { type: string; score?: number; probabilities?: Record<string, number> }
    >;
    const level = crossCheckLevel(answers);
    const confidence = levelToConfidence(level);

    // The request left the device, so record its cost. This runs AFTER the
    // answer cross-check: an `answer_mismatch` throws before reaching here, so
    // it writes no usage row. Exactly one row per completed call.
    usage.push(await recordUsage(result));

    const outcome = evaluatePolicy({ kind: "merge_duplicates", confidence });
    // A merge is never auto-applied; a `review` decision lands `pending`.
    const status: DecisionDocument["status"] =
      outcome === "unsure" ? "unsure" : "pending";
    const document = toMergeDocument(
      entry,
      options,
      result.model,
      confidence,
      answers.same_content?.probabilities,
      status,
    );
    let decision: DecisionRow;
    try {
      decision = await persistDecision(document);
    } catch (cause) {
      if (cause instanceof DecisionStoreError) {
        throw new DuplicateScanError(
          "persist_failed",
          "Failed to persist the merge_duplicates decision.",
        );
      }
      throw cause;
    }
    results.push({
      ids: [entry.pair.a.id, entry.pair.b.id],
      level,
      confidence,
      outcome,
      decision,
    });
  }

  return { sent: true, pairs: pairs.length, skipped, results, usage };
}
