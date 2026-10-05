import { z } from "../schemas/z";
import { db } from "../db/database";
import {
  pruneAuditLocked,
  pruneTerminalDecisionsLocked,
} from "../db/retention";
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
 *   local `guard` sidecar: the placement (`parentId`) and the sent `{url,
 *   title}` snapshot of every bookmark id, captured from the state the
 *   request was built from (spec J05). `apply.ts` compares it against the
 *   live tree to refuse a stale decision. The guard is not part of the
 *   wire/decision schema — it is local, derived state.
 * - **Idempotent persistence (J04).** A caller-derived deterministic id —
 *   one per `(jobId, bookmarkIds, kind)` — makes a replayed batch upsert the
 *   same row instead of inserting a duplicate. Persisting also supersedes
 *   every other still-undecided (`pending`/`unsure`) row for the same
 *   bookmark set and kind, whatever job produced it; a decided row
 *   (`approved`, `applied`, `auto_applied`, `rejected`, `reverted`) is final
 *   and returned unchanged instead of being overwritten.
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
 * The send-time bookmark state a decision's freshness is checked against
 * (J05). `placements[id]` is the Chrome `parentId` read when the request
 * was built; an id absent from the map had no parent to capture.
 * `snapshots[id]` carries the RAW `{url, title}` read at send time — never
 * the minimized wire form (its cleaned url drops query/hash, which would
 * false-stale an unchanged bookmark). Local, derived state.
 */
export interface DecisionGuard {
  placements: Record<string, string>;
  snapshots?: Record<string, { url: string; title: string }>;
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
// Deterministic id (J04)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/**
 * The J04 idempotency key: one decision row per `(jobId, bookmarkIds,
 * kind)` — a SHA-256 of the tuple rendered as a version-5-style UUID, so a
 * replayed batch upserts the same row instead of inserting a second one.
 * `jobId` absent (interactive analysis) collapses to `""`, making repeated
 * manual analysis of the same bookmark land on the same slot. Bookmark ids
 * are sorted so a merge pair is orientation-free.
 */
export async function decisionIdFor(input: {
  readonly jobId?: string;
  readonly bookmarkIds: readonly string[];
  readonly kind: Decision["kind"];
}): Promise<string> {
  const sortedIds = [...input.bookmarkIds].sort().join("\u0000");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${input.jobId ?? ""}\u0000${sortedIds}\u0000${input.kind}`),
  );
  const bytes = new Uint8Array(digest.slice(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 (name-based)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Statuses a re-analysis may supersede — rows nobody has decided yet. */
const UNDECIDED_STATUSES: readonly DecisionStatus[] = ["pending", "unsure"];

/** Statuses that count as "a decision was made" — final for the slot. */
const DECIDED_STATUSES: readonly DecisionStatus[] = [
  "approved",
  "applied",
  "auto_applied",
  "rejected",
  "reverted",
];

/**
 * Whether a DECIDED row already occupies `(bookmarkIds, kind)` — the J04
 * resurrection fence. A superseded row can be re-created by a replayed
 * batch (its deterministic id is re-derived), so the auto-apply seam must
 * check for an already-decided same-slot row rather than trusting that the
 * pending row it just wrote is the slot's only outcome. `excludeId` skips
 * the row under inspection itself.
 */
export async function hasDecidedSlotRow(
  bookmarkIds: readonly string[],
  kind: DecisionDocument["kind"],
  excludeId?: string,
): Promise<boolean> {
  const decided = await db.decisions
    .where("status")
    .anyOf(DECIDED_STATUSES)
    .toArray();
  return decided.some(
    (row) =>
      row.id !== excludeId &&
      row.kind === kind &&
      sameBookmarkSet(row.bookmarkIds, bookmarkIds),
  );
}

/** The sorted-ids slot two decisions share ("same bookmark" for J04). */
function sameBookmarkSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.length === sortedB.length &&
    sortedA.every((id, index) => id === sortedB[index]);
}

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
 * Validate `document` against the §7 `Decision` schema and upsert the row
 * (keyed by `id`) behind the J04 rules: a same-id row that is already
 * decided is returned unchanged — a replayed batch reuses its outcome
 * rather than clobbering `status`/`undoSnapshotId`; every OTHER undecided
 * (`pending`/`unsure`) row for the same bookmark set and kind is deleted
 * first — re-analysis supersedes it whatever job produced it. `guard` is
 * the send-time snapshot the caller captured (J05); absent, the
 * decision-time placement is read live — the fallback for non-send callers.
 * Rejects `invalid` for a schema violation and `api` for a storage failure;
 * nothing is written in either case.
 */
export async function persistDecision(
  document: DecisionDocument,
  options?: { guard?: DecisionGuard },
): Promise<DecisionRow> {
  const parsed = Decision.safeParse(document);
  if (!parsed.success) {
    throw new DecisionStoreError(
      "invalid",
      `decision failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid document"}`,
    );
  }
  const guard = options?.guard ?? (await captureGuard(parsed.data.bookmarkIds));
  const row: DecisionRow = { ...parsed.data, guard };
  try {
    return await db.transaction("rw", db.decisions, async () => {
      const existing = await db.decisions.get(row.id);
      if (
        existing !== undefined &&
        !UNDECIDED_STATUSES.includes((existing as DecisionRow).status)
      ) {
        // A decided row is final: a replay of work whose outcome already
        // landed must not erase the status or its revert target.
        return existing as DecisionRow;
      }
      // Supersession is a re-analysis concern: only an undecided row being
      // stored clears the older undecided rows for its slot. (Production
      // rows are always pending/unsure here — a decided row goes through
      // transitionStatus, never a fresh persist.)
      if (UNDECIDED_STATUSES.includes(row.status)) {
        const undecided = await db.decisions
          .where("status")
          .anyOf(UNDECIDED_STATUSES)
          .toArray();
        const superseded = undecided.filter(
          (other) =>
            other.id !== row.id &&
            other.kind === row.kind &&
            sameBookmarkSet(other.bookmarkIds, row.bookmarkIds),
        );
        if (superseded.length > 0) {
          await db.decisions.bulkDelete(superseded.map((other) => other.id));
        }
      }
      await db.decisions.put(row);
      return row;
    });
  } catch (cause) {
    if (cause instanceof DecisionStoreError) throw cause;
    throw new DecisionStoreError(
      "api",
      `failed to persist decision "${row.id}"`,
      { cause },
    );
  }
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

