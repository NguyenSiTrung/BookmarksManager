import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { SummaryDialog } from "../../src/entrypoints/sidepanel/SummaryDialog";

/**
 * SummaryDialog drives the explicit `LLM_SUMMARIZE` intent: the send fires
 * ONLY when the dialog is open (never on mount/mount-only renders), progress
 * and result states render the worker's reply verbatim, and a
 * `confirmation_required` reply swaps in CostConfirmationDialog whose
 * confirm resends the same intent with `unknownCostConfirmed: true`.
 */

const sendMessage = vi.fn();

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ ok: true, code: "summary_read" });
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      getURL: (p: string) => `chrome-extension://test-id/${p}`,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDialog(open = true) {
  return render(
    <SummaryDialog
      open={open}
      tabId={42}
      bookmarkId="bm-001"
      bookmarkTitle="An article"
      onClose={vi.fn()}
    />,
  );
}

describe("SummaryDialog", () => {
  it("sends LLM_SUMMARIZE exactly once when opened — never on a closed mount", async () => {
    const { rerender } = renderDialog(false);
    expect(sendMessage).not.toHaveBeenCalled();
    rerender(
      <SummaryDialog
        open
        tabId={42}
        bookmarkId="bm-001"
        bookmarkTitle="An article"
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({
      type: "LLM_SUMMARIZE",
      tabId: 42,
      bookmarkId: "bm-001",
    });
  });

  it("renders the persisted summary only after a verified summary_ok", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      code: "summary_ok",
      summary: "A page about caching.",
      model: "gpt-4o-mini",
    });
    renderDialog();
    const text = await screen.findByTestId("summary-text");
    expect(text.textContent).toContain("A page about caching.");
  });

  it("renders worker failures as an alert without a summary", async () => {
    sendMessage.mockResolvedValue({
      ok: false,
      code: "no_consent",
      stage: "consent",
      message: "Page text has not been consented.",
    });
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Page text has not been consented.");
    expect(screen.queryByTestId("summary-text")).toBeNull();
  });

  it("shows the cost dialog on confirmation_required and resends with the flag", async () => {
    sendMessage
      .mockResolvedValueOnce({
        ok: false,
        code: "confirmation_required",
        stage: "summarize",
        message: "This request needs an explicit unknown-cost confirmation.",
        destinationOrigin: "https://api.openai.com",
      })
      .mockResolvedValueOnce({
        ok: true,
        code: "summary_ok",
        summary: "Confirmed summary.",
        model: "gpt-4o-mini",
      });
    renderDialog();
    const confirm = await screen.findByRole("button", {
      name: "Send anyway",
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "LLM_SUMMARIZE",
      tabId: 42,
      bookmarkId: "bm-001",
      unknownCostConfirmed: true,
    });
    expect((await screen.findByTestId("summary-text")).textContent).toContain(
      "Confirmed summary.",
    );
  });

  it("announces progress and result through the live region", async () => {
    sendMessage.mockResolvedValue({
      ok: true,
      code: "summary_ok",
      summary: "A page about caching.",
      model: "gpt-4o-mini",
    });
    renderDialog();
    await screen.findByTestId("summary-text");
    const status = document.getElementById("summary-dialog-announce");
    expect(status?.textContent).toContain("Summary saved");
  });

  it("Escape closes without resending", async () => {
    const onClose = vi.fn();
    sendMessage.mockResolvedValue({
      ok: false,
      code: "no_provider",
      message: "No LLM provider is configured.",
    });
    render(
      <SummaryDialog
        open
        tabId={42}
        bookmarkId="bm-001"
        bookmarkTitle="An article"
        onClose={onClose}
      />,
    );
    await screen.findByRole("alert");
    fireEvent.keyDown(screen.getAllByRole("dialog")[0]!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
