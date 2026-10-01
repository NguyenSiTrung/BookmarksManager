import { useEffect, useRef, useState } from "react";
import { CostConfirmationDialog } from "../../ui/components/CostConfirmationDialog";
import {
  SummarizeMessageResult,
  type SummarizeMessage,
  type SummaryConsentApproval,
  type SummaryConsentPreflight,
} from "../../messages/summaries";
import { LLM_SCOPE_DISCLOSURES } from "../../consent/disclosure";

/** Read-only preflight on open; only the disclosed affirmative send may
 * authorize extraction/egress. Unknown-cost confirmation is separate and
 * retains exactly the accepted provider/version binding. */

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
  | { kind: "loading" }
  | { kind: "disclosure"; consent: SummaryConsentPreflight }
  | { kind: "running" }
  | { kind: "confirm"; destinationOrigin: string; approval: SummaryConsentApproval }
  | { kind: "done"; summary: string; model: string }
  | { kind: "error"; message: string };

const TITLE_ID = "summary-dialog-title";
const ANNOUNCE_ID = "summary-dialog-announce";

export function SummaryDialog(props: SummaryDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const inputKey = JSON.stringify([props.open, props.tabId, props.bookmarkId, props.bookmarkTitle]);
  const [previousInput, setPreviousInput] = useState(inputKey);
  if (inputKey !== previousInput) {
    setPreviousInput(inputKey);
    setPhase({ kind: "loading" });
  }

  useEffect(() => {
    if (props.open) {
      previousFocus.current = document.activeElement as HTMLElement;
      cancelRef.current?.focus();
    } else if (previousFocus.current !== null) {
      previousFocus.current.focus();
      previousFocus.current = null;
    }
  }, [props.open]);

  useEffect(() => {
    const gen = ++generation.current;
    busy.current = false;
    if (props.open) {
      void sendSummarizeMessage({ type: "LLM_SUMMARY_PREFLIGHT" }).then((reply) => {
        if (generation.current !== gen) return;
        if (reply.ok && reply.code === "summary_consent") {
          setPhase({ kind: "disclosure", consent: reply.consent });
        } else {
          setPhase({ kind: "error", message: reply.ok ? UNEXPECTED_REPLY_MESSAGE : reply.message });
        }
      });
    }
    return () => { generation.current += 1; };
  }, [props.open, inputKey]);

  function close() {
    generation.current += 1;
    busy.current = true;
    props.onClose();
  }

  function sendApproved(approval: SummaryConsentApproval, unknownCostConfirmed = false) {
    if (busy.current) return;
    busy.current = true;
    const gen = generation.current;
    setPhase({ kind: "running" });
    void sendSummarizeMessage({
      type: "LLM_SUMMARIZE",
      tabId: props.tabId,
      bookmarkId: props.bookmarkId,
      consentApproval: approval,
      ...(unknownCostConfirmed ? { unknownCostConfirmed: true } : {}),
    }).then((reply) => {
      if (generation.current !== gen) return;
      busy.current = false;
      if (reply.ok && reply.code === "summary_ok") {
        setPhase({ kind: "done", summary: reply.summary, model: reply.model });
      } else if (!reply.ok && reply.code === "confirmation_required" && reply.destinationOrigin === approval.llm.origin) {
        setPhase({ kind: "confirm", destinationOrigin: reply.destinationOrigin, approval });
      } else {
        setPhase({ kind: "error", message: reply.ok ? UNEXPECTED_REPLY_MESSAGE : reply.message });
      }
    });
  }

  if (!props.open) {
    return null;
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
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
        className="mx-4 flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id={TITLE_ID} className="shrink-0 text-base font-semibold">
          Summarize “{props.bookmarkTitle}”
        </h2>
        <p
          id={ANNOUNCE_ID}
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {phase.kind === "loading" && "Loading summary disclosure…"}
          {phase.kind === "disclosure" && "Review both recipients before sending."}
          {phase.kind === "running" && "Summarizing the page…"}
          {phase.kind === "done" && "Summary saved to the bookmark."}
          {phase.kind === "error" && `Summarize failed: ${phase.message}`}
          {phase.kind === "confirm" && "The request needs a cost confirmation."}
        </p>
        <div
          role="region"
          aria-label="Summary disclosure and result"
          tabIndex={0}
          className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain break-words"
        >
          {phase.kind === "loading" && <p>Loading summary disclosure…</p>}
          {phase.kind === "disclosure" && (
            <div className="space-y-3 text-sm">
              <p>Consent version {phase.consent.approval.consentVersion}. Review both recipients before agreeing.</p>
              {(["llm", "jev"] as const).map((hop) => {
                const disclosure = LLM_SCOPE_DISCLOSURES[hop === "llm" ? "llm_summary" : "jev_summary_verify"];
                return (
                  <section key={hop} aria-label={`${disclosure.title} disclosure`}>
                    <h3 className="font-semibold">{disclosure.title}</h3>
                    <p>{phase.consent.approval[hop].origin}</p>
                    <p>{disclosure.purpose}</p>
                    <ul>{disclosure.fields.map((field) => <li key={field}>{field}</li>)}</ul>
                    <p>{hop === "llm" ? "Site name and meta description are included when present." : "The title is the saved bookmark title."}</p>
                    <p>{disclosure.credentialUse}</p>
                    <p>{(hop === "llm" ? phase.consent.llmGranted : phase.consent.jevGranted) ? "Current grant" : "New or renewed consent required"}</p>
                  </section>
                );
              })}
              <p>Query strings, fragments, and embedded URL credentials are removed. Notes, byline, and the full page DOM are not sent.</p>
              <p>Agreeing authorizes these summary scopes for these recipients and starts this request. Unknown-cost confirmation, if needed, is a separate choice.</p>
            </div>
          )}
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
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Close
          </button>
          {phase.kind === "disclosure" && (
            <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => sendApproved(phase.consent.approval)}>
              Agree and summarize
            </button>
          )}
        </div>
        {phase.kind === "confirm" && (
          <CostConfirmationDialog
            open
            featureLabel="Summarize this page"
            destinationOrigin={phase.destinationOrigin}
            onConfirm={() => sendApproved(phase.approval, true)}
            onCancel={close}
          />
        )}
      </div>
    </div>
  );
}
