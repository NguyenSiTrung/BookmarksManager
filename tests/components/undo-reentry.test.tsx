import "fake-indexeddb/auto";
import {
  act,
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
import { transitionStatus } from "../../src/decisions/store";
import { App } from "../../src/entrypoints/sidepanel/App";
import {
  UndoToast,
  useUndoToastController,
} from "../../src/entrypoints/sidepanel/UndoToast";
import { Decision } from "../../src/schemas/decision";
import type { Decision as DecisionDocument } from "../../src/schemas/decision";
import * as restore from "../../src/undo/restore";
import type { UndoResult } from "../../src/undo/restore";
import { decisionBase } from "../fixtures/base-records";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { chooseMenuItem, openMenu } from "./menu-helpers";

/**
 * Re-entry safety for the Undo toast — bug B12.
 *
 * Two layers, both here:
 *
 *  - The CONTROLLER (`useUndoToastController`) guards its own generic path:
 *    `undoLatest` runs once for two rapid `undo()` calls, and a later call
 *    works again once the first settles (P4 review fix #1).
 *  - The SHELL (`App`) dispatches the toast's Undo. An applied-decision toast
 *    routes to `REVERT_DECISION` (armed by ReviewView), every other toast to
 *    the generic snapshot stack — and the armed decision target is consumed
 *    by the FIRST activation. The controller's guard cannot see that: a
 *    second activation would fall through to the generic path and pop a
 *    snapshot nobody asked for. So the dispatcher needs its own synchronous
 *    in-flight guard, a target that survives until settlement, and a toast
 *    generation token so a late completion cannot overwrite a newer toast.
 *
 * The shell tests run through the REAL sidepanel harness (More menu → Review
 * suggestions → approve) with the worker's `REVERT_DECISION` reply parked, so
 * the round trip is genuinely outstanding while the second activation lands.
 */

let fake: FakeBookmarksApi;
let sendMessage: ReturnType<typeof vi.fn>;

/** Every REVERT_DECISION the panel dispatched, in dispatch order. */
let reverts: string[];
/** The parked REVERT_DECISION reply, while the worker holds one. */
let parkedRevert: {
  decisionId: string;
  resolve: (raw: unknown) => void;
  reject: (cause: unknown) => void;
} | null;

/** One review decision, `decisionBase` plus the kind-specific payload. */
function decision(over: Partial<DecisionDocument>): DecisionDocument {
  return Decision.parse({ ...decisionBase, ...over });
}

const D_TAGS = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const D_CATEGORY = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

/** Two actionable pending rows: "Alpha" (b1) and "Gamma" (b3). */
function seedRows(): DecisionDocument[] {
  return [
    decision({
      id: D_TAGS,
      kind: "add_tags",
      tags: ["dev"],
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
  ];
}

type Intent = {
  type?: string;
  decisionId?: string;
  bookmarkId?: string;
};

function decisionReply(id: string, status: string): unknown {
  return { ok: true, code: "decision_ok", decision: { id, status } };
}

/**
 * The canned worker. Status intents run the store's real transition — the
 * bookkeeping the worker's apply path performs, so the panel observes it
 * through the Dexie live query — while every REVERT_DECISION PARKS. That
 * parked reply is the slow revert the guard has to survive; the helpers below
 * settle/refuse/crash it.
 */
async function defaultWorker(raw: unknown): Promise<unknown> {
  const message = raw as Intent;
  switch (message.type) {
    case "APPROVE_DECISION": {
      const { row } = await transitionStatus(
        message.decisionId as string,
        "applied",
        "user",
        { undoSnapshotId: 1 },
      );
      return decisionReply(row.id, row.status);
    }
    case "REJECT_DECISION": {
      const { row } = await transitionStatus(
        message.decisionId as string,
        "rejected",
        "user",
      );
      return decisionReply(row.id, row.status);
    }
    case "REVERT_DECISION": {
      const decisionId = message.decisionId as string;
      reverts.push(decisionId);
      return await new Promise<unknown>((resolve, reject) => {
        parkedRevert = { decisionId, resolve, reject };
      });
    }
    default:
      return {
        ok: false,
        code: "internal_error",
        message: "unhandled intent",
      };
  }
}

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
  vi.restoreAllMocks();
  restoreElementRects();
});

beforeEach(async () => {
  await db.open();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
  await db.decisions.clear();
  await db.audit.clear();
  let tick = 0;
  fake = createFakeBookmarks({
    now: () => (tick += 100),
    bookmarksBar: [
      {
        id: "10",
        title: "Dev",
        children: [
          { id: "b1", title: "Alpha", url: "https://a.example/1" },
        ],
      },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
    ],
    otherBookmarks: [{ id: "b4", title: "Delta", url: "https://d.example/" }],
  });
  reverts = [];
  parkedRevert = null;
  sendMessage = vi.fn(defaultWorker);
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
 * the same stub the other sidepanel harnesses use.
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

// ---------------------------------------------------------------------------
// Parked-revert controls
// ---------------------------------------------------------------------------

function parked(): NonNullable<typeof parkedRevert> {
  if (parkedRevert === null) {
    throw new Error("no REVERT_DECISION is parked");
  }
  return parkedRevert;
}

/** Release the parked revert: the worker replays, the row becomes reverted. */
async function settleRevert(): Promise<void> {
  const current = parked();
  parkedRevert = null;
  await act(async () => {
    const { row } = await transitionStatus(
      current.decisionId,
      "reverted",
      "user",
    );
    current.resolve(decisionReply(row.id, row.status));
  });
}

/** Answer the parked revert with a worker-shaped refusal (`{ok:false}`). */
async function refuseRevert(message: string, code = "stale"): Promise<void> {
  const current = parked();
  parkedRevert = null;
  await act(async () => {
    current.resolve({ ok: false, code, message });
  });
}

/** Reject the parked revert, the way a dead worker's sendMessage would. */
async function crashRevert(cause: unknown): Promise<void> {
  const current = parked();
  parkedRevert = null;
  await act(async () => {
    current.reject(cause);
  });
}

/**
 * Let every pending promise continuation drain (one real macrotask inside
 * `act`). An approve's show→arm pair runs in its handler's continuation, so
 * "the newer toast is armed" is only guaranteed after a task boundary — the
 * same guarantee the browser gives before any later activation.
 */
async function drainAsyncWork(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Sidepanel harness
// ---------------------------------------------------------------------------

async function renderApp(props?: {
  undoToastAutoHideMs?: number;
}): Promise<void> {
  render(<App {...props} />);
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

function undoButton(): HTMLButtonElement {
  return within(toast()).getByRole("button", {
    name: "Undo",
  }) as HTMLButtonElement;
}

/** The generic snapshot path, spied so "no generic undo ran" is assertable. */
function spyGenericUndo() {
  return vi.spyOn(restore, "undoLatest").mockResolvedValue({
    ok: true,
    restoredIds: [],
    idMap: {},
    fellBackToOther: false,
  });
}

/** Apply the pending suggestion for `title` and wait for its armed toast. */
async function applyDecision(title: string): Promise<void> {
  const listbox = screen.getByRole("listbox", {
    name: "Pending suggestions",
  });
  fireEvent.click(
    within(option(new RegExp(title))).getByRole("button", {
      name: /^Approve/,
    }),
  );
  await waitFor(() =>
    expect(
      within(listbox).queryByRole("option", { name: new RegExp(title) }),
    ).toBeNull(),
  );
  await drainAsyncWork();
  await waitFor(() =>
    expect(toast().textContent).toContain("Applied the suggestion."),
  );
}

/** The palette's own Undo entry — a dispatch path no disabled button gates. */
async function openPalette(): Promise<HTMLElement> {
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  await screen.findByRole("dialog");
  return screen.getByRole("combobox", { name: "Command palette" });
}

/** Walk the palette's flat list to the option whose text matches. */
async function highlight(
  el: HTMLElement,
  name: RegExp,
): Promise<HTMLElement> {
  for (let i = 0; i < 30; i++) {
    const activeId = el.getAttribute("aria-activedescendant");
    const activeEl =
      activeId === null ? null : document.getElementById(activeId);
    if (activeEl !== null && name.test(activeEl.textContent ?? "")) {
      return activeEl;
    }
    fireEvent.keyDown(el, { key: "ArrowDown" });
  }
  throw new Error(`no palette option matching ${String(name)}`);
}

// ---------------------------------------------------------------------------
// Controller-level guard (P4 review fix #1)
// ---------------------------------------------------------------------------

/**
 * `undoLatest` is serialized internally, but a double-click (or a click that
 * lands while a slow restore is still outstanding) would otherwise queue a
 * SECOND undo and pop two snapshots. `useUndoToastController().undo` gates on
 * an in-flight ref: a second call while one is outstanding is ignored, so
 * `undoLatest` runs exactly once.
 */

function Harness() {
  const controller = useUndoToastController();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          controller.showToast({ message: "Did a thing", undoable: true })
        }
      >
        show
      </button>
      <button
        type="button"
        onClick={() => {
          // Two rapid clicks with no await between them — the second must be
          // ignored while the first is outstanding.
          void controller.undo();
          void controller.undo();
        }}
      >
        undo-twice
      </button>
      <UndoToast
        toast={controller.toast}
        onUndo={() => void controller.undo()}
        onDismiss={controller.dismiss}
      />
    </>
  );
}

describe("Undo re-entry guard", () => {
  it("runs undoLatest once for two rapid undo() calls", async () => {
    let release!: (result: UndoResult) => void;
    const spy = vi.spyOn(restore, "undoLatest").mockImplementation(
      () =>
        new Promise<UndoResult>((resolve) => {
          release = resolve;
        }),
    );

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    fireEvent.click(screen.getByRole("button", { name: "undo-twice" }));

    // The second call was gated before reaching undoLatest.
    expect(spy).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        ok: true,
        restoredIds: [],
        idMap: {},
        fellBackToOther: false,
      });
    });
    await waitFor(() => expect(screen.getByTestId("undo-toast").textContent).toContain("Undone"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("allows a later undo() once the outstanding one has settled", async () => {
    const spy = vi
      .spyOn(restore, "undoLatest")
      .mockResolvedValue({
        ok: true,
        restoredIds: [],
        idMap: {},
        fellBackToOther: false,
      });

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "show" }));
    fireEvent.click(screen.getByRole("button", { name: "undo-twice" }));
    await waitFor(() =>
      expect(screen.getByTestId("undo-toast").textContent).toContain("Undone"),
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // The gate is released after the first call settles — a fresh pair of
    // clicks runs undoLatest exactly once more.
    fireEvent.click(screen.getByRole("button", { name: "undo-twice" }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// Controller-level expiry notification
// ---------------------------------------------------------------------------

describe("Undo toast expiry", () => {
  /**
   * The shell keys its toast generation token — and its armed decision-revert
   * target — to the toast on screen, so the controller has to tell it when
   * the auto-hide retires one. `onAutoHide` is that signal: synchronous, once
   * per expiry, and only for the toast whose timer actually fired.
   */
  function TimedHarness({ onAutoHide }: { onAutoHide: () => void }) {
    const controller = useUndoToastController(8_000, onAutoHide);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            controller.showToast({ message: "Did a thing", undoable: true })
          }
        >
          show
        </button>
        <UndoToast
          toast={controller.toast}
          onUndo={() => void controller.undo()}
          onDismiss={controller.dismiss}
        />
      </>
    );
  }

  it("notifies once per auto-hide, and never for a superseded timer", () => {
    vi.useFakeTimers();
    try {
      const onAutoHide = vi.fn();
      render(<TimedHarness onAutoHide={onAutoHide} />);

      fireEvent.click(screen.getByRole("button", { name: "show" }));
      act(() => {
        vi.advanceTimersByTime(8_500);
      });
      expect(screen.queryByTestId("undo-toast")).toBeNull();
      expect(onAutoHide).toHaveBeenCalledTimes(1);

      // A new toast re-arms the timer: nothing fires before ITS 8s, and the
      // stale timer cannot notify for the newer toast.
      fireEvent.click(screen.getByRole("button", { name: "show" }));
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(onAutoHide).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(4_500);
      });
      expect(onAutoHide).toHaveBeenCalledTimes(2);

      // A dismissal is not an expiry — its timer must not notify either.
      fireEvent.click(screen.getByRole("button", { name: "show" }));
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      act(() => {
        vi.advanceTimersByTime(9_000);
      });
      expect(onAutoHide).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Shell dispatch (B12)
// ---------------------------------------------------------------------------

describe("decision toast undo", () => {
  it("sends one REVERT_DECISION for a double activation, never the generic undo", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    const button = undoButton();
    fireEvent.click(button);
    fireEvent.click(button);

    // One dispatch, and the second activation did not fall through to the
    // snapshot stack just because the decision target was consumed.
    expect(reverts).toEqual([D_TAGS]);
    expect(genericUndo).not.toHaveBeenCalled();

    // The in-flight state is exposed on the control itself.
    expect(undoButton().disabled).toBe(true);
    expect(undoButton().getAttribute("aria-busy")).toBe("true");

    await settleRevert();
    await waitFor(() =>
      expect(toast().textContent).toContain("Reverted the suggestion."),
    );
    expect(reverts).toEqual([D_TAGS]);
    expect(genericUndo).not.toHaveBeenCalled();
    // The worker's revert really ran, and the success toast offers no retry.
    expect((await db.decisions.get(D_TAGS))?.status).toBe("reverted");
    expect(
      within(toast()).queryByRole("button", { name: "Undo" }),
    ).toBeNull();
  });

  it("refuses a second dispatch from the palette's Undo command while a revert is outstanding", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    expect(reverts).toEqual([D_TAGS]);

    // The palette entry calls the same dispatcher WITHOUT the toast's now
    // disabled control, so only the synchronous in-flight guard can refuse
    // it — and the preserved target is what keeps it off the generic path.
    const palette = await openPalette();
    await highlight(palette, /Undo last action/);
    fireEvent.keyDown(palette, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(reverts).toEqual([D_TAGS]);
    expect(genericUndo).not.toHaveBeenCalled();

    await settleRevert();
    await waitFor(() =>
      expect(toast().textContent).toContain("Reverted the suggestion."),
    );
    expect(reverts).toEqual([D_TAGS]);
    expect(genericUndo).not.toHaveBeenCalled();
  });

  it("keeps the decision target armed for a retry when the worker refuses", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    await refuseRevert("The suggestion is no longer applied.");
    await waitFor(() =>
      expect(toast().textContent).toContain(
        "The suggestion is no longer applied.",
      ),
    );
    // The refusal is an error toast, but the row is still applied — so the
    // revert stays retryable and Undo is offered again, now enabled.
    expect(toast().getAttribute("role")).toBe("alert");
    const retry = undoButton();
    expect(retry.disabled).toBe(false);
    expect((await db.decisions.get(D_TAGS))?.status).toBe("applied");

    fireEvent.click(retry);
    expect(reverts).toEqual([D_TAGS, D_TAGS]);
    expect(genericUndo).not.toHaveBeenCalled();

    await settleRevert();
    await waitFor(() =>
      expect(toast().textContent).toContain("Reverted the suggestion."),
    );
    expect((await db.decisions.get(D_TAGS))?.status).toBe("reverted");
    expect(genericUndo).not.toHaveBeenCalled();
  });

  it("reports a dead worker without falling back to the snapshot stack", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    await crashRevert(new Error("worker unreachable"));
    await waitFor(() =>
      expect(toast().textContent).toMatch(/not reachable/i),
    );
    expect(genericUndo).not.toHaveBeenCalled();
    expect(undoButton().disabled).toBe(false);
  });

  it("does not overwrite a newer toast with a stale revert outcome", async () => {
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    // A newer toast takes the slot while the revert is still in flight.
    fireEvent.click(
      within(option(/Gamma/)).getByRole("button", { name: /^Reject/ }),
    );
    await waitFor(() =>
      expect(toast().textContent).toContain("Rejected the suggestion."),
    );

    await settleRevert();
    await drainAsyncWork();
    // The retired round trip still happened…
    await waitFor(async () =>
      expect((await db.decisions.get(D_TAGS))?.status).toBe("reverted"),
    );
    // …but it reported into neither the newer toast nor a fresh one.
    expect(toast().textContent).toContain("Rejected the suggestion.");
    expect(toast().textContent).not.toContain("Reverted the suggestion.");
    expect(
      within(toast()).queryByRole("button", { name: "Undo" }),
    ).toBeNull();
  });

  it("leaves a newer decision toast armed and still dispatches its own revert", async () => {
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    // A newer decision toast replaces Alpha's while Alpha's revert is parked.
    await applyDecision("Gamma");
    // One decision round trip at a time: the newer Undo waits for the older.
    expect(undoButton().disabled).toBe(true);

    // The stale completion is a refusal — the kind that would otherwise
    // re-arm the OLD target on top of the newer toast.
    await refuseRevert("The suggestion is no longer applied.");
    await waitFor(() => expect(undoButton().disabled).toBe(false));
    expect(toast().textContent).toContain("Applied the suggestion.");
    expect(toast().textContent).not.toContain("no longer applied");

    fireEvent.click(undoButton());
    expect(reverts).toEqual([D_TAGS, D_CATEGORY]);

    await settleRevert();
    await waitFor(() =>
      expect(toast().textContent).toContain("Reverted the suggestion."),
    );
    // The newer toast's target is the one that reverted; Alpha's refused
    // round trip changed nothing on its row.
    expect((await db.decisions.get(D_CATEGORY))?.status).toBe("reverted");
    expect((await db.decisions.get(D_TAGS))?.status).toBe("applied");
  });

  it("drops the outcome when the toast is dismissed while the revert is outstanding", async () => {
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    fireEvent.click(
      within(toast()).getByRole("button", { name: "Dismiss" }),
    );
    expect(screen.queryByTestId("undo-toast")).toBeNull();

    await settleRevert();
    await drainAsyncWork();
    await waitFor(async () =>
      expect((await db.decisions.get(D_TAGS))?.status).toBe("reverted"),
    );
    // The user retired the toast: a late completion does not bring it back.
    expect(screen.queryByTestId("undo-toast")).toBeNull();
    expect(reverts).toEqual([D_TAGS]);
  });

  it("offers no retry when the replay already ran but went unrecorded", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    // `state_unrecorded` is the refusal whose replay ALREADY ran: the change
    // is reverted and only the row's status write failed, so a retry could
    // only be refused again (`undo_conflict`).
    await refuseRevert(
      `Decision "${D_TAGS}" was reverted but its status could not be recorded.`,
      "state_unrecorded",
    );
    await waitFor(() =>
      expect(toast().textContent).toContain("could not be recorded"),
    );

    // The typed message is shown plainly — no Undo affordance…
    expect(toast().getAttribute("role")).toBe("alert");
    expect(
      within(toast()).queryByRole("button", { name: "Undo" }),
    ).toBeNull();

    // …and the decision is not re-armed: the next activation (through the
    // palette, which has no disabled control to hide behind) is the generic
    // snapshot undo, not another doomed revert.
    const palette = await openPalette();
    await highlight(palette, /Undo last action/);
    fireEvent.keyDown(palette, { key: "Enter" });
    await waitFor(() => expect(genericUndo).toHaveBeenCalledTimes(1));
    expect(reverts).toEqual([D_TAGS]);
  });

  it("keeps the retry affordance for other refusal codes (undo_conflict)", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    await renderApp();
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    await refuseRevert(
      `The undo snapshot for decision "${D_TAGS}" is not the top of the stack.`,
      "undo_conflict",
    );
    await waitFor(() =>
      expect(toast().textContent).toContain("not the top of the stack"),
    );

    // Only `state_unrecorded` suppresses the retry: every other refusal left
    // the row applied, so Undo is offered again and still targets the
    // decision rather than the snapshot stack.
    const retry = undoButton();
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(reverts).toEqual([D_TAGS, D_TAGS]);
    expect(genericUndo).not.toHaveBeenCalled();

    await settleRevert();
    await waitFor(() =>
      expect(toast().textContent).toContain("Reverted the suggestion."),
    );
    expect(genericUndo).not.toHaveBeenCalled();
  });

  it("retires the armed target when the auto-hide takes the toast", async () => {
    const genericUndo = spyGenericUndo();
    await db.decisions.bulkPut(seedRows());
    // A short REAL auto-hide (production is ~8s) so the controller's own
    // timer retires the toast inside the test: this is what pins App's
    // `onAutoHide` → `retireCurrentToast` wiring. Unwire it and the late
    // success below would resurrect the toast and re-arm the decision.
    await renderApp({ undoToastAutoHideMs: 1_500 });
    await openReviewView();
    await applyDecision("Alpha");

    fireEvent.click(undoButton());
    expect(reverts).toEqual([D_TAGS]);

    // The auto-hide retires the toast while the revert is still parked.
    await waitFor(
      () => expect(screen.queryByTestId("undo-toast")).toBeNull(),
      { timeout: 5_000 },
    );

    await settleRevert();
    await drainAsyncWork();

    // The late success neither resurrects the toast nor re-arms the decision.
    expect(screen.queryByTestId("undo-toast")).toBeNull();
    const palette = await openPalette();
    await highlight(palette, /Undo last action/);
    fireEvent.keyDown(palette, { key: "Enter" });
    await waitFor(() => expect(genericUndo).toHaveBeenCalledTimes(1));
    expect(reverts).toEqual([D_TAGS]);
  });
});
