import { z } from "../schemas/z";
import { db } from "../db/database";
import { AuditEvent } from "../schemas/audit";
import type { AuditActor, DecisionStatus } from "../schemas/audit";
import { Decision } from "../schemas/decision";
import type { Decision as DecisionDocument } from "../schemas/decision";
import { get } from "../sync/chrome-bookmarks";

/**
 * Persistence and status bookkeeping for review decisions (spec FR6,
 * PROJECT_PLAN.md §7). This module owns the `decisions` and `audit` tables:
 * it stores the §7 `Decision` rows, answers the review-queue queries, and
 * exposes the ONE transactional primitive that moves a decision between
 * statuses and appends the matching audit row. The mutation half — approve,
 * reject, revert, bulk approve, with undo snapshots — lives in
 * `src/decisions/apply.ts` and calls {@link transitionStatus}.
 *
 * Design rules (locked by tests/unit/decisions-store.test.ts):
 *
 * - **The row is the §7 schema.** `persistDecision` validates the incoming
 *   document with `Decision` and stores those fields verbatim; `source.model`
 *   and `source.questionSetVersion` come from the caller (the store never
 *   calls Jev). Invalid documents reject `invalid` and nothing is written.
 * - **Additive staleness guard.** Alongside the §7 fields each row carries a
 *   local `guard` sidecar: the placement (`parentId`) of every bookmark id
 *   observed when the decision was persisted. `apply.ts` compares it against
 *   the live tree to refuse a stale decision. The guard is not part of the
 *   wire/decision schema — it is local, derived state, and holds only Chrome
 *   node ids (no title, url, or tags).
 * - **Additive undo pointer.** A row that has been applied carries the
 *   `undoSnapshotId` pushed by `apply.ts`, so a revert targets the snapshot
 *   THIS decision created rather than the stack head ("discard by row id,
 *   never latest").
 * - **Transition + audit are one transaction.** {@link transitionStatus}
 *   reads the row, checks the transition against {@link isLegalTransition},
 *   writes the new status, and appends exactly one content-free `AuditEvent`
 *   inside a single `rw` transaction over `decisions` + `audit`. A refused
 *   transition writes nothing.
 * - **Content-free audit.** An `audit` row is the `AuditEvent` shape and
 *   nothing else: decision id, from, to, actor, timestamp. It never carries a
 *   title, url, folder, tag, or note.
 * - Reads re-derive nothing: `getDecision`/`listDecisions`/`listPending`/
 *   `listByStatus` return the stored rows (with their sidecars) as-is.
 */

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type DecisionStoreErrorCode =
  /** The document violates the §7 `Decision` schema. */
  | "invalid"
  /** The decision id does not exist. */
  | "not_found"
  /** The requested status change is not allowed from the current status. */
  | "illegal_transition"
  /** Unexpected storage-level failure (Dexie / IndexedDB). */
  | "api";

/** Rejection for every failure this module produces. */
export class DecisionStoreError extends Error {
  readonly code: DecisionStoreErrorCode;

