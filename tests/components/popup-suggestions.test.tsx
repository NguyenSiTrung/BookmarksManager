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
import { grantConsent } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { App as PopupApp } from "../../src/entrypoints/popup/App";
import { Decision } from "../../src/schemas/decision";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Task 2 — popup save suggestions (spec FR10).
 *
 * The popup fires one `SAVE_SUGGEST` message once the form is prefilled and a
 * `jev_decisions` consent grant exists. The reply carries only counts — the
 * actual folder/tag/category suggestions arrive as persisted `db.decisions`
 * rows keyed by a synthetic `popup:<uuid>` bookmark id, which the suggestion
 * layer live-queries. The save form never waits on any of this.
 *
 * The worker is not running in these tests: `chrome.runtime.sendMessage` is a
 * stub that captures the outbound message and answers with a canned reply,
 * and decision rows are written straight into fake-indexeddb to emulate what
 * the worker's `saveSuggest` handler would have persisted.
 */

const FIXED_NOW = 1_700_000_000_000;
const ACTIVE_TAB = {
  id: 11,
  windowId: 7,
  title: "Example Page",
  url: "https://example.com/page",
};

let fake: FakeBookmarksApi;
let tabsQuery: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});

beforeEach(async () => {
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  await db.metadata.clear();
  await db.decisions.clear();
  await db.consents.clear();

  fake = createFakeBookmarks({
    now: () => FIXED_NOW,
    bookmarksBar: [{ id: "barfold", title: "Dev", children: [] }],
    otherBookmarks: [{ id: "fold", title: "Reading", children: [] }],
  });

  tabsQuery = vi.fn(async () => [ACTIVE_TAB]);
  sendMessage = vi.fn(async () => ({
    ok: true,
    code: "analyze_ok",
    result: { sent: true, decisionCount: 0 },
  }));
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    tabs: { query: tabsQuery },
    runtime: {
      sendMessage,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

/** Render the popup and wait for the tab/tree/last-folder prefill to settle. */
async function renderPopup(): Promise<void> {
  render(<PopupApp />);
  await waitFor(() =>
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      ACTIVE_TAB.title,
    ),
  );
}

function folderSelect(): HTMLSelectElement {
  return screen.getByLabelText("Folder") as HTMLSelectElement;
}

function categorySelect(): HTMLSelectElement {
  return screen.getByLabelText("Category") as HTMLSelectElement;
}

interface SentBookmark {
  id: string;
  title: string;
  url: string;
  parentId?: string;
  notes?: string;
}

/** The `bookmark` payload of the first sendMessage call. */
function sentBookmark(): SentBookmark {
  const message = sendMessage.mock.calls[0]?.[0] as
    | { type: string; bookmark: SentBookmark }
    | undefined;
  if (message === undefined) throw new Error("no message was sent");
  return message.bookmark;
}

/** Wait until the popup has dispatched SAVE_SUGGEST; returns its bookmark. */
async function waitForSuggestRequest(): Promise<SentBookmark> {
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  return sentBookmark();
}

interface DecisionSeed {
  bookmarkId: string;
  confidence?: number;
}

/** Validate + persist one decision row, inside act so live queries flush. */
async function putDecision(document: unknown): Promise<void> {
  const row = Decision.parse(document);
  await act(async () => {
    await db.decisions.put(row);
  });
}

function baseRow(seed: DecisionSeed): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    bookmarkIds: [seed.bookmarkId],
    confidence: seed.confidence ?? 0.9,
    status: "pending",
    source: {
      engine: "jev",
      providerId: "typesafe",
      model: "jev-1.13.0",
      questionSetVersion: "1",
    },
    createdAt: new Date(FIXED_NOW).toISOString(),
  };
}

function putMoveDecision(
  seed: DecisionSeed & { targetFolderId: string },
): Promise<void> {
  return putDecision({
    ...baseRow(seed),
    kind: "move",
    targetFolderId: seed.targetFolderId,
  });
}

function putTagsDecision(
  seed: DecisionSeed & { tags: string[] },
): Promise<void> {
  return putDecision({ ...baseRow(seed), kind: "add_tags", tags: seed.tags });
}

