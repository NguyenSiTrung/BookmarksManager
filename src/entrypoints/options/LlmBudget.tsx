import { useEffect, useState } from "react";
import {
  LlmProviderMessage,
  LlmProviderMessageResult,
} from "../../messages/llm-provider";
import { insetClass } from "./ui";

/**
 * Monthly LLM spend panel (spec FR7): reported vs estimated vs unknown-cost
 * request counts, the configured monthly cap, and remaining headroom.
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
      <h3 className="font-medium">Monthly budget</h3>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          Budget information is unavailable.
        </p>
      )}
      {snapshot === null && !error && (
        <p role="status" className="mt-2 text-muted-foreground">
          Loading budget…
        </p>
      )}
      {snapshot !== null && (
        <dl className="mt-2 space-y-1">
          <div className="flex justify-between">
            <dt>Month</dt>
            <dd>{snapshot.month}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Requests</dt>
            <dd>{snapshot.requestCount} requests</dd>
          </div>
          <div className="flex justify-between">
            <dt>Tokens</dt>
            <dd>
              {snapshot.inputTokens} in / {snapshot.outputTokens} out
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Reported cost</dt>
            <dd>${snapshot.reportedCostUsd.toFixed(2)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Estimated cost</dt>
            <dd>${snapshot.estimatedCostUsd.toFixed(2)}</dd>
          </div>
          {snapshot.hasUnknownCost && (
            <div className="flex justify-between">
              <dt>Unknown cost</dt>
              <dd>{snapshot.unknownCostRequests} requests unpriced</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Monthly cap</dt>
            <dd>
              {snapshot.budgetUsd !== null
                ? `$${snapshot.budgetUsd.toFixed(2)}`
                : "none set"}
            </dd>
          </div>
          {snapshot.remainingUsd !== null && (
            <div className="flex justify-between">
              <dt>Remaining</dt>
              <dd>${snapshot.remainingUsd.toFixed(2)}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
