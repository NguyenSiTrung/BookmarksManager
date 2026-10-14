import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within, waitFor } from "@testing-library/react";
import { db } from "../../src/db/database";
import { getMeta, getTag, patchMeta, setBookmarkSummary } from "../../src/db/meta";
import { flattenTree } from "../../src/sync/tree";
import { SummaryDialog } from "../../src/entrypoints/sidepanel/SummaryDialog";
import { EditDialog } from "../../src/entrypoints/sidepanel/EditDialog";
import { FolderActions } from "../../src/entrypoints/sidepanel/FolderActions";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";

const sendMessage = vi.fn();
const APPROVAL = {
  consentVersion: 4,
  llm: { origin: "https://api.openai.com", providerId: "preset:openai", model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1/chat/completions" },
  jev: { origin: "https://api.typesafe.ai", providerId: "typesafe", model: "jev-latest", endpoint: "https://api.typesafe.ai/v1/systemone" },
};
const PREFLIGHT = { ok: true, code: "summary_consent", consent: { approval: APPROVAL, llmGranted: false, jevGranted: false } };
const SUCCESS = { ok: true, code: "summary_ok", summary: "A page about caching.", model: "gpt-4o-mini" };
const PROPS = { open: true, tabId: 42, bookmarkId: "bm-001", bookmarkTitle: "An article", onClose: vi.fn() };

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await db.open();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
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

  it("labels the dismiss control 'Continue in background' while a send is in flight", async () => {
    const held = deferred();
    const onClose = vi.fn();
    sendMessage.mockResolvedValueOnce(PREFLIGHT).mockReturnValueOnce(held.promise);
    render(<SummaryDialog {...PROPS} onClose={onClose} />);
    await approve();
    // The worker request is fire-and-forget — closing cannot cancel it, so
    // the only dismiss control says so.
    const dismiss = await screen.findByRole("button", { name: "Continue in background" });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(dismiss);
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => held.resolve(SUCCESS));
  });

  it("uses theme tokens, not hardcoded light-theme colors", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("bg-background");
    const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const cls = (node as Element).getAttribute("class") ?? "";
      expect(cls).not.toMatch(/bg-white|text-slate|bg-slate/);
    }
  });

  it("traps focus inside the dialog while open", async () => {
    renderDialog();
    const dialog = await screen.findByRole("dialog");
    const close = await screen.findByRole("button", { name: "Close" });
    await screen.findByRole("button", { name: "Agree and summarize" });
    // Radix's focus scope owns Tab cycling; Tabbing past the last control
    // wraps back inside instead of escaping to the page.
    const sentinel = document.createElement("button");
    document.body.appendChild(sentinel);
    sentinel.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(dialog.contains(active)).toBe(true);
    });
    sentinel.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    await vi.waitFor(() => {
      const active = document.activeElement;
      expect(dialog.contains(active)).toBe(true);
    });
    expect(close).toBeDefined();
    sentinel.remove();
  });
});

