import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
import {
  cancelJob,
  enqueueJob,
  pauseJob,
  resumeJob,
  setJobStatus,
} from "../../src/jobs/queue";
import { transitionStatus } from "../../src/decisions/store";
import type { DecisionRow } from "../../src/decisions/store";
import { App } from "../../src/entrypoints/sidepanel/App";
import { ReviewView } from "../../src/entrypoints/sidepanel/ReviewView";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import { Decision } from "../../src/schemas/decision";
import type { Decision as DecisionDocument } from "../../src/schemas/decision";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";
import { decisionBase } from "../fixtures/base-records";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { chooseMenuItem, openMenu } from "./menu-helpers";

/**
 * Phase 4 Task 3 — the side-panel Review view and the Analyze actions.
 *
 * Layers under test:
 *  - `ReviewView`    the pending-decisions queue: kind label, bookmark
 *                    title(s), payload summary, confidence band shading +
 *                    label, a "stale" affordance when a bookmark is gone,
 *                    per-row Approve/Reject/Undo, checkbox selection, and one
 *                    BULK_APPROVE for the selection (or all pending rows).
 *  - `App` wiring    the "Review suggestions" header button + fixed nav
 *                    entry with a pending-count badge; the right pane swaps
 *                    BookmarkList for ReviewView on `kind: "review"`; the
 *                    approve toast's Undo is wired to REVERT_DECISION.
 *  - Analyze         a per-row kebab/context entry (`ANALYZE_BOOKMARK`) and
 *                    the BulkBar flow — a confirm with the estimate, then
 *                    ONE `JOB_START` (`analyze_selection`) for the selected
 *                    ids and a live status card (U02).
 *
 * The worker is a stub: `chrome.runtime.sendMessage` answers canned
 * `DecisionMessageResult` payloads and, for status intents, transitions the
 * real Dexie rows so the view's `useLiveQuery` refires — exactly what the
 * real worker's side effects look like from the panel. Decision rows are
 * seeded into `db.decisions` directly.
 */

let fake: FakeBookmarksApi;

const D_TAGS = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const D_CATEGORY = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
const D_MOVE = "c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f";
const D_STALE = "d4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f8a";

function decision(over: Partial<DecisionDocument>): DecisionDocument {
  return Decision.parse({ ...decisionBase, ...over });
}

/** The four seeded pending rows, in `createdAt` (queue) order. */
function seedRows(): DecisionDocument[] {
  return [
    decision({
      id: D_TAGS,
      kind: "add_tags",
      tags: ["dev", "reading"],
      bookmarkIds: ["b1"],
      confidence: 0.92,
      createdAt: "2026-09-27T09:00:00.000Z",
    }),
    decision({
      id: D_CATEGORY,
      kind: "set_category",
      category: "docs",
      bookmarkIds: ["b3"],
      confidence: 0.6,
      createdAt: "2026-09-27T09:01:00.000Z",
    }),
    decision({
      id: D_MOVE,
      kind: "move",
      targetFolderId: "10",
      bookmarkIds: ["b4"],
      confidence: 0.35,
      createdAt: "2026-09-27T09:02:00.000Z",
    }),
    decision({
      id: D_STALE,
      kind: "add_tags",
      tags: ["gone"],
      bookmarkIds: ["gone-9"],
      confidence: 0.9,
      createdAt: "2026-09-27T09:03:00.000Z",
    }),
  ];
}

interface Intent {
  type?: string;
  decisionId?: string;
  decisionIds?: string[];
  bookmarkId?: string;
  kind?: "analyze_selection" | "library_scan" | "restructure";
  bookmarkIds?: string[];
  jobId?: string;
}

/**
 * The canned worker. Status intents run the store's real transition (the
 * same bookkeeping the worker's apply path performs) so the panel observes
 * them through the Dexie live query. Anything unhandled — including a
 * missing intent — answers a protocol-shaped `{ok:false}`.
 */
