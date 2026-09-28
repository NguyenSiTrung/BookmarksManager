import { describe, expect, it } from "vitest";
import {
  monthlyBudgetSnapshot,
  reconcileBudget,
  releaseBudget,
  reserveBudget,
  type BudgetReservation,
  type LlmUsageRow,
} from "../../src/llm/budget";

const PRICING = { inputPerMillion: 0.15, outputPerMillion: 0.6 };
const SEP_15 = new Date("2026-09-15T12:00:00Z");

function row(partial: Partial<LlmUsageRow> = {}): LlmUsageRow {
  return {
    providerId: "preset:openai",
    model: "gpt-4o-mini",
    inputTokens: 1000,
    outputTokens: 500,
    recordedAt: "2026-09-10T00:00:00Z",
    ...partial,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    reservationId: "res-1",
    providerId: "preset:openai",
    model: "gpt-4o-mini",
    maxInputTokens: 1000,
    maxOutputTokens: 500,
    pricing: PRICING,
    kind: "manual" as const,
    usage: [] as LlmUsageRow[],
    reservations: [] as BudgetReservation[],
    now: SEP_15,
    ...overrides,
  };
}

describe("reserveBudget", () => {
  it("reserves a conservative estimate from input/output rates", () => {
    const result = reserveBudget(baseInput({ monthlyBudgetUsd: 10 }));
    expect(result.status).toBe("reserved");
    if (result.status !== "reserved") return;
    // (1000 * 0.15 + 500 * 0.6) / 1e6 = 0.00045
    expect(result.reservation.reservedUsd).toBeCloseTo(0.00045, 8);
    expect(result.reservation.month).toBe("2026-09");
    expect(result.reservation.status).toBe("active");
  });

  it("allows a reservation that lands exactly on the cap", () => {
    const usage = [row({ costUsd: 5 })];
    const result = reserveBudget(
      baseInput({
        monthlyBudgetUsd: 10,
        usage,
        // 5 remaining; reserve exactly 5: 2M input tokens at $0.15/M = $0.30…
        // pick bounds so estimate == 5: input 0, output 8_333_333.33 → use
        // simpler numbers: input 10_000_000 * 0.15/1e6 = 1.5; need exactly 5
        // → maxInputTokens 33_333_333.33… choose output-heavy: 8_333_333.333.
        maxInputTokens: 0,
        maxOutputTokens: 8_333_333.333333333,
      }),
    );
    expect(result.status).toBe("reserved");
  });

  it("refuses a reservation one epsilon over the cap", () => {
    const usage = [row({ costUsd: 5 })];
    const allowed = reserveBudget(
      baseInput({
        monthlyBudgetUsd: 10,
        usage,
        maxInputTokens: 0,
        maxOutputTokens: 8_333_333.333333333,
      }),
    );
    expect(allowed.status).toBe("reserved");

    const refused = reserveBudget(
      baseInput({
        monthlyBudgetUsd: 10,
        usage,
        maxInputTokens: 0,
        maxOutputTokens: 8_333_334, // one token more → ~$5.0000000004
      }),
    );
    expect(refused.status).toBe("refused");
    if (refused.status === "refused") {
      expect(refused.reason).toBe("budget_exceeded");
    }
  });

  it("counts concurrent active reservations toward the cap", () => {
    const first = reserveBudget(
      baseInput({ monthlyBudgetUsd: 10, maxOutputTokens: 8_333_333 }),
    );
    expect(first.status).toBe("reserved");
    if (first.status !== "reserved") return;

    // Second reservation sees the first — combined estimate exceeds cap.
    const second = reserveBudget(
      baseInput({
        monthlyBudgetUsd: 10,
        reservations: [first.reservation],
        maxOutputTokens: 8_333_333,
      }),
    );
    expect(second.status).toBe("refused");
    if (second.status === "refused") {
      expect(second.reason).toBe("budget_exceeded");
    }
  });

  it("proceeds without a configured budget (cap unset)", () => {
    const result = reserveBudget(baseInput());
    expect(result.status).toBe("reserved");
  });

  it("refuses automatic requests without reliable pricing", () => {
    const result = reserveBudget(
      baseInput({ kind: "automatic", pricing: undefined }),
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("pricing_required");
    }
  });

  it("returns confirmation_required for manual requests without pricing", () => {
    const result = reserveBudget(baseInput({ pricing: undefined }));
    expect(result.status).toBe("confirmation_required");
  });

  it("proceeds for a manual request once unknown cost is confirmed", () => {
    const result = reserveBudget(
      baseInput({ pricing: undefined, unknownCostConfirmed: true }),
    );
    expect(result.status).toBe("reserved");
    if (result.status !== "reserved") return;
    // Unknown monetary cost is recorded as such — never silently zero.
    expect(result.reservation.reservedUsd).toBeNull();
  });

  it("ignores the unknown-cost override for automatic requests", () => {
    const result = reserveBudget(
      baseInput({
        kind: "automatic",
        pricing: undefined,
        unknownCostConfirmed: true,
      }),
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("pricing_required");
    }
  });

  it("does not let a null-amount reservation bypass the cap", () => {
    // An unknown-cost reservation does not count against the budget —
    // it proceeds only through the manual override path.
    const pending = reserveBudget(
      baseInput({ pricing: undefined, unknownCostConfirmed: true }),
    );
    expect(pending.status).toBe("reserved");
    if (pending.status !== "reserved") return;
    const still = reserveBudget(
      baseInput({
        monthlyBudgetUsd: 1,
        reservations: [pending.reservation],
      }),
    );
    expect(still.status).toBe("reserved");
  });
});

