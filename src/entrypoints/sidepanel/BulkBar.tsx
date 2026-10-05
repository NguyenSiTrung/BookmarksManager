import { useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../db/database";
import { deleteMetaByIds } from "../../db/meta";
import { estimateJobCost } from "../../jobs/estimate";
import { MAX_JOB_BOOKMARK_IDS } from "../../schemas/job";
import type { Job as JobDocument, JobCostEstimate } from "../../schemas/job";
import { Category } from "../../schemas/bookmark";
import type { UndoMeta, UndoNode } from "../../schemas/undo";
import { removeTree } from "../../sync/mutations";
import type { FlattenedTree } from "../../sync/tree";
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkSetCategory,
} from "../../sync/tag-ops";
import { captureSubtree, pushSnapshot } from "../../undo/snapshot";
import { discardById } from "../../undo/restore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/components/dropdown-menu";
import { useSelection } from "./BookmarkList";
import { sendDecisionMessage } from "./ReviewView";
import { DecisionMessage } from "../../messages/decisions";
import { errorMessage, useToast } from "./UndoToast";

/**
 * Selection action bar (appears whenever `useSelection()` holds ≥1 id) plus
 * the undoable delete helper the rest of the panel reuses.
 *
 *  - {@link deleteNodesWithUndo} is the shared delete path: every id is
 *    deep-captured (`captureSubtree` — folders keep their whole subtree and
 *    meta rows), ONE `delete` snapshot is pushed BEFORE the first removal,
 *    then each node is removed through `removeTree`. Meta rows for the
 *    removed subtrees are deleted explicitly (the worker's `onRemoved`
 *    cascade is the second, idempotent pass) because the snapshot already
 *    holds the pre-delete rows for undo. A fully rejected delete discards
 *    the snapshot again — nothing to undo.
 *  - Bar actions run the corresponding mutation/tag-op over the selected
 *    ids and report the `{affected}` count in the toast: Move to… (dialog
 *    owned by the shell), Delete, Analyze, Add tag, Remove tag, Set
 *    category, Clear selection. Analyze routes through the job queue: it
 *    filters the selection down to bookmarks (folders are not analyzable),
 *    refuses a work set over the protocol cap (`MAX_JOB_BOOKMARK_IDS`), and
 *    opens a confirm dialog showing `estimateJobCost`'s lower bound before
 *    anything is sent; confirm dispatches ONE `JOB_START`
 *    (`analyze_selection`) and the bar streams the LATEST analyze_selection
 *    job row live (ScanPanel's model — a remounted bar re-attaches to a job
 *    still running from an earlier mount): a compact status line with
 *    Pause/Resume/Cancel while the job is non-terminal and a dismiss on a
 *    terminal state. A failed row read fails closed — the launcher stays
 *    disabled and the card reports "status unavailable" rather than freeing
 *    a second enqueue. The card follows the bar's visibility: a cleared
 *    selection hides it, the job keeps running, and the card returns with
 *    the next selection. Delete and Move are greyed out when NO
 *    selected row is mutable (every selected id is managed, per the
 *    optional `tree` prop) — the policy wall the mutation service would
 *    reject anyway.
 *  - Selection policy (documented): Delete and Move CLEAR the selection —
 *    deleted ids leave every view, and a move may leave the current view
 *    too; tag/category ops PRESERVE it so the user can chain edits. "Clear
 *    selection" is always explicit.
 */

/** `deleteNodesWithUndo` result — counts plus the first typed failure. */
export interface DeleteNodesResult {
  /** Top-level nodes the service actually removed. */
  deleted: number;
  /** Requested ids that could not be removed. */
  failed: number;
  /** First typed failure message, when any. */
  error?: string;
  /**
   * The undo row this delete pushed, when `deleted > 0` (D07): callers put
   * it on the toast so Undo replays THIS snapshot regardless of stack head.
   */
  snapshotId?: number;
}

/** Every id inside a captured undo node, depth-first. */
function undoNodeIds(node: UndoNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of node.children ?? []) undoNodeIds(child, into);
  return into;
}

