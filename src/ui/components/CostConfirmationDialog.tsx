import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

/**
 * One-shot cost confirmation for a manual LLM request whose price cannot be
 * estimated (no provider pricing configured). It states that the monetary
 * cost is unknown, names the feature and the exact destination origin, and
 * resolves to a single confirm/cancel for THIS action — there is no
 * "always allow" affordance and nothing persists a blanket bypass.
 *
 * Built on the shared Radix dialog (theme tokens, focus trap, dark mode).
 * `showCloseButton={false}`: there is no corner X — Escape and a click on
 * the overlay close the dialog, which maps to `onCancel`, the safe action.
 * Focus lands on the cancel button on open so an accidental Enter cannot
 * spend money.
 */
export interface CostConfirmationDialogProps {
  open: boolean;
  /** What the user is about to do, e.g. "Explain this decision". */
  featureLabel: string;
  /** The exact provider origin the request would go to. */
  destinationOrigin: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CostConfirmationDialog({
  open,
  featureLabel,
  destinationOrigin,
  onConfirm,
  onCancel,
}: CostConfirmationDialogProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Send without a cost estimate?</DialogTitle>
          <DialogDescription>
            The provider at{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">
              {destinationOrigin}
            </code>{" "}
            has no pricing configured, so the cost of “{featureLabel}” can’t
            be estimated beforehand. The actual cost is only known if the
            provider reports it after the request.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          You’ll be asked again for each request — this approval isn’t saved.
        </p>
        <DialogFooter>
          <button
            type="button"
            ref={cancelRef}
            onClick={onCancel}
            className={
              "rounded-md border border-input px-4 py-2 text-sm font-medium " +
              "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring " +
              "focus-visible:outline-hidden"
            }
          >
            Don’t send
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              "rounded-md bg-primary px-4 py-2 text-sm font-medium " +
              "text-primary-foreground hover:bg-primary/90 " +
              "focus-visible:ring-2 focus-visible:ring-ring " +
              "focus-visible:outline-hidden"
            }
          >
            Send anyway
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
