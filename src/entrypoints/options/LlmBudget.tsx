import { useCallback, useEffect, useState } from "react";
import {
  LlmProviderMessage,
  LlmProviderMessageResult,
} from "../../messages/llm-provider";
import { cn } from "../../ui/lib/cn";
import { Alert } from "./components";
import { inputClass, insetClass, secondaryButtonClass } from "./ui";

/**
 * Monthly LLM spend panel (spec FR7): reported vs estimated vs unknown-cost
 * request counts, the configured monthly cap, and remaining headroom —
 * rendered as a stat row rather than a definition list so the numbers scan.
 * Unknown-cost requests are surfaced as a count — never rendered as $0.00.
 */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

interface Snapshot {
  month: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  unknownCostRequests: number;
  hasUnknownCost: boolean;
  reservedUsd: number;
  committedUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
}

/** The provider fields this panel reads and writes. */
interface BudgetStatus {
  providerId?: string;
  budget?: "capped" | "unlimited" | "unset";
  monthlyBudgetUsd?: number;
  pricingKnown?: boolean;
  model?: string;
}

function Stat(props: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-sm font-medium tabular-nums",
          props.tone === "warn"
            ? "text-amber-700 dark:text-amber-400"
            : "text-foreground",
        )}
      >
        {props.value}
      </dd>
      {props.hint !== undefined && (
        <dd className="mt-0.5 text-xs text-muted-foreground">{props.hint}</dd>
      )}
    </div>
  );
}

