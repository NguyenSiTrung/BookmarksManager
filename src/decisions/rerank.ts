import { db } from "../db/database";
import { UsageRecord } from "../schemas/usage";
import type { SentBookmark } from "../schemas/decision-state";
import type { PresetId } from "../schemas/provider";
import { JevClientError, createJevClient } from "../jev/client";
import type { JevClient, JevRunResult, JevTransport } from "../jev/client";
import { rerank } from "../jev/tasks/rerank";
import { NetworkGateError } from "../net/send";
import type { SearchHit } from "../search/index";
import { rerankCandidates } from "./candidates";
import { minimizeBookmark } from "./minimize";
import { isNoMatch } from "./policy";

/**
 * "Ask" rerank service (spec FR3–FR6, PROJECT_PLAN.md §9.4 "Ask" / §10.2):
 * the orchestration that turns one MiniSearch result set into a ranked,
 * Jev-judged shortlist. It
 *  1. projects the hits to a bounded shortlist (`rerankCandidates`, cap 30),
 *  2. minimizes each shortlisted hit to a `SentBookmark` — title, cleaned
 *     URL, and domain only; notes never leave the device and a
 *     blocklisted/sensitive URL is skipped, exactly as the analyze pipeline
 *     does,
 *  3. builds the `rerank` question set (one noul per candidate, keyed
 *     `candidate_<index>` — the candidate is referenced positionally into
 *     `state.candidateBookmarks`, so Chrome node ids never enter the request),
 *  4. sends it as ONE `createJevClient` request bound to the `jev_decisions`
 *     scope (caller may inject `client`/`transport`; production defaults to
 *     `sendConsented`),
 *  5. cross-checks every answer key against the candidates that were actually
 *     sent — an answer outside `candidate_<i>` (or of the wrong type) is an
 *     `answer_mismatch`, the FR2 hard boundary,
 *  6. sorts the results by probability (descending) and applies the §10.2
 *     no-match bar (`isNoMatch`),
 *  7. records exactly one `usage` row per egress.
 *
 * The query is user input, so it is sent ONLY as `DecisionState.query` — never
 * embedded in question text or anywhere else. An empty or all-blocklisted
 * shortlist makes NO request (and writes no `usage` row). Failures are typed
 * `RerankError`s: provider errors relay the client's own (already redacted)
 * code and message; persistence failures are reported with generic,
 * content-free messages — no response body, query, title, or URL ever reaches
 * an error message.
 */

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export interface RerankSearchOptions {
  /** The "Ask" search string — sent only as `DecisionState.query`. */
  readonly query: string;
  /** The MiniSearch hits for the query; the caller runs the query. */
  readonly hits: readonly SearchHit[];
  /** Jev preset the client is bound to. */
  readonly preset: PresetId;
  /** Model id sent in the request; the response may report another. */
  readonly model: string;
  /**
   * The user's own blocklist (normalized hosts). A shortlisted hit on a
   * user-blocklisted host is skipped exactly like a built-in-sensitive one
   * and never enters a request. Absent means the user has added no entries.
   */
  readonly userBlocklist?: readonly string[];
  /** An already-built client (tests / reuse). When absent one is created. */
  readonly client?: JevClient;
  /** Transport override when the service creates its own client. */
  readonly transport?: JevTransport;
}

/** One ranked candidate: the local bookmark id plus its Jev probability. */
export interface RerankResult {
  /** Chrome node id of the candidate (local only — never sent to Jev). */
  readonly id: string;
  /** Probability the candidate matches the query, in `[0, 1]`. */
  readonly probability: number;
}

/** Why no request was made: no hits, or every candidate was blocklisted. */
export type RerankNotSentReason = "empty" | "blocklisted";

/** A rerank that made no request. */
export interface RerankNotSent {
  readonly sent: false;
  readonly reason: RerankNotSentReason;
}

/** A completed rerank: the ranked list, the no-match verdict, and usage. */
export interface RerankSent {
  readonly sent: true;
  /** The model that answered. */
  readonly model: string;
  /** Candidates sorted by probability, descending (ties keep shortlist order). */
  readonly results: readonly RerankResult[];
  /** True when every probability is below `RERANK_NO_MATCH_BAR` (§10.2). */
  readonly noMatch: boolean;
  readonly usage: UsageRecord;
}

export type RerankSearchResult = RerankNotSent | RerankSent;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** `code` values on a failed rerank: the client's codes plus service ones. */
export type RerankErrorCode =
  | JevClientError["code"]
  | "invalid_input"
  | "persist_failed"
  | "provider";

/** Rejection for every failure this module produces. Messages stay redacted. */
export class RerankError extends Error {
  readonly code: RerankErrorCode;

  constructor(code: RerankErrorCode, message: string) {
    super(message);
    this.name = "RerankError";
    this.code = code;
  }
}

