import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { SummaryDialog } from "../../src/entrypoints/sidepanel/SummaryDialog";

const sendMessage = vi.fn();
const APPROVAL = {
  consentVersion: 4,
  llm: { origin: "https://api.openai.com", providerId: "preset:openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1/chat/completions" },
  jev: { origin: "https://api.typesafe.ai", providerId: "typesafe", model: "jev-latest", endpoint: "https://api.typesafe.ai/v1/systemone" },
};
const PREFLIGHT = { ok: true, code: "summary_consent", consent: { approval: APPROVAL, llmGranted: false, jevGranted: false } };
const SUCCESS = { ok: true, code: "summary_ok", summary: "A page about caching.", model: "gpt-4o-mini" };
const PROPS = { open: true, tabId: 42, bookmarkId: "bm-001", bookmarkTitle: "An article", onClose: vi.fn() };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (message: { type: string }) => message.type === "LLM_SUMMARY_PREFLIGHT" ? PREFLIGHT : SUCCESS);
  vi.stubGlobal("chrome", { runtime: { sendMessage, getURL: (p: string) => `chrome-extension://test-id/${p}` } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function renderDialog(open = true) { return render(<SummaryDialog {...PROPS} open={open} />); }
async function approve() { fireEvent.click(await screen.findByRole("button", { name: "Agree and summarize" })); }
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SummaryDialog disclosed consent", () => {
  it("preflights only on open and sends nothing until the affirmative click", async () => {
    const { rerender } = renderDialog(false);
    expect(sendMessage).not.toHaveBeenCalled();
    rerender(<SummaryDialog {...PROPS} />);
    await screen.findByRole("button", { name: "Agree and summarize" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: "LLM_SUMMARY_PREFLIGHT" });
    expect(screen.queryByTestId("summary-text")).toBeNull();
    await approve();
    await screen.findByTestId("summary-text");
    expect(sendMessage).toHaveBeenNthCalledWith(2, { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: "bm-001", consentApproval: APPROVAL });
  });

  it("shows both exact recipients, current version, and all actual per-hop fields", async () => {
    renderDialog();
    await screen.findByRole("button", { name: "Agree and summarize" });
    const llm = screen.getByRole("region", { name: "Page summaries disclosure" });
    const jev = screen.getByRole("region", { name: "Jev summary verification disclosure" });
    expect(llm.textContent).toContain("https://api.openai.com");
    for (const field of ["page title", "cleaned URL", "site name", "headings", "bounded page excerpt", "meta description"]) expect(within(llm).getByText(field)).toBeDefined();
    expect(jev.textContent).toContain("https://api.typesafe.ai");
    for (const field of ["bookmark title", "cleaned URL", "domain", "headings", "bounded page excerpt", "LLM-generated summary"]) expect(within(jev).getByText(field)).toBeDefined();
    expect(jev.textContent).not.toContain("meta description");
    expect(screen.getByText(/Consent version 4/)).toBeDefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("opening and dismissing never records consent or sends a summary", async () => {
    const onClose = vi.fn();
    render(<SummaryDialog {...PROPS} onClose={onClose} />);
    await screen.findByRole("button", { name: "Agree and summarize" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["LLM_SUMMARY_PREFLIGHT"]);
  });

  it("requires a send click even when both grants are already current", async () => {
    sendMessage.mockResolvedValueOnce({ ...PREFLIGHT, consent: { approval: APPROVAL, llmGranted: true, jevGranted: true } });
    renderDialog();
    await screen.findByRole("button", { name: "Agree and summarize" });
    expect(screen.getAllByText("Current grant")).toHaveLength(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await approve();
    expect((await screen.findByTestId("summary-text")).textContent).toContain("A page about caching.");
  });

  it("keeps unknown-cost confirmation separate and resends the accepted binding", async () => {
    sendMessage.mockResolvedValueOnce(PREFLIGHT).mockResolvedValueOnce({ ok: false, code: "confirmation_required", message: "Confirm unknown cost.", destinationOrigin: "https://api.openai.com" }).mockResolvedValueOnce(SUCCESS);
    renderDialog();
    await approve();
    fireEvent.click(await screen.findByRole("button", { name: "Send anyway" }));
    await screen.findByTestId("summary-text");
    expect(sendMessage).toHaveBeenNthCalledWith(3, { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: "bm-001", consentApproval: APPROVAL, unknownCostConfirmed: true });
  });

  it("guards duplicate affirmative clicks while a request is pending", async () => {
    const held = deferred();
    sendMessage.mockResolvedValueOnce(PREFLIGHT).mockReturnValueOnce(held.promise);
    renderDialog();
    const button = await screen.findByRole("button", { name: "Agree and summarize" });
    fireEvent.click(button); fireEvent.click(button);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await act(async () => held.resolve(SUCCESS));
    await screen.findByTestId("summary-text");
  });

  it("guards duplicate unknown-cost confirmation clicks", async () => {
    const held = deferred();
    sendMessage.mockResolvedValueOnce(PREFLIGHT).mockResolvedValueOnce({ ok: false, code: "confirmation_required", message: "Confirm cost.", destinationOrigin: "https://api.openai.com" }).mockReturnValueOnce(held.promise);
    renderDialog(); await approve();
    const button = await screen.findByRole("button", { name: "Send anyway" });
    fireEvent.click(button); fireEvent.click(button);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await act(async () => held.resolve(SUCCESS));
  });

  it("ignores stale preflight completion after inputs change while mounted", async () => {
    const old = deferred();
    const fresh = { ...APPROVAL, llm: { ...APPROVAL.llm, origin: "https://new-provider.dev", endpoint: "https://new-provider.dev/v1/chat/completions" } };
    sendMessage.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...PREFLIGHT, consent: { ...PREFLIGHT.consent, approval: fresh } });
    const { rerender } = renderDialog();
    rerender(<SummaryDialog {...PROPS} tabId={43} bookmarkId="bm-002" bookmarkTitle="New article" />);
    await screen.findByText("https://new-provider.dev");
    await act(async () => old.resolve(PREFLIGHT));
    expect(screen.queryByText("https://api.openai.com")).toBeNull();
    await approve(); await screen.findByTestId("summary-text");
    expect(sendMessage).toHaveBeenLastCalledWith({ type: "LLM_SUMMARIZE", tabId: 43, bookmarkId: "bm-002", consentApproval: fresh });
  });

  it("ignores a stale summary response after close and reopen", async () => {
    const held = deferred();
    sendMessage.mockResolvedValueOnce(PREFLIGHT).mockReturnValueOnce(held.promise).mockResolvedValueOnce(PREFLIGHT);
    const { rerender } = renderDialog(); await approve();
    rerender(<SummaryDialog {...PROPS} open={false} />);
    rerender(<SummaryDialog {...PROPS} />);
    await screen.findByRole("button", { name: "Agree and summarize" });
    await act(async () => held.resolve(SUCCESS));
    expect(screen.queryByTestId("summary-text")).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("renders failures and does not send after a failed preflight", async () => {
    sendMessage.mockResolvedValue({ ok: false, code: "no_provider", message: "No provider configured." });
    renderDialog();
    expect((await screen.findByRole("alert")).textContent).toContain("No provider configured.");
    expect(screen.queryByRole("button", { name: "Agree and summarize" })).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("announces the saved result only after the approved request succeeds", async () => {
    renderDialog(); await approve(); await screen.findByTestId("summary-text");
    expect(document.getElementById("summary-dialog-announce")?.textContent).toContain("Summary saved");
  });

  it("Escape closes without an affirmative send", async () => {
    const onClose = vi.fn();
    render(<SummaryDialog {...PROPS} onClose={onClose} />);
    await screen.findByRole("button", { name: "Agree and summarize" });
    fireEvent.keyDown(screen.getAllByRole("dialog")[0]!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
