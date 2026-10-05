import { db } from "./database";
import { utcMonthOf } from "../llm/budget";
import type {
  LlmUsageMonthRollup,
  LlmUsageRecord,
  UsageMonthRollup,
  UsageRecord,
} from "../schemas/usage";

/**
 * Retention and monthly compaction (spec A08). Every bounded table obeys the
 * same discipline the `sentLog` trim established: the write and its prune
 * share one transaction, reads go through an index, and the sweep never
 * materializes the table — the worst case is bounded by the cap itself plus
 * whatever accumulated since the last write.
 *
 * - `usage`/`llmUsage` rows materialize `month` at write time; each write
 *   compacts EXPIRED months into `usageMonths`/`llmUsageMonths` rollup rows
 *   (`recordedAt`-indexed range read; current-month rows are never folded,
 *   so an in-flight job or a mid-send settle always sees raw detail).
 * - The budget transaction reads only `[providerId+month] = [pid, current]` —
 *   the compound index makes the "current month" lookup an index hit.
 * - Settled/released `llmReservations` outside the current month are pruned
 *   on write (`month`-indexed range); `active` rows are never reaped — the
 *   startup sweep owns them.
 * - `audit`, `jobs` (terminal rows only), and non-popup `decisions`
 *   (terminal rows only) are capped by count, oldest-first.
 */

/** Rows the decision-audit log keeps (bounded like the sent log). */
export const AUDIT_RETENTION_CAP = 1000;
/** Terminal job rows retained for resume/history display. */
export const JOB_RETENTION_CAP = 200;
/** Terminal (rejected/reverted) non-popup decision rows retained. */
export const DECISION_TERMINAL_RETENTION_CAP = 2000;

const TERMINAL_JOB_STATUSES = ["completed", "failed", "canceled"] as const;
const TERMINAL_DECISION_STATUSES = ["rejected", "reverted"] as const;

/** UTC `YYYY-MM` of an ISO timestamp (NaN input → "NaN-NaN", never matches). */
export function monthOfIso(recordedAt: string): string {
  return utcMonthOf(new Date(recordedAt));
}

/** Inclusive-exclusive lower bound for "rows older than `month`". */
function monthStartIso(month: string): string {
  return `${month}-01T00:00:00.000Z`;
}

/**
 * Fold every `usage` row recorded before `currentMonth` into its
 * (jobId, month) rollup and delete the raw rows. MUST run inside a `rw`
 * transaction covering `usage` + `usageMonths`; the range read goes through
 * the `recordedAt` index, so the steady-state cost is one empty scan.
 */
export async function compactUsageMonthsLocked(
  currentMonth: string,
): Promise<number> {
  const expired = await db.usage
    .where("recordedAt")
    .below(monthStartIso(currentMonth))
    .toArray();
  if (expired.length === 0) return 0;

  const groups = new Map<string, UsageMonthRollup>();
  for (const row of expired) {
    const month = row.month ?? monthOfIso(row.recordedAt);
    const key = `${row.jobId ?? ""}|${month}`;
    let roll = groups.get(key);
    if (roll === undefined) {
      roll = {
        key,
        month,
        ...(row.jobId === undefined ? {} : { jobId: row.jobId }),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        unpricedRequests: 0,
      };
      groups.set(key, roll);
    }
    roll.requests += 1;
    roll.inputTokens += row.inputTokens;
    roll.outputTokens += row.outputTokens;
    if (row.costUsd !== undefined) {
      roll.costUsd = (roll.costUsd ?? 0) + row.costUsd;
    } else {
      roll.unpricedRequests += 1;
    }
  }
  for (const partial of groups.values()) {
    const existing = await db.usageMonths.get(partial.key);
    const merged: UsageMonthRollup =
      existing === undefined
        ? partial
        : {
            ...partial,
            requests: existing.requests + partial.requests,
            inputTokens: existing.inputTokens + partial.inputTokens,
            outputTokens: existing.outputTokens + partial.outputTokens,
            ...(existing.costUsd !== undefined || partial.costUsd !== undefined
              ? { costUsd: (existing.costUsd ?? 0) + (partial.costUsd ?? 0) }
              : {}),
            unpricedRequests:
              existing.unpricedRequests + partial.unpricedRequests,
          };
    await db.usageMonths.put(merged);
  }
  await db.usage.bulkDelete(
    expired
      .map((row) => row.id)
      .filter((id): id is number => id !== undefined),
  );
  return expired.length;
}

