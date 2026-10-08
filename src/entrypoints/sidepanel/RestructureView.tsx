import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CostConfirmationDialog } from "../../ui/components/CostConfirmationDialog";
import { FeatureConsentDialog } from "../../ui/components/FeatureConsentDialog";
import type { FeatureConsentApproval, FeatureConsentDisclosure } from "../../schemas/feature-consent";
import { RestructureMessageResult } from "../../messages/restructure";
import type { Job } from "../../schemas/job";
import type { RestructureDiff, DiffRow } from "../../restructure/diff";
import { Checkbox } from "../../ui/components/checkbox";
import { ChevronDownIcon } from "../../ui/components/icons";
import { cn } from "../../ui/lib/cn";
import { useToast } from "./UndoToast";

/**
 * The restructure workflow pane (spec FR8): propose → assign → preview →
 * confirm → apply → undo. Every intent is a `RESTRUCTURE_*` message to the
 * worker; replies are validated by `RestructureMessageResult.safeParse`.
 *
 * Design rules:
 *
 * - **Messages out, polling in.** The view holds no Dexie handles — it asks
 *   `RESTRUCTURE_STATUS` for the latest restructure job on mount and again
 *   every second while a job is `pending`/`running` or a start is still
 *   in flight (the worker may die mid-run; polling also covers the resume
 *   path and a START reply that never lands). A terminal job stops the
 *   poll. Polls are serialized and coalesced: a tick while a poll link is
 *   still queued or in flight is dropped, so a slow STATUS read never
 *   piles up a backlog that fires stale reads later.
 * - **Confidence is never color-only.** Each diff row carries a text chip
 *   (`High`/`Low`/`Unresolved`) in addition to shading, so the confidence
 *   signal survives monochrome and screen readers.
 * - **Apply needs two clicks.** `RESTRUCTURE_CONFIRM` fires only after an
 *   explicit destructive confirmation — the first click arms, the second
 *   confirms. A plan NEVER applies on proposal or on job completion alone
 *   (spec: "plans never auto-apply").
 * - **Unresolved stays visible.** Rows Jev left unresolved (low confidence
 *   or "keep") render in their own section and are excluded from the apply —
 *   the user can leave them in place or re-run later.
 * - **Worker restart is a state, not an error.** A `running` job whose poll
 *   stops changing is still shown as running; `resumeJobs` picks it up on
 *   the next worker start and the next poll reflects the catch-up.
 */

declare const chrome: {
  runtime?: {
    getURL?(path: string): string;
    sendMessage?(message: unknown): Promise<unknown>;
  };
};

async function send(message: unknown): Promise<RestructureMessageResult> {
  let raw: unknown;
  try {
    const runtime = chrome.runtime;
    if (runtime?.sendMessage === undefined) {
      return { ok: false, code: "internal_error", message: "Messaging unavailable." };
    }
    raw = await runtime.sendMessage(message);
  } catch {
    return {
      ok: false,
      code: "internal_error",
      message: "The extension worker is not reachable — nothing was changed.",
    };
  }
  const parsed = RestructureMessageResult.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "internal_error",
      message: "The worker returned an unreadable reply.",
    };
  }
  return parsed.data;
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "consent"; consent: FeatureConsentDisclosure }
  | { kind: "confirm_cost"; destinationOrigin: string; approval: FeatureConsentApproval }
  | { kind: "active"; job: Job; diff?: RestructureDiff }
  | { kind: "arm_apply"; job: Job; diff: RestructureDiff }
  | { kind: "applied"; moved: number }
  | { kind: "error"; message: string };

/**
 * Default status-poll cadence. Overridable per instance for tests: the
 * re-entrancy suite needs a poll far shorter than the multi-second reads it
 * simulates, and driving that through a module constant made one test cost
 * ~8.6 s of real waiting. `App` already exposes the same kind of seam for the
 * undo toast (`undoToastAutoHideMs`), so this matches the existing pattern.
 * Production always uses the default.
 */
const POLL_MS = 1_000;

function confidenceLabel(row: DiffRow): string {
  if (row.managed === true) return "Managed";
  if (row.status === "unresolved") return "Unresolved";
  if (row.status === "stale") return "Stale";
  const c = row.confidence;
  return c !== null && c >= 0.75 ? "High" : "Low";
}

