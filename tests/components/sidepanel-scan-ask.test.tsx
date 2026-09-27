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
import { CONSENT_VERSION } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { App } from "../../src/entrypoints/sidepanel/App";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import type { Job } from "../../src/schemas/job";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Tasks 4 + 5 — the coordinator's App wiring, at App level.
 *
 * Layers under test:
 *  - `App.tsx`  the sidebar "Scan library…" entry opens the ScanPanel
 *               dialog over the minimized whole-library work set, and
 *               "Start scan" sends one `JOB_START` intent carrying every
 *               bookmark id.
 *  - `App.tsx`  SearchBar's `onRerankOrder` sink: an Ask-reranked order
 *               permutes the CURRENT query's results (probability-desc),
 *               and a new query falls back to local order until its own
 *               reply lands — the order is keyed by the query it answered,
 *               so a stale or pending rerank can never permute different
 *               results.
 *
 * The worker is a stub (`chrome.runtime.sendMessage`); the JOB_START stub
 * also writes the running `jobs` row the real runner would persist, so the
 * panel's live Dexie read renders "Running" end to end.
 */

const ORIGIN = "https://api.typesafe.ai";

/** Canned `rerank_ok` reply builder. */
function rankedReply(
  results: { id: string; probability: number }[],
): DecisionMessageResult {
  return {
    ok: true,
    code: "rerank_ok",
    result: {
      sent: true,
      model: "jev-1.13.0",
      results,
      noMatch: false,
    },
  };
}

/** A freshly-started running `library_scan` row (what the runner persists). */
function runningJobRow(ids: readonly string[]): Job {
  return {
    id: "job-1",
    kind: "library_scan",
    status: "running",
    progress: { totalBatches: 1, committedBatches: 0, processedCount: 0 },
    batchSize: 5,
    bookmarkIds: [...ids],
    usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    createdAt: "2026-09-27T17:00:00.000Z",
    updatedAt: "2026-09-27T17:00:00.000Z",
  };
}

/** Per-test RERANK reply factory (query → reply promise). */
let replyFor: (
  query: string,
) => DecisionMessageResult | Promise<DecisionMessageResult>;

const sendMessage = vi.fn((raw: unknown): Promise<unknown> => {
  const message = raw as {
    type: string;
    query?: string;
    bookmarkIds?: string[];
  };
  if (message.type === "RERANK" && message.query !== undefined) {
    return Promise.resolve(replyFor(message.query)) as Promise<unknown>;
  }
  if (message.type === "JOB_START" && message.bookmarkIds !== undefined) {
    const ids = message.bookmarkIds;
    // The real handler persists the row before replying; mirror that so
    // ScanPanel's live Dexie read has something to render.
    void db.jobs.put(runningJobRow(ids));
    return Promise.resolve({
      ok: true,
      code: "job_ok",
      job: runningJobRow(ids),
    }) as Promise<unknown>;
  }
  return Promise.resolve({
    ok: false,
    code: "internal_error",
    message: "unhandled intent",
  }) as Promise<unknown>;
});

let fake: FakeBookmarksApi;

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
  await db.consents.clear();
  await db.jobs.clear();
  replyFor = () => rankedReply([]);
  sendMessage.mockClear();
  let tick = 0;
  fake = createFakeBookmarks({
    now: () => (tick += 100),
    bookmarksBar: [
      { id: "b1", title: "Alpha Notes", url: "https://a.example/" },
      { id: "b2", title: "Beta Notes", url: "https://b.example/" },
      { id: "b3", title: "Gamma", url: "https://g.example/" },
    ],
    otherBookmarks: [],
  });
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
 * @tanstack/react-virtual render nothing. The scroll container gets a fixed
 * 600x400 rect so rows mount (same trick as sidepanel-search.test.tsx).
 */
const SCROLL_TESTID = "bookmark-scroll";
let savedRectDescriptors: [string, PropertyDescriptor | undefined][] = [];