export function LlmBudget() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [cap, setCap] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSnapshot = useCallback(async () => {
    try {
      const raw = await chrome.runtime.sendMessage(
        LlmProviderMessage.parse({ type: "LLM_BUDGET_SNAPSHOT" }),
      );
      const result = LlmProviderMessageResult.safeParse(raw);
      if (result.success && result.data.ok && "snapshot" in result.data) {
        setSnapshot(result.data.snapshot);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const raw = await chrome.runtime.sendMessage(
        LlmProviderMessage.parse({ type: "LLM_PROVIDER_STATUS" }),
      );
      const result = LlmProviderMessageResult.safeParse(raw);
      if (result.success && result.data.ok && "status" in result.data) {
        const next = result.data.status;
        setStatus(next);
        setUnlimited(next.budget === "unlimited");
        setCap(
          next.monthlyBudgetUsd !== undefined
            ? String(next.monthlyBudgetUsd)
            : "",
        );
      }
    } catch {
      // The panel renders the snapshot alone; the editor stays hidden.
    }
  }, []);

  useEffect(() => {
    // The microtask boundary keeps the fetches subscription callbacks rather
    // than synchronous state writes in the effect body.
    queueMicrotask(() => {
      void loadSnapshot();
      void loadStatus();
    });
  }, [loadSnapshot, loadStatus]);

  /** Persist the ceiling (and the optional price override) on the record. */
  const onSave = () => {
    if (busy || status?.providerId === undefined) return;
    setNotice(null);
    setSaveError(null);

    const trimmedCap = cap.trim();
    const usd = unlimited || trimmedCap === "" ? undefined : Number(trimmedCap);
    if (usd !== undefined && (!Number.isFinite(usd) || usd < 0)) {
      setSaveError("The monthly cap must be a nonnegative number.");
      return;
    }
    const priceIn = inputPrice.trim();
    const priceOut = outputPrice.trim();
    let pricing: { inputPerMillion: number; outputPerMillion: number } | null =
      null;
    if (priceIn !== "" || priceOut !== "") {
      const inputPerMillion = Number(priceIn);
      const outputPerMillion = Number(priceOut);
      if (
        priceIn === "" ||
        priceOut === "" ||
        !Number.isFinite(inputPerMillion) ||
        !Number.isFinite(outputPerMillion) ||
        inputPerMillion < 0 ||
        outputPerMillion < 0
      ) {
        setSaveError(
          "Pricing must be two nonnegative USD-per-million-token numbers, or both fields left empty.",
        );
        return;
      }
      pricing = { inputPerMillion, outputPerMillion };
    }

    setBusy(true);
    void chrome.runtime
      .sendMessage(
        LlmProviderMessage.parse({
          type: "LLM_BUDGET_SET",
          providerId: status.providerId,
          budget: unlimited
            ? { kind: "unlimited" }
            : usd !== undefined
              ? { kind: "capped", usd }
              : { kind: "unset" },
          ...(pricing !== null ? { pricing } : {}),
        }),
      )
      .then((raw) => {
        const result = LlmProviderMessageResult.safeParse(raw);
        if (!result.success) {
          setSaveError("The extension worker returned an unexpected response.");
          return;
        }
        if (!result.data.ok) {
          setSaveError(result.data.message);
          return;
        }
        setNotice("Spending ceiling saved.");
        setInputPrice("");
        setOutputPrice("");
        void loadSnapshot();
        void loadStatus();
      })
      .catch(() => {
        setSaveError("Something went wrong while saving the ceiling.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <section
      id="llm-budget"
      aria-label="LLM budget"
      className={`mt-4 ${insetClass}`}
    >
      <h3 className="text-sm font-medium">Monthly budget</h3>
      {error && (
        <div className="mt-2">
          <Alert tone="error">Budget information is unavailable.</Alert>
        </div>
      )}
      {snapshot === null && !error && (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Loading budget…
        </p>
      )}
      {snapshot !== null && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Stat label="Month" value={snapshot.month} />
            <Stat
              label="Requests"
              value={`${snapshot.requestCount} requests`}
              hint={`${snapshot.inputTokens} in / ${snapshot.outputTokens} out tokens`}
            />
            <Stat
              label="Reported cost"
              value={`$${snapshot.reportedCostUsd.toFixed(2)}`}
              hint={
                snapshot.hasUnknownCost
                  ? `${snapshot.unknownCostRequests} unknown-cost`
                  : undefined
              }
              tone={snapshot.hasUnknownCost ? "warn" : undefined}
            />
            <Stat
              label="Monthly cap"
              value={
                status?.budget === "unlimited"
                  ? "unlimited"
                  : snapshot.budgetUsd !== null
                    ? `$${snapshot.budgetUsd.toFixed(2)}`
                    : "not set"
              }
              hint={
                snapshot.remainingUsd !== null
                  ? `$${snapshot.remainingUsd.toFixed(2)} remaining`
                  : undefined
              }
            />
          </dl>
          {snapshot.estimatedCostUsd > 0 && (
            <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
              Estimated cost so far: ${snapshot.estimatedCostUsd.toFixed(2)}
              {snapshot.hasUnknownCost &&
                ` — ${snapshot.unknownCostRequests} request${
                  snapshot.unknownCostRequests === 1 ? "" : "s"
                } reported no price.`}
            </p>
          )}

          {/* Editing lives here rather than in the setup form so the ceiling
              can change without revoking the provider and re-entering the
              credential. */}
          {status?.providerId !== undefined && (
            <div className="mt-4 space-y-3 border-t border-border pt-3">
              <p className="text-sm font-medium">Spending ceiling</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={unlimited}
                  disabled={busy}
                  onChange={(event) => {
                    setUnlimited(event.target.checked);
                    if (event.target.checked) setCap("");
                  }}
                />
                No monthly cap — spend without a limit
              </label>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    Monthly cap (USD)
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Monthly cap (USD)"
                    disabled={unlimited || busy}
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                    className={`mt-1 ${inputClass}`}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    Input $/1M tokens
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Input price (USD per 1M tokens)"
                    disabled={busy}
                    value={inputPrice}
                    onChange={(event) => setInputPrice(event.target.value)}
                    className={`mt-1 ${inputClass}`}
                  />
                </label>
                <label className="text-sm">
                  <span className="text-muted-foreground">
                    Output $/1M tokens
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label="Output price (USD per 1M tokens)"
                    disabled={busy}
                    value={outputPrice}
                    onChange={(event) => setOutputPrice(event.target.value)}
                    className={`mt-1 ${inputClass}`}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {status.pricingKnown === true
                  ? `Prices are known for ${status.model ?? "this model"}. Enter both rates only to override them.`
                  : `No price is known for ${status.model ?? "this model"} — unattended features refuse until you enter both rates.`}
              </p>
              <button
                type="button"
                onClick={onSave}
                disabled={busy}
                className={secondaryButtonClass}
              >
                {busy ? "Saving…" : "Save ceiling"}
              </button>
              {notice !== null && (
                <div className="mt-2">
                  <Alert tone="success">{notice}</Alert>
                </div>
              )}
              {saveError !== null && (
                <div className="mt-2">
                  <Alert tone="error">{saveError}</Alert>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