/**
 * Delete `ids` (bookmarks and/or folders) undoably. Snapshots first, removes
 * through the guarded service, and cascades the meta rows for what actually
 * left the tree. Total: never throws.
 */
export async function deleteNodesWithUndo(
  ids: readonly string[],
): Promise<DeleteNodesResult> {
  try {
    const nodes: UndoNode[] = [];
    const meta: UndoMeta[] = [];
    for (const id of new Set(ids)) {
      const capture = await captureSubtree(id);
      if (capture === undefined) continue; // gone, or a fixed root
      nodes.push(capture.node);
      meta.push(...capture.meta);
    }
    if (nodes.length === 0) {
      return {
        deleted: 0,
        failed: ids.length,
        error: "Nothing to delete — the items may already be gone.",
      };
    }
    const snapshotId = await pushSnapshot({ kind: "delete", nodes, meta });

    const removedIds: string[] = [];
    let deleted = 0;
    let firstError: string | undefined;
    for (const node of nodes) {
      try {
        await removeTree(node.id);
        deleted += 1;
        undoNodeIds(node, removedIds);
      } catch (cause) {
        firstError ??= errorMessage(cause);
      }
    }
    if (removedIds.length > 0) {
      try {
        await deleteMetaByIds(removedIds);
      } catch {
        // The worker's onRemoved cascade is the idempotent second pass.
      }
    }
    if (deleted === 0) {
      // Nothing left the tree — drop THIS snapshot by id instead of wedging
      // the stack head with an unreplayable no-op. By-id keeps the discard
      // from popping an unrelated snapshot a concurrent flow pushed on top.
      await discardById(snapshotId);
      return {
        deleted: 0,
        failed: ids.length,
        error: firstError ?? "Delete failed.",
      };
    }
    return {
      deleted,
      failed: ids.length - deleted,
      error: firstError,
      snapshotId,
    };
  } catch (cause) {
    return { deleted: 0, failed: ids.length, error: errorMessage(cause) };
  }
}

/** User-visible summary of a delete result (the toast message). */
export function deleteResultMessage(result: DeleteNodesResult): string {
  if (result.deleted === 0) {
    return `Delete failed${result.error === undefined ? "." : `: ${result.error}`}`;
  }
  const noun = result.deleted === 1 ? "bookmark" : "bookmarks";
  const base = `Deleted ${result.deleted} ${noun}`;
  if (result.failed === 0) return base;
  return `${base} — ${result.failed} failed${
    result.error === undefined ? "" : `: ${result.error}`
  }`;
}

export interface BulkBarProps {
  /** Opens the shell's "Move to…" dialog for the current selection. */
  onMoveRequest?: (ids: readonly string[]) => void;
  /**
   * The live flattened tree — used to grey out Delete/Move when every
   * selected row is managed (no selected row is mutable). Optional so the
   * bar stays renderable in isolation; without it the actions stay enabled.
   */
  tree?: FlattenedTree;
}

const barButtonClass =
  "rounded-sm px-2 py-1 text-xs outline-hidden " +
  "hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:pointer-events-none disabled:opacity-50";

