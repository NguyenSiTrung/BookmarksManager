import { useEffect, useRef, useState } from "react";
import { CostConfirmationDialog } from "../../ui/components/CostConfirmationDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/components/dialog";
import {
  SummarizeMessageResult,
  type SummarizeMessage,
  type SummaryConsentApproval,
  type SummaryConsentPreflight,
} from "../../messages/summaries";
import { LLM_SCOPE_DISCLOSURES } from "../../consent/disclosure";

/** Read-only preflight on open; only the disclosed affirmative send may
 * authorize extraction/egress. Unknown-cost confirmation is separate and
 * retains exactly the accepted provider/version binding.
 *
 * Built on the shared Radix Dialog: focus is trapped while open and restored
 * on close, and all colors come from theme tokens. The summarize request is
 * fire-and-forget on the worker — there is no cancellation message — so while
 * a send is in flight the footer control is labeled "Continue in background";
 * the work keeps running and its result is persisted by the worker. The
 * icon-only close is always hidden so the labeled button is the single
 * dismiss control. */

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

const ANNOUNCE_ID = "summary-dialog-announce";

const CLOSE_BUTTON_CLASS =
  "rounded-md border border-input px-4 py-2 text-sm font-medium " +
  "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden";
const PRIMARY_BUTTON_CLASS =
  "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
  "text-primary-foreground hover:bg-primary/90 " +
  "focus-visible:ring-2 focus-visible:ring-ring " +
  "focus-visible:outline-hidden";

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

  const running = phase.kind === "running";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          // Still the pre-open element at this point — capture it so close
          // can return focus (there is no Radix trigger to restore to).
          previousFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // No Radix trigger exists, so restore to the element that held
          // focus before open; skip Radix's trigger-focused default.
          event.preventDefault();
          if (previousFocus.current?.isConnected) {
            previousFocus.current.focus();
          }
          previousFocus.current = null;
        }}
      >
        <DialogHeader>
          <DialogTitle>
            Summarize “{props.bookmarkTitle}”
          </DialogTitle>
          <DialogDescription className="sr-only">
            Send this bookmark’s page to your configured AI provider and save
            the summary on the bookmark.
          </DialogDescription>
        </DialogHeader>
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
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain break-words"
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
            <p className="text-sm text-muted-foreground">Summarizing the page…</p>
          )}
          {phase.kind === "done" && (
            <p className="text-sm text-foreground" data-testid="summary-text">
              {phase.summary}
            </p>
          )}
          {phase.kind === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {phase.message}
            </p>
          )}
        </div>
        <DialogFooter>
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            className={CLOSE_BUTTON_CLASS}
          >
            {running ? "Continue in background" : "Close"}
          </button>
          {phase.kind === "disclosure" && (
            <button type="button" className={PRIMARY_BUTTON_CLASS} onClick={() => sendApproved(phase.consent.approval)}>
              Agree and summarize
            </button>
          )}
        </DialogFooter>
        {phase.kind === "confirm" && (
          <CostConfirmationDialog
            open
            featureLabel="Summarize this page"
            destinationOrigin={phase.destinationOrigin}
            onConfirm={() => sendApproved(phase.approval, true)}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
