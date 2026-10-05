import { getMetaByIds, MetaRepoError } from "../db/meta";
import type { MetaRepoErrorCode } from "../db/meta";
import { mergeGroup } from "../duplicates/merge";
import type { DuplicateGroup } from "../duplicates/group";
import type { AuditActor } from "../schemas/audit";
import type { Decision as DecisionDocument } from "../schemas/decision";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";
import { get } from "../sync/chrome-bookmarks";
import { MutationError, moveNode } from "../sync/mutations";
import type { MutationErrorCode } from "../sync/mutations";
import { bulkAddTag, bulkSetCategory } from "../sync/tag-ops";
import type { TagOpsErrorCode } from "../sync/tag-ops";
import { discardById, undoExpected } from "../undo/restore";
import type { UndoFailureCode } from "../undo/restore";
import { captureNodes, peekLatest, pushSnapshot } from "../undo/snapshot";
import type { UndoMeta } from "../schemas/undo";
import {
  claimDecision,
  DecisionStoreError,
  getDecision,
  isLegalTransition,
  releaseDecisionClaim,
  transitionStatus,
} from "./store";
import type { DecisionRow, DecisionStoreErrorCode } from "./store";

/**
 * The apply half of the decision store (spec FR6, PROJECT_PLAN.md §10.2):
 * approve, reject, revert, and bulk approve. Every decision that changes the
 * tree or extension metadata goes through the existing guarded services —
 * `src/sync/tag-ops.ts` (tags, category), `src/sync/mutations.ts`
 * (`moveNode`), and `src/duplicates/merge.ts` (`mergeGroup`) — and every
 * apply pushes an undo snapshot FIRST, so the change can be reverted. This
 * module never writes `chrome.bookmarks` directly.
 *
 * Design rules (locked by tests/unit/decisions-apply.test.ts):
 *
 * - **Apply = approve.** `approveDecision` validates the transition, refuses
 *   a stale decision, applies the action behind an undo snapshot, then moves
 *   the row to `applied` and records the snapshot id on it — all via
 *   {@link transitionStatus}, which appends exactly one content-free audit
 *   row. `reject` records `rejected` without touching the tree; `revert`
 *   replays the row's recorded snapshot and records `reverted`.
 * - **Supported kinds.** `add_tags`, `set_category`, `move`, and
 *   `merge_duplicates` apply. `mark_dead`, `rename`, and `create_folder` are
 *   refused `unsupported` **by design, not by oversight**: the track spec's
 *   "Out of Scope" section defers `mark_dead` to release 1.1 and
 *   `create_folder`/`rename` to Phase 5 (the LLM layer), and the undo stack
 *   has no replay kind for any of them. They gain an apply path only when
 *   those releases land.
 * - **Apply/status atomicity (compensating undo).** The mutation
 *   (`chrome.bookmarks` / Dexie metadata) and the status+audit write cannot
 *   share one IndexedDB transaction: the mutation awaits non-Dexie async work,
 *   which auto-commits a surrounding Dexie transaction, so a "single
 *   transaction" would silently not be atomic. Instead the apply is two-phase
 *   with compensation: after a successful mutation the status transition runs;
 *   if THAT throws, the mutation is undone via the snapshot just pushed
 *   (targeted by id) and a typed error is rethrown — a failed status write can
 *   never leave an orphaned, un-revertable mutation. `revertDecision` applies
 *   the same reasoning in reverse: if the row cannot be marked `reverted`
 *   after the undo popped, it reports `state_unrecorded` rather than leaving
 *   the row silently inconsistent.
 * - **Compensation is targeted by id, never "latest".** Both the
 *   mutation-failure rollback and the transition-failure compensation name the
 *   exact snapshot id they pushed: `discardById` drops it when there is
 *   nothing to restore, and `undoExpected` replays it ONLY while it is
 *   verifiably the stack head — checking the head and replaying the checked
 *   row inside one hold of the extension-wide undo lock, so a snapshot another
 *   context pushed in between can never be popped in its place.
 * - **Meta undo via the `delete` kind.** The undo system has no dedicated
 *   "metadata changed" snapshot; the `delete`/`merge` replay writes every
 *   `meta` row whose id is NOT in `nodes` back onto its surviving bookmark
 *   (that is how a merge restores the kept row). A tag/category apply pushes
 *   `{ kind: "delete", nodes: [], meta: <pre-change rows> }`: replay restores
 *   the pre-change rows, and an id that had no row gets an empty row that the
 *   lazy-row rule deletes again. Moves use `bulk_move`; merges rely on
 *   `mergeGroup`'s own `merge` snapshot.
 * - **Stale decisions are refused.** Before any mutation the live tree is
 *   re-read and compared against the row's persisted `guard` — the snapshot
 *   the request was SENT from (J05): a bookmark that no longer exists is
 *   `stale`/`bookmark_gone`; for a `move`, one whose `parentId` changed
 *   since the decision was made is `stale`/`bookmark_moved`; for
 *   `add_tags`/`set_category`/`merge_duplicates`, one whose url or title
 *   changed is `stale`/`bookmark_edited`. Nothing is written and no audit
 *   row is added.
 * - **Revert targets its own snapshot.** A revert only runs through
 *   `undoExpected`, which replays the row's recorded `undoSnapshotId` and
 *   reports `conflict` (mapped to `undo_conflict`) when that row is no longer
 *   the stack head — rather than blindly popping an unrelated snapshot.
 * - **Per-decision mutual exclusion (J06).** Approve and reject serialize on
 *   the decision id: an in-worker promise chain makes same-context calls run
 *   one-at-a-time, and a conditional `claim` sidecar in the store makes
 *   cross-context calls exclusive — the loser of a race sees `claimed` (a
 *   live claim) or `illegal_transition` (the winner already committed). A
 *   claim expires after `DECISION_CLAIM_TTL_MS`, is token-verified at the
 *   transition, and is released on every failure path, so nothing wedges.
 * - **Bulk approve is per-row atomic.** Each id is approved in its own
 *   try/catch; one row's failure (e.g. stale) never affects the others, and
 *   the result reports the applied rows and the per-row failures.
 * - **Typed errors, no raw causes.** Every rejection is a
 *   {@link DecisionApplyError} carrying a code and a message; underlying
 *   `cause` objects (which could hold bookmark content) are never attached.
 */

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

