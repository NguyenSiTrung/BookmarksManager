import "fake-indexeddb/auto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../../src/db/database";
import { LlmBudget } from "../../src/entrypoints/options/LlmBudget";

/**
 * Options → monthly LLM spend panel: the reported/estimated stat row, and the
 * spending-ceiling editor that exists so the ceiling can change without
 * revoking the provider and re-entering its credential.
 *
 * The editor is the only writer of `LLM_BUDGET_SET` in the extension, so the
 * cases here pin what it puts on the wire: one ceiling state at a time, an
 * empty form meaning "not chosen" rather than an unlimited default, and
 * pricing sent as a matched pair or not at all.
 */

const PROVIDER_ID = "preset:openai";

interface FakeStatus {
  configured: boolean;
  enabled: boolean;
  consentGranted: boolean;
  permissionGranted: boolean;
  active: boolean;
  providerId?: string;
  origin?: string;
  budget?: "capped" | "unlimited" | "unset";
  monthlyBudgetUsd?: number;
  pricingKnown?: boolean;
  model?: string;
}

interface FakeSnapshot {
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

const SNAPSHOT: FakeSnapshot = {
  month: "2026-09",
  requestCount: 3,
  inputTokens: 1200,
  outputTokens: 400,
  reportedCostUsd: 0.5,
  estimatedCostUsd: 0.6,
  unknownCostRequests: 0,
  hasUnknownCost: false,
  reservedUsd: 0,
  committedUsd: 0.5,
  budgetUsd: 5,
  remainingUsd: 4.5,
};

let status: FakeStatus;
let snapshot: FakeSnapshot;
let snapshotFail: boolean;
let budgetSetError: { code: string; message: string } | null;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let budgetSetCalls: Array<Record<string, unknown>>;

function workerReply(message: unknown): Promise<unknown> {
  const msg = message as Record<string, unknown>;
  switch (msg.type) {
    case "LLM_BUDGET_SNAPSHOT":
      if (snapshotFail) {
        return Promise.resolve({
          ok: false,
          code: "internal_error",
          message: "snapshot unavailable",
        });
      }
      return Promise.resolve({
        ok: true,
        code: "budget_snapshot",
        snapshot,
      });
    case "LLM_PROVIDER_STATUS":
      return Promise.resolve({ ok: true, status });
    case "LLM_BUDGET_SET": {
      budgetSetCalls.push(msg);
      if (budgetSetError !== null) {
        return Promise.resolve({ ok: false, ...budgetSetError });
      }
      // Mirror the worker: exactly one ceiling state survives the write.
      const budget = msg.budget as
        | { kind: "capped"; usd: number }
        | { kind: "unlimited" }
        | { kind: "unset" };
      if (budget.kind === "capped") {
        status = {
          ...status,
          budget: "capped",
          monthlyBudgetUsd: budget.usd,
        };
      } else if (budget.kind === "unlimited") {
        status = { ...status, budget: "unlimited" };
        delete status.monthlyBudgetUsd;
      } else {
        status = { ...status, budget: "unset" };
        delete status.monthlyBudgetUsd;
      }
      return Promise.resolve({ ok: true, status });
    }
    default:
      return Promise.resolve({
        ok: false,
        code: "internal_error",
        message: "unhandled intent",
      });
  }
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  status = {
    configured: true,
    enabled: true,
    consentGranted: true,
    permissionGranted: true,
    active: true,
    providerId: PROVIDER_ID,
    origin: "https://api.openai.com",
    budget: "capped",
    monthlyBudgetUsd: 5,
    pricingKnown: true,
    model: "gpt-4o-mini",
  };
  snapshot = { ...SNAPSHOT };
  snapshotFail = false;
  budgetSetError = null;
  budgetSetCalls = [];
  sendMessageSpy = vi.fn(workerReply);
  await db.metadata.clear();
  await db.llmUsage.clear();
  await db.llmReservations.clear();
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: sendMessageSpy,
      getURL: (p: string) => `chrome-extension://testext/${p}`,
    },
  });
});