/** Map any thrown cause onto the rerank error model (never copies content). */
function toRerankError(cause: unknown): RerankError {
  if (cause instanceof RerankError) return cause;
  if (cause instanceof JevClientError) {
    // The client's message is already redacted (no bodies, keys, or state).
    return new RerankError(cause.code, cause.message);
  }
  if (cause instanceof NetworkGateError) {
    return new RerankError(cause.code, cause.message);
  }
  return new RerankError(
    "provider",
    "The rerank request failed before a response could be read.",
  );
}

// ---------------------------------------------------------------------------
// Answer-ID cross-check
// ---------------------------------------------------------------------------

/** The positional `candidate_<index>` question key, or `null` for anything else. */
function candidateIndexOf(key: string): number | null {
  const match = /^candidate_(\d+)$/.exec(key);
  if (match === null) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

function mismatch(key: string): RerankError {
  return new RerankError(
    "answer_mismatch",
    `The answer for question ${JSON.stringify(key)} is not one of the candidates that were sent.`,
  );
}

/**
 * FR2 hard boundary: every answer key must be `candidate_<i>` for a candidate
 * that was actually sent, and every candidate must be answered with a noul. A
 * violation is an `answer_mismatch` and stops the run before anything is
 * returned or recorded.
 */
function crossCheckAnswers(
  answers: Record<string, { type: string; noul?: number }>,
  count: number,
): void {
  for (const key of Object.keys(answers)) {
    const index = candidateIndexOf(key);
    if (index === null || index >= count) throw mismatch(key);
  }
  for (let index = 0; index < count; index++) {
    const key = `candidate_${index}`;
    const answer = answers[key];
    if (answer?.type !== "noul" || typeof answer.noul !== "number") {
      throw mismatch(key);
    }
  }
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
    throw new RerankError("persist_failed", "Failed to record request usage.");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Rerank the MiniSearch hits for `query`: minimize → one `rerank` question set
 * → one `jev_decisions` request → answer-ID cross-check → sort by probability
 * → §10.2 no-match verdict → one `usage` row. Returns `{sent: false}` for an
 * empty or all-blocklisted shortlist (no request). Throws `RerankError` for
 * every failure, with a redacted message.
 */
export async function rerankSearch(
  options: RerankSearchOptions,
): Promise<RerankSearchResult> {
  // Outer boundary: task builders throw raw `TypeError`s and the gate/parse
  // steps can throw raw errors whose values may embed state. Map EVERY throw
  // through `toRerankError` so callers only ever see typed, redacted errors.
  try {
    return await runRerank(options);
  } catch (cause) {
    throw toRerankError(cause);
  }
}

async function runRerank(
  options: RerankSearchOptions,
): Promise<RerankSearchResult> {
  if (options.query.trim() === "") {
    throw new RerankError(
      "invalid_input",
      "The rerank query must be non-empty text.",
    );
  }

  const shortlist = rerankCandidates(options.hits);
  if (shortlist.length === 0) {
    return { sent: false, reason: "empty" };
  }

  // Minimize each shortlisted hit; a blocklisted/sensitive URL is skipped
  // (never sent). The sent candidates — not the raw hits — define the
  // positional `candidate_<index>` keys, so ids stay on the device.
  const sent: { id: string; bookmark: SentBookmark }[] = [];
  for (const candidate of shortlist) {
    const bookmark = minimizeBookmark(
      {
        title: candidate.title,
        url: candidate.url,
      },
      options.userBlocklist,
    );
    if (bookmark === null) continue;
    sent.push({ id: candidate.id, bookmark });
  }
  if (sent.length === 0) {
    return { sent: false, reason: "blocklisted" };
  }

  const set = rerank({
    query: options.query,
    candidates: sent.map((entry) => entry.bookmark),
  });
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

  const request = set.decision.build(set.state, client.model);
  let result: JevRunResult;
  try {
    result = await client.run(request);
  } catch (cause) {
    throw toRerankError(cause);
  }

  const answers = result.answers as Record<
    string,
    { type: string; noul?: number }
  >;
  crossCheckAnswers(answers, sent.length);

  // The request left the device, so record its cost. This runs AFTER the
  // answer cross-check above: an `answer_mismatch` throws before reaching
  // here, so it writes no usage row (matching the analyze pipeline). Exactly
  // one row per completed call.
  const usage = await recordUsage(result);

  const ranked = sent.map((entry, index) => ({
    id: entry.id,
    probability: answers[`candidate_${index}`]?.noul ?? 0,
    index,
  }));
  // Descending probability; ties keep the shortlist's own (relevance) order.
  ranked.sort((a, b) => b.probability - a.probability || a.index - b.index);
  const results: RerankResult[] = ranked.map(({ id, probability }) => ({
    id,
    probability,
  }));

  return {
    sent: true,
    model: result.model,
    results,
    noMatch: isNoMatch(results.map((entry) => entry.probability)),
    usage,
  };
}
