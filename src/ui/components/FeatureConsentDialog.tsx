import { useId, useRef, useState } from "react";
import { LLM_SCOPE_DISCLOSURES, NO_DEVELOPER_SERVER_NOTE } from "../../consent/disclosure";
import { consentVersionForScope, grantConsentAtOrigin } from "../../consent/records";
import type { FeatureConsentApproval, FeatureConsentDisclosure } from "../../schemas/feature-consent";
import { Checkbox } from "./checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "./dialog";

/** Mount only for a disclosed recipient. Every mount starts unchecked.
 * Only this distinct affirmative action writes the exact scope/origin grant.
 * Cost confirmation is separate and cannot create consent. */
export function FeatureConsentDialog({
  consent,
  onApproved,
  onCancel,
}: {
  consent: FeatureConsentDisclosure;
  onApproved: (approval: FeatureConsentApproval) => Promise<void>;
  onCancel: () => void;
}) {
  const disclosure = LLM_SCOPE_DISCLOSURES[consent.scope];
  const checkboxId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inFlight = useRef(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const action = consent.scope === "llm_explain" ? "Agree and explain" : "Agree and propose";

  async function approve() {
    if (!checked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (consent.approval.consentVersion !== consentVersionForScope(consent.scope)) {
        throw new Error("stale_disclosure");
      }
      await grantConsentAtOrigin(consent.scope, consent.approval.origin);
    } catch {
      inFlight.current = false;
      setBusy(false);
      setError("Consent could not be saved. Nothing was sent; reopen the disclosure and try again.");
      return;
    }
    await onApproved(consent.approval);
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !inFlight.current) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[85vh] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocus.current;
          queueMicrotask(() => { if (target?.isConnected) target.focus(); });
        }}
      >
        <DialogHeader>
          <DialogTitle>Allow {disclosure.title.toLowerCase()}?</DialogTitle>
          <DialogDescription>
            Review what will be sent before allowing this feature for this exact origin.
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-2 text-sm">
          <div><dt className="font-medium">Recipient</dt><dd>{consent.recipient}</dd></div>
          <div><dt className="font-medium">Destination</dt><dd className="break-all font-mono text-xs">{consent.approval.origin}</dd></div>
          <div><dt className="font-medium">Endpoint</dt><dd className="break-all font-mono text-xs">{consent.approval.endpoint}</dd></div>
          <div><dt className="font-medium">Model</dt><dd className="break-all">{consent.approval.model}</dd></div>
          <div><dt className="font-medium">Fields sent</dt><dd>{disclosure.fields.join(", ")}</dd></div>
          <div><dt className="font-medium">Purpose</dt><dd>{disclosure.purpose}</dd></div>
          <div><dt className="font-medium">Trigger</dt><dd>{disclosure.trigger}</dd></div>
        </dl>
        <p className="text-xs text-muted-foreground">{disclosure.credentialUse}. Notes and page text are never sent by this feature.</p>
        <p className="text-xs text-muted-foreground">{NO_DEVELOPER_SERVER_NOTE}</p>
        <div className="flex items-start gap-2 text-sm">
          <Checkbox id={checkboxId} checked={checked} disabled={busy}
            onCheckedChange={(value) => setChecked(value === true)} />
          <label htmlFor={checkboxId}>I agree to send these fields to {consent.recipient} at {consent.approval.origin} for this feature.</label>
        </div>
        {error !== null && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <button type="button" ref={cancelRef} disabled={busy} onClick={onCancel}
            className="rounded-md border border-input px-4 py-2 text-sm hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            Don’t send
          </button>
          <button type="button" disabled={!checked || busy} onClick={() => void approve()}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
            {busy ? "Saving consent…" : action}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