async function defaultWorker(raw: unknown): Promise<DecisionMessageResult> {
  const message = raw as Intent;
  switch (message.type) {
    case "ANALYZE_BOOKMARK":
      return {
        ok: true,
        code: "analyze_ok",
        result: { sent: true, model: "jev-1.13.0", decisionCount: 2 },
      };
    case "APPROVE_DECISION": {
      const { row } = await transitionStatus(
        message.decisionId as string,
        "applied",
        "user",
        { undoSnapshotId: 1 },
      );
      return {
        ok: true,
        code: "decision_ok",
        decision: { id: row.id, status: row.status },
      };
    }
    case "REJECT_DECISION": {
      const { row } = await transitionStatus(
        message.decisionId as string,
        "rejected",
        "user",
      );
      return {
        ok: true,
        code: "decision_ok",
        decision: { id: row.id, status: row.status },
      };
    }
    case "REVERT_DECISION": {
      const { row } = await transitionStatus(
        message.decisionId as string,
        "reverted",
        "user",
      );
      return {
        ok: true,
        code: "decision_ok",
        decision: { id: row.id, status: row.status },
      };
    }
    case "BULK_APPROVE": {
      const applied: string[] = [];
      const failed: { id: string; code: string; message: string }[] = [];
      for (const id of message.decisionIds ?? []) {
        try {
          await transitionStatus(id, "applied", "user", {
            undoSnapshotId: 1,
          });
          applied.push(id);
        } catch (cause) {
          failed.push({
            id,
            code: "api",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      return { ok: true, code: "bulk_ok", applied, failed };
    }
    case "JOB_START": {
      const enqueued = await enqueueJob({
        kind:
          message.kind === "analyze_selection"
            ? "analyze_selection"
            : "library_scan",
        bookmarkIds: message.bookmarkIds ?? [],
      });
      const job = await setJobStatus(enqueued.id, "running");
      return { ok: true, code: "job_ok", job };
    }
    case "JOB_PAUSE":
      return {
        ok: true,
        code: "job_ok",
        job: await pauseJob(message.jobId ?? ""),
      };
    case "JOB_RESUME":
      return {
        ok: true,
        code: "job_ok",
        job: await resumeJob(message.jobId ?? ""),
      };
    case "JOB_CANCEL":
      return {
        ok: true,
        code: "job_ok",
        job: await cancelJob(message.jobId ?? ""),
      };
    case "REVERT_BATCH": {
      const reverted: string[] = [];
      const failed: { id: string; code: string; message: string }[] = [];
      for (const id of [...(message.decisionIds ?? [])].reverse()) {
        try {
          await transitionStatus(id, "reverted", "user");
          reverted.push(id);
        } catch (cause) {
          failed.push({
            id,
            code: "api",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      return { ok: true, code: "bulk_reverted", reverted, failed };
    }
    default:
      return {
        ok: false,
        code: "internal_error",
        message: "unhandled intent",
      };
  }
}

const sendMessage = vi.fn(defaultWorker);

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
  db.close();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreElementRects();
});

beforeEach(async () => {
  await db.open();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  await db.decisions.clear();
  await db.audit.clear();
  await db.jobs.clear();
  let tick = 0;
  fake = createFakeBookmarks({
    now: () => (tick += 100),
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [
          { id: "b1", title: "Alpha", url: "https://a.example/1" },
          { id: "b2", title: "Beta", url: "https://b.example/" },
        ],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
    ],
    otherBookmarks: [
      { id: "20", title: "Archive", children: [] },
      { id: "b4", title: "Delta", url: "https://d.example/" },
    ],
  });
  sendMessage.mockClear();
  sendMessage.mockImplementation(defaultWorker);
  vi.stubGlobal("chrome", {
    bookmarks: fake,
    runtime: {
      getURL: (path: string) =>
        `chrome-extension://test-extension-id/${path}`,
      sendMessage,
    },
  });
  stubElementRects();
});

/**
 * jsdom reports 0 for every element's offsetHeight/offsetWidth, which makes
 * @tanstack/react-virtual render nothing. The scroll container
 * (data-testid="bookmark-scroll") gets a fixed 600x400 rect so rows mount —
 * the same stub sidepanel-actions.test.tsx uses.
 */
const SCROLL_TESTID = "bookmark-scroll";
let savedRectDescriptors: [string, PropertyDescriptor | undefined][] = [];

function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  savedRectDescriptors = defs.map(([prop, value]) => {
    const prior = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      prop,
    );
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("data-testid") === SCROLL_TESTID
          ? value
          : 0;
      },
    });
    return [prop, prior];
  });
}

function restoreElementRects(): void {
  for (const [prop, prior] of savedRectDescriptors) {
    if (prior === undefined) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
    } else {
      Object.defineProperty(HTMLElement.prototype, prop, prior);
    }
  }
  savedRectDescriptors = [];
}

async function liveTree(): Promise<FlattenedTree> {
  return flattenTree(await fake.getTree());
}