describe("reconcileBudget", () => {
  function activeReservation(): BudgetReservation {
    const result = reserveBudget(baseInput({ monthlyBudgetUsd: 10 }));
    if (result.status !== "reserved") {
      throw new Error("expected reservation");
    }
    return result.reservation;
  }

  it("settles with reported cost when the provider returned one", () => {
    const settled = reconcileBudget(activeReservation(), {
      inputTokens: 800,
      outputTokens: 200,
      reportedCostUsd: 0.0007,
    }, SEP_15);
    expect(settled.reservation.status).toBe("settled");
    expect(settled.usageRow.costUsd).toBe(0.0007);
    expect(settled.usageRow.provenance).toBe("reported");
  });

  it("computes estimated cost from configured rates when unreported", () => {
    const settled = reconcileBudget(activeReservation(), {
      inputTokens: 2000,
      outputTokens: 1000,
    }, SEP_15);
    // 2000*0.15/1e6 + 1000*0.6/1e6 = 0.0009
    expect(settled.usageRow.estimatedCostUsd).toBeCloseTo(0.0009, 8);
    expect(settled.usageRow.provenance).toBe("estimated");
    expect(settled.usageRow.costUsd).toBeUndefined();
  });

  it("marks cost unknown when neither reported nor priced", () => {
    const unknown = reserveBudget(
      baseInput({ pricing: undefined, unknownCostConfirmed: true }),
    );
    if (unknown.status !== "reserved") throw new Error("expected reservation");
    const settled = reconcileBudget(unknown.reservation, {
      inputTokens: 2000,
      outputTokens: 1000,
    }, SEP_15);
    expect(settled.usageRow.provenance).toBe("unknown");
    expect(settled.usageRow.costUsd).toBeUndefined();
    expect(settled.usageRow.estimatedCostUsd).toBeUndefined();
    // Tokens and request facts are still recorded.
    expect(settled.usageRow.inputTokens).toBe(2000);
    expect(settled.usageRow.outputTokens).toBe(1000);
  });

  it("releases the over-reserved remainder when actual < estimate", () => {
    const reservation = activeReservation();
    const snapshotBefore = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage: [],
      reservations: [reservation],
      now: SEP_15,
    });
    expect(snapshotBefore.reservedUsd).toBeCloseTo(0.00045, 8);

    const settled = reconcileBudget(reservation, {
      inputTokens: 100,
      outputTokens: 50,
    }, SEP_15);
    const after = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage: [row({ ...settled.usageRow, providerId: "preset:openai" })],
      reservations: [settled.reservation],
      now: SEP_15,
    });
    // Settled reservation no longer reserved; actual estimated spend recorded.
    expect(after.reservedUsd).toBe(0);
    expect(after.estimatedCostUsd).toBeCloseTo(100 * 0.15 / 1e6 + 50 * 0.6 / 1e6, 8);
  });
});