/** `code` values on a failed apply: the store codes, the apply guards, and
 * every typed write error the underlying services can produce. */
export type DecisionApplyErrorCode =
  | DecisionStoreErrorCode
  | MutationErrorCode
  | MetaRepoErrorCode
  | TagOpsErrorCode
  /** Undo replay refusals. `conflict` never surfaces from here: it is mapped
   * onto `undo_conflict` below. */
  | Exclude<UndoFailureCode, "conflict">
  /** The decision's bookmark is gone or has moved since it was made. */
  | "stale"
  /** The decision kind has no apply path (mark_dead / rename / create_folder). */
  | "unsupported"
  /** The recorded undo snapshot is not the top of the stack. */
  | "undo_conflict"
  /** A change was made (or undone) but its row state could not be recorded. */
  | "state_unrecorded";

/** Why a decision is stale. */
export type StaleReason =
  | "bookmark_gone"
  | "bookmark_moved"
  | "bookmark_edited";

/** Rejection for every failure this module produces. */
export class DecisionApplyError extends Error {
  readonly code: DecisionApplyErrorCode;
  /** Set only for `code: "stale"`. */
  readonly staleReason?: StaleReason;

  constructor(
    code: DecisionApplyErrorCode,
    message: string,
    options?: { staleReason?: StaleReason },
  ) {
    super(message);
    this.name = "DecisionApplyError";
    this.code = code;
    if (options?.staleReason !== undefined) {
      this.staleReason = options.staleReason;
    }
  }
}