async function seedDecisions(): Promise<DecisionRow[]> {
  const rows = seedRows();
  await db.decisions.bulkPut(rows);
  return rows;
}

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

/** Open the More menu, pick Review suggestions and wait for the queue. */
async function openReviewView(): Promise<HTMLElement> {
  await openMenu(/^More/);
  await chooseMenuItem(/Review suggestions/);
  return screen.findByRole("listbox", { name: "Pending suggestions" });
}

function option(name: string | RegExp): HTMLElement {
  return screen.getByRole("option", { name });
}

function toast(): HTMLElement {
  return screen.getByTestId("undo-toast");
}

function selectionBar(): HTMLElement {
  return screen.getByRole("toolbar", { name: "Selection actions" });
}

// ---------------------------------------------------------------------------
// ReviewView — rendering
// ---------------------------------------------------------------------------

describe("ReviewView", () => {
  it("lists pending decisions with kind, titles, payload summary and confidence", async () => {
    render(<ReviewView tree={await liveTree()} decisions={seedRows()} />);

    const listbox = screen.getByRole("listbox", {
      name: "Pending suggestions",
    });
    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBe(4);

    // Rows are ordered by createdAt (seed order).
    const [tags, category, move, stale] = options as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];

    expect(tags.dataset.confidence).toBe("high");
    expect(tags.textContent).toContain("Add tags");
    expect(tags.textContent).toContain("Alpha");
    expect(tags.textContent).toContain("+tags dev, reading");
    // Not color-only: the band is paired with a text label and a % value.
    expect(tags.textContent).toContain("High");
    expect(tags.textContent).toContain("92%");

    expect(category.dataset.confidence).toBe("medium");
    expect(category.textContent).toContain("Set category");
    expect(category.textContent).toContain("category: docs");
    expect(category.textContent).toContain("60%");

    expect(move.dataset.confidence).toBe("low");
    expect(move.textContent).toContain("Move");
    expect(move.textContent).toContain("Delta");
    // The folder target resolves through the live tree to its title.
    expect(move.textContent).toContain("Dev");
    expect(move.textContent).toContain("35%");

    // A bookmark that no longer resolves is flagged stale.
    expect(stale.textContent).toMatch(/stale/i);
  });

  it("renders an empty state when nothing is pending", async () => {
    render(<ReviewView tree={await liveTree()} decisions={[]} />);
    expect(
      screen.getByRole("listbox", { name: "Pending suggestions" }),
    ).toBeTruthy();
    expect(screen.getByText(/no pending/i)).toBeTruthy();
  });

  it("is keyboard-operable: arrows move row focus and Space toggles selection", async () => {
    render(<ReviewView tree={await liveTree()} decisions={seedRows()} />);
    const listbox = screen.getByRole("listbox", {
      name: "Pending suggestions",
    });
    const options = within(listbox).getAllByRole("option");
    const first = options[0] as HTMLElement;

    first.focus();
    // Row keys bubble to the listbox's onKeyDown (same pattern as
    // BookmarkList); fire on the focused element like the layout tests do.
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(options[3]);
    fireEvent.keyDown(options[3] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: " " });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(
      (within(first).getByRole("checkbox") as HTMLInputElement).checked,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// App wiring — nav, badge, pane swap
// ---------------------------------------------------------------------------

describe("Review view wiring", () => {
  it("opens via the More menu with a pending-count badge", async () => {
    await seedDecisions();
    await renderApp();

    const moreButton = screen.getByRole("button", { name: /^More/ });
    // The pending count streams from Dexie, so it lands a tick after mount.
    await waitFor(() => expect(moreButton.textContent).toContain("4"));

    const listbox = await openReviewView();
    expect(within(listbox).getAllByRole("option").length).toBe(4);
    // The pane is the review queue, not a BookmarkList of bookmarks.
    expect(
      screen.queryByRole("listbox", { name: "Bookmarks" }),
    ).toBeNull();
  });

  it("approve sends APPROVE_DECISION and the row leaves the queue", async () => {
    await seedDecisions();
    await renderApp();
    const listbox = await openReviewView();

    const row = option(/Alpha/);
    fireEvent.click(
      within(row).getByRole("button", { name: /^Approve/ }),
    );

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "APPROVE_DECISION",
        decisionId: D_TAGS,
      });
    });
    await waitFor(() =>
      expect(within(listbox).queryByRole("option", { name: /Alpha/ })).toBeNull(),
    );
    await waitFor(() =>
      expect(toast().textContent).toMatch(/applied/i),
    );
    // The row's status flipped in the store.
    expect((await db.decisions.get(D_TAGS))?.status).toBe("applied");
    // A pending row that failed nothing offers Approve but not Undo.
    const remaining = option(/Delta/);
    expect(
      within(remaining).getByRole("button", { name: /^Approve/ }),
    ).toBeTruthy();
    expect(
      within(remaining).queryByRole("button", { name: /^Undo/ }),
    ).toBeNull();
  });

  it("reject sends REJECT_DECISION and the row leaves the queue", async () => {
    await seedDecisions();
    await renderApp();
    const listbox = await openReviewView();

    fireEvent.click(
      within(option(/Gamma/)).getByRole("button", { name: /^Reject/ }),
    );

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "REJECT_DECISION",
        decisionId: D_CATEGORY,
      });
    });
    await waitFor(() =>
      expect(within(listbox).queryByRole("option", { name: /Gamma/ })).toBeNull(),
    );
    expect((await db.decisions.get(D_CATEGORY))?.status).toBe("rejected");
  });

  it("the approve toast's Undo sends REVERT_DECISION for that decision", async () => {
    await seedDecisions();
    await renderApp();
    const listbox = await openReviewView();

    fireEvent.click(
      within(option(/Alpha/)).getByRole("button", { name: /^Approve/ }),
    );
    await waitFor(() =>
      expect(within(listbox).queryByRole("option", { name: /Alpha/ })).toBeNull(),
    );
    await waitFor(() => expect(toast().textContent).toMatch(/applied/i));

    fireEvent.click(within(toast()).getByRole("button", { name: "Undo" }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "REVERT_DECISION",
        decisionId: D_TAGS,
      });
    });
    await waitFor(() =>
      expect(toast().textContent).toMatch(/reverted/i),
    );
    expect((await db.decisions.get(D_TAGS))?.status).toBe("reverted");
  });

  it("bulk approve sends ONE BULK_APPROVE and reports applied/failed counts", async () => {
    await seedDecisions();
    await renderApp();
    const listbox = await openReviewView();

    // Select two rows via their checkboxes; the bulk bar relabels.
    fireEvent.click(within(option(/Alpha/)).getByRole("checkbox"));
    fireEvent.click(within(option(/Gamma/)).getByRole("checkbox"));

    fireEvent.click(
      screen.getByRole("button", { name: /Approve selected/ }),
    );
    expect(await screen.findByTestId("bulk-approve-confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply all$/ }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "BULK_APPROVE",
        decisionIds: [D_TAGS, D_CATEGORY],
      });
    });
    await waitFor(() =>
      expect(toast().textContent).toMatch(/applied 2/i),
    );
    await waitFor(() =>
      expect(within(listbox).queryAllByRole("option").length).toBe(2),
    );
  });

  it("bulk approves ALL pending when nothing is selected", async () => {
    await seedDecisions();
    await renderApp();
    await openReviewView();

    fireEvent.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByTestId("bulk-approve-confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply all$/ }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "BULK_APPROVE",
        decisionIds: [D_TAGS, D_CATEGORY, D_MOVE, D_STALE],
      });
    });
    await waitFor(() =>
      expect(toast().textContent).toMatch(/applied 4/i),
    );
  });

  it("surfaces per-row failures from a partial bulk approve", async () => {
    await seedDecisions();
    await renderApp();
    await openReviewView();

    sendMessage.mockImplementation(async (raw: unknown) => {
      const message = raw as Intent;
      if (message.type === "BULK_APPROVE") {
        await transitionStatus(D_TAGS, "applied", "user", {
          undoSnapshotId: 1,
        });
        return {
          ok: true,
          code: "bulk_ok",
          applied: [D_TAGS],
          failed: [
            {
              id: D_CATEGORY,
              code: "stale",
              message: "the bookmark moved since the decision was made",
            },
          ],
        };
      }
      return defaultWorker(raw);
    });

    fireEvent.click(within(option(/Alpha/)).getByRole("checkbox"));
    fireEvent.click(within(option(/Gamma/)).getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: /Approve selected/ }),
    );
    expect(await screen.findByTestId("bulk-approve-confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply all$/ }));

    await waitFor(() =>
      expect(toast().textContent).toMatch(/1 failed/i),
    );
    // The failed row stays pending and carries an inline alert.
    const failedRow = option(/Gamma/);
    expect(
      within(failedRow).getByRole("alert").textContent,
    ).toContain("the bookmark moved");
  });

  it("renders the worker's {ok:false} message verbatim on a failed approve", async () => {
    await seedDecisions();
    await renderApp();
    await openReviewView();

    sendMessage.mockImplementation(async () => ({
      ok: false,
      code: "illegal_transition",
      message: "Cannot approve the decision from its current status.",
    }));

    fireEvent.click(
      within(option(/Alpha/)).getByRole("button", { name: /^Approve/ }),
    );
    await waitFor(() =>
      expect(toast().textContent).toContain(
        "Cannot approve the decision from its current status.",
      ),
    );
    // The row is still pending and shows the inline failure too.
    expect(
      within(option(/Alpha/)).getByRole("alert").textContent,
    ).toContain("Cannot approve");
  });
});

