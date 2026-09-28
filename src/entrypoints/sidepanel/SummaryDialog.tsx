import { useEffect, useRef, useState } from "react";
import { CostConfirmationDialog } from "../../ui/components/CostConfirmationDialog";
import {
  SummarizeMessageResult,
  type SummarizeMessage,
} from "../../messages/summaries";

/**
 * The Summarize dialog (spec FR10): a bookmark row action resolves the
 * active tab inside the click handler (the `activeTab` grant), opens this
 * dialog, and the worker runs extract → LLM summarize → Jev verify →
 * persist. The page text is sent ONLY after this explicit intent — the
 * dialog's own open is the consent-gated trigger; nothing runs on mount,
 * navigation, or timers.
 *
 * Progress/result states live here: `running` → `done` (the persisted
 * summary, shown only after `summary_ok` confirms verified storage) or
 * `error` (the worker's code + message verbatim). On
 * `confirmation_required` the dialog asks via `CostConfirmationDialog` and
 * resends the SAME intent with `unknownCostConfirmed: true` — the only
 * path allowed to set that flag (spec FR7.8).
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

async function sendSummarizeMessage(
  message: SummarizeMessage,
): Promise<SummarizeMessageResult> {
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
  const parsed = SummarizeMessageResult.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "internal_error",
      message: UNEXPECTED_REPLY_MESSAGE,
    };
  }
  return parsed.data;
}

export interface SummaryDialogProps {
  open: boolean;
  /** Tab resolved inside the click handler. */
  tabId: number;
  /** The saved bookmark this page is claimed to map to. */
  bookmarkId: string;
  bookmarkTitle: string;
  onClose: () => void;
}

type Phase =
  | { kind: "running" }
  | { kind: "confirm"; destinationOrigin: string }
  | { kind: "done"; summary: string; model: string }
  | { kind: "error"; message: string };

const TITLE_ID = "summary-dialog-title";
const ANNOUNCE_ID = "summary-dialog-announce";

export function SummaryDialog(props: SummaryDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "running" });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (props.open) {
      previousFocus.current = document.activeElement as HTMLElement;
      cancelRef.current?.focus();
    } else if (previousFocus.current !== null) {
      previousFocus.current.focus();
      previousFocus.current = null;
    }
    return () => {
      // Invalidate stale sends when the dialog closes mid-flight.
      generation.current += 1;
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const gen = generation.current;
    setPhase({ kind: "running" });
    void sendSummarizeMessage({
      type: "LLM_SUMMARIZE",
      tabId: props.tabId,
      bookmarkId: props.bookmarkId,
    }).then((reply) => {
      if (generation.current !== gen) return; // closed meanwhile
      applyReply(reply);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  function applyReply(reply: SummarizeMessageResult) {
    if (reply.ok) {
      if (reply.code === "summary_ok") {
        setPhase({ kind: "done", summary: reply.summary, model: reply.model });
      }
      return;
    }
    if (
      reply.code === "confirmation_required" &&
      reply.destinationOrigin !== undefined
    ) {
      setPhase({ kind: "confirm", destinationOrigin: reply.destinationOrigin });
      return;
    }
    setPhase({ kind: "error", message: reply.message });
  }

  function resendConfirmed() {
    const gen = generation.current;
    setPhase({ kind: "running" });
    void sendSummarizeMessage({
      type: "LLM_SUMMARIZE",
      tabId: props.tabId,
      bookmarkId: props.bookmarkId,
      unknownCostConfirmed: true,
    }).then((reply) => {
      if (generation.current !== gen) return;
      applyReply(reply);
    });
  }

  if (!props.open) {
    return null;
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        onKeyDown={onKeyDown}
        className="mx-4 max-w-lg rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id={TITLE_ID} className="text-base font-semibold">
          Summarize “{props.bookmarkTitle}”
        </h2>
        <p
          id={ANNOUNCE_ID}
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {phase.kind === "running" && "Summarizing the page…"}
          {phase.kind === "done" && "Summary saved to the bookmark."}
          {phase.kind === "error" && `Summarize failed: ${phase.message}`}
          {phase.kind === "confirm" && "The request needs a cost confirmation."}
        </p>
        <div className="mt-3 min-h-16">
          {phase.kind === "running" && (
            <p className="text-sm text-slate-600">Summarizing the page…</p>
          )}
          {phase.kind === "done" && (
            <p className="text-sm text-slate-800" data-testid="summary-text">
              {phase.summary}
            </p>
          )}
          {phase.kind === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {phase.message}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={props.onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Close
          </button>
        </div>
        {phase.kind === "confirm" && (
          <CostConfirmationDialog
            open
            featureLabel="Summarize this page"
            destinationOrigin={phase.destinationOrigin}
            onConfirm={resendConfirmed}
            onCancel={props.onClose}
          />
        )}
      </div>
    </div>
  );
}
