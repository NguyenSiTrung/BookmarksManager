import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestructureView } from "../../src/entrypoints/sidepanel/RestructureView";
import { ToastProvider } from "../../src/entrypoints/sidepanel/UndoToast";

/**
 * `RestructureView` (spec FR8 UI): the workflow pane drives the
 * `RESTRUCTURE_*` protocol — start/confirmation dialog resend, progress
 * polling, pause/resume/cancel, the diff preview, the two-step destructive
 * apply, and undo via the shell toast. The worker is a
 * `chrome.runtime.sendMessage` stub returning canned replies; the view
 * must never apply before confirmation and must render confidence as text
 * (non-color-only), keyboard-navigable rows, and live-region announcements.
 */

const NOW = "2026-09-28T00:00:00.000Z";

function jobRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    kind: "restructure",
    status: "running",
    progress: { totalBatches: 4, committedBatches: 1 },
    batchSize: 10,
    bookmarkIds: ["11"],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    restructure: {
      proposal: { folders: [{ path: "dev", description: "" }] },
      assignments: [],
    },
    ...over,
  };
}

const DIFF = {
  resolved: 1,
  unresolved: 1,
  stale: 0,
  rows: [
    {
      bookmarkId: "11",
      title: "Article A",
      fromPath: "Bookmarks bar/Old",
      toPath: "dev",
      confidence: 0.92,
      status: "resolved",
    },
    {
      bookmarkId: "12",
      title: "Article B",
      fromPath: "Bookmarks bar/Old",
      toPath: null,
      confidence: null,
      status: "unresolved",
    },
  ],
};

/**
 * Canned worker: STATUS returns the mutable job (the stub mutates it on
 * PAUSE/RESUME/CANCEL so a later poll reflects the transition, like the
 * real worker's row), everything else a fixed ack.
 */
function workerFor(initial: Record<string, unknown> | null) {
  const job = initial;
  return vi.fn(async (raw: unknown) => {
    const msg = raw as { type: string };
    switch (msg.type) {
      case "RESTRUCTURE_STATUS":
        if (job === null) {
          return { ok: false, code: "not_found", message: "none" };
        }
        return { ok: true, code: "job_state", result: { job } };
      case "RESTRUCTURE_START":
        return { ok: true, code: "job_ok", job: jobRow({ status: "running" }) };
      case "RESTRUCTURE_PAUSE":
        if (job !== null) job.status = "paused";
        return { ok: true, code: "job_ok", job };
      case "RESTRUCTURE_RESUME":
        if (job !== null) job.status = "running";
        return { ok: true, code: "job_ok", job };
      case "RESTRUCTURE_CANCEL":
        if (job !== null) job.status = "canceled";
        return { ok: true, code: "job_ok", job };
      case "RESTRUCTURE_CONFIRM":
        return { ok: true, code: "applied", moved: 1, snapshotId: 7 };
      case "RESTRUCTURE_UNDO":
        return { ok: true, code: "undone" };
      default:
        return { ok: false, code: "internal_error", message: "unknown" };
    }
  });
}

let sendMessage: ReturnType<typeof vi.fn<(m: unknown) => Promise<unknown>>>;

function mount() {
  return render(
    <ToastProvider controller={{ showToast: () => {} }}>
      <RestructureView />
    </ToastProvider>,
  );
}

beforeEach(() => {
  sendMessage = vi.fn(workerFor(null) as never);
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (p: string) => `chrome-extension://t/${p}`,
      // Late-bound: tests swap `sendMessage` implementations per case.
      sendMessage: (message: unknown) => sendMessage(message),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RestructureView idle/start", () => {
  it("shows the idle affordance with no job, then starts on click", async () => {
    sendMessage = vi.fn(workerFor(null) as never);
    mount();
    const btn = await screen.findByRole("button", {
      name: "Propose a layout…",
    });
    fireEvent.click(btn);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "RESTRUCTURE_START" }),
      ),
    );
  });

  it("resends START with unknownCostConfirmed on confirmation_required", async () => {
    sendMessage = vi.fn(async (raw: unknown): Promise<unknown> => {
      const msg = raw as { type: string; unknownCostConfirmed?: boolean };
      if (msg.type === "RESTRUCTURE_STATUS") {
        return { ok: false, code: "not_found", message: "none" };
      }
      if (msg.type === "RESTRUCTURE_START" && msg.unknownCostConfirmed !== true) {
        return {
          ok: false,
          code: "confirmation_required",
          message: "unpriced",
          destinationOrigin: "https://api.openai.com",
        };
      }
      if (msg.type === "RESTRUCTURE_START") {
        return { ok: true, code: "job_ok", job: jobRow() };
      }
      return { ok: false, code: "internal_error", message: "?" };
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Propose a layout…" }),
    );
    // The cost dialog names the destination and offers confirm.
    const confirm = await screen.findByRole("button", {
      name: /send anyway|confirm|continue/i,
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "RESTRUCTURE_START",
          unknownCostConfirmed: true,
        }),
      ),
    );
  });
});