async function panel(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "LLM budget" }),
    ).toBeTruthy(),
  );
  return screen.getByRole("region", { name: "LLM budget" });
}

function capInput(): HTMLInputElement {
  return screen.getByLabelText("Monthly cap (USD)") as HTMLInputElement;
}

function unlimitedBox(): HTMLInputElement {
  return screen.getByLabelText(
    /no monthly cap — spend without a limit/i,
  ) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /save ceiling/i }) as HTMLButtonElement;
}

/** Render, then wait for the panel's status read before touching the editor. */
async function ready(): Promise<HTMLElement> {
  render(<LlmBudget />);
  const region = await panel();
  // The editor is the last thing to appear: it needs the status reply.
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  return region;
}

describe("LlmBudget spend stats", () => {
  it("renders the month's spend against the cap", async () => {
    await ready();
    const region = await panel();
    expect(region.textContent).toContain("$5.00");
    expect(region.textContent).toContain("$4.50");
  });

  it("says unlimited instead of showing a cap that does not exist", async () => {
    status = { ...status, budget: "unlimited" };
    delete status.monthlyBudgetUsd;
    await ready();
    const region = await panel();
    expect(region.textContent).toContain("unlimited");
    expect(unlimitedBox().checked).toBe(true);
    // An unlimited ceiling leaves no cap to type into.
    expect(capInput().disabled).toBe(true);
  });

  it("hides the editor entirely when no provider is configured", async () => {
    status = { ...status, budget: "unset", pricingKnown: false };
    delete status.providerId;
    render(<LlmBudget />);
    await panel();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /save ceiling/i })).toBeNull(),
    );
    expect(sendMessageSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "LLM_BUDGET_SET" }),
    );
  });
});

describe("LlmBudget ceiling editor", () => {
  it("sends the typed cap and nothing else", async () => {
    await ready();
    fireEvent.change(capInput(), { target: { value: "12.5" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(budgetSetCalls).toHaveLength(1));
    expect(budgetSetCalls[0]).toMatchObject({
      type: "LLM_BUDGET_SET",
      providerId: PROVIDER_ID,
      budget: { kind: "capped", usd: 12.5 },
    });
    expect(budgetSetCalls[0]).not.toHaveProperty("pricing");
  });

  it("sends an explicit unlimited choice and clears the typed cap", async () => {
    await ready();
    fireEvent.change(capInput(), { target: { value: "9" } });
    fireEvent.click(unlimitedBox());
    // The cap is dropped from the form the moment unlimited is chosen, so a
    // stale number can never be saved alongside it.
    expect(capInput().value).toBe("");
    expect(capInput().disabled).toBe(true);

    fireEvent.click(saveButton());
    await waitFor(() => expect(budgetSetCalls).toHaveLength(1));
    expect(budgetSetCalls[0]).toMatchObject({
      budget: { kind: "unlimited" },
    });
  });

  it("sends 'unset' when both the cap and unlimited are left alone", async () => {
    status = { ...status, budget: "unlimited" };
    delete status.monthlyBudgetUsd;
    await ready();
    fireEvent.click(unlimitedBox());
    expect(unlimitedBox().checked).toBe(false);
    expect(capInput().value).toBe("");

    fireEvent.click(saveButton());
    await waitFor(() => expect(budgetSetCalls).toHaveLength(1));
    expect(budgetSetCalls[0]).toMatchObject({ budget: { kind: "unset" } });
  });

  it("refuses a non-numeric cap without messaging the worker", async () => {
    await ready();
    fireEvent.change(capInput(), { target: { value: "five" } });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(
        screen.getByText(/must be a nonnegative number/i),
      ).toBeTruthy(),
    );
    expect(budgetSetCalls).toHaveLength(0);
  });

  it("refuses a one-sided price pair without messaging the worker", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText(/input price/i), {
      target: { value: "3" },
    });
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText(/two nonnegative USD-per-million/i)).toBeTruthy(),
    );
    expect(budgetSetCalls).toHaveLength(0);
  });

  it("sends both rates when both are given, then clears the fields", async () => {
    await ready();
    fireEvent.change(screen.getByLabelText(/input price/i), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/output price/i), {
      target: { value: "4" },
    });
    fireEvent.click(saveButton());
    await waitFor(() => expect(budgetSetCalls).toHaveLength(1));
    expect(budgetSetCalls[0]).toMatchObject({
      pricing: { inputPerMillion: 3, outputPerMillion: 4 },
    });
    // The override is now stored, so the form does not keep echoing it.
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/input price/i) as HTMLInputElement).value,
      ).toBe(""),
    );
  });

  it("renders the worker's refusal verbatim and keeps the editor usable", async () => {
    await ready();
    budgetSetError = {
      code: "not_configured",
      message: "That provider is not configured; enable it first.",
    };
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(
        screen.getByText(/That provider is not configured/i),
      ).toBeTruthy(),
    );
    expect(saveButton().disabled).toBe(false);
  });

  it("says an unpriced model refuses unattended runs until rates are entered", async () => {
    status = { ...status, pricingKnown: false };
    await ready();
    expect(screen.getByText(/no price is known/i)).toBeTruthy();
    expect(
      screen.getByText(/unattended features refuse until you enter both rates/i),
    ).toBeTruthy();
  });

  it("names the model when a price is already known", async () => {
    await ready();
    expect(screen.getByText(/prices are known for gpt-4o-mini/i)).toBeTruthy();
  });

  it("refuses hex and exponent caps without messaging the worker", async () => {
    await ready();
    for (const bad of ["0x10", "1e3"]) {
      fireEvent.change(capInput(), { target: { value: bad } });
      fireEvent.click(saveButton());
      await waitFor(() =>
        expect(
          screen.getByText(/must be a nonnegative number/i),
        ).toBeTruthy(),
      );
    }
    expect(budgetSetCalls).toHaveLength(0);
  });
});

