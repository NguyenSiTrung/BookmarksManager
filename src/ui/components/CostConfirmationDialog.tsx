import { useEffect, useRef } from "react";

/**
 * One-shot cost confirmation for a manual LLM request whose price cannot be
 * estimated (no provider pricing configured). It states that the monetary
 * cost is unknown, names the feature and the exact destination origin, and
 * resolves to a single confirm/cancel for THIS action — there is no
 * "always allow" affordance and nothing persists a blanket bypass.
 *
 * Modal semantics: `role="dialog"` + `aria-modal`, labelled by its title,
 * Escape cancels, and focus lands on the cancel button on open so an
 * accidental Enter cannot spend money.
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

const TITLE_ID = "cost-confirmation-title";

export function CostConfirmationDialog(props: CostConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (props.open) {
      cancelRef.current?.focus();
    }
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
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
        className="mx-4 max-w-md rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id={TITLE_ID} className="text-base font-semibold">
          Confirm unknown-cost request
        </h2>
        <p className="mt-2 text-sm text-gray-700">
          The monetary cost of “{props.featureLabel}” cannot be estimated —
          this provider has no pricing configured. The request would be sent
          to{" "}
          <code className="rounded bg-gray-100 px-1">
            {props.destinationOrigin}
          </code>
          , and its actual cost will only be known if the provider reports it
          afterwards.
        </p>
        <p className="mt-2 text-sm text-gray-700">
          This confirmation applies to this one request only.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            ref={cancelRef}
            onClick={props.onCancel}
            className="rounded border border-gray-300 px-3 py-1 text-sm"
          >
            Don&apos;t send
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white"
          >
            Send anyway
          </button>
        </div>
      </div>
    </div>
  );
}