function putCategoryDecision(
  seed: DecisionSeed & { category: string },
): Promise<void> {
  return putDecision({
    ...baseRow(seed),
    kind: "set_category",
    category: seed.category,
  });
}

describe("PopupApp — save suggestions", () => {
  it("keeps the save form fully interactive while the suggestion request is in flight", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    // The worker never answers — the form must still work end to end.
    sendMessage.mockImplementation(() => new Promise(() => {}));
    await renderPopup();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Renamed" },
    });
    expect(
      (screen.getByLabelText("Title") as HTMLInputElement).value,
    ).toBe("Renamed");

    // A full save completes with the request still pending.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("save-confirmation");
  });

  it("does not tear down the in-flight SAVE_SUGGEST when the title/URL are edited", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    // Hold the reply so we can edit the form while the request is in flight.
    let resolveReply: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReply = resolve;
        }),
    );
    await renderPopup();
    await waitForSuggestRequest();

    // The user edits Title and URL mid-flight. The one-shot effect must not
    // re-run (and thus must not cancel the request or drop the reply).
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Renamed" },
    });
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/edited" },
    });

    await act(async () => {
      resolveReply({
        ok: true,
        code: "analyze_ok",
        result: { sent: false, reason: "blocklisted", decisionCount: 0 },
      });
      await Promise.resolve();
    });

    // The reply is honoured: the "not sent" note renders. Under the old
    // title/url-dependent effect this reply was dropped and the note missing.
    const note = await screen.findByTestId("suggestions-not-sent");
    expect(note.textContent ?? "").toMatch(/not sent/i);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still renders streamed suggestions when the reply lands after a mid-flight edit", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    let resolveReply: (value: unknown) => void = () => {};
    sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReply = resolve;
        }),
    );
    await renderPopup();
    const { id } = await waitForSuggestRequest();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Renamed" },
    });

    await act(async () => {
      resolveReply({
        ok: true,
        code: "analyze_ok",
        result: { sent: true, decisionCount: 1 },
      });
      await Promise.resolve();
    });

    // Suggestions arrive as persisted rows correlated by the synthetic id and
    // render despite the edit; the request was sent exactly once.
    await putTagsDecision({ bookmarkId: id, tags: ["reading"] });
    await screen.findByRole("button", { name: "Add suggested tag reading" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends SAVE_SUGGEST once with a synthetic popup id and no notes field", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await renderPopup();
    const bookmark = await waitForSuggestRequest();

    const message = sendMessage.mock.calls[0]?.[0] as {
      type: string;
      bookmark: SentBookmark;
    };
    expect(message.type).toBe("SAVE_SUGGEST");
    expect(bookmark.id).toMatch(/^popup:/);
    expect(bookmark.title).toBe(ACTIVE_TAB.title);
    expect(bookmark.url).toBe(ACTIVE_TAB.url);
    // parentId is the folder the picker resolved to (Other bookmarks).
    expect(bookmark.parentId).toBe("2");
    expect("notes" in bookmark).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("pre-selects the suggested folder only at confidence >= 0.7", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await renderPopup();
    const { id } = await waitForSuggestRequest();

    await putMoveDecision({
      bookmarkId: id,
      targetFolderId: "fold",
      confidence: 0.9,
    });
    await waitFor(() => expect(folderSelect().value).toBe("fold"));
  });

  it("leaves the folder picker on the default below 0.7", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await renderPopup();
    const { id } = await waitForSuggestRequest();

    // A weak move suggestion plus an observable tag row (proving the live
    // query delivered both) — the picker must not move.
    await putMoveDecision({
      bookmarkId: id,
      targetFolderId: "barfold",
      confidence: 0.6,
    });
    await putTagsDecision({ bookmarkId: id, tags: ["reading"] });
    await screen.findByRole("button", { name: "Add suggested tag reading" });

    expect(folderSelect().value).toBe("2");
  });

  it("offers suggested tags as chips that apply only on click", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await renderPopup();
    const { id } = await waitForSuggestRequest();

    await putTagsDecision({
      bookmarkId: id,
      tags: ["focus", "reading"],
    });

    // Suggestions render; nothing is staged yet.
    await screen.findByRole("button", { name: "Add suggested tag focus" });
    expect(
      screen.getByRole("button", { name: "Add suggested tag reading" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove tag focus" })).toBeNull();
    expect(screen.getByPlaceholderText("Add tags…")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Add suggested tag reading" }),
    );

    // Clicked → it becomes a real staged chip (removable); unclicked stays a
    // suggestion only.
    await screen.findByRole("button", { name: "Remove tag reading" });
    expect(
      screen.queryByRole("button", { name: "Add suggested tag reading" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add suggested tag focus" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove tag focus" })).toBeNull();
  });

  it("offers a suggested category that applies only on click", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await renderPopup();
    const { id } = await waitForSuggestRequest();

    await putCategoryDecision({ bookmarkId: id, category: "docs" });
    const chip = await screen.findByRole("button", {
      name: "Set category to Docs",
    });

    // Not applied until the user clicks.
    expect(categorySelect().value).toBe("");
    fireEvent.click(chip);
    await waitFor(() => expect(categorySelect().value).toBe("docs"));
    // Applied → the suggestion is gone.
    expect(
      screen.queryByRole("button", { name: "Set category to Docs" }),
    ).toBeNull();
  });

  it("never overrides fields the user already edited", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    await renderPopup();
    const { id } = await waitForSuggestRequest();

    // The user edits folder, category, and tags BEFORE suggestions land.
    fireEvent.change(folderSelect(), { target: { value: "fold" } });
    fireEvent.change(categorySelect(), { target: { value: "article" } });
    fireEvent.change(screen.getByLabelText("New tag name"), {
      target: { value: "Focus" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));

    // Late-arriving suggestions for every field, all high confidence.
    await putMoveDecision({
      bookmarkId: id,
      targetFolderId: "barfold",
      confidence: 0.95,
    });
    await putCategoryDecision({ bookmarkId: id, category: "docs" });
    await putTagsDecision({ bookmarkId: id, tags: ["focus", "reading"] });

    // Delivery proof: the un-staged tag suggestion renders.
    await screen.findByRole("button", { name: "Add suggested tag reading" });

    // The user's choices stand: folder and category unchanged, the staged
    // "focus" tag hides its suggestion twin instead of duplicating, and the
    // category suggestion is suppressed entirely.
    expect(folderSelect().value).toBe("fold");
    expect(categorySelect().value).toBe("article");
    expect(
      screen.queryByRole("button", { name: "Add suggested tag focus" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Set category to/ }),
    ).toBeNull();
  });

  it("does not send SAVE_SUGGEST without a jev_decisions consent grant", async () => {
    // No grantConsent call — the cheap local gate skips the request.
    await renderPopup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByTestId("save-suggestions")).toBeNull();
    expect(screen.queryByTestId("suggestions-not-sent")).toBeNull();
  });

  it('shows a quiet "not sent" note for a blocklisted page', async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    sendMessage.mockResolvedValue({
      ok: true,
      code: "analyze_ok",
      result: { sent: false, reason: "blocklisted", decisionCount: 0 },
    });
    await renderPopup();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());

    const note = await screen.findByTestId("suggestions-not-sent");
    expect(note.textContent ?? "").toMatch(/not sent/i);
    expect(screen.queryByTestId("save-suggestions")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Add suggested tag/ }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays quiet when the worker answers ok:false", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    sendMessage.mockResolvedValue({
      ok: false,
      code: "invalid_input",
      message: "No provider is enabled for decisions.",
    });
    await renderPopup();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(screen.queryByTestId("save-suggestions")).toBeNull();
    expect(screen.queryByTestId("suggestions-not-sent")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The form is unaffected.
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("stays quiet when sendMessage rejects", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    sendMessage.mockRejectedValue(new Error("Could not establish connection"));
    await renderPopup();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.queryByTestId("save-suggestions")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