describe("SummaryDialog saved summary and runtime origin permissions (B-06b, U-02)", () => {
  it("displays an existing saved summary first with Re-summarize and Clear summary actions", async () => {
    await setBookmarkSummary("bm-001", "Previously saved summary.");
    const onClose = vi.fn();
    render(<SummaryDialog {...PROPS} onClose={onClose} />);

    const summaryEl = await screen.findByTestId("summary-text");
    expect(summaryEl.textContent).toBe("Previously saved summary.");
    expect(screen.getByRole("button", { name: "Re-summarize" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear summary" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Agree and summarize" })).toBeNull();

    // Clicking Re-summarize transitions into the normal preflight / disclosure flow.
    fireEvent.click(screen.getByRole("button", { name: "Re-summarize" }));
    await screen.findByRole("button", { name: "Agree and summarize" });
    expect(sendMessage).toHaveBeenCalledWith({ type: "LLM_SUMMARY_PREFLIGHT" });
  });

  it("Clear summary removes the saved summary from bookmarkMeta and closes", async () => {
    await setBookmarkSummary("bm-001", "Summary to clear.");
    const onClose = vi.fn();
    render(<SummaryDialog {...PROPS} onClose={onClose} />);

    await screen.findByTestId("summary-text");
    fireEvent.click(screen.getByRole("button", { name: "Clear summary" }));

    await waitFor(async () => {
      expect((await getMeta("bm-001"))?.summary).toBeUndefined();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requests missing runtime origin permissions on Agree and summarize click (B-06b)", async () => {
    const contains = vi.fn(async ({ origins }: { origins?: string[] }) =>
      origins?.[0] === "https://api.typesafe.ai/*",
    );
    const request = vi.fn(async () => true);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, getURL: (p: string) => `chrome-extension://test-id/${p}` },
      permissions: { contains, request },
    });

    renderDialog();
    await approve();
    await screen.findByTestId("summary-text");

    expect(contains).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
    expect(request).toHaveBeenCalledWith({ origins: ["https://api.openai.com/*"] });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "LLM_SUMMARIZE",
      tabId: 42,
      bookmarkId: "bm-001",
      consentApproval: APPROVAL,
    });
  });

  it("aborts without sending when runtime origin permission is denied (B-06b)", async () => {
    const contains = vi.fn(async () => false);
    const request = vi.fn(async () => false);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, getURL: (p: string) => `chrome-extension://test-id/${p}` },
      permissions: { contains, request },
    });

    renderDialog();
    await approve();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Host permission was not granted — nothing was sent.");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("EditDialog & FolderActions hardening (U-02a, U-04b, U-08d)", () => {
  it("displays saved summary with Clear summary, commits uncommitted tagInput on Save, and stamps metaPatch.url", async () => {
    const fake = createFakeBookmarks({
      bookmarksBar: [{ id: "b1", title: "Alpha", url: "https://a.example/1" }],
    });
    vi.stubGlobal("chrome", {
      bookmarks: fake,
      runtime: { getURL: (p: string) => `chrome-extension://test-id/${p}` },
    });
    await patchMeta("b1", { summary: "Saved page summary.", notes: "initial note" });
    const tree = flattenTree(await fake.getTree());
    const target = tree.bookmarks.get("b1")!;
    const meta = await getMeta("b1");
    const onOpenChange = vi.fn();

    render(
      <EditDialog
        target={target}
        open
        onOpenChange={onOpenChange}
        tree={tree}
        {...(meta !== undefined ? { meta } : {})}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("max-h-[85vh]");
    expect(dialog.className).toContain("overflow-y-auto");

    const savedSummary = within(dialog).getByTestId("edit-saved-summary");
    expect(savedSummary.textContent).toBe("Saved page summary.");

    // Clear the saved summary
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear summary" }));
    expect(within(dialog).queryByTestId("edit-saved-summary")).toBeNull();

    // Type a new tag without pressing Enter or Add tag
    fireEvent.change(within(dialog).getByLabelText("New tag name"), {
      target: { value: "UncommittedTag" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    const updatedMeta = await getMeta("b1");
    expect(updatedMeta?.summary).toBeUndefined();
    expect(updatedMeta?.tags).toEqual(["uncommittedtag"]);
    expect(updatedMeta?.url).toBe("https://a.example/1");
    expect(await getTag("uncommittedtag")).toBeDefined();
  });

  it("hides Tags, Category, and Notes when editing a folder and forwards tabIndex on FolderActions", async () => {
    const fake = createFakeBookmarks({
      bookmarksBar: [{ id: "f1", title: "Docs Folder", children: [] }],
    });
    vi.stubGlobal("chrome", {
      bookmarks: fake,
      runtime: { getURL: (p: string) => `chrome-extension://test-id/${p}` },
    });
    const tree = flattenTree(await fake.getTree());
    const folder = tree.folders.get("f1")!;

    const { unmount } = render(
      <FolderActions node={folder} onAction={() => {}} tabIndex={-1} />,
    );
    const kebab = screen.getByRole("button", { name: "Folder actions for Docs Folder" });
    expect(kebab.tabIndex).toBe(-1);
    unmount();

    render(<EditDialog target={folder} open onOpenChange={() => {}} tree={tree} />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("URL")).toBeNull();
    expect(within(dialog).queryByLabelText("New tag name")).toBeNull();
    expect(within(dialog).queryByLabelText("Category")).toBeNull();
    expect(within(dialog).queryByLabelText("Notes")).toBeNull();
  });
});
