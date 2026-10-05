import type {
  BudgetChoice,
  LlmProviderRecord,
  ModelPricing,
} from "../schemas/llm";

/**
 * Pure monthly budget and usage accounting for the dynamic LLM layer
 * (spec FR7). Every function is pure: persisted usage rows and reservation
 * rows are passed in, results are returned — the caller owns persistence
 * (Phase 2 wires the Dexie tables).
 *
 * Semantics:
 *  - Months are UTC calendar months (`YYYY-MM`), derived from `recordedAt`/
 *    `now` timestamps — a row just inside the local month but outside the
 *    UTC month does not count.
 *  - Cost provenance is three-way: provider-`reported`, locally `estimated`
 *    from configured rates, or `unknown` — unknown is never presented as 0.
 *  - Before a request, `reserveBudget` computes a conservative maximum from
 *    caller-supplied token upper bounds and refuses when committed spend
 *    (usage + active reservations) plus the new reservation would exceed
 *    the configured monthly cap. Exactly-at-cap is allowed.
 *  - Automatic escalation requires reliable pricing (configured input/output
 *    rates); it is refused outright without it, and can never take the
 *    manual `unknownCostConfirmed` override.
 *  - Manual requests without pricing return `confirmation_required`; retrying
 *    with `unknownCostConfirmed: true` reserves with a null amount and the
 *    cost is recorded as unknown at reconcile time.
 */

/** One persisted LLM usage row (Phase 2 persists these). */
export interface LlmUsageRow {
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** ISO-8601 timestamp; UTC month membership is derived from it. */
  recordedAt: string;
  /** Provider-reported USD cost (e.g. OpenRouter). Absent = not reported. */
  costUsd?: number;
  /** Locally estimated USD cost from configured rates. */
  estimatedCostUsd?: number;
}

export type ReservationStatus = "active" | "settled" | "released";
export type CostProvenance = "reported" | "estimated" | "unknown";
export type RequestKind = "manual" | "automatic";

/**
 * Classify a provider record's spend-ceiling decision. Mirrors the
 * {@link BudgetChoice} schema; kept as a plain function so the budget math
 * stays free of schema parsing.
 */
export function budgetChoiceOf(record: LlmProviderRecord): BudgetChoice {
  if (record.monthlyBudgetUnlimited === true) return "unlimited";
  return record.monthlyBudgetUsd !== undefined ? "capped" : "unset";
}

/**
 * A pending-cost placeholder created before a request. `reservedUsd` is the
 * conservative maximum the request may cost; `null` marks an unknown-cost
 * reservation (manual override only — it never counts toward the cap).
 * `pricing` snapshots the rates used, so reconcile can estimate without the
 * caller re-supplying them.
 */
export interface BudgetReservation {
  id: string;
  providerId: string;
  model: string;
  /** UTC `YYYY-MM` at reservation time. */
  month: string;
  reservedUsd: number | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  pricing?: ModelPricing;
  kind: RequestKind;
  status: ReservationStatus;
  createdAt: string;
  settledAt?: string;
  /** Consent scope that authorized the request, stamped so a startup sweep
   * can settle an orphaned row under its true feature (additive; absent on
   * rows written before stamping existed). */
  feature?: string;
}

export interface ReserveBudgetInput {
  /** Caller-generated reservation id (e.g. uuid). */
  reservationId: string;
  providerId: string;
  model: string;
  /** Conservative upper bounds for the request. */
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Configured input/output per-million rates, when known. */
  pricing?: ModelPricing;
  kind: RequestKind;
  monthlyBudgetUsd?: number;
  /** Persisted usage rows for this provider (all months — filtered here). */
  usage: LlmUsageRow[];
  /** Persisted reservation rows for this provider (active counted). */
  reservations: BudgetReservation[];
  now: Date;
  /** Manual-only confirmation that this request may proceed at unknown cost. */
  unknownCostConfirmed?: boolean;
  /** Consent scope stamped onto the row for honest later accounting. */
  feature?: string;
}

export type ReserveBudgetResult =
  | { status: "reserved"; reservation: BudgetReservation }
  | { status: "refused"; reason: "budget_exceeded" | "pricing_required" }
  | { status: "confirmation_required" };

export interface MonthlyBudgetSnapshot {
  /** UTC `YYYY-MM`. */
  month: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum over provider-reported costs only. */
  reportedCostUsd: number;
  /** Sum over locally estimated costs only. */
  estimatedCostUsd: number;
  /** Settled requests plus active reservations with no monetary figure. */
  unknownCostRequests: number;
  hasUnknownCost: boolean;
  /** Sum of active reservations' known amounts. */
  reservedUsd: number;
  /** reported + estimated + reserved (pending exposure). */
  committedUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
}

