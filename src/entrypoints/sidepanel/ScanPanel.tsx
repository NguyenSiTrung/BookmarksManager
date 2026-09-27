import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../db/database";
import { DEFAULT_BATCH_SIZE, estimateJobCost } from "../../jobs/estimate";
import { DecisionMessage } from "../../messages/decisions";
import type { Job as JobDocument } from "../../schemas/job";
import { cn } from "../../ui/lib/cn";
import { sendDecisionMessage } from "./ReviewView";

/**
 * The library-scan launcher (spec FR10 "a library-scan launcher with
 * progress, pause, cancel, and running cost"; FR7 "before a job starts, show
 * a cost estimate derived from the token estimate") — Phase 4 Task 4.
 *
 * Props (kept minimal so the coordinator's mount stays trivial):
 *
 *  - `bookmarks` — the work set as MINIMIZED rows: `{ id, title, url }` per
 *    bookmark (typically the whole library, `[...tree.bookmarks.values()]`;
 *    any subset works the same). `id` is exactly what `JOB_START` sends;
 *    `{title, url}` is exactly what `estimateJobCost` folds — notes are never
 *    passed and never estimated.
 *  - `onOpenReview?: () => void` — optional routing callback behind the
 *    "View results" affordance on a completed scan; the coordinator owns
 *    navigation (omitted → the button is simply not rendered).
 *  - `className?: string` — merged onto the root section.
 *
 * Design rules:
 *
 * - **Estimate before start.** The launcher renders `estimateJobCost`'s pure
 *   lower bound — "at least ~N tokens across M batches" at
 *   `DEFAULT_BATCH_SIZE` — plus the bookmark count, and Start is a distinct
 *   action (FR7). The estimate deliberately says "at least": it folds only
 *   the per-batch bookmark payloads, not the fixed question scaffolding the
 *   pipeline adds to every request.
 * - **Dexie in, messages out.** The live card streams the latest
 *   `library_scan` row from the `jobs` table through `useLiveQuery` (with a
 *   `.catch` inside the querier — dexie-react-hooks rethrows observable
 *   errors, so a failed read must degrade to "no job" instead of throwing
 *   the render). Every mutation is a decisions-protocol intent through
 *   {@link sendDecisionMessage} — `JOB_START` on Start, `JOB_PAUSE` /
 *   `JOB_RESUME` / `JOB_CANCEL` with the live row's id — and every reply is
 *   validated by `DecisionMessageResult.safeParse` inside that helper; an
 *   `{ok:false}` reply renders its (already redacted) `message` verbatim.
 * - **The row is the source of truth.** No shadow copy of the job exists
 *   here: progress, usage, and status all read the Dexie row the worker's
 *   runner updates, so a reopened panel (or a worker restart mid-run)
 *   renders the resumed state straight from storage. The `job` echoed in a
 *   reply is never used to render — only the live row is.
 * - **Terminal + reset.** `completed`/`canceled`/`failed` render their
 *   terminal state (a `failed` row shows its redacted `job.error`) plus a
 *   "New scan" reset that dismisses THAT row locally — the panel never
 *   deletes job rows; a NEW row from a later start takes the panel back
 *   regardless of the dismissal.
 * - **Scoped.** Launcher + live status card only: per-decision review lives
 *   in the Review view, reachable through `onOpenReview`.
 */

/** A minimized bookmark row: the id `JOB_START` sends plus the `{title, url}` pair the estimate folds. */
export interface ScanBookmark {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

export interface ScanPanelProps {
  /** The work set as minimized rows — never notes. */
  readonly bookmarks: readonly ScanBookmark[];
  /** Open the Review view from a completed scan ("View results"); coordinator-owned routing. */
  readonly onOpenReview?: () => void;
  readonly className?: string;
}

const UNEXPECTED_REPLY_MESSAGE =
  "The extension worker returned an unexpected reply.";

/** Pinned locale so the token/cost figures format identically everywhere. */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/** Human label per `JobStatus`; the card reads "Scan: <label>". */
const STATUS_LABEL: Record<JobDocument["status"], string> = {
  pending: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
  failed: "Failed",
};

const startButtonClass =
  "shrink-0 rounded-sm bg-primary px-3 py-1.5 text-sm font-medium " +
  "text-primary-foreground outline-hidden hover:bg-primary/90 " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const secondaryButtonClass =
  "shrink-0 rounded-sm border border-border bg-background px-2 py-1 text-xs " +
  "outline-hidden hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** True for a status the scan can still continue from. */
function isTerminal(status: JobDocument["status"]): boolean {
  return (
    status === "completed" || status === "canceled" || status === "failed"
  );
}

/**
 * The latest `library_scan` row, by `createdAt` — `null` when none exists
 * (or the read failed). The `.catch` keeps a failed read from throwing the
 * render: the panel degrades to the idle launcher rather than blanking.
 * `undefined` never escapes this querier; `useLiveQuery`'s own initial
 * `undefined` remains the only "first read still pending" signal, which is
 * what the Start guard below keys off.
 */
async function latestLibraryScanJob(): Promise<JobDocument | null> {
  const row = await db.jobs
    .orderBy("createdAt")
    .filter((row) => row.kind === "library_scan")
    .last()
    .catch((): undefined => undefined);
  return row ?? null;
}

/** The job-intent discriminators this panel sends (Start is separate). */
type JobControlIntent = "JOB_PAUSE" | "JOB_RESUME" | "JOB_CANCEL";

export function ScanPanel({
  bookmarks,
  onOpenReview,
  className,
}: ScanPanelProps) {
  /** Pure lower-bound estimate over the minimized `{title, url}` payloads. */
  const estimate = useMemo(() => estimateJobCost({ bookmarks }), [bookmarks]);
  /**
   * The live row's read. `jobRead` is `undefined` ONLY until Dexie's first
   * emission lands; `job` collapses that away so every consumer below sees
   * exactly two states (`JobDocument | null`). The tristate matters for one
   * thing: Start stays disabled while the read is pending, so a click can
   * never race a live row the first read has not surfaced yet — a second
   * start would strand the first job's rows mid-flight.
   */
  const jobRead = useLiveQuery(latestLibraryScanJob, []);
  const job = jobRead ?? null;

  /**
   * A terminal row the user reset away. Local by design: the panel never
   * deletes job rows, and a NEW row (a later Start) shows regardless — the
   * id comparison makes the dismissal apply to exactly one row.
   */
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  /** An intent is in flight; its button (and siblings) disable meanwhile. */
  const [busy, setBusy] = useState(false);
  /** The last `{ok:false}` / unexpected-reply message, rendered verbatim. */
  const [failure, setFailure] = useState<string | null>(null);

  const count = bookmarks.length;
  const showCard =
    job !== null && (!isTerminal(job.status) || job.id !== dismissedJobId);

  /**
   * Send one job intent. Replies are validated by `DecisionMessageResult`
   * inside {@link sendDecisionMessage}; success needs no local action — the
   * worker's write to the `jobs` row is what re-renders the card — so only
   * failures (and non-`job_ok` success shapes, reported rather than misread)
   * land here.
   */
  const runIntent = async (intent: DecisionMessage): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const result = await sendDecisionMessage(intent);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    if (result.code !== "job_ok") {
      setFailure(UNEXPECTED_REPLY_MESSAGE);
    }
  };

