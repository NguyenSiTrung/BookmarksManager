import { useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  AUTO_APPLY_THRESHOLD,
  REVIEW_FLOOR,
} from "../../decisions/policy";
import { isLegalTransition } from "../../decisions/store";
import type { DecisionRow } from "../../decisions/store";
import {
  DecisionMessage,
  DecisionMessageResult,
} from "../../messages/decisions";
import {
  LlmFeatureMessage,
  LlmFeatureMessageResult,
} from "../../messages/llm-features";
import { CostConfirmationDialog } from "../../ui/components/CostConfirmationDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import { FeatureConsentDialog } from "../../ui/components/FeatureConsentDialog";
import type { FeatureConsentApproval, FeatureConsentDisclosure } from "../../schemas/feature-consent";
import type { Decision } from "../../schemas/decision";
import type { DecisionStatus } from "../../schemas/audit";
import type { FlattenedTree } from "../../sync/tree";
import { cn } from "../../ui/lib/cn";
import { useToast } from "./UndoToast";

/**
 * The review queue (spec FR10 "a Review view with confidence shading,
 * approve, reject, bulk approve, and undo"): one row per pending §7
 * `Decision`, in `createdAt` order, with a kind label, the affected
 * bookmark titles resolved through the live tree, a payload summary, and a
 * confidence band chip — the shading is never color-only.
 *
 * Design rules:
 *
 * - **Dexie in, messages out.** Rows arrive via the `decisions` prop — App
 *   streams `listPending()` through `useLiveQuery`, so the queue re-renders
 *   on every worker write; this component performs no storage reads itself
 *   (the `DuplicatesView` precedent). Every mutation is a
 *   decisions-protocol intent through {@link sendDecisionMessage} —
 *   APPROVE/REJECT/REVERT per row and ONE `BULK_APPROVE` for the selection
 *   — and every reply is validated by `DecisionMessageResult.safeParse`.
 *   An `{ok:false}` reply renders its (already redacted) `message`
 *   verbatim, on the row AND in the toast.
 * - **Selection is local.** The review queue is not the bookmark list, so
 *   `useBookmarkSelection` does not apply: the simpler mechanism here is a
 *   per-row checkbox (`Set<string>` of decision ids), pruned to rows still
 *   in the queue — the same pruning rule the bookmark selection applies to
 *   ids that leave the view. With an empty selection the toolbar button is
 *   "Approve all".
 * - **Legal moves only.** Approve renders only when the row's status can
 *   legally reach `applied`, Reject when it can reach `rejected`, and Undo
 *   when it can reach `reverted` — `isLegalTransition` from the store is
 *   the source of truth, mirrored so the UI never offers a move the store
 *   would refuse. The queue lists `pending` rows; the gating keeps
 *   `unsure`/`approved` rows correct if the query ever widens, and an
 *   `applied`/`auto_applied` row would get the Undo affordance.
 * - **Undo rides the toast.** A successful approve shows the shell's undo
 *   toast and then arms it through `onApplied`: the toast's Undo sends
 *   `REVERT_DECISION` for that decision (the worker replays the snapshot it
 *   recorded on the row) instead of popping the generic snapshot stack. A
 *   bulk approve goes through the same door with `REVERT_BATCH` over the
 *   applied ids — every row replays its own snapshot, so the batch undoes
 *   whole without an aggregate snapshot kind.
 * - **Bulk approve is confirmed first (U01).** "Approve all/selected"
 *   opens a count + per-kind dialog; only its Apply dispatches
 *   `BULK_APPROVE`. Esc/overlay/X/Cancel all close it as a cancel —
 *   nothing applies.
 * - **Stale rows are marked, not hidden.** A decision whose bookmark id no
 *   longer resolves in the live tree shows a "Stale" affordance; the
 *   worker's own staleness guard stays the authority, so Approve remains
 *   available and a refusal lands on the row.
 * - **Placeholder rows are excluded, not marked.** A `pending` decision the
 *   quick-save popup persisted through SAVE_SUGGEST is keyed by a synthetic
 *   `popup:<uuid>` bookmark id — a bookmark that is NOT saved yet and never
 *   will be under that id. There is no target to approve, reject, or revert,
 *   so such rows are filtered out of the queue entirely (see
 *   {@link reviewQueue}); the toolbar reports how many are waiting so the
 *   count is never silently wrong. This is deliberately NOT the stale rule:
 *   a stale row names a real bookmark the worker can refuse, while a
 *   placeholder names nothing at all.
 * - **Keyboard.** The list is a `role="listbox"` (`aria-multiselectable`)
 *   with a roving tabindex over `role="option"` rows: arrows/Home/End move
 *   focus, Space toggles the focused row's selection, and every action is a
 *   real button.
 */