describe("releaseBudget", () => {
  it("marks an active reservation released so it frees the cap", () => {
    const pending = reserveBudget(baseInput({ monthlyBudgetUsd: 1 }));
    if (pending.status !== "reserved") throw new Error("expected reservation");
    const released = releaseBudget(pending.reservation, SEP_15);
    expect(released.status).toBe("released");
    const snapshot = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage: [],
      reservations: [released],
      now: SEP_15,
    });
    expect(snapshot.reservedUsd).toBe(0);
  });
});

describe("monthlyBudgetSnapshot", () => {
  it("filters usage rows to the current UTC month", () => {
    const usage = [
      row({ costUsd: 1, recordedAt: "2026-09-30T23:59:59Z" }),
      row({ costUsd: 2, recordedAt: "2026-10-01T00:00:00Z" }), // next month
      row({ costUsd: 3, recordedAt: "2026-09-30T23:30:00-02:00" }), // Oct 1 UTC
      row({ costUsd: 4, recordedAt: "2026-10-01T00:30:00+02:00" }), // Sep 30 UTC
    ];
    const snap = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage,
      reservations: [],
      now: SEP_15,
    });
    expect(snap.month).toBe("2026-09");
    expect(snap.requestCount).toBe(2); // Sep-30T23:59Z + Oct-01T00:30+02:00
    expect(snap.reportedCostUsd).toBe(5);
  });

  it("tracks tokens, requests, provenance, and never reports unknown as zero", () => {
    const usage = [
      row({ costUsd: 0.5 }),
      row({ estimatedCostUsd: 0.25 }),
      row({}), // unknown cost
    ];
    const snap = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage,
      reservations: [],
      now: SEP_15,
      monthlyBudgetUsd: 10,
    });
    expect(snap.requestCount).toBe(3);
    expect(snap.inputTokens).toBe(3000);
    expect(snap.outputTokens).toBe(1500);
    expect(snap.reportedCostUsd).toBe(0.5);
    expect(snap.estimatedCostUsd).toBe(0.25);
    expect(snap.unknownCostRequests).toBe(1);
    expect(snap.hasUnknownCost).toBe(true);
    expect(snap.committedUsd).toBeCloseTo(0.75, 8);
    expect(snap.remainingUsd).toBeCloseTo(9.25, 8);
  });

  it("scopes rows to the selected provider", () => {
    const usage = [
      row({ costUsd: 1 }),
      row({ providerId: "preset:openrouter", costUsd: 2 }),
    ];
    const snap = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage,
      reservations: [],
      now: SEP_15,
    });
    expect(snap.reportedCostUsd).toBe(1);
    expect(snap.requestCount).toBe(1);
  });

  it("reports null remainingUsd when no budget is configured", () => {
    const snap = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage: [row({ costUsd: 1 })],
      reservations: [],
      now: SEP_15,
    });
    expect(snap.remainingUsd).toBeNull();
    expect(snap.budgetUsd).toBeNull();
  });

  it("ignores settled and released reservations in the reserved total", () => {
    const pending = reserveBudget(baseInput({ monthlyBudgetUsd: 10 }));
    const toSettle = reserveBudget(
      baseInput({ reservationId: "res-2", monthlyBudgetUsd: 10 }),
    );
    const toRelease = reserveBudget(
      baseInput({ reservationId: "res-3", monthlyBudgetUsd: 10 }),
    );
    for (const r of [pending, toSettle, toRelease]) {
      if (r.status !== "reserved") throw new Error("expected reservation");
    }
    if (
      pending.status !== "reserved" ||
      toSettle.status !== "reserved" ||
      toRelease.status !== "reserved"
    ) {
      throw new Error("expected reservations");
    }
    const settled = reconcileBudget(toSettle.reservation, {
      inputTokens: 10,
      outputTokens: 10,
    }, SEP_15);
    const released = releaseBudget(toRelease.reservation, SEP_15);
    const snap = monthlyBudgetSnapshot({
      providerId: "preset:openai",
      usage: [],
      reservations: [pending.reservation, settled.reservation, released],
      now: SEP_15,
    });
    // Only the still-active reservation counts.
    const expected = pending.reservation.reservedUsd;
    if (expected === null) throw new Error("expected priced reservation");
    expect(snap.reservedUsd).toBeCloseTo(expected, 8);
  });
});
