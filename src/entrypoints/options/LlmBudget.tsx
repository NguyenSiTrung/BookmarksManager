import { useEffect, useState } from "react";
import {
  LlmProviderMessage,
  LlmProviderMessageResult,
} from "../../messages/llm-provider";
import { cn } from "../../ui/lib/cn";
import { Alert } from "./components";
import { insetClass } from "./ui";

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

  useEffect(() => {
    let cancelled = false;
    chrome.runtime
      .sendMessage(LlmProviderMessage.parse({ type: "LLM_BUDGET_SNAPSHOT" }))
      .then((raw) => {
        if (cancelled) return;
        const result = LlmProviderMessageResult.safeParse(raw);
        if (result.success && result.data.ok && "snapshot" in result.data) {
          setSnapshot(result.data.snapshot);
        } else {
          setError(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="LLM budget" className={`mt-4 ${insetClass}`}>
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
                snapshot.budgetUsd !== null
                  ? `$${snapshot.budgetUsd.toFixed(2)}`
                  : "none set"
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
        </>
      )}
    </section>
  );
}