/**
 * Lazy slice of `chrome`: only `runtime.sendMessage`. Resolved at call time
 * so `vi.stubGlobal("chrome", …)` interposes correctly in tests; a missing
 * or partial surface degrades to a protocol-shaped `{ok:false}` instead of
 * a throw.
 */
declare const chrome: {
  runtime?: {
    sendMessage?(message: unknown): Promise<unknown>;
  } | null;
};

const NO_WORKER_MESSAGE =
  "The extension worker is not reachable — nothing was changed.";
const UNEXPECTED_REPLY_MESSAGE =
  "The extension worker returned an unexpected reply.";

/**
 * Send one decisions-protocol intent and validate the reply. Never throws
 * and never fabricates: a missing runtime, a rejected `sendMessage`, or a
 * reply that fails the wire schema collapses to a `{ok:false}` result so
 * the caller can render `message` verbatim exactly like a worker error.
 */
export async function sendDecisionMessage(
  message: DecisionMessage,
): Promise<DecisionMessageResult> {
  let raw: unknown;
  try {
    const runtime = chrome.runtime;
    const send = runtime?.sendMessage;
    if (send === undefined) {
      return {
        ok: false,
        code: "internal_error",
        message: NO_WORKER_MESSAGE,
      };
    }
    raw = await send.call(runtime, message);
  } catch {
    return {
      ok: false,
      code: "internal_error",
      message: NO_WORKER_MESSAGE,
    };
  }
  const parsed = DecisionMessageResult.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "internal_error",
      message: UNEXPECTED_REPLY_MESSAGE,
    };
  }
  return parsed.data;
}

/**
 * Send one LLM-feature intent and validate the reply — the same
 * never-throw/never-fabricate rules as {@link sendDecisionMessage}, against
 * the feature protocol's result union.
 */
export async function sendLlmFeatureMessage(
  message: LlmFeatureMessage,
): Promise<LlmFeatureMessageResult> {
  let raw: unknown;
  try {
    const runtime = chrome.runtime;
    const send = runtime?.sendMessage;
    if (send === undefined) {
      return {
        ok: false,
        code: "internal_error",
        message: NO_WORKER_MESSAGE,
      };
    }
    raw = await send.call(runtime, message);
  } catch {
    return {
      ok: false,
      code: "internal_error",
      message: NO_WORKER_MESSAGE,
    };
  }
  const parsed = LlmFeatureMessageResult.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "internal_error",
      message: UNEXPECTED_REPLY_MESSAGE,
    };
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Analyze reporting — shared by the per-row action (App) and BulkBar
// ---------------------------------------------------------------------------

/** Outcome of one ANALYZE_BOOKMARK exchange, distilled for reporting. */
export type AnalyzeOutcome =
  | { kind: "sent"; decisionCount: number }
  | { kind: "skipped"; reason: "blocklisted" | undefined }
  | { kind: "failed"; message: string };

/**
 * Fold a validated reply into its analyze outcome. `analyze_ok` is the only
 * success shape an ANALYZE_BOOKMARK can legitimately return; anything else
 * is reported as a failure rather than misread.
 */
export function analyzeOutcome(
  result: DecisionMessageResult,
): AnalyzeOutcome {
  if (!result.ok) return { kind: "failed", message: result.message };
  if (result.code !== "analyze_ok") {
    return { kind: "failed", message: UNEXPECTED_REPLY_MESSAGE };
  }
  if (result.result.sent) {
    return { kind: "sent", decisionCount: result.result.decisionCount };
  }
  return { kind: "skipped", reason: result.result.reason };
}

/** Toast text for a single-bookmark analyze, naming the bookmark. */
export function analyzeResultMessage(
  label: string,
  result: DecisionMessageResult,
): string {
  const outcome = analyzeOutcome(result);
  switch (outcome.kind) {
    case "sent": {
      const count = outcome.decisionCount;
      return `Analyzed “${label}” — ${count} suggestion${
        count === 1 ? "" : "s"
      }`;
    }
    case "skipped":
      return outcome.reason === "blocklisted"
        ? `Skipped “${label}” — it is on the blocklist.`
        : `Skipped “${label}” — nothing was sent.`;
    case "failed":
      return outcome.message;
  }
}