describe("LlmBudget live refresh", () => {
  it("re-reads the snapshot when the usage tables change", async () => {
    const region = await ready();
    expect(region.textContent).toContain("$4.50");
    snapshot = { ...snapshot, reportedCostUsd: 9.99, committedUsd: 9.99 };
    // A write to any table the snapshot derives from re-reads it through
    // the worker protocol.
    await act(async () => {
      await db.llmUsage.put({
        providerId: PROVIDER_ID,
        feature: "llm_explain",
        model: "gpt-4o-mini",
        configuredModel: "gpt-4o-mini",
        inputTokens: 10,
        outputTokens: 2,
        month: "2026-09",
        recordedAt: "2026-09-27T10:00:00.000Z",
      });
    });
    await waitFor(() => expect(region.textContent).toContain("$9.99"));
  });

  it("clears a stale load error once the snapshot answers again", async () => {
    snapshotFail = true;
    render(<LlmBudget />);
    await waitFor(() =>
      expect(
        screen.getByText(/budget information is unavailable/i),
      ).toBeTruthy(),
    );
    snapshotFail = false;
    await act(async () => {
      await db.metadata.put({ key: "poke", value: 1 });
    });
    const region = await panel();
    await waitFor(() =>
      expect(
        screen.queryByText(/budget information is unavailable/i),
      ).toBeNull(),
    );
    expect(region.textContent).toContain("$4.50");
  });

  it("never clobbers an in-progress cap edit on refresh", async () => {
    await ready();
    fireEvent.change(capInput(), { target: { value: "42" } });
    status = { ...status, monthlyBudgetUsd: 7 };
    await act(async () => {
      await db.metadata.put({ key: "poke", value: 1 });
    });
    await waitFor(() =>
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LLM_PROVIDER_STATUS" }),
      ),
    );
    expect(capInput().value).toBe("42");
  });
});