// ---------------------------------------------------------------------------
// Non-actionable rows — save-suggest placeholders
// ---------------------------------------------------------------------------

describe("Non-actionable pending decisions", () => {
  const D_UNSAVED = "e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8a9b";
  /** The synthetic id SAVE_SUGGEST keys an unsaved bookmark by. */
  const UNSAVED_BOOKMARK_ID = `popup:${D_UNSAVED}`;

  /**
   * A `pending` row for a bookmark the quick-save popup holds but has NOT
   * saved — its bookmark id is the `popup:<uuid>` placeholder, which can
   * never resolve to a live Chrome node.
   */
  function unsavedRow(): DecisionDocument {
    return decision({
      id: D_UNSAVED,
      kind: "set_category",
      category: "docs",
      bookmarkIds: [UNSAVED_BOOKMARK_ID],
      confidence: 0.7,
      createdAt: "2026-09-27T09:04:00.000Z",
    });
  }

  it("keeps a save-suggest placeholder out of the actionable queue", async () => {
    render(
      <ReviewView
        tree={await liveTree()}
        decisions={[...seedRows(), unsavedRow()]}
      />,
    );
    const listbox = screen.getByRole("listbox", {
      name: "Pending suggestions",
    });

    // Only the four real rows are listed…
    expect(within(listbox).getAllByRole("option").length).toBe(4);
    // …and exactly four Approve controls exist — the placeholder offers none.
    expect(
      within(listbox).getAllByRole("button", {
        name: /^Approve the suggestion/,
      }).length,
    ).toBe(4);
    // Nothing on screen references the placeholder at all.
    expect(screen.queryByText(/popup:/)).toBeNull();
    // The toolbar says why a pending decision is not listed.
    expect(
      screen.getByText(/waiting on an unsaved bookmark/i),
    ).toBeTruthy();
  });

  it("excludes placeholders from bulk approve and from the pending badge", async () => {
    await db.decisions.bulkPut([...seedRows(), unsavedRow()]);
    await renderApp();

    // The badge counts actionable rows only — the fifth stays hidden.
    const moreButton = screen.getByRole("button", { name: /^More/ });
    await waitFor(() => expect(moreButton.textContent).toContain("4"));
    expect(moreButton.textContent).not.toContain("5");

    await openReviewView();
    fireEvent.click(screen.getByRole("button", { name: /Approve all/ }));
    expect(await screen.findByTestId("bulk-approve-confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Apply all$/ }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "BULK_APPROVE",
        decisionIds: [D_TAGS, D_CATEGORY, D_MOVE, D_STALE],
      });
    });
    // The placeholder row is never touched.
    expect((await db.decisions.get(D_UNSAVED))?.status).toBe("pending");
  });
});

