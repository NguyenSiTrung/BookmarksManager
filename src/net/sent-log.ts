import { db, type SentLogEntry, type SentLogOutcome } from "../db/database";

/**
 * Audit-log service for the "Data sent" view (FR10). This module is the only
 * writer of the Dexie `sentLog` table (`++id,sentAt`, see
 * `src/db/database.ts`): both network gates call {@link beginSentLog} at each
 * admitted fetch dispatch, then update its outcome after transport completes.
 * Options calls {@link clearSentLog} behind the "Clear" button.
 *
 * Design rules (locked by tests/unit/sent-log.test.ts):
 *
 * - **Metadata-only, always.** A row records when fetch was dispatched, the
 *   destination origin it targeted, the consent scope (`feature`), and the
 *   top-level request field NAMES — never bodies, headers, keys, or bookmark
 *   content. {@link appendSentLog} rebuilds the row from exactly those four
 *   fields and an optional closed outcome, so a stray runtime property (a
 *   body, a title, a URL) can never reach storage.
 * - **Bounded growth.** The table is capped at {@link SENT_LOG_RETENTION_CAP}
 *   rows; each append keeps the newest by primary key (`++id` is insertion
 *   order) and drops the oldest excess. Trimming runs inside the same
 *   transaction as the insert, so a concurrent append cannot overshoot the cap.
 * - **Bounded trim work.** The trim never materializes the table: it counts
 *   rows (an IndexedDB aggregate) and deletes only the oldest `excess`
 *   primary keys via the `++id` index, so the cost is O(excess), not
 *   O(table size).
 */

/**
 * Maximum number of rows retained in the `sentLog` audit table.
 *
 * Chosen as 500: large enough to cover a long review session — a user
 * scanning "what has this extension sent lately?" sees hundreds of recent
 * egresses without pagination — yet a hard, tiny bound on disk. Each row is
 * a handful of short strings, so 500 rows is on the order of tens of
 * kilobytes: negligible for IndexedDB while still guaranteeing the
 * append-only log can never grow without limit (backlog `BookmarksManager-sd1`).
 * Exported so the Options/UI and tests share the exact same boundary.
 */
export const SENT_LOG_RETENTION_CAP = 500;

/** Reject arbitrary runtime strings: outcomes must never carry error text. */
function isSentLogOutcome(value: unknown): value is SentLogOutcome {
  return value === "ok" || value === "retried" || value === "timeout" ||
    value === "redirect" || value === "transport" ||
    (typeof value === "string" && /^http_[1-5]\d{2}$/.test(value));
}

/**
 * Append one metadata-only audit row and enforce the retention cap in a
 * single `sentLog` transaction. Only `sentAt`/`destination`/`feature`/
 * `fieldNames` and a safe optional `outcome` are persisted — a fresh object
 * is written so neither the caller's object nor any extra property on it
 * reaches the table. Rows beyond
 * {@link SENT_LOG_RETENTION_CAP} are dropped oldest-first (primary-key order =
 * insertion order). Resolves to the new row id.
 */
export async function appendSentLog(
  input: Omit<SentLogEntry, "id">,
): Promise<number> {
  return db.transaction("rw", db.sentLog, async () => {
    const id = await db.sentLog.add({
      sentAt: input.sentAt,
      destination: input.destination,
      feature: input.feature,
      fieldNames: [...input.fieldNames],
      ...(isSentLogOutcome(input.outcome) ? { outcome: input.outcome } : {}),
    });
    const excess = (await db.sentLog.count()) - SENT_LOG_RETENTION_CAP;
    if (excess > 0) {
      // Load only the oldest `excess` primary keys through the `++id` index —
      // never the whole table.
      const oldestKeys = await db.sentLog
        .orderBy(":id")
        .limit(excess)
        .primaryKeys();
      await db.sentLog.bulkDelete(oldestKeys);
    }
    return id;
  });
}

/**
 * Start bookkeeping synchronously at dispatch, without awaiting IndexedDB.
 * The returned finisher awaits the insert and updates ONLY the safe outcome.
 * Its failures are swallowed so audit IO cannot alter transport results,
 * trigger retries, or interfere with budget settlement. A worker killed while
 * transport is pending leaves an honest outcome-less row if the insert landed.
 * Call only after final admission and the pre-abort check, immediately before
 * fetch, with no intervening await. Update (not put) cannot resurrect a row
 * removed by Clear or retention trimming while the request was in flight.
 */
export function beginSentLog(
  input: Omit<SentLogEntry, "id" | "outcome">,
): (outcome: SentLogOutcome) => Promise<void> {
  const appended = appendSentLog(input).catch(() => undefined);
  return async (outcome) => {
    try {
      const id = await appended;
      if (id !== undefined && isSentLogOutcome(outcome)) {
        await db.sentLog.update(id, { outcome });
      }
    } catch {
      // Metadata bookkeeping is best effort, never an egress/budget result.
    }
  };
}

/**
 * Empty the `sentLog` table (the Options "Clear" button) and resolve to the
 * number of rows removed.
 */
export async function clearSentLog(): Promise<number> {
  return db.transaction("rw", db.sentLog, async () => {
    const removed = await db.sentLog.count();
    await db.sentLog.clear();
    return removed;
  });
}
