import { appendUsage } from "../db/retention";
import { createJevClient } from "../jev/client";
import type { JevClient, JevTransport } from "../jev/client";
import { minimizeBookmark } from "../decisions/minimize";
import { UsageRecord } from "../schemas/usage";
import type { AnalyzeBookmarkResult } from "../decisions/pipeline";
import type { Job } from "../schemas/job";
import { DECISIONS_CONSENT_SCOPE } from "../schemas/provider";
import {
  RestructureAssignment,
  type RestructureProposal,
} from "../schemas/restructure";
import {
  restructure,
  indexForKey,
  KEEP_FOLDER_KEY,
  keyForIndex,
} from "../jev/tasks/restructure";
import { assertJobAuthority, mergeRestructureAssignments } from "../jobs/queue";
import type { JobAnalyzeFn, JobAnalyzeInput } from "../jobs/runner";

/**
 * The Jev half of spec FR8 — assign each bookmark to one of the LLM-proposed
 * folders (or keep its current one). Runs under `jev_decisions` — the state
 * is the closed `DecisionState` shape (`{bookmark, candidateFolders}`), so
 * no new egress surface is introduced.
 *
 * Every send produces exactly one `usage` row and one committed
 * `RestructureAssignment` on the job's carried plan — both durable BEFORE the
 * runner advances `committedBatches`, so a service-worker suspension mid-run
 * resumes without duplicate egress.
 */

/**
 * Below this §10.1 confidence the assignment stays `unresolved` — the row is
 * persisted (so review shows it and resume skips it) but `proposedPath` is
 * `null` and the apply phase (task 3) excludes it.
 */
export const ASSIGNMENT_CONFIDENCE_THRESHOLD = 0.5;

/** `code` values on an assign-layer failure. */
export type AssignErrorCode = "invalid_job" | "invalid_proposal";

export class AssignError extends Error {
  readonly code: AssignErrorCode;

  constructor(code: AssignErrorCode, message: string) {
    super(message);
    this.name = "AssignError";
    this.code = code;
  }
}

/**
 * Read the proposal off the job row — the row is authoritative so a resumed
 * runner can never assign against a different proposal than the one the user
 * approved.
 */
function requireProposal(job: Job): RestructureProposal {
  if (job.kind !== "restructure" || job.restructure === undefined) {
    throw new AssignError(
      "invalid_job",
      `Job ${JSON.stringify(job.id)} is not a restructure job.`,
    );
  }
  return job.restructure.proposal;
}

/**
 * Interpret Jev's answer: the option key maps back to a proposed path via
 * `indexForKey`, the `none` sentinel and answers below
 * `ASSIGNMENT_CONFIDENCE_THRESHOLD` both stay unresolved (null path).
 * `indexForKey` returning an out-of-range index means the client let an
 * unknown key through — treated as unresolved, never applied.
 */
function toAssignment(
  bookmarkId: string,
  folderKey: string,
  confidence: number,
  proposal: RestructureProposal,
): RestructureAssignment {
  const index = indexForKey(folderKey);
  const resolved =
    folderKey !== KEEP_FOLDER_KEY &&
    index !== null &&
    index < proposal.folders.length &&
    confidence >= ASSIGNMENT_CONFIDENCE_THRESHOLD;
  return RestructureAssignment.parse({
    bookmarkId,
    proposedPath: resolved ? proposal.folders[index as number]!.path : null,
    confidence: resolved ? confidence : null,
  });
}

/** Persist one `usage` row for the completed request (mirrors the pipeline). */
async function recordUsage(
  model: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost?: number },
): Promise<UsageRecord> {
  const parsed = UsageRecord.parse({
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cost === undefined ? {} : { costUsd: usage.cost }),
    recordedAt: new Date().toISOString(),
  });
  const id = await appendUsage(parsed);
  return { ...parsed, id };
}

export interface AssignOptions {
  /** Jev provider the client is bound to — a preset id or `"custom"`. */
  readonly providerId: string;
  /** Model id sent in every request. */
  readonly model: string;
  /** The user's own blocklist (normalized hosts), mirrored into `minimizeBookmark`. */
  readonly userBlocklist?: readonly string[];
  /** An already-built client (tests / reuse). When absent one is created. */
  readonly client?: JevClient;
  /** Test seam — a `JevTransport` replacing the consented send. */
  readonly transport?: JevTransport;
}

/**
 * One bookmark's assignment: minimize → Jev `restructure` choice over the
 * job's carried proposal → persist the `RestructureAssignment` onto the job
 * row → return the usage row for the runner's roll-up. A bookmark that fails
 * `minimizeBookmark` returns `{sent:false}` without any egress or write.
 */
export async function assignProposedFolder(
  input: JobAnalyzeInput,
  options: AssignOptions,
): Promise<AnalyzeBookmarkResult> {
  const proposal = requireProposal(input.job);
  const sent = minimizeBookmark(
    {
      title: input.bookmark.title,
      url: input.bookmark.url,
      ...(input.bookmark.notes === undefined
        ? {}
        : { notes: input.bookmark.notes }),
    },
    options?.userBlocklist,
  );
  if (sent === null) {
    return { sent: false, reason: "blocklisted" };
  }
  const client: JevClient =
    options.client ??
    createJevClient({
      providerId: options.providerId,
      model: options.model,
      scope: DECISIONS_CONSENT_SCOPE,
      beforeSend: () => assertJobAuthority(input.job),
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    });
  const set = restructure({ bookmark: sent, folders: proposal.folders });
  const run = await set.decision.run(client, set.state);
  const assignment = toAssignment(
    input.bookmark.id,
    run.values.folder,
    run.confidence.folder,
    proposal,
  );
  // Persist the assignment and the usage row before the runner commits the
  // batch — the commit boundary is what makes resume skip this bookmark.
  await mergeRestructureAssignments(
    input.job.id,
    [assignment],
    undefined,
    input.job.ownerGeneration ?? 0,
  );
  const usage = await recordUsage(client.model, run.usage);
  return { sent: true, model: run.model, decisions: [], usage };
}

/**
 * Adapt {@link assignProposedFolder} into the runner's `JobAnalyzeFn`: every
 * `restructure` job calls this once per bookmark per batch. `checks` is
 * ignored — a restructure job has no analysis checks (`jobChecks` → `[]`).
 */
export function createRestructureAssigner(options: AssignOptions): JobAnalyzeFn {
  return (input) => assignProposedFolder(input, options);
}

/** A proposal's folder index keys, for tests and the diff view. */
export const proposalKeys = {
  keyForIndex,
  indexForKey,
  keep: KEEP_FOLDER_KEY,
};