describe("U01 — confirmed, undoable Approve all", () => {
  it("Approve all opens a confirm showing count and kinds; cancel applies nothing", async () => {
    await seedDecisions();
    await renderApp();
    await openReviewView();

    fireEvent.click(screen.getByRole("button", { name: /Approve all/ }));
    const dialog = await screen.findByTestId("bulk-approve-confirm");
    // Count in the title, per-kind breakdown in the body.
    expect(dialog.textContent).toMatch(/Apply 4 suggestions/);
    expect(dialog.textContent).toContain("add tags");
    expect(dialog.textContent).toContain("set category");
    expect(dialog.textContent).toContain("move");
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "BULK_APPROVE" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    await waitFor(() =>
      expect(screen.queryByTestId("bulk-approve-confirm")).toBeNull(),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "BULK_APPROVE" }),
    );
    // Nothing applied.
    for (const id of [D_TAGS, D_CATEGORY, D_MOVE, D_STALE]) {
      expect((await db.decisions.get(id))?.status).toBe("pending");
    }
  });

  it("confirming applies under one undoable toast; Undo sends REVERT_BATCH for the batch", async () => {
    await seedDecisions();
    await renderApp();
    await openReviewView();

    fireEvent.click(screen.getByRole("button", { name: /Approve all/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Apply all$/ }),
    );
    await waitFor(() =>
      expect(toast().textContent).toMatch(/applied 4/i),
    );
    // The batch toast carries an Undo affordance.
    const undoButton = await screen.findByRole("button", {
      name: /^undo$/i,
    });
    fireEvent.click(undoButton);
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "REVERT_BATCH",
        decisionIds: [D_TAGS, D_CATEGORY, D_MOVE, D_STALE],
      });
    });
    await waitFor(() =>
      expect(toast().textContent).toMatch(/reverted 4/i),
    );
    for (const id of [D_TAGS, D_CATEGORY, D_MOVE, D_STALE]) {
      expect((await db.decisions.get(id))?.status).toBe("reverted");
    }
  });

  it("a partial batch revert re-arms Undo for the still-applied rows", async () => {
    await seedDecisions();
    await renderApp();
    await openReviewView();

    fireEvent.click(screen.getByRole("button", { name: /Approve all/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Apply all$/ }),
    );
    await waitFor(() =>
      expect(toast().textContent).toMatch(/applied 4/i),
    );

    // Revert one row of the batch first — its status leaves `applied`,
    // so the batch Undo must fail on it while the other three revert.
    await sendMessage({ type: "REVERT_DECISION", decisionId: D_STALE });
    const undoButton = await screen.findByRole("button", {
      name: /^undo$/i,
    });
    fireEvent.click(undoButton);
    await waitFor(() =>
      expect(toast().textContent).toMatch(/Reverted 3 of 4 — 1 failed/i),
    );
    // The still-applied rows are re-armed: a second Undo retries just
    // them — the already-reverted rows are not re-sent. One id left, so
    // the retry goes through the single-decision REVERT_DECISION path.
    const calls = sendMessage.mock.calls.filter(
      ([raw]) =>
        (raw as { type?: string }).type === "REVERT_BATCH",
    );
    expect(calls.length).toBe(1);
    fireEvent.click(await screen.findByRole("button", { name: /^undo$/i }));
    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "REVERT_DECISION",
        decisionId: D_STALE,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Analyze — per-row kebab entry and the BulkBar action
// ---------------------------------------------------------------------------

describe("Analyze actions", () => {
  it("per-row Analyze sends ANALYZE_BOOKMARK and toasts the suggestion count", async () => {
    await renderApp();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Alpha" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Analyze" }));

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: "ANALYZE_BOOKMARK",
        bookmarkId: "b1",
      });
    });
    await waitFor(() =>
      expect(toast().textContent).toMatch(/2 suggestion/i),
    );
  });

  it("toasts a quiet blocklist skip when nothing was sent", async () => {
    sendMessage.mockImplementation(async () => ({
      ok: true,
      code: "analyze_ok",
      result: { sent: false, reason: "blocklisted", decisionCount: 0 },
    }));
    await renderApp();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Alpha" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Analyze" }));

    await waitFor(() =>
      expect(toast().textContent).toMatch(/blocklist/i),
    );
  });

  it("toasts the redacted message when the gate refuses ({ok:false})", async () => {
    sendMessage.mockImplementation(async () => ({
      ok: false,
      code: "invalid_input",
      message: "No AI provider is enabled for decisions.",
    }));
    await renderApp();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Actions for Alpha" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Analyze" }));

    await waitFor(() =>
      expect(toast().textContent).toContain(
        "No AI provider is enabled for decisions.",
      ),
    );
  });

  it("bulk-bar Analyze confirms then starts one analyze_selection job (U02)", async () => {
    await renderApp();

    fireEvent.click(option(/Alpha/));
    fireEvent.click(option(/Gamma/), { ctrlKey: true });
    const bar = selectionBar();
    expect(bar.textContent).toContain("2 selected");

    const analyze = within(bar).getByRole("button", {
      name: "Analyze",
    }) as HTMLButtonElement;
    await waitFor(() => expect(analyze.disabled).toBe(false));
    fireEvent.click(analyze);

    // Confirm shows the count and the estimate before anything is sent.
    const dialog = (await screen.findByRole("dialog", {
      name: "Analyze 2 bookmarks?",
    })) as HTMLElement;
    expect(dialog.textContent).toContain("2 AI requests");
    expect(dialog.textContent).toContain("tokens, likely more");
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Analyze" }),
    );

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "JOB_START",
        kind: "analyze_selection",
        bookmarkIds: ["b1", "b3"],
      }),
    );

    // The queued→running row streams into the card with Pause/Cancel.
    const card = await screen.findByRole("status", {
      name: "Selection analysis",
    });
    await waitFor(() =>
      expect(card.textContent).toContain("Analysis: Running"),
    );
    expect(
      within(card).getByRole("button", { name: "Pause" }),
    ).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Cancel" }),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Explain + second opinions (spec FR5/FR6)