  const handleStart = async (): Promise<void> => {
    if (busy || count === 0) return;
    // A fresh start supersedes any dismissed terminal row.
    setDismissedJobId(null);
    await runIntent(
      DecisionMessage.parse({
        type: "JOB_START",
        kind: "library_scan",
        bookmarkIds: bookmarks.map((bookmark) => bookmark.id),
      }),
    );
  };

  const handleControl = async (type: JobControlIntent): Promise<void> => {
    if (busy || job === null) return;
    await runIntent(DecisionMessage.parse({ type, jobId: job.id }));
  };

  return (
    <section
      aria-label="Library scan"
      className={cn(
        "flex flex-col gap-3 rounded border border-border p-3 text-sm",
        className,
      )}
    >
      <div>
        <p className="font-medium">Library scan</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Categorize and tag every bookmark, then flag misfiled and
          near-duplicate entries for review.
        </p>
      </div>

      {showCard && job !== null ? (
        <div
          role="status"
          aria-label="Library scan status"
          className="flex flex-col gap-2 rounded-sm border border-border bg-muted/30 p-2"
        >
          <p className="font-medium">Scan: {STATUS_LABEL[job.status]}</p>

          {job.status === "failed" && job.error !== undefined && (
            <p role="alert" className="text-xs text-destructive">
              {job.error}
            </p>
          )}

          {job.progress.totalBatches > 0 ? (
            <>
              <progress
                aria-label="Scan progress"
                className="h-1.5 w-full accent-primary"
                max={job.progress.totalBatches}
                value={job.progress.committedBatches}
              />
              <p className="text-xs text-muted-foreground">
                Batches {job.progress.committedBatches} /{" "}
                {job.progress.totalBatches} (
                {Math.round(
                  (job.progress.committedBatches /
                    job.progress.totalBatches) *
                    100,
                )}
                %) · {job.progress.processedCount} bookmark
                {job.progress.processedCount === 1 ? "" : "s"} processed
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Preparing the scan…</p>
          )}

          <p className="text-xs text-muted-foreground">
            {NUMBER_FORMAT.format(job.usage.inputTokens)} input +{" "}
            {NUMBER_FORMAT.format(job.usage.outputTokens)} output tokens ·{" "}
            {job.usage.requests} {job.usage.requests === 1 ? "request" : "requests"}
            {/* costUsd only where the provider reported one — never "$0.00". */}
            {job.usage.costUsd !== undefined &&
              ` · $${job.usage.costUsd.toFixed(4)}`}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {(job.status === "pending" || job.status === "running") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleControl("JOB_PAUSE")}
                className={secondaryButtonClass}
              >
                Pause
              </button>
            )}
            {job.status === "paused" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleControl("JOB_RESUME")}
                className={secondaryButtonClass}
              >
                Resume
              </button>
            )}
            {!isTerminal(job.status) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleControl("JOB_CANCEL")}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
            )}
            {job.status === "completed" && onOpenReview !== undefined && (
              <button
                type="button"
                onClick={onOpenReview}
                className={secondaryButtonClass}
              >
                View results
              </button>
            )}
            {isTerminal(job.status) && (
              <button
                type="button"
                onClick={() => setDismissedJobId(job.id)}
                className={secondaryButtonClass}
              >
                New scan
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {count === 0
              ? "Nothing to scan — the library is empty."
              : `${count} bookmark${count === 1 ? "" : "s"} · at least ~${NUMBER_FORMAT.format(
                  estimate.inputTokens,
                )} tokens across ${estimate.totalBatches} batch${
                  estimate.totalBatches === 1 ? "" : "es"
                } (batch size ${DEFAULT_BATCH_SIZE})`}
          </p>
          <div>
            <button
              type="button"
              disabled={busy || count === 0 || jobRead === undefined}
              onClick={() => void handleStart()}
              className={startButtonClass}
            >
              {busy ? "Starting…" : "Start scan"}
            </button>
          </div>
        </>
      )}

      {failure !== null && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </section>
  );
}