/** Map any thrown cause onto the apply error model (never copies `cause`). */
function toApplyError(cause: unknown): DecisionApplyError {
  if (cause instanceof DecisionApplyError) return cause;
  if (cause instanceof DecisionStoreError) {
    return new DecisionApplyError(cause.code, cause.message);
  }
  if (cause instanceof MutationError) {
    return new DecisionApplyError(cause.code, cause.message);
  }
  if (cause instanceof MetaRepoError) {
    return new DecisionApplyError(cause.code, cause.message);
  }
  return new DecisionApplyError(
    "api",
    cause instanceof Error ? cause.message : String(cause),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Load a row or reject `not_found`. */
async function requireRow(id: string): Promise<DecisionRow> {
  const row = await getDecision(id);
  if (row === undefined) {
    throw new DecisionApplyError(
      "not_found",
      `No decision exists for id "${id}".`,
    );
  }
  return row;
}

/** Total existence probe — `get` rejects on an unknown id. */
async function lookup(id: string): Promise<BookmarksTreeNode | undefined> {
  try {
    return (await get(id))[0];
  } catch {
    return undefined;
  }
}

/**
 * Refuse a decision whose bookmarks no longer match the snapshot the
 * request was SENT from (J05). Existence is checked for every kind; a
 * `move` also requires the recorded placement to be unchanged; an
 * `add_tags`/`set_category`/`merge_duplicates` also requires the sent
 * url/title to be unchanged — a retagged or recategorized bookmark whose
 * content shifted underneath the analysis must not be written over.
 */
async function assertFresh(row: DecisionRow): Promise<void> {
  const ids = new Set(row.bookmarkIds);
  if (row.kind === "merge_duplicates") ids.add(row.keepId);
  for (const id of ids) {
    const node = await lookup(id);
    if (node === undefined) {
      throw new DecisionApplyError(
        "stale",
        `Decision "${row.id}" is stale: bookmark "${id}" no longer exists.`,
        { staleReason: "bookmark_gone" },
      );
    }
    if (row.kind === "move") {
      const expected = row.guard?.placements[id];
      if (expected !== undefined && node.parentId !== expected) {
        throw new DecisionApplyError(
          "stale",
          `Decision "${row.id}" is stale: bookmark "${id}" moved since the ` +
            `decision was made.`,
          { staleReason: "bookmark_moved" },
        );
      }
    }
    if (
      row.kind === "add_tags" ||
      row.kind === "set_category" ||
      row.kind === "merge_duplicates"
    ) {
      const snapshot = row.guard?.snapshots?.[id];
      if (
        snapshot !== undefined &&
        ((node.url ?? "") !== snapshot.url || node.title !== snapshot.title)
      ) {
        throw new DecisionApplyError(
          "stale",
          `Decision "${row.id}" is stale: bookmark "${id}" changed since the ` +
            `decision was made.`,
          { staleReason: "bookmark_edited" },
        );
      }
    }
  }
}

/** The pre-change meta rows for `ids`, an empty row where none existed. */
async function preChangeMeta(
  ids: readonly string[],
): Promise<UndoMeta[]> {
  const unique = [...new Set(ids)];
  const existing = await getMetaByIds(unique);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const now = new Date().toISOString();
  return unique.map(
    (id) => byId.get(id) ?? { id, tags: [], updatedAt: now },
  );
}

/** Push a `delete`-kind snapshot carrying only the pre-change meta rows. */
async function pushMetaUndo(ids: readonly string[]): Promise<number> {
  const meta = await preChangeMeta(ids);
  return pushSnapshot({ kind: "delete", nodes: [], meta });
}

/**
 * Drop snapshot `snapshotId` WITHOUT replaying it — the "nothing to restore"
 * branch of compensation, for a failed single service call that rolled itself
 * back. Targets the row BY ID (`discardById`), never the stack head, so a
 * concurrent snapshot is never touched. Best-effort: never masks the original
 * failure.
 */
async function rollback(snapshotId: number): Promise<void> {
  try {
    await discardById(snapshotId);
  } catch {
    // Never mask the original failure.
  }
}

/**
 * Replay snapshot `snapshotId` to compensate a change that must be undone
 * (a partially-applied multi-op, or a mutation whose status write failed).
 * {@link undoExpected} checks that the row is still the stack head AND replays
 * that exact row inside one hold of the extension-wide undo lock, so a
 * snapshot another context pushed in the meantime can never be popped in its
 * place — the peek and the replay are one atomic step, not two. A head that
 * moved reports `conflict` (and nothing is replayed). Returns whether the
 * replay ran and succeeded; best-effort, never throws.
 */
async function compensate(snapshotId: number): Promise<boolean> {
  try {
    const result = await undoExpected(snapshotId);
    return result.ok;
  } catch {
    return false;
  }
}

async function applyTags(
  row: Extract<DecisionDocument, { kind: "add_tags" }>,
): Promise<number> {
  const snapshotId = await pushMetaUndo(row.bookmarkIds);
  let appliedAny = false;
  for (const tag of row.tags) {
    const result = await bulkAddTag(row.bookmarkIds, tag);
    if (!result.ok) {
      // A later tag failing must undo the tags already applied; if none
      // applied yet the failed call rolled itself back, so drop the snapshot.
      if (appliedAny) await compensate(snapshotId);
      else await rollback(snapshotId);
      throw new DecisionApplyError(result.code, result.message);
    }
    appliedAny = true;
  }
  return snapshotId;
}

async function applyCategory(
  row: Extract<DecisionDocument, { kind: "set_category" }>,
): Promise<number> {
  const snapshotId = await pushMetaUndo(row.bookmarkIds);
  const result = await bulkSetCategory(row.bookmarkIds, row.category);
  if (!result.ok) {
    // One transactional call — a failure leaves no net change to restore.
    await rollback(snapshotId);
    throw new DecisionApplyError(result.code, result.message);
  }
  return snapshotId;
}

async function applyMove(
  row: Extract<DecisionDocument, { kind: "move" }>,
): Promise<number> {
  const { nodes, meta } = await captureNodes(row.bookmarkIds);
  const snapshotId = await pushSnapshot({ kind: "bulk_move", nodes, meta });
  let movedAny = false;
  try {
    for (const id of row.bookmarkIds) {
      await moveNode(id, { parentId: row.targetFolderId });
      movedAny = true;
    }
  } catch (cause) {
    // Undo moves already made; a first-move failure needs no replay.
    if (movedAny) await compensate(snapshotId);
    else await rollback(snapshotId);
    throw toApplyError(cause);
  }
  return snapshotId;
}

async function applyMerge(
  row: Extract<DecisionDocument, { kind: "merge_duplicates" }>,
): Promise<number | undefined> {
  const nodes = await get([...row.bookmarkIds]);
  const items = row.bookmarkIds.map((id, index) => ({
    id,
    url: nodes[index]?.url ?? "",
  }));
  const group: DuplicateGroup = { key: row.keepId, kind: "exact", items };
  const result = await mergeGroup(group, row.keepId);
  if (!result.ok) {
    throw new DecisionApplyError(result.code, result.message);
  }
  // mergeGroup pushed its own `merge` snapshot; record it for revert.
  return (await peekLatest())?.id;
}

/** Dispatch the decision's kind to its apply path. */
async function applyAction(row: DecisionRow): Promise<number | undefined> {
  switch (row.kind) {
    case "add_tags":
      return applyTags(row);
    case "set_category":
      return applyCategory(row);
    case "move":
      return applyMove(row);
    case "merge_duplicates":
      return applyMerge(row);
    default:
      throw new DecisionApplyError(
        "unsupported",
        `Decision kind "${row.kind}" has no apply path.`,
      );
  }
}

/** Run a status transition, mapping store errors onto the apply model. */
async function transition(
  id: string,
  to: Parameters<typeof transitionStatus>[1],
  actor: AuditActor,
  undoSnapshotId?: number,
  claimToken?: string,
): Promise<DecisionRow> {
  try {
    const extra =
      undoSnapshotId === undefined && claimToken === undefined
        ? undefined
        : {
            ...(undoSnapshotId === undefined ? {} : { undoSnapshotId }),
            ...(claimToken === undefined ? {} : { claimToken }),
          };
    const { row } = await transitionStatus(id, to, actor, extra);
    return row;
  } catch (cause) {
    throw toApplyError(cause);
  }
}

// ---------------------------------------------------------------------------
// Mutual exclusion (J06)
// ---------------------------------------------------------------------------

/**
 * In-flight ops per decision id — the in-worker half of J06 mutual
 * exclusion. A second approve/reject for the same id from THIS context
 * queues behind the one already running and re-reads the row fresh when
 * its turn comes, so it either proceeds legitimately or fails
 * `illegal_transition` on the winner's committed status. Cross-context
 * calls (side panel vs. options vs. background) serialize on the persisted
 * claim instead — see {@link claimDecision}.
 */
const inflightByDecision = new Map<string, Promise<unknown>>();

/**
 * Run `run` after every earlier op for `id` in this context settles — win
 * or lose — and chain this op's completion onto the same queue. Entries
 * self-delete on settle, so the map never grows past live work.
 */
function serializeDecision<T>(
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  const prior = inflightByDecision.get(id) ?? Promise.resolve();
  const next = prior.then(run, run);
  inflightByDecision.set(id, next);
  // `then(clear, clear)` — not `.finally`, whose derived promise would carry
  // the rejection unobserved — cleans the map without touching `next`.
  void next.then(
    () => {
      if (inflightByDecision.get(id) === next) inflightByDecision.delete(id);
    },
    () => {
      if (inflightByDecision.get(id) === next) inflightByDecision.delete(id);
    },
  );
  return next;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Approve decision `id`: apply its action through the guarded services behind
 * an undo snapshot, then move the row to its target terminal status and record
 * the snapshot id. `target` defaults to `applied` (a user approval); the
 * auto-apply path passes `auto_applied` so the policy-driven terminal status
 * matches the schema and the `pending → auto_applied` legal transition. Rejects
 * `illegal_transition` for a status that cannot be moved to `target`,
 * `unsupported` for a kind with no apply path, `stale` when a bookmark is gone
 * or has moved since the decision was made, and the underlying service's typed
 * error when the mutation itself fails. No audit row is written unless the
 * transition succeeds.
 *
 * If the status/audit write fails AFTER the mutation succeeded, the mutation is
 * undone via the snapshot just pushed (targeted by id) before the typed error
 * is rethrown, so a failed status write never leaves an orphaned change. If the
 * change could not be compensated either, the error reports `state_unrecorded`.
 */
export async function approveDecision(
  id: string,
  actor: AuditActor = "user",
  target: "applied" | "auto_applied" = "applied",
): Promise<DecisionRow> {
  return serializeDecision(id, async () => {
    // J06: the conditional claim is what makes the mutation below exclusive
    // — a `claimed` refusal means another context already owns this row.
    const { row, token } = await claim(id, target);
    try {
      await assertFresh(row);
      const snapshotId = await applyAction(row);
      try {
        return await transition(id, target, actor, snapshotId, token);
      } catch (cause) {
        // The mutation succeeded but the row could not record it — undo the
        // mutation so nothing is left applied-but-untracked.
        const compensated =
          snapshotId === undefined ? true : await compensate(snapshotId);
        if (!compensated) {
          throw new DecisionApplyError(
            "state_unrecorded",
            `Decision "${id}" was applied but its status could not be ` +
              `recorded, and the change could not be compensated.`,
          );
        }
        throw toApplyError(cause);
      }
    } catch (cause) {
      // The transition clears the claim on success; every failure path must
      // release it so a crashed/refused apply never wedges the row.
      await releaseDecisionClaim(id, token).catch(() => {});
      throw cause;
    }
  });
}

/** Claim the row for `to`, mapping store errors onto the apply model. */
async function claim(
  id: string,
  to: "applied" | "auto_applied" | "rejected",
): Promise<{ row: DecisionRow; token: string }> {
  try {
    return await claimDecision(id, to);
  } catch (cause) {
    throw toApplyError(cause);
  }
}

/**
 * Reject decision `id`: record `rejected` and the matching audit row without
 * touching the tree or extension metadata. Rejects `illegal_transition` for a
 * status that cannot be rejected.
 */
export async function rejectDecision(
  id: string,
  actor: AuditActor = "user",
): Promise<DecisionRow> {
  return serializeDecision(id, async () => {
    const { token } = await claim(id, "rejected");
    try {
      return await transition(id, "rejected", actor, undefined, token);
    } catch (cause) {
      await releaseDecisionClaim(id, token).catch(() => {});
      throw cause;
    }
  });
}

/**
 * Revert decision `id`: replay the undo snapshot recorded when it was applied,
 * then record `reverted`. Rejects `illegal_transition` when the row is not in
 * an applied state, `invalid` when it has no recorded snapshot, and
 * `undo_conflict` when that snapshot is no longer the current stack head — the
 * check and the replay are one atomic step inside the extension-wide undo
 * lock, so an unrelated snapshot is never popped by mistake.
 *
 * If the row cannot be marked `reverted` after the undo popped, the revert has
 * already happened and the error reports `state_unrecorded` rather than leaving
 * the row silently inconsistent.
 */
export async function revertDecision(
  id: string,
  actor: AuditActor = "user",
): Promise<DecisionRow> {
  const row = await requireRow(id);
  if (!isLegalTransition(row.status, "reverted")) {
    throw new DecisionApplyError(
      "illegal_transition",
      `Cannot revert decision "${id}" from "${row.status}".`,
    );
  }
  const snapshotId = row.undoSnapshotId;
  if (snapshotId === undefined) {
    throw new DecisionApplyError(
      "invalid",
      `Decision "${id}" has no recorded undo snapshot to revert.`,
    );
  }
  // Atomic targeted replay: the head check and the replay happen inside one
  // hold of the extension-wide undo lock, so a snapshot another context pushes
  // in the meantime is never popped in this decision's place.
  const undone = await undoExpected(snapshotId);
  if (!undone.ok) {
    if (undone.code === "conflict") {
      throw new DecisionApplyError(
        "undo_conflict",
        `The undo snapshot for decision "${id}" is not the top of the stack.`,
      );
    }
    throw new DecisionApplyError(undone.code, undone.message);
  }
  try {
    return await transition(id, "reverted", actor);
  } catch (cause) {
    // The undo already ran — the change is reverted but the row could not be
    // marked so. Surface a typed error instead of leaving it inconsistent.
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new DecisionApplyError(
      "state_unrecorded",
      `Decision "${id}" was reverted but its status could not be recorded` +
        `${detail}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bulk approve
// ---------------------------------------------------------------------------

/** One row that could not be approved, with the reason. */
export interface BulkApproveFailure {
  id: string;
  code: DecisionApplyErrorCode;
  message: string;
}

/** Bulk-approve outcome: the rows applied and the rows that failed. */
export interface BulkApproveResult {
  ok: true;
  applied: DecisionRow[];
  failed: BulkApproveFailure[];
}

/**
 * Approve each id in turn, per-row atomic: a failure on one row (a stale
 * decision, an illegal transition, a mutation error) is captured in `failed`
 * and never prevents the others from applying. Duplicate ids collapse; the
 * result is always `ok: true` — inspect `failed` for per-row errors.
 */
export async function bulkApprove(
  ids: readonly string[],
  actor: AuditActor = "user",
): Promise<BulkApproveResult> {
  const applied: DecisionRow[] = [];
  const failed: BulkApproveFailure[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      applied.push(await approveDecision(id, actor));
    } catch (cause) {
      const error = toApplyError(cause);
      failed.push({ id, code: error.code, message: error.message });
    }
  }
  return { ok: true, applied, failed };
}