// ---------------------------------------------------------------------------
// Non-actionable rows — save-suggest placeholders
// ---------------------------------------------------------------------------

/**
 * Synthetic bookmark-id namespaces. `SAVE_SUGGEST` persists a `pending`
 * decision for a bookmark the quick-save popup holds but that has NOT been
 * saved yet, keyed by a placeholder id in the `popup:<uuid>` namespace. That
 * id can never resolve to a live Chrome node — nothing could ever be applied
 * for it — so a decision referencing one is not actionable.
 */
const SYNTHETIC_BOOKMARK_ID_PREFIXES = ["popup:"] as const;

/** True for a placeholder id that can never be a live Chrome bookmark. */
export function isSyntheticBookmarkId(bookmarkId: string): boolean {
  return SYNTHETIC_BOOKMARK_ID_PREFIXES.some((prefix) =>
    bookmarkId.startsWith(prefix),
  );
}

/**
 * True when the decision targets a not-yet-saved placeholder bookmark, i.e.
 * it has no actionable target at all.
 */
export function isUnsavedDecision(row: DecisionRow): boolean {
  return row.bookmarkIds.some(isSyntheticBookmarkId);
}

/**
 * The actionable review queue: the pending decisions that reference a real
 * bookmark. Placeholder (`popup:`) rows are dropped rather than rendered as
 * a non-actionable variant — there is no bookmark for a stale-style
 * affordance to point at, and the popup's own save flow is where such a
 * suggestion is resolved. The shell mirrors this for the pending-count
 * badge, so the badge and the queue never disagree.
 */
export function reviewQueue(
  decisions: readonly DecisionRow[],
): DecisionRow[] {
  return decisions.filter((row) => !isUnsavedDecision(row));
}

// ---------------------------------------------------------------------------
// Confidence bands — shared with the §10.2 policy thresholds
// ---------------------------------------------------------------------------

/**
 * Confidence shading tiers, pinned to the policy breakpoints in
 * `src/decisions/policy.ts`: `high` is at-or-above the auto-apply bar
 * (0.85), `medium` is the review band (0.5–0.85), and `low` is anything the
 * policy would have marked `unsure` (< 0.5) — a pending row can still carry
 * it, so it shades distinctly rather than being hidden.
 */
export type ConfidenceBand = "high" | "medium" | "low";

/** Map a 0–1 confidence onto its band. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= AUTO_APPLY_THRESHOLD) return "high";
  if (confidence >= REVIEW_FLOOR) return "medium";
  return "low";
}

const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Row fill per band — always paired with the text chip and % value. */
const BAND_FILL: Record<ConfidenceBand, string> = {
  high: "bg-primary/10",
  medium: "bg-accent/60",
  low: "bg-transparent",
};

/** The confidence stripe at the row's leading edge (aria-hidden). */
const BAND_STRIPE: Record<ConfidenceBand, string> = {
  high: "bg-primary",
  medium: "bg-muted-foreground/60",
  low: "bg-border",
};

// ---------------------------------------------------------------------------
// Row presentation helpers
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<Decision["kind"], string> = {
  set_category: "Set category",
  add_tags: "Add tags",
  move: "Move",
  mark_dead: "Mark dead",
  merge_duplicates: "Merge duplicates",
  rename: "Rename",
  create_folder: "Create folder",
};

const MARK_DEAD_EVIDENCE_LABEL: Record<
  Extract<Decision, { kind: "mark_dead" }>["evidence"],
  string
> = {
  http: "HTTP error",
  soft_404: "soft 404",
  parked: "parked domain",
  login_wall: "login wall",
};

const secondaryButtonClass =
  "shrink-0 rounded-sm border border-border bg-background px-2 py-1 text-xs " +
  "outline-hidden hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/** Dialog confirm — same weight/shape as CostConfirmationDialog's. */
const primaryButtonClass =
  "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
  "text-primary-foreground hover:bg-primary/90 " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden disabled:opacity-50";

/** Dialog cancel — mirrors CostConfirmationDialog's bordered button. */
const dialogSecondaryClass =
  "rounded-md border border-input px-4 py-2 text-sm font-medium " +
  "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden disabled:opacity-50";

function displayTitle(title: string, url: string): string {
  return title === "" ? url : title;
}

/**
 * The kind-specific payload rendered as one line: "category: work",
 * "+tags a, b", "→ folder X", "keep “title”", "rename to “title”",
 * "new folder a / b", "mark dead (HTTP error)". Folder targets and kept
 * bookmarks resolve through the live tree; an unresolvable id falls back to
 * the raw id.
 */