  constructor(
    code: DecisionStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DecisionStoreError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * Placement of every bookmark id observed when a decision was persisted.
 * `placements[id]` is the Chrome `parentId`; an id absent from the map had
 * already vanished when the decision was stored. Local, derived state — no
 * bookmark content.
 */
export interface DecisionGuard {
  placements: Record<string, string>;
}

/**
 * A persisted decision row: the §7 `Decision` fields plus the additive local
 * sidecars this module and `apply.ts` maintain. Consumers that only need the
 * decision itself can treat it as a `Decision` (the extra keys are ignored by
 * the schema, which strips unknown keys on parse).
 */
export type DecisionRow = DecisionDocument & {
  guard?: DecisionGuard;
  /** Undo row pushed when this decision was applied — the revert target. */
  undoSnapshotId?: number;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Best-effort placement capture for `bookmarkIds`. A bookmark that no longer
 * resolves (or an API failure) simply contributes no placement — that absence
 * is itself the "gone" signal `apply.ts` acts on.
 */
async function captureGuard(
  bookmarkIds: readonly string[],
): Promise<DecisionGuard> {
  const placements: Record<string, string> = {};
  for (const id of [...new Set(bookmarkIds)]) {
    try {
      const node = (await get(id))[0];
      if (node?.parentId !== undefined) placements[id] = node.parentId;
    } catch {
      // Unknown id / lookup failure — leave it unplaced.
    }
  }
  return { placements };
}

/**
 * Validate `document` against the §7 `Decision` schema, capture its
 * decision-time placement guard, and upsert the row (keyed by `id`). Rejects
 * `invalid` for a schema violation and `api` for a storage failure; nothing
 * is written in either case.
 */
export async function persistDecision(
  document: DecisionDocument,
): Promise<DecisionRow> {
  const parsed = Decision.safeParse(document);
  if (!parsed.success) {
    throw new DecisionStoreError(
      "invalid",
      `decision failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid document"}`,
    );
  }
  const guard = await captureGuard(parsed.data.bookmarkIds);
  const row: DecisionRow = { ...parsed.data, guard };
  try {
    await db.transaction("rw", db.decisions, async () => {
      await db.decisions.put(row);
    });
  } catch (cause) {
    throw new DecisionStoreError(
      "api",
      `failed to persist decision "${row.id}"`,
      { cause },
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Rationale persistence (spec FR5.4)
// ---------------------------------------------------------------------------

const Rationale = z.string().min(1).max(1_000);

/**
 * Set the §7 `rationale` field on an existing decision — the one field a row
 * may gain after persistence. Updates ONLY `rationale`: the status, every
 * `kind` payload field, and both sidecars (`guard`, `undoSnapshotId`) are
 * preserved verbatim, and NO audit row is appended (an explanation is not a
 * status transition). Rejects `invalid` for an empty/over-1,000-char
 * rationale and `not_found` for an unknown id; nothing is written in either
 * case.
 */
export async function persistDecisionRationale(
  id: string,
  rationale: string,
): Promise<DecisionRow> {
  const parsed = Rationale.safeParse(rationale);
  if (!parsed.success) {
    throw new DecisionStoreError(
      "invalid",
      "rationale must be 1–1,000 characters",
    );
  }
  return db.transaction("rw", db.decisions, async () => {
    const raw = await db.decisions.get(id);
    if (raw === undefined) {
      throw new DecisionStoreError(
        "not_found",
        `No decision exists for id "${id}".`,
      );
    }
    const row = raw as DecisionRow;
    const updated: DecisionRow = { ...row, rationale: parsed.data };
    await db.decisions.put(updated);
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** One decision row by id, or `undefined` when absent. */
export async function getDecision(
  id: string,
): Promise<DecisionRow | undefined> {
  return (await db.decisions.get(id)) as DecisionRow | undefined;
}

/** Every decision row, oldest-first by the indexed `createdAt`. */
export async function listDecisions(): Promise<DecisionRow[]> {
  const rows = await db.decisions.orderBy("createdAt").toArray();
  return rows as DecisionRow[];
}

/** Every decision row currently in `status`, via the `status` index. */
export async function listByStatus(
  status: DecisionStatus,
): Promise<DecisionRow[]> {
  const rows = await db.decisions.where("status").equals(status).toArray();
  return rows as DecisionRow[];
}

/** The review queue: decisions still awaiting a user action. */
export async function listPending(): Promise<DecisionRow[]> {
  return listByStatus("pending");
}

// ---------------------------------------------------------------------------
// Status transitions + audit
// ---------------------------------------------------------------------------

/**
 * The legal status changes, by current status. `approved` is a reviewable
 * state (a decision an upstream flow pre-approved) that this module can still
 * apply or reject; `rejected` and `reverted` are terminal. A self-transition
 * is never legal. Mirrored by {@link isLegalTransition} and pinned in the
 * store test.
 */
const LEGAL_TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  pending: ["applied", "rejected", "auto_applied"],
  unsure: ["applied", "rejected", "auto_applied"],
  approved: ["applied", "rejected", "auto_applied"],
  auto_applied: ["applied", "rejected", "reverted"],
  applied: ["reverted"],
  rejected: [],
  reverted: [],
};

/** True when a decision may move from `from` to `to`. */
export function isLegalTransition(
  from: DecisionStatus,
  to: DecisionStatus,
): boolean {
  return from !== to && LEGAL_TRANSITIONS[from].includes(to);
}

/** Extra row fields a transition may set alongside the new status. */
export interface TransitionExtra {
  /** Undo row pushed by the apply path — the revert target. */
  undoSnapshotId?: number;
}

/**
 * Move decision `id` from its current status to `to`, appending exactly one
 * content-free audit row, all inside one `rw` transaction over `decisions` +
 * `audit`. Rejects `not_found` for an unknown id and `illegal_transition`
 * (writing nothing) when the move is not allowed. Returns the updated row and
 * the audit row that was written.
 */
export async function transitionStatus(
  id: string,
  to: DecisionStatus,
  actor: AuditActor,
  extra?: TransitionExtra,
): Promise<{ row: DecisionRow; audit: AuditEvent }> {
  return db.transaction("rw", db.decisions, db.audit, async () => {
    const raw = await db.decisions.get(id);
    if (raw === undefined) {
      throw new DecisionStoreError(
        "not_found",
        `No decision exists for id "${id}".`,
      );
    }
    const row = raw as DecisionRow;
    if (!isLegalTransition(row.status, to)) {
      throw new DecisionStoreError(
        "illegal_transition",
        `Cannot move decision "${id}" from "${row.status}" to "${to}".`,
      );
    }
    const updated: DecisionRow = { ...row, status: to };
    if (extra?.undoSnapshotId !== undefined) {
      updated.undoSnapshotId = extra.undoSnapshotId;
    }
    await db.decisions.put(updated);
    const audit = AuditEvent.parse({
      decisionId: id,
      from: row.status,
      to,
      actor,
      changedAt: new Date().toISOString(),
    });
    await db.audit.add(audit);
    return { row: updated, audit };
  });
}