function stubElementRects(): void {
  const defs: ["offsetHeight" | "offsetWidth", number][] = [
    ["offsetHeight", 600],
    ["offsetWidth", 400],
  ];
  savedRectDescriptors = defs.map(([prop, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(
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
    return [prop, descriptor];
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

/** Options under the result list — suggestion popups also render
 * `role="option"`, so always scope to the `Bookmarks` listbox. */
function results(): HTMLElement[] {
  const list = screen.queryByRole("listbox", { name: "Bookmarks" });
  return list === null ? [] : within(list).queryAllByRole("option");
}

function searchbox(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search bookmarks" });
}

async function renderApp(): Promise<void> {
  render(<App />);
  await waitFor(() => expect(results().length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText("Indexing…")).toBeNull());
}

/** Seed a `jev_decisions` consent row at the current version. */
async function seedConsent(): Promise<void> {
  await db.consents.put({
    scope: DECISIONS_CONSENT_SCOPE,
    origin: ORIGIN,
    consentVersion: CONSENT_VERSION,
    acceptedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("side-panel scan + ask wiring", () => {
  it("opens the scan dialog from the sidebar and starts a scan over every bookmark", async () => {
    await renderApp();

    // The sidebar entry opens the dialog hosting ScanPanel.
    fireEvent.click(screen.getByRole("button", { name: "Scan library…" }));
    const dialog = await screen.findByRole("dialog", { name: "Scan library" });
    // The pre-start estimate covers the whole (3-bookmark) library.
    expect(
      within(dialog).getByText(/3 bookmarks · at least ~\d+ tokens/),
    ).toBeTruthy();

    // Start sends ONE JOB_START with every bookmark id — after the live
    // read gate opens the button (no row exists, so it must resolve to
    // "idle launcher", never stay disabled).
    const start = within(dialog).getByRole("button", {
      name: "Start scan",
    }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith({
      type: "JOB_START",
      kind: "library_scan",
      bookmarkIds: ["b1", "b2", "b3"],
    });

    // The live card streams the row the (stubbed) worker persisted.
    await waitFor(() =>
      expect(within(dialog).getByText("Scan: Running")).toBeTruthy(),
    );
  });

  it("permutes the answered query's results by the Ask verdict and falls back per query", async () => {
    replyFor = () =>
      rankedReply([
        { id: "b2", probability: 0.9 },
        { id: "b1", probability: 0.6 },
      ]);
    await seedConsent();
    await renderApp();

    // Local relevance order for the shared token.
    fireEvent.change(searchbox(), { target: { value: "notes" } });
    await waitFor(() =>
      expect(results().map((el) => el.textContent)).toEqual([
        expect.stringContaining("Alpha"),
        expect.stringContaining("Beta"),
      ]),
    );

    // Ask on → the debounced RERANK lands and permutes the list.
    fireEvent.click(await screen.findByRole("switch", { name: "Ask" }));
    await waitFor(() =>
      expect(results().map((el) => el.textContent)).toEqual([
        expect.stringContaining("Beta"),
        expect.stringContaining("Alpha"),
      ]),
    );
    expect(screen.getByTestId("ask-status").textContent).toBe(
      "Ranked by Ask.",
    );

    // A new query renders LOCAL order while its own rerank is pending —
    // the previous verdict never leaks across queries. ("not" prefix-
    // matches the shared "notes" token, so both results stay present and
    // the stale [b2, b1] order WOULD show without the per-query key.)
    let releaseReply: (() => void) | undefined;
    replyFor = () =>
      new Promise((resolve) => {
        releaseReply = () => resolve(rankedReply([]));
      });
    fireEvent.change(searchbox(), { target: { value: "not" } });
    await waitFor(() =>
      expect(results().map((el) => el.textContent)).toEqual([
        expect.stringContaining("Alpha"),
        expect.stringContaining("Beta"),
      ]),
    );
    releaseReply?.();
  });

  it("a rerank reply with duplicate ids still yields a pure permutation", async () => {
    // A malformed/duplicated verdict must not duplicate a row (and thereby
    // drop an unranked one) — [b2, b2, b1] over [Alpha, Beta] is exactly
    // [Beta, Alpha], never [Beta, Beta].
    replyFor = () =>
      rankedReply([
        { id: "b2", probability: 0.9 },
        { id: "b2", probability: 0.9 },
        { id: "b1", probability: 0.6 },
      ]);
    await seedConsent();
    await renderApp();

    fireEvent.change(searchbox(), { target: { value: "notes" } });
    await waitFor(() => expect(results().length).toBe(2));

    fireEvent.click(await screen.findByRole("switch", { name: "Ask" }));
    await waitFor(() =>
      expect(results().map((el) => el.textContent)).toEqual([
        expect.stringContaining("Beta"),
        expect.stringContaining("Alpha"),
      ]),
    );
  });
});