function payloadSummary(row: DecisionRow, tree: FlattenedTree): string {
  switch (row.kind) {
    case "set_category":
      return `category: ${row.category}`;
    case "add_tags":
      return `+tags ${row.tags.join(", ")}`;
    case "move": {
      const folder = tree.folders.get(row.targetFolderId);
      const name =
        folder === undefined || folder.title === ""
          ? row.targetFolderId
          : folder.title;
      return `→ ${name}`;
    }
    case "mark_dead":
      return `mark dead (${MARK_DEAD_EVIDENCE_LABEL[row.evidence]})`;
    case "merge_duplicates": {
      const keep = tree.bookmarks.get(row.keepId);
      return `keep “${
        keep === undefined ? row.keepId : displayTitle(keep.title, keep.url)
      }”`;
    }
    case "rename":
      return `rename to “${row.newTitle}”`;
    case "create_folder":
      return `new folder ${row.path.join(" / ")}`;
  }
}

/** Bookmark titles for the row, joined; a missing id becomes a marker. */
function titleText(row: DecisionRow, tree: FlattenedTree): string {
  return row.bookmarkIds
    .map((id) => {
      const item = tree.bookmarks.get(id);
      return item === undefined
        ? `missing bookmark ${id}`
        : displayTitle(item.title, item.url);
    })
    .join(", ");
}

/**
 * True when the row references a bookmark the tree no longer has — any
 * affected id, plus the kept bookmark for a merge. Marked stale in the UI;
 * the worker's guard remains the final authority on approving it.
 */
function isStale(row: DecisionRow, tree: FlattenedTree): boolean {
  for (const id of row.bookmarkIds) {
    if (!tree.bookmarks.has(id)) return true;
  }
  return row.kind === "merge_duplicates" && !tree.bookmarks.has(row.keepId);
}

function statusAllows(row: DecisionRow, to: DecisionStatus): boolean {
  return isLegalTransition(row.status, to);
}

// ---------------------------------------------------------------------------
// ReviewView
// ---------------------------------------------------------------------------

export interface ReviewViewProps {
  /**
   * Pending decision rows — App streams `listPending()` through
   * `useLiveQuery`; any extra statuses that arrive are still gated through
   * `isLegalTransition`.
   */
  decisions: readonly DecisionRow[];
  /** Live flattened tree — bookmark titles and folder names resolve here. */
  tree: FlattenedTree;
  /**
   * Called after decisions successfully applied: arms the shell's undo
   * toast so its Undo sends `REVERT_DECISION` (one id) or `REVERT_BATCH`
   * (a bulk approve's applied ids). Optional — standalone renders still
   * get the undoable toast, and the ambient Undo handler decides what
   * runs.
   */
  onApplied?: (decisionIds: readonly string[]) => void;
  /**
   * Shown when the queue is empty. Defaults to the plain "No pending
   * suggestions" line.
   */
  empty?: ReactNode;
  className?: string;
}

