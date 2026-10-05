import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type SentLogEntry } from "../../db/database";
import { clearSentLog, SENT_LOG_RETENTION_CAP } from "../../net/sent-log";
import type { UsageMonthRollup, UsageRecord } from "../../schemas/usage";
import { cn } from "../../ui/lib/cn";
import { Alert, Chip } from "./components";
import { PulseIcon, TrashIcon } from "../../ui/components/icons";
import { cardClass, ghostDangerButtonClass, sectionHeadingClass } from "./ui";

/**
 * Sent-log rows rendered before the reader asks for more (A08: the section
 * loads lazily — no `db.sentLog` read at all while collapsed — and pages by
 * this count inside the 500-row retention cap).
 */
const SENT_LOG_PAGE_SIZE = 50;

/**
 * Options-page "Data sent" surface (spec FR10) plus the FR8 cost totals.
 *
 * - **Usage stats.** `db.usage` holds only the CURRENT month's raw rows —
 *   expired months fold into `db.usageMonths` rollups at write time (A08).
 *   The tiles sum both, so totals stay all-time-honest while the read stays
 *   bounded. `costUsd` absent means "not reported", never $0.00; unpriced
 *   requests surface as a count (`unpricedRequests` on a rollup carries the
 *   same meaning).
 * - **Sent log.** `db.sentLog` is metadata-only by construction
 *   (`src/net/sent-log.ts` rebuilds each row from exactly
 *   `sentAt`/`destination`/`feature`/`fieldNames` plus a closed `outcome`), so each row renders those
 *   metadata fields and nothing else — no request bodies, headers, keys, or
 *   bookmark content exist on the rows to leak. Ordered newest-first by
 *   `sentAt`; the retention cap is disclosed with the same
 *   `SENT_LOG_RETENTION_CAP` the writer enforces. The table is only read
 *   once the reader expands the section, and then one
 *   {@link SENT_LOG_PAGE_SIZE}-row page at a time. Clear calls
 *   `clearSentLog()`.
 *
 * Both lists degrade to empty when IndexedDB is unavailable; a missing or
 * failing read must not throw the render (`useLiveQuery` rethrows observable
 * errors, so the queriers catch to `[]`/`0`).
 */
export function SentLog() {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(SENT_LOG_PAGE_SIZE);
  const inFlight = useRef(false);

  const entries =
    useLiveQuery(
      () =>
        expanded
          ? db.sentLog
              .orderBy("sentAt")
              .reverse()
              .limit(limit)
              .toArray()
              .catch((): SentLogEntry[] => [])
          : Promise.resolve([] as SentLogEntry[]),
      [expanded, limit],
    ) ?? [];

  const totalEntries =
    useLiveQuery(
      () => (expanded ? db.sentLog.count().catch(() => 0) : 0),
      [expanded],
    ) ?? 0;

  const usage =
    useLiveQuery(
      () => db.usage.toArray().catch((): UsageRecord[] => []),
      [],
    ) ?? [];

  const usageMonths =
    useLiveQuery(
      () => db.usageMonths.toArray().catch((): UsageMonthRollup[] => []),
      [],
    ) ?? [];

  const requestCount =
    usage.length + usageMonths.reduce((sum, roll) => sum + roll.requests, 0);
  const inputTokens =
    usage.reduce((sum, row) => sum + row.inputTokens, 0) +
    usageMonths.reduce((sum, roll) => sum + roll.inputTokens, 0);
  const outputTokens =
    usage.reduce((sum, row) => sum + row.outputTokens, 0) +
    usageMonths.reduce((sum, roll) => sum + roll.outputTokens, 0);
  // `costUsd` absent means "not reported" — never folded in as $0.
  const costReported =
    usage.filter((row) => row.costUsd !== undefined).length +
    usageMonths.reduce(
      (sum, roll) => sum + (roll.requests - roll.unpricedRequests),
      0,
    );
  const costTotal =
    usage.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) +
    usageMonths.reduce((sum, roll) => sum + (roll.costUsd ?? 0), 0);
  const unpriced = requestCount - costReported;

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
        {requestCount === 0 ? (
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
                {requestCount}
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
                {costReported > 0 ? `$${costTotal.toFixed(4)}` : "—"}
              </dd>
              <dd className="mt-0.5 text-xs text-muted-foreground">
                {costReported} of {requestCount} priced
                {unpriced > 0 && ` · ${unpriced} unpriced`}
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* Sent log — structured rows, read lazily on expand. */}
      <section aria-labelledby="sent-log-list-heading" className="mt-6">
        <h3 id="sent-log-list-heading" className="text-sm font-medium">
          Sent log
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Dispatched attempts are listed by time, destination, feature, field
          names, and outcome — contents are never recorded. Unknown / pending
          means the outcome was not recorded, including older entries. The log
          keeps the newest {SENT_LOG_RETENTION_CAP} entries when logging succeeds.
        </p>
        {!expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-3 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Show sent log
          </button>
        ) : entries.length === 0 ? (
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
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {new Date(entry.sentAt).toLocaleString()}
                  </span>
                  <Chip>{entry.destination}</Chip>
                  <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                    {entry.feature}
                  </span>
                  <span className="text-xs font-medium" aria-label="Attempt outcome">
                    {entry.outcome ?? "Unknown / pending"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {entry.fieldNames.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {entries.length < totalEntries && (
                <button
                  type="button"
                  onClick={() => setLimit(totalEntries)}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Show all {totalEntries} entries
                </button>
              )}
              <button
                type="button"
                onClick={onClear}
                disabled={busy}
                className={ghostDangerButtonClass}
              >
                <TrashIcon className="size-3.5" />
                Clear sent log
              </button>
            </div>
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