/**
 * Fold every `llmUsage` row recorded before `currentMonth` into its
 * (providerId, month) rollup and delete the raw rows. Mirrors
 * `monthlyBudgetSnapshot`'s cost classification — provider-reported,
 * locally estimated, or unknown — except `notBilled` rows, which the
 * snapshot reports as unknown-cost: they roll into `notBilledRequests`
 * instead so the provably-unsent distinction survives (a snapshot-mirror
 * read over rollups is `unknownCostRequests + notBilledRequests`). MUST
 * run inside a `rw` transaction covering `llmUsage` + `llmUsageMonths`.
 */
export async function compactLlmUsageMonthsLocked(
  currentMonth: string,
): Promise<number> {
  const expired = await db.llmUsage
    .where("recordedAt")
    .below(monthStartIso(currentMonth))
    .toArray();
  if (expired.length === 0) return 0;

  const groups = new Map<string, LlmUsageMonthRollup>();
  for (const row of expired) {
    const month = row.month ?? monthOfIso(row.recordedAt);
    const key = `${row.providerId}|${month}`;
    let roll = groups.get(key);
    if (roll === undefined) {
      roll = {
        key,
        providerId: row.providerId,
        month,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        reportedCostUsd: 0,
        estimatedCostUsd: 0,
        unknownCostRequests: 0,
        notBilledRequests: 0,
      };
      groups.set(key, roll);
    }
    roll.requests += 1;
    roll.inputTokens += row.inputTokens;
    roll.outputTokens += row.outputTokens;
    if (row.notBilled === true) {
      roll.notBilledRequests += 1;
      continue;
    }
    if (row.costUsd !== undefined) {
      roll.reportedCostUsd += row.costUsd;
    } else if (row.estimatedCostUsd !== undefined) {
      roll.estimatedCostUsd += row.estimatedCostUsd;
    } else {
      roll.unknownCostRequests += 1;
    }
  }
  for (const partial of groups.values()) {
    const existing = await db.llmUsageMonths.get(partial.key);
    const merged: LlmUsageMonthRollup =
      existing === undefined
        ? partial
        : {
            ...partial,
            requests: existing.requests + partial.requests,
            inputTokens: existing.inputTokens + partial.inputTokens,
            outputTokens: existing.outputTokens + partial.outputTokens,
            reportedCostUsd:
              existing.reportedCostUsd + partial.reportedCostUsd,
            estimatedCostUsd:
              existing.estimatedCostUsd + partial.estimatedCostUsd,
            unknownCostRequests:
              existing.unknownCostRequests + partial.unknownCostRequests,
            notBilledRequests:
              existing.notBilledRequests + partial.notBilledRequests,
          };
    await db.llmUsageMonths.put(merged);
  }
  await db.llmUsage.bulkDelete(
    expired
      .map((row) => row.id)
      .filter((id): id is number => id !== undefined),
  );
  return expired.length;
}

/**
 * Append one `usage` row — `month` materialized — then compact expired
 * months, all inside one `rw` transaction. This is the ONLY sanctioned
 * write path for `db.usage` (A08); call it instead of `db.usage.add`.
 */
export async function appendUsage(
  record: Omit<UsageRecord, "id">,
  now: () => Date = () => new Date(),
): Promise<number> {
  return db.transaction("rw", db.usage, db.usageMonths, async () => {
    const month = monthOfIso(record.recordedAt);
    const id = await db.usage.add({ ...record, month });
    await compactUsageMonthsLocked(utcMonthOf(now()));
    return id;
  });
}

/**
 * Append one `llmUsage` row — `month` materialized — then compact expired
 * months, inside one `rw` transaction (A08). Replaces `db.llmUsage.add`.
 */