/**
 * The full review surface: `pending` rows plus `unsure` ones — unsure rows
 * carry the LLM second-opinion verdicts and remain user-reviewable (they
 * can still reach `applied`/`rejected`). Oldest-first by `createdAt`.
 */
export async function listReviewable(): Promise<DecisionRow[]> {
  const [pending, unsure] = await Promise.all([
    listByStatus("pending"),
    listByStatus("unsure"),
  ]);
  return [...pending, ...unsure].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

// ---------------------------------------------------------------------------
// Synthetic popup retention (improvement I05)
// ---------------------------------------------------------------------------

/** Prefix marking a save-suggest reference as synthetic (no Chrome node). */
const POPUP_ID_PREFIX = "popup:";

/**
 * Upper bound on retained synthetic popup save-suggest rows. The popup writes
 * one or more `popup:<uuid>` rows on every SAVE_SUGGEST; nothing can ever apply
 * them (the guarded apply refuses a synthetic id), so without a bound they
 * accumulate for the life of the profile. See {@link prunePopupDecisions}.
 */
export const POPUP_DECISION_LIMIT = 300;

/**
 * Statuses a synthetic popup row may be pruned from. The save-suggest flow
 * forces every auto-apply toggle off, so synthetic rows only ever land
 * `pending` or `unsure`; every other status is treated as user/audit
 * significant and preserved.
 */
const PRUNABLE_POPUP_STATUSES: ReadonlySet<DecisionStatus> = new Set([
  "pending",
  "unsure",
]);

/** True when every reference is a synthetic `popup:` id (and there is one). */
function isSyntheticPopupRow(row: DecisionRow): boolean {
  return (
    row.bookmarkIds.length > 0 &&
    row.bookmarkIds.every((id) => id.startsWith(POPUP_ID_PREFIX))
  );
}

/**
 * Bound the synthetic popup save-suggest backlog to {@link POPUP_DECISION_LIMIT}
 * rows. Deletes only the oldest ELIGIBLE rows — whose references are ALL
 * synthetic `popup:` ids AND whose status is `pending`/`unsure` — beyond the
 * limit, oldest-first by `createdAt` with ties broken ascending by decision id
 * (so a sweep is fully deterministic). The read/decide/delete runs inside one
 * `rw` transaction over `decisions`, so swallowed/legacy backlogs are reaped
 * atomically and concurrent popup opens never see a half-swept table. Returns
 * the number of rows removed.
 *
 * Never touched: real or mixed-reference rows, any row whose status is
 * `approved`/`auto_applied`/`applied`/`rejected`/`reverted`, and the
 * `audit`/`undo` tables entirely.
 */
export async function prunePopupDecisions(): Promise<number> {
  return db.transaction("rw", db.decisions, async () => {
    // A08: only `pending`/`unsure` rows can ever be prunable, so read them
    // through the `status` index instead of materializing the whole table.
    const rows = (await db.decisions
      .where("status")
      .anyOf("pending", "unsure")
      .toArray()) as DecisionRow[];
    const eligible = rows.filter(
      (row) =>
        isSyntheticPopupRow(row) && PRUNABLE_POPUP_STATUSES.has(row.status),
    );
    // Non-popup terminal rows (rejected/reverted) share this sweep's
    // cadence — cap them inside the same transaction.
    await pruneTerminalDecisionsLocked();
    if (eligible.length <= POPUP_DECISION_LIMIT) return 0;
    eligible.sort((a, b) => {
      const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
      return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
    });
    const victims = eligible.slice(0, eligible.length - POPUP_DECISION_LIMIT);
    await db.decisions.bulkDelete(victims.map((row) => row.id));
    return victims.length;
  });
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
    // A08: keep the decision-audit log bounded — oldest-first, in-transaction.
    await pruneAuditLocked();
    return { row: updated, audit };
  });
}
