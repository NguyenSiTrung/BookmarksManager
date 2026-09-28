import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import "fake-indexeddb/auto";
import { SummaryDialog } from "../../src/entrypoints/sidepanel/SummaryDialog";
import { RestructureView } from "../../src/entrypoints/sidepanel/RestructureView";
import { ToastProvider } from "../../src/entrypoints/sidepanel/UndoToast";

/**
 * Phase 6 Task 2 — accessibility gate for the LLM surfaces. Every new
 * control must expose an accessible name, keep keyboard focus sane
 * (dialog focus-in, focus-restore on close), announce async progress via
 * live regions, and carry state as text — never color alone.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let sendMessageSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The summarize send never resolves — the dialog stays in `running`.
  sendMessageSpy = vi.fn(() => new Promise<never>(() => {}));
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: sendMessageSpy },
  });
});

const DIALOG = {
  tabId: 7,
  bookmarkId: "bm-1",
  bookmarkTitle: "Fixture page",
};

describe("SummaryDialog accessibility", () => {
  it("is a labelled modal that moves focus in and restores it on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(
      <SummaryDialog open {...DIALOG} onClose={() => {}} />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("summary-dialog-title");
    // Focus moved inside on open — the Close button.
    const close = screen.getByRole("button", { name: "Close" });
    await waitFor(() => {
      expect(document.activeElement).toBe(close);
    });
    // A live region carries progress announcements.
    expect(dialog.querySelector("[aria-live='polite']")).not.toBeNull();

    rerender(<SummaryDialog open={false} {...DIALOG} onClose={() => {}} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
    trigger.remove();
  });

  it("keeps every control keyboard-reachable while running", async () => {
    render(<SummaryDialog open {...DIALOG} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const focusables = dialog.querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of focusables) {
      expect((el as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("RestructureView accessibility", () => {
  it("exposes a labelled pane, a progressbar, and live announcements", async () => {
    const job = {
      id: "job-1",
      kind: "restructure",
      status: "running",
      progress: { totalBatches: 4, committedBatches: 1 },
      batchSize: 10,
      bookmarkIds: ["11"],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
      restructure: { proposal: { folders: [] }, assignments: [] },
    };
    sendMessageSpy.mockImplementation((m: { type: string }) =>
      m.type === "RESTRUCTURE_STATUS"
        ? Promise.resolve({ ok: true, code: "job_state", result: { job } })
        : Promise.resolve({ ok: false, code: "internal_error" }),
    );
    render(
      <ToastProvider controller={{ showToast: () => {} }}>
        <RestructureView />
      </ToastProvider>,
    );
    const bar = await screen.findByRole("progressbar", {
      name: "Assignment progress",
    });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    // Live-region text announces batch progress — not color alone.
    const pane = document.querySelector("[aria-label='Restructure library']");
    expect(pane).not.toBeNull();
    expect(
      pane!.querySelectorAll("[aria-live='polite']").length,
    ).toBeGreaterThan(0);
    // The proposal trigger is a real button (keyboard-operable).
    expect(
      screen.getAllByRole("button").length,
    ).toBeGreaterThan(0);
  });
});
