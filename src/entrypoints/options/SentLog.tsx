import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type SentLogEntry } from "../../db/database";
import { clearSentLog, SENT_LOG_RETENTION_CAP } from "../../net/sent-log";
import type { UsageRecord } from "../../schemas/usage";
import { cn } from "../../ui/lib/cn";
import { Alert, Chip } from "./components";
import { PulseIcon, TrashIcon } from "../../ui/components/icons";
import { cardClass, ghostDangerButtonClass, sectionHeadingClass } from "./ui";

/**
 * Options-page "Data sent" surface (spec FR10) plus the FR8 cost totals.
 *
 * - **Usage stats.** `db.usage` rows aggregate live into stat tiles: request
 *   count, input/output tokens, and reported cost — summed only over rows
 *   that reported one. An absent `costUsd` means "not reported", never $0.00;
 *   unpriced requests surface as a count.
 * - **Sent log.** `db.sentLog` is metadata-only by construction
 *   (`src/net/sent-log.ts` rebuilds each row from exactly
 *   `sentAt`/`destination`/`feature`/`fieldNames`), so each row renders those
 *   four fields and nothing else — no request bodies, headers, keys, or
 *   bookmark content exist on the rows to leak. Ordered newest-first by
 *   `sentAt`; the retention cap is disclosed with the same
 *   `SENT_LOG_RETENTION_CAP` the writer enforces. Clear calls
 *   `clearSentLog()`.
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
  const unpriced = usage.length - costReported.length;

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
    <section aria-labelledby="sent-log-heading" className={cardClass}>
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <PulseIcon className="size-4" />
        </span>
        <h2 id="sent-log-heading" className={sectionHeadingClass}>
          Data sent to providers
        </h2>
      </div>

      {/* Usage totals — stat tiles instead of a run-on sentence. */}
      <section aria-labelledby="usage-totals-heading" className="mt-5">
        <h3 id="usage-totals-heading" className="text-sm font-medium">
          Usage and cost
        </h3>
        {usage.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No provider requests recorded yet.
          </p>
        ) : (
          <dl
            aria-label="Usage totals"
            className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">Requests</dt>
              <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">
                {usage.length}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">Tokens in</dt>
              <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">
                {inputTokens.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">Tokens out</dt>
              <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">
                {outputTokens.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <dt className="text-xs text-muted-foreground">Reported cost</dt>
              <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">
                {costReported.length > 0 ? `$${costTotal.toFixed(4)}` : "—"}
              </dd>
              <dd className="mt-0.5 text-xs text-muted-foreground">
                {costReported.length} of {usage.length} priced
                {unpriced > 0 && ` · ${unpriced} unpriced`}
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* Sent log — structured rows. */}
      <section aria-labelledby="sent-log-list-heading" className="mt-6">
        <h3 id="sent-log-list-heading" className="text-sm font-medium">
          Sent log
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every request that left this device is listed by time, destination,
          feature, and the names of the fields it carried — contents are never
          recorded. The log keeps the newest {SENT_LOG_RETENTION_CAP} entries.
        </p>
        {entries.length === 0 ? (
          <div className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            <PulseIcon className="size-5 shrink-0 text-muted-foreground/60" />
            Nothing has been sent yet.
          </div>
        ) : (
          <>
            <ul className="mt-3 space-y-2">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg",
                    "border border-border bg-muted/30 px-3 py-2.5",
                  )}
                >
                  <span className="font-options-mono text-xs text-muted-foreground tabular-nums">
                    {new Date(entry.sentAt).toLocaleString()}
                  </span>
                  <Chip>{entry.destination}</Chip>
                  <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                    {entry.feature}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {entry.fieldNames.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className={`mt-4 ${ghostDangerButtonClass}`}
            >
              <TrashIcon className="size-3.5" />
              Clear sent log
            </button>
          </>
        )}
      </section>

      {notice !== null && (
        <div className="mt-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {error !== null && (
        <div className="mt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </section>
  );
}