/** UTC calendar month of an ISO timestamp or Date, as `YYYY-MM`. */
export function utcMonthOf(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function estimateUsd(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * pricing.inputPerMillion +
      outputTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

function isInMonth(recordedAt: string, month: string): boolean {
  const date = new Date(recordedAt);
  return !Number.isNaN(date.getTime()) && utcMonthOf(date) === month;
}

export function monthlyBudgetSnapshot(input: {
  providerId: string;
  usage: LlmUsageRow[];
  reservations: BudgetReservation[];
  now: Date;
  monthlyBudgetUsd?: number;
}): MonthlyBudgetSnapshot {
  const month = utcMonthOf(input.now);
  const rows = input.usage.filter(
    (row) =>
      row.providerId === input.providerId && isInMonth(row.recordedAt, month),
  );

  let reported = 0;
  let estimated = 0;
  let unknown = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of rows) {
    inputTokens += row.inputTokens;
    outputTokens += row.outputTokens;
    if (row.costUsd !== undefined) {
      reported += row.costUsd;
    } else if (row.estimatedCostUsd !== undefined) {
      estimated += row.estimatedCostUsd;
    } else {
      unknown += 1;
    }
  }

  const activeReservations = input.reservations.filter(
    (reservation) =>
      reservation.providerId === input.providerId &&
      reservation.month === month &&
      reservation.status === "active",
  );
  unknown += activeReservations.filter((reservation) => reservation.reservedUsd === null).length;
  const reservedUsd = activeReservations
    .reduce((sum, reservation) => sum + (reservation.reservedUsd ?? 0), 0);

  const committed = reported + estimated + reservedUsd;
  const budgetUsd = input.monthlyBudgetUsd ?? null;
  return {
    month,
    requestCount: rows.length,
    inputTokens,
    outputTokens,
    reportedCostUsd: reported,
    estimatedCostUsd: estimated,
    unknownCostRequests: unknown,
    hasUnknownCost: unknown > 0,
    reservedUsd,
    committedUsd: committed,
    budgetUsd,
    remainingUsd: budgetUsd === null ? null : budgetUsd - committed,
  };
}

export function reserveBudget(input: ReserveBudgetInput): ReserveBudgetResult {
  const month = utcMonthOf(input.now);
  const snapshot = monthlyBudgetSnapshot({
    providerId: input.providerId,
    usage: input.usage,
    reservations: input.reservations,
    now: input.now,
    ...(input.monthlyBudgetUsd !== undefined
      ? { monthlyBudgetUsd: input.monthlyBudgetUsd }
      : {}),
  });

  const hasPricing = input.pricing !== undefined;
  // The unknown-cost confirmation is a manual-action escape hatch only —
  // automatic escalation can never use it (spec FR7.4/FR7.8).
  const unknownConfirmed =
    input.kind === "manual" && input.unknownCostConfirmed === true;

  if (!hasPricing) {
    if (input.kind === "automatic") {
      return { status: "refused", reason: "pricing_required" };
    }
    if (!unknownConfirmed) {
      return { status: "confirmation_required" };
    }
  }

  const reservedUsd =
    hasPricing && input.pricing !== undefined
      ? estimateUsd(
          input.pricing,
          input.maxInputTokens,
          input.maxOutputTokens,
        )
      : null;

  // Null-amount (unknown-cost) reservations can't be compared to the cap;
  // they exist only via the manual override above.
  if (
    reservedUsd !== null &&
    input.monthlyBudgetUsd !== undefined &&
    snapshot.committedUsd + reservedUsd > input.monthlyBudgetUsd
  ) {
    return { status: "refused", reason: "budget_exceeded" };
  }

  const reservation: BudgetReservation = {
    id: input.reservationId,
    providerId: input.providerId,
    model: input.model,
    month,
    reservedUsd,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.pricing !== undefined ? { pricing: input.pricing } : {}),
    kind: input.kind,
    status: "active",
    createdAt: input.now.toISOString(),
    ...(input.feature !== undefined ? { feature: input.feature } : {}),
  };
  return { status: "reserved", reservation };
}

export interface ActualUsage {
  /** Absent is unknown, not an explicitly reported zero. */
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported USD cost, when the response carried one. */
  reportedCostUsd?: number;
}

export interface ReconciledUsage {
  reservation: BudgetReservation;
  /** The usage row to persist: tokens, model, provenance, cost fields. */
  usageRow: LlmUsageRow & { provenance: CostProvenance };
}

/**
 * Settle a reservation with the returned usage. Reported cost wins;
 * configured rates produce a local estimate, substituting the reservation
 * bound for each missing token dimension; otherwise the cost is unknown.
 * Settling frees the reserved amount — the snapshot then counts the actual
 * row instead of the reservation.
 */
export function reconcileBudget(
  reservation: BudgetReservation,
  usage: ActualUsage,
  now: Date,
): ReconciledUsage {
  const usageRow: LlmUsageRow & { provenance: CostProvenance } = {
    providerId: reservation.providerId,
    model: reservation.model,
    inputTokens: usage.inputTokens ?? reservation.maxInputTokens,
    outputTokens: usage.outputTokens ?? reservation.maxOutputTokens,
    recordedAt: now.toISOString(),
    provenance: "unknown",
  };

  if (
    typeof usage.reportedCostUsd === "number" &&
    Number.isFinite(usage.reportedCostUsd) &&
    usage.reportedCostUsd >= 0
  ) {
    usageRow.costUsd = usage.reportedCostUsd;
    usageRow.provenance = "reported";
  } else if (reservation.pricing !== undefined) {
    usageRow.estimatedCostUsd = estimateUsd(
      reservation.pricing,
      usageRow.inputTokens,
      usageRow.outputTokens,
    );
    usageRow.provenance = "estimated";
  }

  return {
    reservation: {
      ...reservation,
      status: "settled",
      settledAt: now.toISOString(),
    },
    usageRow,
  };
}

/**
 * Release a reservation without spending (request never sent).
 * Released reservations no longer count against the cap.
 */
export function releaseBudget(
  reservation: BudgetReservation,
  now: Date,
): BudgetReservation {
  return { ...reservation, status: "released", settledAt: now.toISOString() };
}