// ---------------------------------------------------------------------------

const D_UNSURE = "e5f6a7b8-c9d0-4e1f-a2b3-4c5d6e7f8a9b";

/** The stub worker's reply type — LLM replies sit outside that union, so
 * feature-protocol replies are cast through it at the mock boundary. */
const asWorkerReply = (v: unknown): ReturnType<typeof defaultWorker> =>
  Promise.resolve(v) as ReturnType<typeof defaultWorker>;

describe("Explain and second opinions", () => {
  /** Seed an unsure row carrying a second-opinion verdict. */
  function unsureRow(over: Partial<DecisionDocument> = {}) {
    return decision({
      id: D_UNSURE,
      kind: "set_category",
      category: "docs",
      bookmarkIds: ["b1"],
      confidence: 0.3,
      status: "unsure",
      escalation: {
        llmVerdict: "disagree",
        llmModel: "gpt-4o-mini",
        llmAlternative: "article",
      },
      rationale: "The article body reads as a tutorial.",
      createdAt: "2026-09-27T09:04:00.000Z",
      ...over,
    });
  }

  it("an unsure row renders the verdict + constrained alternative in words", async () => {
    render(
      <ReviewView tree={await liveTree()} decisions={[unsureRow()]} />,
    );
    const row = option(/Alpha/);
    expect(row.textContent).toMatch(/unsure/i);
    // Non-color-only: the verdict and the alternative id are written out.
    expect(row.textContent).toContain("disagrees");
    expect(row.textContent).toContain("article");
    expect(row.textContent).toContain("gpt-4o-mini");
    expect(row.textContent).toContain("The article body reads as a tutorial.");
    // Explain is a pending-queue action — an unsure row has no button.
    expect(
      within(row).queryByRole("button", { name: /^Explain/ }),
    ).toBeNull();
  });

  it("renders an agree verdict", async () => {
    render(
      <ReviewView
        tree={await liveTree()}
        decisions={[
          unsureRow({
            escalation: { llmVerdict: "agree", llmModel: "m" },
            rationale: undefined,
          } as Partial<DecisionDocument>),
        ]}
      />,
    );
    expect(option(/Alpha/).textContent).toContain("agrees with the suggestion");
  });

  it("Explain sends LLM_EXPLAIN and renders the returned rationale", async () => {
    await seedDecisions();
    sendMessage.mockImplementation(async (raw: unknown) => {
      const msg = raw as Intent & { unknownCostConfirmed?: boolean };
      if (msg.type === "LLM_EXPLAIN") {
        await db.decisions.update(msg.decisionId as string, {
          rationale: "Looks like a reference page.",
        });
        return asWorkerReply({
          ok: true,
          code: "explain_ok",
          result: {
            decisionId: msg.decisionId,
            rationale: "Looks like a reference page.",
            model: "gpt-4o-mini",
          },
        });
      }
      return defaultWorker(raw);
    });
    render(<ReviewView tree={await liveTree()} decisions={seedRows()} />);

    const row = option(/Alpha/);
    fireEvent.click(
      within(row).getByRole("button", { name: /^Explain/ }),
    );
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "LLM_EXPLAIN",
        decisionId: D_TAGS,
      }),
    );
    await waitFor(() =>
      expect(row.textContent).toContain("Looks like a reference page."),
    );
    // The rationale is on the persisted row too (worker wrote it).
    expect((await db.decisions.get(D_TAGS))?.rationale).toBe(
      "Looks like a reference page.",
    );
  });

  it("a double click sends exactly one request", async () => {
    sendMessage.mockImplementation(async (raw: unknown) => {
      const msg = raw as Intent;
      if (msg.type === "LLM_EXPLAIN") {
        return asWorkerReply({
          ok: true,
          code: "explain_ok",
          result: { decisionId: msg.decisionId, rationale: "R.", model: "m" },
        });
      }
      return defaultWorker(raw);
    });
    render(<ReviewView tree={await liveTree()} decisions={seedRows()} />);
    const button = within(option(/Alpha/)).getByRole("button", {
      name: /^Explain/,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "LLM_EXPLAIN",
        decisionId: D_TAGS,
      }),
    );
    expect(
      sendMessage.mock.calls.filter(
        ([m]) => (m as Intent).type === "LLM_EXPLAIN",
      ),
    ).toHaveLength(1);
  });

  it("confirmation_required opens the cost dialog and resends with the flag", async () => {
    sendMessage.mockImplementation(async (raw: unknown) => {
      const msg = raw as Intent & { unknownCostConfirmed?: boolean };
      if (msg.type === "LLM_EXPLAIN" && msg.unknownCostConfirmed !== true) {
        return asWorkerReply({
          ok: false,
          code: "confirmation_required",
          message: "Cost cannot be estimated — confirm to send.",
          destinationOrigin: "https://api.openai.com",
          consentApproval: { providerId: "preset:openai", origin: "https://api.openai.com",
            model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1/chat/completions", consentVersion: 5 },
        });
      }
      if (msg.type === "LLM_EXPLAIN") {
        return asWorkerReply({
          ok: true,
          code: "explain_ok",
          result: {
            decisionId: msg.decisionId,
            rationale: "Confirmed.",
            model: "gpt-4o-mini",
          },
        });
      }
      return defaultWorker(raw);
    });
    render(<ReviewView tree={await liveTree()} decisions={seedRows()} />);

    fireEvent.click(
      within(option(/Alpha/)).getByRole("button", { name: /^Explain/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("https://api.openai.com");

    fireEvent.click(
      within(dialog).getByRole("button", { name: /send anyway/i }),
    );
    await waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "LLM_EXPLAIN",
        decisionId: D_TAGS,
        unknownCostConfirmed: true,
        consentApproval: { providerId: "preset:openai", origin: "https://api.openai.com",
          model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1/chat/completions", consentVersion: 5 },
      }),
    );
    await waitFor(() =>
      expect(option(/Alpha/).textContent).toContain("Confirmed."),
    );
    // The dialog is gone after the resend.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancel dismisses the dialog without resending", async () => {
    sendMessage.mockImplementation(async (raw: unknown) => {
      const msg = raw as Intent & { unknownCostConfirmed?: boolean };
      if (msg.type === "LLM_EXPLAIN") {
        return asWorkerReply({
          ok: false,
          code: "confirmation_required",
          message: "Cost cannot be estimated — confirm to send.",
          destinationOrigin: "https://api.openai.com",
          consentApproval: { providerId: "preset:openai", origin: "https://api.openai.com",
            model: "gpt-4o-mini", endpoint: "https://api.openai.com/v1/chat/completions", consentVersion: 5 },
        });
      }
      return defaultWorker(raw);
    });
    render(<ReviewView tree={await liveTree()} decisions={seedRows()} />);

    fireEvent.click(
      within(option(/Alpha/)).getByRole("button", { name: /^Explain/ }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /cancel|don.t send/i }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      sendMessage.mock.calls.filter(
        ([m]) => (m as Intent).type === "LLM_EXPLAIN",
      ),
    ).toHaveLength(1);
  });

  it("an {ok:false} reply lands on the row and in the toast, focus retained", async () => {
    sendMessage.mockImplementation(async (raw: unknown) => {
      const msg = raw as Intent;
      if (msg.type === "LLM_EXPLAIN") {
        return {
          ok: false,
          code: "no_provider",
          message: "No LLM provider is configured.",
        };
      }
      return defaultWorker(raw);
    });
    await seedDecisions();
    await renderApp();
    await openReviewView();

    const row = option(/Alpha/);
    const explainButton = within(row).getByRole("button", {
      name: /^Explain/,
    });
    explainButton.focus();
    fireEvent.click(explainButton);
    await waitFor(() =>
      expect(within(row).getByRole("alert").textContent).toBe(
        "No LLM provider is configured.",
      ),
    );
    await waitFor(() =>
      expect(toast().textContent).toContain("No LLM provider is configured."),
    );
    // Focus stays on the row's control surface.
    expect(document.activeElement).toBe(explainButton);
  });
});