export function BulkBar({ onMoveRequest, tree }: BulkBarProps) {
  const selection = useSelection();
  const toast = useToast();
  const [tagPrompt, setTagPrompt] = useState<"add" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * U02: Analyze's confirm payload — the analyzable ids frozen at open plus
   * the pre-start estimate (null when no `tree` prop, so a bare bar still
   * confirms by count). `null` = closed.
   */
  const [analyzeConfirm, setAnalyzeConfirm] = useState<{
    ids: readonly string[];
    estimate: JobCostEstimate | null;
  } | null>(null);
  /**
   * Synchronous re-entrancy guard for the analyze intent (the I02 lesson):
   * `analyzeBusy` state lags one render behind a double-click; the ref is
   * flipped inside the handler before the first await. Both clear in
   * `finally` so a thrown send can never wedge the bar.
   */
  const analyzeBusyRef = useRef(false);
  const [analyzeBusy, setAnalyzeBusy] = useState(false);
  /**
   * A terminal analyze row the user dismissed. Local by design: the bar
   * never deletes job rows, and a NEW row (a later start, or one started
   * elsewhere) shows regardless — the id comparison dismisses exactly one.
   */
  const [dismissedAnalyzeJobId, setDismissedAnalyzeJobId] = useState<
    string | null
  >(null);
  /**
   * The latest `analyze_selection` row is the card's source of truth
   * (ScanPanel's model): a remounted bar re-attaches to a job still
   * running from an earlier mount instead of orphaning its controls.
   */
  const analyzeJobRead = useLiveQuery(latestAnalyzeSelectionJob, []);
  const analyzeReadFailed = analyzeJobRead === JOB_READ_FAILED;
  /**
   * The failed-read card can be dismissed; the flag resets as soon as the
   * read recovers so a LATER failure surfaces again. Render-adjusted state
   * (React's "you might not need an effect" pattern): the transition out
   * of read-failed is the reset signal, applied during render rather than
   * in an effect.
   */
  const [readFailureDismissed, setReadFailureDismissed] = useState(false);
  const [prevAnalyzeReadFailed, setPrevAnalyzeReadFailed] = useState(
    analyzeReadFailed,
  );
  if (prevAnalyzeReadFailed !== analyzeReadFailed) {
    setPrevAnalyzeReadFailed(analyzeReadFailed);
    if (!analyzeReadFailed) setReadFailureDismissed(false);
  }
  const analyzeJob =
    analyzeReadFailed || analyzeJobRead === undefined
      ? null
      : analyzeJobRead;
  const showAnalyzeCard =
    analyzeJob !== null &&
    (!isTerminalJob(analyzeJob.status) ||
      analyzeJob.id !== dismissedAnalyzeJobId);
  /**
   * One live launcher at a time (ScanPanel's rule): Analyze stays disabled
   * while the row read is pending (`undefined` — a fresh mount or the gap
   * right after JOB_START), while the read FAILED (fail-closed: the job
   * may still be running), or while the live row is non-terminal.
   */
  const analyzeDisabled =
    busy ||
    analyzeBusy ||
    analyzeJobRead === undefined ||
    analyzeReadFailed ||
    (analyzeJob !== null && !isTerminalJob(analyzeJob.status));

  const count = selection.selectedIds.size;
  const ids = [...selection.selectedIds];

  if (count === 0) return null;

  // At least one selected row must be mutable for Delete/Move to do
  // anything — a managed selection is a policy wall (the service rejects it
  // too), so the buttons are greyed out rather than firing a doomed call.
  const anyMutable =
    tree === undefined ||
    ids.some((id) => {
      const node = tree.bookmarks.get(id) ?? tree.folders.get(id);
      return node !== undefined && !node.isManaged;
    });
  const moveDeleteDisabled = busy || !anyMutable;

  const handleDelete = async (): Promise<void> => {
    setBusy(true);
    const result = await deleteNodesWithUndo(ids);
    setBusy(false);
    toast.showToast({
      message: deleteResultMessage(result),
      undoable: result.deleted > 0,
      error: result.deleted === 0,
    });
    if (result.deleted > 0) selection.clear();
  };

  /**
   * U02 analyze action: open the confirm dialog instead of sending. Only
   * bookmark ids are analyzable — folder ids are filtered out (the queue
   * would fail them item-by-item); a folder-only selection is rejected up
   * front. A selection over the protocol cap is rejected BEFORE any send —
   * `JOB_START` refuses it anyway, and a queued 50k+ bookmark payload is
   * never honest UI. The estimate folds the same minimized `{id,title,url}`
   * rows the ScanPanel uses; without a `tree` prop the confirm still shows
   * the count (no estimate).
   */
  const handleAnalyze = (): void => {
    if (analyzeBusyRef.current) return;
    const analyzableIds =
      tree === undefined
        ? ids
        : ids.filter((id) => tree.bookmarks.has(id));
    if (analyzableIds.length === 0) {
      toast.showToast({
        message:
          "Nothing analyzable in the selection — folders have no page to scan.",
        error: true,
      });
      return;
    }
    if (analyzableIds.length > MAX_JOB_BOOKMARK_IDS) {
      toast.showToast({
        message: `Selection too large — analyze at most ${NUMBER_FORMAT.format(
          MAX_JOB_BOOKMARK_IDS,
        )} bookmarks at once.`,
        error: true,
      });
      return;
    }
    const estimate =
      tree === undefined
        ? null
        : estimateJobCost({
            bookmarks: analyzableIds.map((id) => {
              const bookmark = tree.bookmarks.get(id);
              return {
                id,
                title: bookmark?.title ?? "",
                url: bookmark?.url ?? "",
              };
            }),
            kind: "analyze_selection",
          });
    setAnalyzeConfirm({ ids: analyzableIds, estimate });
  };

  /**
   * The confirm's affirmative: ONE `JOB_START` for the frozen analyzable
   * ids (`analyze_selection` — categorize + tags, no near-duplicate phase).
   * The dialog is closed before dispatch and the ref guards the send, so a
   * double-click can only ever enqueue one job. Success tracks the replied
   * job row; the row itself (not the reply) drives the status card.
   */
  const handleAnalyzeConfirm = async (): Promise<void> => {
    if (analyzeConfirm === null || analyzeBusyRef.current) return;
    const pending = analyzeConfirm;
    setAnalyzeConfirm(null);
    analyzeBusyRef.current = true;
    setAnalyzeBusy(true);
    try {
      const result = await sendDecisionMessage(
        DecisionMessage.parse({
          type: "JOB_START",
          kind: "analyze_selection",
          bookmarkIds: [...pending.ids],
        }),
      );
      if (!result.ok) {
        toast.showToast({ message: result.message, error: true });
        return;
      }
      if (result.code !== "job_ok") {
        toast.showToast({ message: UNEXPECTED_REPLY_MESSAGE, error: true });
        return;
      }
      // A fresh start supersedes any dismissed terminal row.
      setDismissedAnalyzeJobId(null);
      toast.showToast({
        message: `Analysis started — ${pending.ids.length} bookmark${
          pending.ids.length === 1 ? "" : "s"
        } queued.`,
      });
    } finally {
      analyzeBusyRef.current = false;
      setAnalyzeBusy(false);
    }
  };

  /** Pause/Resume/Cancel for the tracked analyze job — same reply contract as the start. */
  const handleJobControl = async (
    type: "JOB_PAUSE" | "JOB_RESUME" | "JOB_CANCEL",
  ): Promise<void> => {
    if (analyzeJob === null || analyzeBusyRef.current) return;
    analyzeBusyRef.current = true;
    setAnalyzeBusy(true);
    try {
      const result = await sendDecisionMessage(
        DecisionMessage.parse({ type, jobId: analyzeJob.id }),
      );
      if (!result.ok) {
        toast.showToast({ message: result.message, error: true });
        return;
      }
      if (result.code !== "job_ok") {
        toast.showToast({ message: UNEXPECTED_REPLY_MESSAGE, error: true });
      }
      // Success needs no local action — the live row is the source of truth.
    } finally {
      analyzeBusyRef.current = false;
      setAnalyzeBusy(false);
    }
  };

  const handleSetCategory = async (
    category: Category | null,
  ): Promise<void> => {
    const result = await bulkSetCategory(ids, category);
    if (!result.ok) {
      toast.showToast({ message: result.message, error: true });
      return;
    }
    const noun = result.affected === 1 ? "bookmark" : "bookmarks";
    toast.showToast({
      message:
        category === null
          ? `Cleared category on ${result.affected} ${noun}`
          : `Set category to ${category} on ${result.affected} ${noun}`,
    });
    // Selection preserved — the user can chain further edits.
  };

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className={
        "flex shrink-0 flex-wrap items-center gap-1 border-t border-border " +
        "px-2 py-1"
      }
    >
      <span className="mr-auto text-xs font-medium">{count} selected</span>
      <button
        type="button"
        disabled={moveDeleteDisabled}
        onClick={() => onMoveRequest?.(ids)}
        className={barButtonClass}
      >
        Move to…
      </button>
      <button
        type="button"
        disabled={moveDeleteDisabled}
        onClick={() => void handleDelete()}
        className={barButtonClass}
      >
        Delete
      </button>
      <button
        type="button"
        disabled={analyzeDisabled}
        onClick={() => handleAnalyze()}
        className={barButtonClass}
      >
        Analyze
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setTagPrompt("add")}
        className={barButtonClass}
      >
        Add tag
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setTagPrompt("remove")}
        className={barButtonClass}
      >
        Remove tag
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled={busy} className={barButtonClass}>
            Set category
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {Category.options.map((category) => (
            <DropdownMenuItem
              key={category}
              onSelect={() => void handleSetCategory(category)}
            >
              {category.charAt(0).toUpperCase() + category.slice(1)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSetCategory(null)}>
            No category
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={() => selection.clear()}
        className={barButtonClass}
      >
        Clear selection
      </button>
      {analyzeReadFailed && !readFailureDismissed && (
        <div
          role="status"
          aria-label="Selection analysis"
          className="flex w-full flex-wrap items-center gap-2 pt-1"
        >
          <span className="text-xs font-medium">
            Analysis: status unavailable
          </span>
          <span className="text-xs text-muted-foreground">
            the job may still be running
          </span>
          <button
            type="button"
            onClick={() => {
              // Hiding only dismisses the notice — the job itself is
              // unaffected; the card returns if the read keeps failing.
              setReadFailureDismissed(true);
            }}
            className={barButtonClass}
          >
            Dismiss
          </button>
        </div>
      )}
      {showAnalyzeCard && analyzeJob !== null && (
        <div
          role="status"
          aria-label="Selection analysis"
          className="flex w-full flex-wrap items-center gap-2 pt-1"
        >
          <span className="text-xs font-medium">
            Analysis: {JOB_STATUS_LABEL[analyzeJob.status]}
          </span>
          {analyzeJob.progress.totalBatches > 0 && (
            <span className="text-xs text-muted-foreground">
              {analyzeJob.progress.processedCount} processed
            </span>
          )}
          {analyzeJob.status === "failed" &&
            analyzeJob.error !== undefined && (
              <span role="alert" className="text-xs text-destructive">
                {analyzeJob.error}
              </span>
            )}
          {(analyzeJob.status === "pending" ||
            analyzeJob.status === "running") && (
            <button
              type="button"
              disabled={analyzeBusy}
              onClick={() => void handleJobControl("JOB_PAUSE")}
              className={barButtonClass}
            >
              Pause
            </button>
          )}
          {(analyzeJob.status === "paused" ||
            analyzeJob.status === "failed") && (
            <button
              type="button"
              disabled={analyzeBusy}
              onClick={() => void handleJobControl("JOB_RESUME")}
              className={barButtonClass}
            >
              Resume
            </button>
          )}
          {!isTerminalJob(analyzeJob.status) && (
            <button
              type="button"
              disabled={analyzeBusy}
              onClick={() => void handleJobControl("JOB_CANCEL")}
              className={barButtonClass}
            >
              Cancel
            </button>
          )}
          {isTerminalJob(analyzeJob.status) && (
            <button
              type="button"
              onClick={() => setDismissedAnalyzeJobId(analyzeJob.id)}
              className={barButtonClass}
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {analyzeConfirm !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setAnalyzeConfirm(null);
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Analyze {analyzeConfirm.ids.length} bookmark{analyzeConfirm.ids.length === 1 ? "" : "s"}?</DialogTitle>
              <DialogDescription>
                Categorize and tag the selected bookmarks, then list the
                suggestions in Review.
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-muted-foreground" data-testid="analyze-estimate">
              {analyzeConfirm.estimate === null
                ? `${analyzeConfirm.ids.length} bookmark${
                    analyzeConfirm.ids.length === 1 ? "" : "s"
                  } · estimate unavailable`
                : `${analyzeConfirm.estimate.requests} AI request${
                    analyzeConfirm.estimate.requests === 1 ? "" : "s"
                  } · ~${NUMBER_FORMAT.format(
                    analyzeConfirm.estimate.inputTokens,
                  )} tokens, likely more`}
            </p>
            <DialogFooter>
              <button
                type="button"
                onClick={() => setAnalyzeConfirm(null)}
                className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={analyzeBusy}
                onClick={() => void handleAnalyzeConfirm()}
                className={
                  "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
                  "text-primary-foreground disabled:opacity-50"
                }
              >
                Analyze
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {tagPrompt !== null && (
        <TagPromptDialog
          mode={tagPrompt}
          ids={ids}
          onClose={() => setTagPrompt(null)}
        />
      )}
    </div>
  );
}

const UNEXPECTED_REPLY_MESSAGE =
  "The extension worker returned an unexpected reply.";

/**
 * Sentinel for a FAILED job-row read — deliberately distinct from "no row"
 * (`null`): a failed read means the row's state is unknown (fail-closed),
 * so the launcher stays disabled and the card reports it instead of
 * freeing a second enqueue while a job may still be running.
 */
const JOB_READ_FAILED = "job_read_failed" as const;
type AnalyzeJobRead = JobDocument | null | typeof JOB_READ_FAILED;

/**
 * The latest `analyze_selection` row by `createdAt` — `null` when none
 * exists, `JOB_READ_FAILED` when the read threw (dexie-react-hooks
 * rethrows querier errors into the render, so a failed read must degrade
 * to the sentinel rather than throwing).
 */
async function latestAnalyzeSelectionJob(): Promise<AnalyzeJobRead> {
  const row = await db.jobs
    .orderBy("createdAt")
    .filter((row) => row.kind === "analyze_selection")
    .last()
    .catch(() => JOB_READ_FAILED);
  return row ?? null;
}

/** Pinned locale so the cap and token figures format identically everywhere. */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/** Human label per `JobStatus`; the card reads "Analysis: <label>". */
const JOB_STATUS_LABEL: Record<JobDocument["status"], string> = {
  pending: "Queued",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
  failed: "Failed",
};

/** True for a status the job can still continue from. */
function isTerminalJob(status: JobDocument["status"]): boolean {
  return (
    status === "completed" || status === "canceled" || status === "failed"
  );
}

/**
 * Small prompt for the bar's tag actions: takes a tag NAME, resolves/creates
 * the definition through tag-ops (`bulkAddTag`), and reports the affected
 * count. Mounted only while open, so its input state is fresh each time.
 */
function TagPromptDialog({
  mode,
  ids,
  onClose,
}: {
  mode: "add" | "remove";
  ids: readonly string[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const label = name.trim();
    if (label === "") return;
    setBusy(true);
    setError(null);
    const result =
      mode === "add"
        ? await bulkAddTag(ids, label)
        : await bulkRemoveTag(ids, label);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      toast.showToast({ message: result.message, error: true });
      return;
    }
    const noun = result.affected === 1 ? "bookmark" : "bookmarks";
    toast.showToast({
      message:
        mode === "add"
          ? `Added tag “${label}” to ${result.affected} ${noun}`
          : `Removed tag “${label}” from ${result.affected} ${noun}`,
    });
    onClose();
  };

  const heading = mode === "add" ? "Add tag" : "Remove tag";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "Add a tag to every selected bookmark. New names create a tag definition."
              : "Remove a tag from every selected bookmark that carries it."}
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="tag-name" className="text-sm font-medium">
          Tag name
        </label>
        <input
          id="tag-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || name.trim() === ""}
            onClick={() => void submit()}
            className={
              "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
              "text-primary-foreground disabled:opacity-50"
            }
          >
            {heading}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