interface DiffListProps {
  diff: RestructureDiff;
  selectedIds: ReadonlySet<string>;
  onToggle: (bookmarkId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

function DiffList(props: DiffListProps) {
  const [movesOpen, setMovesOpen] = useState(true);
  const [alreadyOpen, setAlreadyOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);

  const moves = props.diff.rows.filter(
    (r) => r.status === "resolved" && r.fromPath !== r.toPath,
  );
  const unchanged = props.diff.rows.filter(
    (r) => r.status === "resolved" && r.fromPath === r.toPath,
  );
  const unresolved = props.diff.rows.filter((r) => r.status !== "resolved");

  const selectedMovesCount = moves.filter((m) =>
    props.selectedIds.has(m.bookmarkId),
  ).length;

  return (
    <div className="space-y-3">
      <section aria-label="Proposed moves">
        <div className="mb-1 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMovesOpen((o) => !o)}
            aria-expanded={movesOpen}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>
              Moves ({selectedMovesCount}/{moves.length} selected)
            </span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                movesOpen && "rotate-180",
              )}
            />
          </button>
          {moves.length > 0 && movesOpen && (
            <button
              type="button"
              onClick={
                selectedMovesCount === moves.length
                  ? props.onDeselectAll
                  : props.onSelectAll
              }
              className="text-[11px] text-muted-foreground underline outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {selectedMovesCount === moves.length
                ? "Deselect all"
                : "Select all"}
            </button>
          )}
        </div>
        {movesOpen && (
          moves.length === 0 ? (
            <p className="text-xs text-muted-foreground">No moves proposed.</p>
          ) : (
            <ul className="space-y-1">
              {moves.map((row) => {
                const isSelected = props.selectedIds.has(row.bookmarkId);
                return (
                  <li
                    key={row.bookmarkId}
                    className={cn(
                      "flex items-start gap-2 rounded-sm border border-border px-2 py-1 text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                      !isSelected && "bg-muted/30 opacity-60",
                    )}
                  >
                    <div className="pt-0.5">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => props.onToggle(row.bookmarkId)}
                        aria-label={`Apply move for ${row.title}`}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{row.title}</span>
                      <span className="block text-muted-foreground">
                        {row.fromPath} → {row.toPath}
                      </span>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span
                          aria-label={`Confidence: ${confidenceLabel(row)}`}
                          className={cn(
                            "inline-block rounded-sm px-1 py-0.5 text-[10px]",
                            confidenceLabel(row) === "High"
                              ? "bg-primary/15 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {confidenceLabel(row)} confidence
                        </span>
                        {!isSelected && (
                          <span className="rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                            Skipped
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </section>
      {unchanged.length > 0 && (
        <section aria-label="Already in place">
          <button
            type="button"
            onClick={() => setAlreadyOpen((o) => !o)}
            aria-expanded={alreadyOpen}
            className="mb-1 flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>Already in place ({unchanged.length})</span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                alreadyOpen && "rotate-180",
              )}
            />
          </button>
          {alreadyOpen && (
            <ul className="space-y-1">
              {unchanged.map((row) => (
                <li
                  key={row.bookmarkId}
                  tabIndex={0}
                  className={cn(
                    "rounded-sm border border-border px-2 py-1 text-xs",
                    "outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <span className="block truncate font-medium">{row.title}</span>
                  <span className="block text-muted-foreground">
                    {row.fromPath}
                  </span>
                  <span
                    aria-label={`Confidence: ${confidenceLabel(row)}`}
                    className={cn(
                      "mt-0.5 inline-block rounded-sm px-1 py-0.5 text-[10px]",
                      confidenceLabel(row) === "High"
                        ? "bg-primary/15 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {confidenceLabel(row)} confidence
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {unresolved.length > 0 && (
        <section aria-label="Unresolved and stale">
          <button
            type="button"
            onClick={() => setLeftOpen((o) => !o)}
            aria-expanded={leftOpen}
            className="mb-1 flex w-full items-center justify-between text-left text-xs font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>Left in place ({unresolved.length})</span>
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                leftOpen && "rotate-180",
              )}
            />
          </button>
          {leftOpen && (
            <ul className="space-y-1">
              {unresolved.map((row) => (
                <li
                  key={row.bookmarkId}
                  tabIndex={0}
                  className={cn(
                    "rounded-sm border border-dashed border-border px-2 py-1",
                    "text-xs outline-hidden focus-visible:ring-2",
                    "focus-visible:ring-ring",
                  )}
                >
                  <span className="block truncate">{row.title}</span>
                  <span className="text-muted-foreground">
                    {row.status === "stale"
                      ? `Stale — ${row.fromPath}`
                      : row.managed === true
                        ? `Managed — ${row.fromPath} (kept)`
                        : `${row.fromPath} (kept)`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

export function RestructureView(props: {
  className?: string;
  /** Status-poll cadence in ms. Test seam; production omits it. */
  pollMs?: number;
}) {
  const pollMs = props.pollMs ?? POLL_MS;
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();
  const mounted = useRef(true);
  const starting = useRef(false);
  const applyingRef = useRef(false);
  const [applying, setApplying] = useState(false);
  // The interval reads the phase through a ref so it never needs a setState
  // side-channel, and refresh promises are chained so a poll never overlaps
  // an in-flight STATUS read.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  });
  const refreshTail = useRef<Promise<void>>(Promise.resolve());
  // Coalescing flag: caller-driven refreshes always queue (each intent
  // deserves its own read), but the interval contributes at most one
  // pending link — a STATUS slower than the interval must not accumulate.
  const pollPending = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    const next = refreshTail.current.then(async () => {
      const reply = await send({ type: "RESTRUCTURE_STATUS" });
      if (!mounted.current) return;
      if (!reply.ok) {
        if (reply.code === "not_found") {
          // A vanished job tears the view down only from settled phases — a
          // poll landing before the START reply must not clobber
          // starting/consent/arm_apply and drop the in-flight flow.
          setPhase((current) =>
            current.kind === "idle" || current.kind === "active"
              ? { kind: "idle" }
              : current,
          );
        }
        return; // transient read failures just retry on the next poll
      }
      if (reply.code === "job_state") {
        const { job, diff } = reply.result;
        setPhase((current) =>
          // Don't tear down the destructive-confirm arm on a background poll.
          current.kind === "arm_apply"
            ? current
            : { kind: "active", job, ...(diff !== undefined ? { diff } : {}) },
        );
      }
    });
    refreshTail.current = next.catch(() => {});
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Deferred out of the effect body — the rule forbids a synchronous
    // setState chain; the microtask keeps mount-order identical.
    queueMicrotask(() => void refresh());
    const timer = setInterval(() => {
      const current = phaseRef.current;
      const shouldPoll =
        current.kind === "starting" ||
        (current.kind === "active" &&
          (current.job.status === "pending" ||
            current.job.status === "running"));
      if (shouldPoll && !pollPending.current) {
        pollPending.current = true;
        void refresh()
          .catch(() => {})
          .finally(() => {
            pollPending.current = false;
          });
      }
    }, pollMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, pollMs]);

  const start = async (unknownCostConfirmed?: boolean, approval?: FeatureConsentApproval) => {
    if (starting.current) return;
    starting.current = true;
    setError(null);
    setPhase({ kind: "starting" });
    const reply = await send({
      type: "RESTRUCTURE_START",
      providerId: "active",
      ...(unknownCostConfirmed === true ? { unknownCostConfirmed } : {}),
      ...(approval !== undefined ? { consentApproval: approval } : {}),
    });
    starting.current = false;
    if (!reply.ok) {
      if (reply.code === "consent_required" && reply.consent?.scope === "llm_restructure") {
        setPhase({ kind: "consent", consent: reply.consent });
        return;
      }
      if (reply.code === "confirmation_required" && reply.destinationOrigin !== undefined && reply.consentApproval !== undefined) {
        setPhase({
          kind: "confirm_cost",
          destinationOrigin: reply.destinationOrigin,
          approval: reply.consentApproval,
        });
        return;
      }
      setPhase({ kind: "error", message: reply.message });
      return;
    }
    await refresh();
  };

  const intent = async (
    message: { type: string; jobId?: string },
    onError: (m: string) => void = setError,
  ) => {
    setError(null);
    const reply = await send(message);
    if (!reply.ok) {
      onError(reply.message);
      return;
    }
    await refresh();
  };

  const confirmApply = async (
    job: Job,
    diff: RestructureDiff,
    bookmarkIds?: string[],
  ) => {
    // Synchronous guard: a second click while CONFIRM is in flight must
    // not double-apply — `applying` mirrors the ref for the disabled prop.
    if (applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const reply = await send({
        type: "RESTRUCTURE_CONFIRM",
        jobId: job.id,
        ...(bookmarkIds !== undefined ? { bookmarkIds } : {}),
      });
      if (!reply.ok) {
        setPhase({ kind: "active", job, diff });
        setError(reply.message);
        return;
      }
      if (reply.code === "applied") {
        setPhase({ kind: "applied", moved: reply.moved });
        // `undoable` arms the shell toast's Undo — with `reply.snapshotId`
        // the toast replays exactly this apply's row (D07: moves back +
        // created empty folders removed) even if something else pushed on
        // top. No custom callback needed.
        showToast({
          message: `Restructure applied — ${reply.moved} bookmark${reply.moved === 1 ? "" : "s"} moved.`,
          undoable: true,
          snapshotId: reply.snapshotId,
        });
        return;
      }
      await refresh();
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const job = phase.kind === "active" || phase.kind === "arm_apply" ? phase.job : null;
  const running = job !== null && (job.status === "pending" || job.status === "running");
  const progress = job?.progress;
  const pct =
    progress !== undefined && progress.totalBatches > 0
      ? Math.round((progress.committedBatches / progress.totalBatches) * 100)
      : 0;

  // Selection is keyed by job id: a superseding job's diff must not
  // inherit a deselection made against a different plan's rows.
  const [selectedIds, setSelectedIds] = useState<{
    jobId: string;
    ids: ReadonlySet<string>;
  } | null>(null);

  const activeDiff =
    phase.kind === "active" || phase.kind === "arm_apply"
      ? phase.diff
      : undefined;

  const activeJobId = job?.id;

  const activeMoves = useMemo(() => {
    if (activeDiff === undefined) return [];
    return activeDiff.rows.filter(
      (r) => r.status === "resolved" && r.fromPath !== r.toPath,
    );
  }, [activeDiff]);

  const effectiveSelectedIds = useMemo(() => {
    if (
      selectedIds !== null &&
      activeJobId !== undefined &&
      selectedIds.jobId === activeJobId
    ) {
      return selectedIds.ids;
    }
    return new Set(activeMoves.map((m) => m.bookmarkId));
  }, [selectedIds, activeMoves, activeJobId]);

  const handleToggle = useCallback(
    (bookmarkId: string) => {
      if (activeJobId === undefined) return;
      const jobId = activeJobId;
      setSelectedIds((current) => {
        const base =
          current !== null && current.jobId === jobId
            ? current.ids
            : new Set(activeMoves.map((m) => m.bookmarkId));
        const set = new Set(base);
        if (set.has(bookmarkId)) {
          set.delete(bookmarkId);
        } else {
          set.add(bookmarkId);
        }
        return { jobId, ids: set };
      });
    },
    [activeMoves, activeJobId],
  );

  const handleSelectAll = useCallback(() => {
    if (activeJobId === undefined) return;
    setSelectedIds({
      jobId: activeJobId,
      ids: new Set(activeMoves.map((m) => m.bookmarkId)),
    });
  }, [activeMoves, activeJobId]);

  const handleDeselectAll = useCallback(() => {
    if (activeJobId === undefined) return;
    setSelectedIds({ jobId: activeJobId, ids: new Set() });
  }, [activeJobId]);

  const selectedMovesCount = activeMoves.filter((m) =>
    effectiveSelectedIds.has(m.bookmarkId),
  ).length;

  return (
    <div
      className={cn("flex flex-col gap-3 overflow-y-auto p-3", props.className)}
      aria-label="Restructure library"
      // Focus lands here when the pane opens; Escape returns to idle only
      // when nothing destructive is armed.
      onKeyDown={(event: ReactKeyboardEvent) => {
        if (event.key === "Escape" && phase.kind === "arm_apply") {
          setPhase({ kind: "active", job: phase.job, diff: phase.diff });
        }
      }}
    >
      <p className="text-xs text-muted-foreground">
        Propose a new folder layout with the configured LLM provider. Every
        bookmark is assigned by Jev; nothing moves until you confirm.
      </p>
      {error !== null && (
        <p role="alert" className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}

      {(phase.kind === "idle" || phase.kind === "starting" || phase.kind === "consent" || phase.kind === "confirm_cost") && (
        <button
          type="button"
          disabled={phase.kind === "starting"}
          onClick={() => void start()}
          className="w-fit rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          Propose a layout…
        </button>
      )}
      {phase.kind === "starting" && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Asking the provider for a layout…
        </p>
      )}
      {phase.kind === "error" && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{phase.message}</p>
          <button
            type="button"
            onClick={() => void start()}
            className="rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </div>
      )}

      {job !== null && (
        <section aria-label="Assignment progress" className="space-y-2">
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Assignment progress"
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {job.status === "completed"
              ? "Assignments ready — review the proposed moves."
              : job.status === "paused"
                ? "Paused."
                : job.status === "failed"
                  ? "The job failed."
                  : `Assigning… ${progress?.committedBatches ?? 0}/${progress?.totalBatches ?? "?"} batches`}
          </p>
          {running && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void intent({ type: "RESTRUCTURE_PAUSE", jobId: job.id })
                }
                className="rounded-sm border border-border px-2 py-1 text-xs outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Pause
              </button>
              <button
                type="button"
                onClick={() =>
                  void intent({ type: "RESTRUCTURE_CANCEL", jobId: job.id })
                }
                className="rounded-sm border border-destructive/40 px-2 py-1 text-xs text-destructive outline-hidden hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </div>
          )}
          {(job.status === "paused" || job.status === "failed") && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() =>
                  void intent({ type: "RESTRUCTURE_RESUME", jobId: job.id })
                }
                className="rounded-sm bg-primary px-2 py-1 text-xs font-medium text-primary-foreground outline-hidden hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={() =>
                  void intent({ type: "RESTRUCTURE_CANCEL", jobId: job.id })
                }
                className="rounded-sm border border-destructive/40 px-2 py-1 text-xs text-destructive outline-hidden hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </div>
          )}
        </section>
      )}

      {phase.kind === "active" && phase.diff !== undefined && (
        <>
          <DiffList
            diff={phase.diff}
            selectedIds={effectiveSelectedIds}
            onToggle={handleToggle}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
          />
          <button
            type="button"
            disabled={selectedMovesCount === 0}
            onClick={() =>
              setPhase({ kind: "arm_apply", job: phase.job, diff: phase.diff! })
            }
            className="w-fit rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply selected moves ({selectedMovesCount})…
          </button>
        </>
      )}
      {phase.kind === "arm_apply" && (
        <section
          aria-label="Confirm apply"
          className="space-y-2 rounded-sm border border-destructive/50 p-2"
        >
          <p className="text-xs">
            {selectedMovesCount === 0
              ? "No moves selected."
              : `Move ${selectedMovesCount} selected bookmark${selectedMovesCount === 1 ? "" : "s"} into the proposed folders? This creates new folders in your library.`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              // Autofocus keeps keyboard flow: confirm lands on focus.
              autoFocus
              disabled={selectedMovesCount === 0 || applying}
              onClick={() =>
                void confirmApply(
                  phase.job,
                  phase.diff,
                  activeMoves
                    .filter((m) => effectiveSelectedIds.has(m.bookmarkId))
                    .map((m) => m.bookmarkId),
                )
              }
              className="rounded-sm bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Yes, apply
            </button>
            <button
              type="button"
              onClick={() =>
                setPhase({ kind: "active", job: phase.job, diff: phase.diff })
              }
              className="rounded-sm border border-border px-3 py-1.5 text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              Keep looking
            </button>
          </div>
        </section>
      )}
      {phase.kind === "applied" && (
        <p className="text-xs" aria-live="polite">
          Applied — {phase.moved} bookmark{phase.moved === 1 ? "" : "s"} moved.
          Use Undo to roll it back.
        </p>
      )}

      <CostConfirmationDialog
        open={phase.kind === "confirm_cost"}
        featureLabel="restructure proposal"
        destinationOrigin={
          phase.kind === "confirm_cost" ? phase.destinationOrigin : ""
        }
        onCancel={() => setPhase({ kind: "idle" })}
        onConfirm={() => {
          if (phase.kind === "confirm_cost") void start(true, phase.approval);
        }}
      />
      {phase.kind === "consent" && (
        <FeatureConsentDialog
          key={JSON.stringify(phase.consent)}
          consent={phase.consent}
          onCancel={() => setPhase({ kind: "idle" })}
          onApproved={(approval) => start(false, approval)}
        />
      )}
    </div>
  );
}