describe("RestructureView job lifecycle", () => {
  it("shows progress, pauses, and resumes a running job", async () => {
    sendMessage = vi.fn(workerFor(jobRow({ status: "running" })));
    mount();
    expect(
      await screen.findByText(/Assigning… 1\/4 batches/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "RESTRUCTURE_PAUSE", jobId: "job-1" }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "RESTRUCTURE_RESUME", jobId: "job-1" }),
      ),
    );
  });

  it("renders the diff with text confidence chips, unresolved separated", async () => {
    sendMessage = vi.fn(
      workerFor(jobRow({ status: "completed" })),
    );
    sendMessage.mockImplementation(async (raw: unknown) => {
      const msg = raw as { type: string };
      if (msg.type === "RESTRUCTURE_STATUS") {
        return {
          ok: true,
          code: "job_state",
          result: { job: jobRow({ status: "completed" }), diff: DIFF },
        };
      }
      return workerFor(jobRow({ status: "completed" }))(raw);
    });
    mount();
    expect(await screen.findByText("Moves (1)")).toBeTruthy();
    expect(screen.getByText("Article A")).toBeTruthy();
    // Non-color-only: the chip text carries the signal.
    expect(screen.getByLabelText("Confidence: High")).toBeTruthy();
    expect(screen.getByText("Left in place (1)")).toBeTruthy();
    expect(screen.getByText("Article B")).toBeTruthy();
  });
});

describe("RestructureView apply", () => {
  it("requires the destructive confirm before CONFIRM fires", async () => {
    sendMessage = vi.fn(async (raw: unknown): Promise<unknown> => {
      const msg = raw as { type: string };
      if (msg.type === "RESTRUCTURE_STATUS") {
        return {
          ok: true,
          code: "job_state",
          result: { job: jobRow({ status: "completed" }), diff: DIFF },
        };
      }
      return workerFor(jobRow({ status: "completed" }))(raw);
    });
    mount();
    const arm = await screen.findByRole("button", {
      name: "Apply this layout…",
    });
    fireEvent.click(arm);
    // Armed: CONFIRM has NOT fired yet.
    expect(
      sendMessage.mock.calls.every(
        (c) => (c[0] as { type: string }).type !== "RESTRUCTURE_CONFIRM",
      ),
    ).toBe(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, apply" }),
    );
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "RESTRUCTURE_CONFIRM",
          jobId: "job-1",
        }),
      ),
    );
    expect(await screen.findByText(/Applied — 1 bookmark moved/)).toBeTruthy();
  });

  it("surfaces a failed apply as an error, staying on the diff", async () => {
    sendMessage = vi.fn(async (raw: unknown): Promise<unknown> => {
      const msg = raw as { type: string };
      if (msg.type === "RESTRUCTURE_STATUS") {
        return {
          ok: true,
          code: "job_state",
          result: { job: jobRow({ status: "completed" }), diff: DIFF },
        };
      }
      if (msg.type === "RESTRUCTURE_CONFIRM") {
        return {
          ok: false,
          code: "mutation_failed",
          message: "Chrome refused the move.",
        };
      }
      return workerFor(jobRow({ status: "completed" }))(raw);
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply this layout…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Yes, apply" }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Chrome refused the move.")).toBeTruthy();
    // The diff is still shown — the user can retry or walk away.
    expect(screen.getByText("Article A")).toBeTruthy();
  });
});