export async function appendLlmUsage(
  record: Omit<LlmUsageRecord, "id">,
  now: () => Date = () => new Date(),
): Promise<number> {
  return db.transaction("rw", db.llmUsage, db.llmUsageMonths, async () => {
    const month = monthOfIso(record.recordedAt);
    const id = await db.llmUsage.add({ ...record, month });
    await compactLlmUsageMonthsLocked(utcMonthOf(now()));
    return id;
  });
}

/**
 * Delete settled/released reservations whose `month` predates
 * `currentMonth` — the cap window only ever consults the current month.
 * `active` rows are never touched (the startup sweep owns orphans). MUST
 * run inside a `rw` transaction covering `llmReservations`.
 */
export async function pruneExpiredReservationsLocked(
  currentMonth: string,
): Promise<number> {
  return db.llmReservations
    .where("month")
    .below(currentMonth)
    .and(
      (row) => row.status === "settled" || row.status === "released",
    )
    .delete();
}

/**
 * Keep at most {@link JOB_RETENTION_CAP} TERMINAL job rows — oldest-first
 * by `createdAt`, id tiebreak for determinism. Non-terminal rows are never
 * reaped (a live job is unprunable state, not garbage). A victim job's
 * `restructureAssignments` rows are deleted in the same transaction — a
 * pruned job must not leave committed assignments orphaned (J13). MUST run
 * inside a `rw` transaction covering `jobs` and `restructureAssignments`.
 */
export async function pruneTerminalJobsLocked(): Promise<number> {
  const terminal = await db.jobs
    .where("status")
    .anyOf(...TERMINAL_JOB_STATUSES)
    .toArray();
  if (terminal.length <= JOB_RETENTION_CAP) return 0;
  terminal.sort((a, b) => {
    const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
    return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
  });
  const victims = terminal.slice(0, terminal.length - JOB_RETENTION_CAP);
  const victimIds = victims.map((row) => row.id);
  await db.restructureAssignments.where("jobId").anyOf(victimIds).delete();
  await db.jobs.bulkDelete(victimIds);
  return victims.length;
}

/**
 * Keep at most {@link AUDIT_RETENTION_CAP} audit rows — the `++id` index
 * hands back the oldest `excess` primary keys without materializing rows
 * (the same trim idiom as `appendSentLog`). MUST run inside a `rw`
 * transaction covering `audit`.
 */
export async function pruneAuditLocked(): Promise<number> {
  const excess = (await db.audit.count()) - AUDIT_RETENTION_CAP;
  if (excess <= 0) return 0;
  const oldestKeys = await db.audit
    .orderBy(":id")
    .limit(excess)
    .primaryKeys();
  await db.audit.bulkDelete(oldestKeys);
  return oldestKeys.length;
}

/**
 * Keep at most {@link DECISION_TERMINAL_RETENTION_CAP} non-popup terminal
 * (`rejected`/`reverted`) decision rows — oldest-first by `createdAt`.
 * Popup (`popup:`-synthetic) rows are excluded: {@link prunePopupDecisions}
 * already owns them with the tighter cap. `pending`/`unsure`/`approved`/
 * `applied` rows are user-visible state and are never reaped. MUST run
 * inside a `rw` transaction covering `decisions`.
 */
export async function pruneTerminalDecisionsLocked(): Promise<number> {
  const terminal = await db.decisions
    .where("status")
    .anyOf(...TERMINAL_DECISION_STATUSES)
    .toArray();
  const real = terminal.filter(
    (row) =>
      !(
        row.bookmarkIds.length > 0 &&
        row.bookmarkIds.every((id) => id.startsWith("popup:"))
      ),
  );
  if (real.length <= DECISION_TERMINAL_RETENTION_CAP) return 0;
  real.sort((a, b) => {
    const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
    return byCreatedAt !== 0 ? byCreatedAt : a.id.localeCompare(b.id);
  });
  const victims = real.slice(0, real.length - DECISION_TERMINAL_RETENTION_CAP);
  await db.decisions.bulkDelete(victims.map((row) => row.id));
  return victims.length;
}
