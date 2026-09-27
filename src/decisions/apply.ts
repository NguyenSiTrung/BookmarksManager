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
import { undoLatest } from "../undo/restore";
import type { UndoFailureCode } from "../undo/restore";
import { captureNodes, peekLatest, pushSnapshot } from "../undo/snapshot";
import type { UndoMeta } from "../schemas/undo";
import {
  DecisionStoreError,
  getDecision,
  isLegalTransition,
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
 *   refused `unsupported` — the spec's FR6 apply paths name only the former
 *   four, and the undo stack has no replay kind for a rename/create/mark.
 * - **Meta undo via the `delete` kind.** The undo system has no dedicated
 *   "metadata changed" snapshot; the `delete`/`merge` replay writes every
 *   `meta` row whose id is NOT in `nodes` back onto its surviving bookmark
 *   (that is how a merge restores the kept row). A tag/category apply pushes
 *   `{ kind: "delete", nodes: [], meta: <pre-change rows> }`: replay restores
 *   the pre-change rows, and an id that had no row gets an empty row that the
 *   lazy-row rule deletes again. Moves use `bulk_move`; merges rely on
 *   `mergeGroup`'s own `merge` snapshot.
 * - **Stale decisions are refused.** Before any mutation the live tree is
 *   re-read and compared against the row's persisted `guard`: a bookmark that
 *   no longer exists is `stale`/`bookmark_gone`; for a `move`, one whose
 *   `parentId` changed since the decision was made is `stale`/`bookmark_moved`.
 *   Nothing is written and no audit row is added.
 * - **Revert targets its own snapshot.** A revert only runs when the row's
 *   recorded `undoSnapshotId` is the current stack head; otherwise it reports
 *   `undo_conflict` rather than blindly popping an unrelated snapshot. A
 *   failed apply best-effort reverts the partial change before rethrowing.
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
  | UndoFailureCode
  /** The decision's bookmark is gone or has moved since it was made. */
  | "stale"
  /** The decision kind has no apply path (mark_dead / rename / create_folder). */
  | "unsupported"
  /** The recorded undo snapshot is not the top of the stack. */
  | "undo_conflict";

/** Why a decision is stale. */
export type StaleReason = "bookmark_gone" | "bookmark_moved";

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
 * Refuse a decision whose bookmarks no longer match the state captured when
 * it was persisted. Existence is checked for every kind; a `move` also
 * requires the recorded placement to be unchanged.
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

/** Best-effort rollback of a partially-applied change via the undo stack. */
async function rollback(): Promise<void> {
  try {
    await undoLatest();
  } catch {
    // Never mask the original failure.
  }
}

async function applyTags(
  row: Extract<DecisionDocument, { kind: "add_tags" }>,
): Promise<number> {
  const snapshotId = await pushMetaUndo(row.bookmarkIds);
  for (const tag of row.tags) {
    const result = await bulkAddTag(row.bookmarkIds, tag);
    if (!result.ok) {
      await rollback();
      throw new DecisionApplyError(result.code, result.message);
    }
  }
  return snapshotId;
}

async function applyCategory(
  row: Extract<DecisionDocument, { kind: "set_category" }>,
): Promise<number> {
  const snapshotId = await pushMetaUndo(row.bookmarkIds);
  const result = await bulkSetCategory(row.bookmarkIds, row.category);
  if (!result.ok) {
    await rollback();
    throw new DecisionApplyError(result.code, result.message);
  }
  return snapshotId;
}

async function applyMove(
  row: Extract<DecisionDocument, { kind: "move" }>,
): Promise<number> {
  const { nodes, meta } = await captureNodes(row.bookmarkIds);
  const snapshotId = await pushSnapshot({ kind: "bulk_move", nodes, meta });
  try {
    for (const id of row.bookmarkIds) {
      await moveNode(id, { parentId: row.targetFolderId });
    }
  } catch (cause) {
    await rollback();
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
): Promise<DecisionRow> {
  try {
    const extra =
      undoSnapshotId === undefined ? undefined : { undoSnapshotId };
    const { row } = await transitionStatus(id, to, actor, extra);
    return row;
  } catch (cause) {
    throw toApplyError(cause);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Approve decision `id`: apply its action through the guarded services behind
 * an undo snapshot, then move the row to `applied` and record the snapshot id.
 * Rejects `illegal_transition` for a status that cannot be applied,
 * `unsupported` for a kind with no apply path, `stale` when a bookmark is gone
 * or has moved since the decision was made, and the underlying service's typed
 * error when the mutation itself fails. No audit row is written unless the
 * transition succeeds.
 */
export async function approveDecision(
  id: string,
  actor: AuditActor = "user",
): Promise<DecisionRow> {
  const row = await requireRow(id);
  if (!isLegalTransition(row.status, "applied")) {
    throw new DecisionApplyError(
      "illegal_transition",
      `Cannot approve decision "${id}" from "${row.status}".`,
    );
  }
  await assertFresh(row);
  const snapshotId = await applyAction(row);
  return transition(id, "applied", actor, snapshotId);
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
  const row = await requireRow(id);
  if (!isLegalTransition(row.status, "rejected")) {
    throw new DecisionApplyError(
      "illegal_transition",
      `Cannot reject decision "${id}" from "${row.status}".`,
    );
  }
  return transition(id, "rejected", actor);
}

/**
 * Revert decision `id`: replay the undo snapshot recorded when it was applied,
 * then record `reverted`. Rejects `illegal_transition` when the row is not in
 * an applied state, `invalid` when it has no recorded snapshot, and
 * `undo_conflict` when that snapshot is not the current stack head (so an
 * unrelated snapshot is never popped by mistake).
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
  const head = await peekLatest();
  if (head?.id !== snapshotId) {
    throw new DecisionApplyError(
      "undo_conflict",
      `The undo snapshot for decision "${id}" is not the top of the stack.`,
    );
  }
  const undone = await undoLatest();
  if (!undone.ok) {
    throw new DecisionApplyError(undone.code, undone.message);
  }
  return transition(id, "reverted", actor);
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