export function ReviewView({
  decisions,
  tree,
  onApplied,
  empty,
  className,
}: ReviewViewProps) {
  const toast = useToast();
  // Placeholder (`popup:`) decisions are dropped before anything else — they
  // are not actionable, so they take part in neither the rows, the
  // selection, nor "approve all". `hiddenUnsaved` keeps the toolbar honest
  // about what was withheld.
  const queue = useMemo(() => reviewQueue(decisions), [decisions]);
  const hiddenUnsaved = decisions.length - queue.length;
  const rows = useMemo(
    () =>
      [...queue].sort(
        (a, b) =>
          a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? -1 : 1,
      ),
    [queue],
  );
  const rowIdSet = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.id, index));
    return map;
  }, [rows]);

  /**
   * The review-queue selection model (documented above): a Set of decision
   * ids behind per-row checkboxes, exposed PRUNED to rows still in the
   * queue — a decision that leaves (approved/rejected here, or changed by
   * the worker) drops out of `selectedIds` without an explicit clear.
   */
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const selectedIds = useMemo(() => {
    const pruned = new Set<string>();
    for (const id of checked) {
      if (rowIdSet.has(id)) pruned.add(id);
    }
    return pruned;
  }, [checked, rowIdSet]);

  /** Per-row in-flight intent — that row's buttons disable while it runs. */
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  // Rationales this session's Explain calls returned — rendered at once so
  // the answer is visible even before the Dexie live-query refresh lands.
  const [explanations, setExplanations] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());
  // A `confirmation_required` refusal parks the resend here until the user
  // confirms or cancels the one-shot unknown-cost dialog (spec FR7.8).
  const [confirming, setConfirming] = useState<{
    decisionId: string;
    origin: string;
    approval: FeatureConsentApproval;
  } | null>(null);
  const [consenting, setConsenting] = useState<{
    decisionId: string;
    consent: FeatureConsentDisclosure;
  } | null>(null);
  const explainingIds = useRef(new Set<string>());
  /** Row id → the redacted failure message it last reported. */
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const optionEls = useRef(new Map<string, HTMLElement>());

  /**
   * Roving-focus index, clamped at RENDER rather than in an effect: when
   * rows leave the queue a stored index could point past the end and NO row
   * would carry `tabIndex=0`, leaving the listbox keyboard-unreachable.
   * (BookmarkList clamps in an effect, but it is exempt from the
   * `set-state-in-effect` rule only because `useVirtualizer` makes the React
   * Compiler skip that component.)
   */
  const rovingIndex =
    rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1);

  const setBusy = (id: string, on: boolean): void => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const setFailure = (id: string, message: string | null): void => {
    setFailures((prev) => {
      const next = new Map(prev);
      if (message === null) next.delete(id);
      else next.set(id, message);
      return next;
    });
  };

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    setActiveIndex(clamped);
    optionEls.current.get(rows[clamped]?.id ?? "")?.focus();
  };

  const registerOption = (id: string, el: HTMLElement | null): void => {
    if (el === null) optionEls.current.delete(id);
    else optionEls.current.set(id, el);
  };

  /**
   * Run one per-row decision intent. `{ok:false}` replies land inline on
   * the row AND in the toast (verbatim, already redacted); a non-`decision_ok`
   * success shape is reported as unexpected rather than misread.
   */
  const runRowIntent = async (
    row: DecisionRow,
    intent: DecisionMessage,
  ): Promise<DecisionMessageResult> => {
    setBusy(row.id, true);
    const result = await sendDecisionMessage(intent);
    setBusy(row.id, false);
    if (!result.ok) {
      setFailure(row.id, result.message);
      toast.showToast({ message: result.message, error: true });
      return result;
    }
    if (result.code !== "decision_ok") {
      setFailure(row.id, UNEXPECTED_REPLY_MESSAGE);
      toast.showToast({ message: UNEXPECTED_REPLY_MESSAGE, error: true });
      return result;
    }
    setFailure(row.id, null);
    return result;
  };

  const handleApprove = async (row: DecisionRow): Promise<void> => {
    const result = await runRowIntent(
      row,
      DecisionMessage.parse({ type: "APPROVE_DECISION", decisionId: row.id }),
    );
    if (!result.ok || result.code !== "decision_ok") return;
    const status = result.decision.status;
    if (status === "applied" || status === "auto_applied") {
      // Show first, then arm: the shell disarms any stale revert target on
      // every new toast, so `onApplied` must run after the toast is up.
      toast.showToast({ message: "Applied the suggestion.", undoable: true });
      onApplied?.([row.id]);
    } else {
      toast.showToast({ message: `Suggestion moved to “${status}”.` });
    }
  };

  const handleReject = async (row: DecisionRow): Promise<void> => {
    const result = await runRowIntent(
      row,
      DecisionMessage.parse({ type: "REJECT_DECISION", decisionId: row.id }),
    );
    if (!result.ok || result.code !== "decision_ok") return;
    toast.showToast({ message: "Rejected the suggestion." });
  };

  const handleRevert = async (row: DecisionRow): Promise<void> => {
    const result = await runRowIntent(
      row,
      DecisionMessage.parse({ type: "REVERT_DECISION", decisionId: row.id }),
    );
    if (!result.ok || result.code !== "decision_ok") return;
    toast.showToast({ message: "Reverted the suggestion." });
  };

  /**
   * Explain one pending row. `confirmed` is the resend flag after the
   * cost dialog — it is the only path allowed to set `unknownCostConfirmed`.
   */
  const explain = async (
    decisionId: string,
    confirmed: boolean,
    approval?: FeatureConsentApproval,
  ): Promise<void> => {
    if (explainingIds.current.has(decisionId)) return;
    explainingIds.current.add(decisionId);
    setBusy(decisionId, true);
    const result = await sendLlmFeatureMessage(
      LlmFeatureMessage.parse({
        type: "LLM_EXPLAIN",
        decisionId,
        ...(confirmed ? { unknownCostConfirmed: true } : {}),
        ...(approval !== undefined ? { consentApproval: approval } : {}),
      }),
    );
    setBusy(decisionId, false);
    explainingIds.current.delete(decisionId);
    if (!result.ok) {
      if (result.code === "consent_required" && result.consent?.scope === "llm_explain") {
        setConfirming(null);
        setConsenting({ decisionId, consent: result.consent });
        return;
      }
      if (result.code === "confirmation_required" && result.consentApproval !== undefined) {
        setConfirming({
          decisionId,
          origin: result.destinationOrigin ?? "the configured provider",
          approval: result.consentApproval,
        });
        return;
      }
      setFailure(decisionId, result.message);
      toast.showToast({ message: result.message, error: true });
      return;
    }
    if (result.code !== "explain_ok") {
      setFailure(decisionId, UNEXPECTED_REPLY_MESSAGE);
      toast.showToast({ message: UNEXPECTED_REPLY_MESSAGE, error: true });
      return;
    }
    setFailure(decisionId, null);
    setExplanations((prev) => {
      const next = new Map(prev);
      next.set(decisionId, result.result.rationale);
      return next;
    });
    toast.showToast({ message: "Added an explanation." });
  };

  const handleExplain = (row: DecisionRow): void => {
    void explain(row.id, false);
  };

  /**
   * U01: Approve all/selected never sends directly — it opens the batch
   * confirm (count + per-kind breakdown) first. `bulkConfirm` holds the
   * frozen id list + label rows; Confirm dispatches the single
   * BULK_APPROVE, Cancel (or Esc/overlay close) applies nothing.
   */
  const [bulkConfirm, setBulkConfirm] = useState<{
    ids: string[];
    kinds: [string, number][];
  } | null>(null);
  /** Synchronous re-entrancy guard for the confirm's dispatch. */
  const bulkBusyRef = useRef(false);

  const handleBulkApprove = (): void => {
    const ids =
      selectedIds.size > 0 ? [...selectedIds] : rows.map((row) => row.id);
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    setBulkConfirm({ ids, kinds: [...counts.entries()] });
  };

  const handleBulkConfirm = async (): Promise<void> => {
    if (bulkConfirm === null || bulkBusyRef.current) return;
    bulkBusyRef.current = true;
    const ids = bulkConfirm.ids;
    setBulkConfirm(null);
    setBulkBusy(true);
    try {
      await dispatchBulkApprove(ids);
    } finally {
      bulkBusyRef.current = false;
      setBulkBusy(false);
    }
  };

  const dispatchBulkApprove = async (ids: readonly string[]): Promise<void> => {
    const result = await sendDecisionMessage(
      DecisionMessage.parse({ type: "BULK_APPROVE", decisionIds: [...ids] }),
    );
    if (!result.ok) {
      toast.showToast({ message: result.message, error: true });
      return;
    }
    if (result.code !== "bulk_ok") {
      toast.showToast({ message: UNEXPECTED_REPLY_MESSAGE, error: true });
      return;
    }
    const applied = result.applied.length;
    const failed = result.failed;
    if (failed.length > 0 || result.applied.length > 0) {
      setFailures((prev) => {
        const next = new Map(prev);
        for (const id of result.applied) next.delete(id);
        for (const entry of failed) next.set(entry.id, entry.message);
        return next;
      });
    }
    // U01: the batch gets an Undo too — the shell reverts every applied
    // row through REVERT_BATCH (each row replays its own recorded
    // snapshot). Partial failure still arms the applied subset: Undo
    // reverts what was applied, not what failed.
    toast.showToast({
      message:
        failed.length === 0
          ? `Applied ${applied} suggestion${applied === 1 ? "" : "s"}.`
          : `Applied ${applied} of ${ids.length} — ${failed.length} failed.`,
      error: failed.length > 0,
      undoable: applied > 0,
    });
    if (applied > 0) onApplied?.(result.applied);
  };

  const handleListKeyDown = (
    event: ReactKeyboardEvent<HTMLElement>,
  ): void => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const rowEl = target.closest<HTMLElement>("[data-decision-id]");
    const rowId = rowEl?.dataset.decisionId;
    const currentIndex =
      rowId === undefined ? -1 : (indexById.get(rowId) ?? -1);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(Math.min(currentIndex + 1, rows.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        if (currentIndex <= 0) {
          // Above the first row: back to the listbox itself (same rule as
          // BookmarkList).
          (event.currentTarget as HTMLElement).focus();
        } else {
          focusRow(currentIndex - 1);
        }
        break;
      case "Home":
        event.preventDefault();
        focusRow(0);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case " ":
        // Space toggles only when the ROW is focused — a focused inner
        // control (checkbox, button) keeps its native activation.
        if (rowEl !== null && target === rowEl && rowId !== undefined) {
          event.preventDefault();
          toggle(rowId);
        }
        break;
    }
  };

  const count = rows.length;
  const approveLabel =
    selectedIds.size > 0
      ? `Approve selected (${selectedIds.size})`
      : `Approve all (${count})`;

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <p className="mr-auto text-xs text-muted-foreground">
          {count} pending suggestion{count === 1 ? "" : "s"}
          {hiddenUnsaved > 0 && (
            <span className="ml-1 italic">
              · {hiddenUnsaved} waiting on an unsaved bookmark
            </span>
          )}
        </p>
        <button
          type="button"
          disabled={bulkBusy || count === 0}
          onClick={handleBulkApprove}
          className={secondaryButtonClass}
        >
          {approveLabel}
        </button>
      </div>
      <div
        role="listbox"
        aria-label="Pending suggestions"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto outline-hidden focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {count === 0 ? (
          (empty ?? (
            <p className="p-4 text-sm text-muted-foreground">
              No pending suggestions — the queue is empty.
            </p>
          ))
        ) : (
          rows.map((row, index) => (
            <ReviewRow
              key={row.id}
              row={row}
              tree={tree}
              index={index}
              setSize={count}
              active={index === rovingIndex}
              selected={selectedIds.has(row.id)}
              busy={busyIds.has(row.id) || bulkBusy}
              failure={failures.get(row.id)}
              explanation={explanations.get(row.id) ?? row.rationale}
              onRegister={registerOption}
              onSelect={(i) => {
                setActiveIndex(i);
                toggle(row.id);
              }}
              onToggle={toggle}
              onApprove={handleApprove}
              onReject={handleReject}
              onRevert={handleRevert}
              onExplain={handleExplain}
            />
          ))
        )}
      </div>
      <CostConfirmationDialog
        open={confirming !== null}
        featureLabel="Explain this suggestion"
        destinationOrigin={confirming?.origin ?? ""}
        onConfirm={() => {
          const pending = confirming;
          setConfirming(null);
          if (pending !== null) void explain(pending.decisionId, true, pending.approval);
        }}
        onCancel={() => setConfirming(null)}
      />
      {consenting !== null && (
        <FeatureConsentDialog
          key={JSON.stringify(consenting)}
          consent={consenting.consent}
          onCancel={() => setConsenting(null)}
          onApproved={async (approval) => {
            const decisionId = consenting.decisionId;
            setConsenting(null);
            await explain(decisionId, false, approval);
          }}
        />
      )}
      <Dialog
        open={bulkConfirm !== null}
        onOpenChange={(next) => {
          // Any close path (Esc, overlay, X) is a cancel — nothing applies.
          if (!next) setBulkConfirm(null);
        }}
      >
        <DialogContent showCloseButton={false} data-testid="bulk-approve-confirm">
          <DialogHeader>
            <DialogTitle>
              Apply {bulkConfirm?.ids.length ?? 0} suggestion
              {(bulkConfirm?.ids.length ?? 0) === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Every suggestion below applies at once. You can undo the whole
              batch afterwards.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {bulkConfirm?.kinds.map(([kind, count]) => (
              <li key={kind}>
                {count} × {KIND_LABELS[kind] ?? kind}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <button
              type="button"
              className={dialogSecondaryClass}
              onClick={() => setBulkConfirm(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => void handleBulkConfirm()}
            >
              Apply all
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Display labels for the batch confirm's per-kind breakdown (U01). */
const KIND_LABELS: Record<string, string> = {
  add_tags: "add tags",
  set_category: "set category",
  move: "move",
  mark_dead: "mark dead",
  merge_duplicates: "merge duplicates",
  rename: "rename",
  create_folder: "create folder",
};

// ---------------------------------------------------------------------------
// One decision row
// ---------------------------------------------------------------------------

interface ReviewRowProps {
  row: DecisionRow;
  tree: FlattenedTree;
  index: number;
  setSize: number;
  /** Roving tabindex: only the active row is tabbable. */
  active: boolean;
  selected: boolean;
  busy: boolean;
  failure?: string;
  /** Persisted rationale or one this session's Explain just returned. */
  explanation?: string;
  onRegister: (id: string, el: HTMLElement | null) => void;
  onSelect: (index: number) => void;
  onToggle: (id: string) => void;
  onApprove: (row: DecisionRow) => void;
  onReject: (row: DecisionRow) => void;
  onRevert: (row: DecisionRow) => void;
  onExplain: (row: DecisionRow) => void;
}

/** The escalation verdict as words — never color-only. */
function verdictText(row: DecisionRow): string | null {
  const escalation = row.escalation;
  if (escalation === undefined) return null;
  switch (escalation.llmVerdict) {
    case "agree":
      return "agrees with the suggestion";
    case "unsure":
      return "is unsure";
    case "disagree":
      return escalation.llmAlternative !== undefined
        ? `disagrees — suggests “${escalation.llmAlternative}”`
        : "disagrees";
  }
}

function ReviewRow({
  row,
  tree,
  index,
  setSize,
  active,
  selected,
  busy,
  failure,
  explanation,
  onRegister,
  onSelect,
  onToggle,
  onApprove,
  onReject,
  onRevert,
  onExplain,
}: ReviewRowProps) {
  const band = confidenceBand(row.confidence);
  const percent = Math.round(row.confidence * 100);
  const titles = titleText(row, tree);
  const primary =
    row.bookmarkIds
      .map((id) => tree.bookmarks.get(id))
      .find((item) => item !== undefined) ?? null;
  const primaryLabel =
    primary === null ? "a missing bookmark" : displayTitle(primary.title, primary.url);
  const stale = isStale(row, tree);
  const canApprove = statusAllows(row, "applied");
  const canReject = statusAllows(row, "rejected");
  const canRevert = statusAllows(row, "reverted");
  // Explain is a pending-queue action (the worker refuses anything else).
  const canExplain = row.status === "pending";
  const verdict = verdictText(row);

  const stopEvent = (event: ReactMouseEvent<HTMLElement>): void => {
    event.stopPropagation();
  };

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={setSize}
      tabIndex={active ? 0 : -1}
      data-decision-id={row.id}
      data-confidence={band}
      ref={(el) => onRegister(row.id, el)}
      onClick={() => onSelect(index)}
      className={cn(
        "flex items-start gap-2 border-b border-border px-2 py-2",
        "cursor-default outline-hidden last:border-b-0",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        BAND_FILL[band],
        selected && "bg-accent",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(row.id)}
        onClick={stopEvent}
        aria-label={`Select the suggestion for ${primaryLabel}`}
        className="mt-1 shrink-0 accent-primary"
      />
      <span
        aria-hidden="true"
        className={cn("w-1 self-stretch rounded-full", BAND_STRIPE[band])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
            {KIND_LABEL[row.kind]}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm"
            title={titles}
          >
            {titles}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {payloadSummary(row, tree)}
        </div>
        {row.status === "unsure" && (
          <div className="mt-0.5 text-xs italic text-muted-foreground">
            Unsure — low confidence; needs a decision.
          </div>
        )}
        {row.escalationSkipped === "budget" && (
          <div className="mt-0.5 text-xs italic text-muted-foreground">
            Second opinion skipped — the monthly budget cap was reached.
          </div>
        )}
        {verdict !== null && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Second opinion ({row.escalation?.llmModel}): {verdict}.
          </div>
        )}
        {explanation !== undefined && (
          <p className="mt-0.5 text-xs italic text-muted-foreground">
            “{explanation}”
          </p>
        )}
        {stale && (
          <div className="mt-0.5 text-xs italic text-muted-foreground">
            Stale — a referenced bookmark is gone; applying may be refused.
          </div>
        )}
        {failure !== undefined && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {failure}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span
          className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={`Model confidence ${percent}%`}
        >
          {BAND_LABEL[band]} · {percent}%
        </span>
        <span
          className="flex items-center gap-1"
          onClick={stopEvent}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {canExplain && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Explain the suggestion for ${primaryLabel}`}
              onClick={() => onExplain(row)}
              className={secondaryButtonClass}
            >
              Explain
            </button>
          )}
          {canApprove && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Approve the suggestion for ${primaryLabel}`}
              onClick={() => onApprove(row)}
              className={secondaryButtonClass}
            >
              Approve
            </button>
          )}
          {canReject && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Reject the suggestion for ${primaryLabel}`}
              onClick={() => onReject(row)}
              className={secondaryButtonClass}
            >
              Reject
            </button>
          )}
          {canRevert && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Undo the applied suggestion for ${primaryLabel}`}
              onClick={() => onRevert(row)}
              className={secondaryButtonClass}
            >
              Undo
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
