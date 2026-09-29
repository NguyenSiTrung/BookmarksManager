import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type SentLogEntry } from "../../db/database";
import { clearSentLog, SENT_LOG_RETENTION_CAP } from "../../net/sent-log";
import type { UsageRecord } from "../../schemas/usage";
import { cardClass, dangerButtonClass, sectionHeadingClass } from "./ui";

/**
 * Options-page "Data sent" surface (spec FR10) plus the FR8 cost totals.
 *
 * - **Sent log.** `db.sentLog` is metadata-only by construction
 *   (`src/net/sent-log.ts` rebuilds each row from exactly
 *   `sentAt`/`destination`/`feature`/`fieldNames`), so the list renders those
 *   four fields and nothing else — no request bodies, headers, keys, or
 *   bookmark content exist on the rows to leak. Ordered newest-first by
 *   `sentAt`; the retention cap is disclosed with the same
 *   `SENT_LOG_RETENTION_CAP` the writer enforces. Clear calls
 *   `clearSentLog()`.
 * - **Cost totals.** `db.usage` rows are aggregated live: total input and
 *   output tokens over all rows, and `costUsd` summed only over the rows
 *   that reported one — an absent `costUsd` means "not reported", never
 *   $0.00.
 *
 * Both lists degrade to empty when IndexedDB is unavailable; a missing or
 * failing read must not throw the render (`useLiveQuery` rethrows observable
 * errors, so the queriers catch to `[]`).
 */
export function SentLog() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const entries =
    useLiveQuery(
      () =>
        db.sentLog
          .orderBy("sentAt")
          .reverse()
          .toArray()
          .catch((): SentLogEntry[] => []),
      [],
    ) ?? [];

  const usage =
    useLiveQuery(
      () => db.usage.toArray().catch((): UsageRecord[] => []),
      [],
    ) ?? [];

  const inputTokens = usage.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = usage.reduce((sum, row) => sum + row.outputTokens, 0);
  // `costUsd` absent means "not reported" — never folded in as $0.
  const costReported = usage.filter((row) => row.costUsd !== undefined);
  const costTotal = costReported.reduce(
    (sum, row) => sum + (row.costUsd ?? 0),
    0,
  );

  const onClear = () => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void clearSentLog()
      .then((removed) => {
        setNotice(
          `Cleared ${removed} sent-log ${removed === 1 ? "entry" : "entries"}.`,
        );
      })
      .catch(() => {
        setError("Something went wrong while clearing the log.");
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <section
      aria-labelledby="sent-log-heading"
      className={cardClass}
    >
      <h2 id="sent-log-heading" className={sectionHeadingClass}>
        Data sent to providers
      </h2>

      <section aria-labelledby="usage-totals-heading" className="mt-4">
        <h3 id="usage-totals-heading" className="font-medium">
          Usage and cost
        </h3>
        {usage.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">
            No provider requests recorded yet.
          </p>
        ) : (
          <p role="status" className="mt-1 text-sm text-muted-foreground">
            {usage.length} {usage.length === 1 ? "request" : "requests"} —{" "}
            {inputTokens} input tokens, {outputTokens} output tokens; cost
            reported on {costReported.length} of {usage.length} requests
            {costReported.length > 0 &&
              `, totalling $${costTotal.toFixed(4)}`}
            .
          </p>
        )}
      </section>

      <section aria-labelledby="sent-log-list-heading" className="mt-6">
        <h3 id="sent-log-list-heading" className="font-medium">
          Sent log
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every request that left this device is listed by time, destination,
          feature, and the names of the fields it carried — contents are never
          recorded. The log keeps the newest {SENT_LOG_RETENTION_CAP} entries.
        </p>
        {entries.length === 0 ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Nothing has been sent yet.
          </p>
        ) : (
          <>
            <ul className="mt-2 space-y-2">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded border border-border p-2 text-sm"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span>{new Date(entry.sentAt).toLocaleString()}</span>
                    <span>{entry.destination}</span>
                    <span>{entry.feature}</span>
                  </div>
                  <div>Fields: {entry.fieldNames.join(", ")}</div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className={`mt-3 ${dangerButtonClass}`}
            >
              Clear sent log
            </button>
          </>
        )}
      </section>

      {notice !== null && (
        <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
