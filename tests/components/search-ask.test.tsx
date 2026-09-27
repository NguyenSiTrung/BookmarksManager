import "fake-indexeddb/auto";
import {
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
import { useState } from "react";
import { CONSENT_VERSION } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { App } from "../../src/entrypoints/sidepanel/App";
import { SearchBar } from "../../src/entrypoints/sidepanel/SearchBar";
import type { DecisionMessageResult } from "../../src/messages/decisions";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Task 5 — the "Ask" toggle on the side-panel search bar (FR10).
 *
 * Layers under test:
 *  - `ask.tsx`       consent-gated visibility (a `jev_decisions` row in
 *                    `db.consents` at the current `CONSENT_VERSION`), the
 *                    debounced RERANK dispatch, the stale-reply guard, and
 *                    the folded note state (ranked / no-match / skipped /
 *                    error).
 *  - `SearchBar`     the `role="switch"` toggle beside the input, the
 *                    `role="status"` ask note under it, and the optional
 *                    `onRerankOrder` callback that surfaces the reranked
 *                    bookmark-id order (absent → identical old behavior).
 *  - `App`           the existing call site keeps compiling and behaving
 *                    identically — plain search stays purely local.
 *
 * The worker is a stub: `chrome.runtime.sendMessage` answers canned
 * `rerank_ok` payloads (or hangs, for the stale-reply race). Consent rows
 * are seeded straight into `db.consents`.
 */

const ORIGIN = "https://api.typesafe.ai";

/** Canned `rerank_ok` reply builder. */
function rankedReply(
  results: { id: string; probability: number }[],
  over: { noMatch?: boolean } = {},
): DecisionMessageResult {
  return {
    ok: true,
    code: "rerank_ok",
    result: {
      sent: true,
      model: "jev-1.13.0",
      results,
      noMatch: over.noMatch === true ? true : false,
    },
  };
}

/** Per-test reply factory (query → reply promise). */
let replyFor: (query: string) => DecisionMessageResult | Promise<DecisionMessageResult>;

const sendMessage = vi.fn((raw: unknown): Promise<unknown> => {
  const message = raw as { type: string; query: string };
  if (message.type === "RERANK") {
    return Promise.resolve(replyFor(message.query)) as Promise<unknown>;
  }
  return Promise.resolve({
    ok: false,
    code: "internal_error",
    message: "unhandled intent",
  });
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
  replyFor = () => rankedReply([]);
  sendMessage.mockClear();
  let tick = 0;
  fake = createFakeBookmarks({
    now: () => (tick += 100),
    bookmarksBar: [
      { id: "b1", title: "Alpha", url: "https://a.example/" },
      { id: "b2", title: "Beta", url: "https://b.example/" },
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

// --- shared helpers --------------------------------------------------------

/** Seed a `jev_decisions` consent row at `version` (current by default). */
async function seedConsent(version: number = CONSENT_VERSION): Promise<void> {
  await db.consents.put({
    scope: DECISIONS_CONSENT_SCOPE,
    origin: ORIGIN,
    consentVersion: version,
    acceptedAt: "2026-09-01T00:00:00.000Z",
  });
}

/** Render SearchBar controlled, optionally observing the reranked order. */
function renderSearchBar(
  onRerankOrder?: (ids: readonly string[] | null) => void,
): void {
  function Harness() {
    const [value, setValue] = useState("");
    return (
      <SearchBar
        value={value}
        onChange={setValue}
        resultCount={3}
        sources={{ tags: [], folders: [] }}
        {...(onRerankOrder === undefined ? {} : { onRerankOrder })}
      />
    );
  }
  render(<Harness />);
}

/** The consent read is a Dexie live query — always await the toggle. */
async function askToggle(): Promise<HTMLElement> {
  return screen.findByRole("switch", { name: "Ask" });
}

function searchbox(): HTMLElement {
  return screen.getByRole("combobox", { name: "Search bookmarks" });
}

function typeQuery(text: string): void {
  fireEvent.change(searchbox(), { target: { value: text } });
}

/** Wait out the rerank debounce (real timers; the wait is the assertion). */
async function settle(ms = 600): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * jsdom reports 0 for every element's offsetHeight/offsetWidth, which makes
 * @tanstack/react-virtual render nothing. The scroll container
 * (data-testid="bookmark-scroll") gets a fixed 600x400 rect so rows mount —
 * the same stub sidepanel-search.test.tsx uses (App-level test only).
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

// --- tests -----------------------------------------------------------------

describe("Ask toggle consent gating", () => {
  it("is hidden while no jev_decisions consent exists, even for a query", async () => {
    renderSearchBar();
    typeQuery("rust");
    await settle();
    expect(screen.queryByRole("switch", { name: "Ask" })).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("is hidden for a stale consentVersion row (re-disclosure required)", async () => {
    await seedConsent(CONSENT_VERSION - 1);
    renderSearchBar();
    await waitFor(() => expect(db.consents.count()).resolves.toBe(1));
    expect(screen.queryByRole("switch", { name: "Ask" })).toBeNull();
  });

  it("appears when consent exists and disappears when it is revoked", async () => {
    renderSearchBar();
    expect(screen.queryByRole("switch", { name: "Ask" })).toBeNull();

    await seedConsent();
    await screen.findByRole("switch", { name: "Ask" });

    await db.consents.clear();
    await waitFor(() =>
      expect(screen.queryByRole("switch", { name: "Ask" })).toBeNull(),
    );
  });
});

describe("Ask rerank", () => {
  it("sends one RERANK for the settled query and reports the probability order", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);

    const toggle = await askToggle();
    // A real, labelled, keyboard-operable control.
    expect(toggle instanceof HTMLButtonElement).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // Deliberately unsorted: the UI must order by probability desc.
    replyFor = () =>
      rankedReply([
        { id: "b2", probability: 0.3 },
        { id: "b1", probability: 0.9 },
        { id: "b3", probability: 0.6 },
      ]);
    typeQuery("rust docs");

    await waitFor(
      () => expect(sendMessage).toHaveBeenCalledTimes(1),
      { timeout: 3000 },
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: "RERANK",
      query: "rust docs",
    });

    await waitFor(() => expect(order).toHaveBeenCalledWith(["b1", "b3", "b2"]));
    expect(order).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ask-status").textContent).toMatch(/ranked/i);
  });

  it("shows the no-match state (distinct from no results)", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);
    fireEvent.click(await askToggle());

    replyFor = () =>
      rankedReply([{ id: "b1", probability: 0.2 }], { noMatch: true });
    typeQuery("ghost");

    await waitFor(() => expect(order).toHaveBeenCalled(), { timeout: 3000 });
    const status = screen.getByTestId("ask-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toMatch(/no close match/i);
    // Distinct from the "no results" count announcement.
    expect(status.textContent).not.toMatch(/0 results/);
    expect(screen.getByTestId("search-status").textContent).toContain(
      "3 results",
    );
  });

  it("keeps plain search local with Ask off — zero messages, local order", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);

    typeQuery("alpha");
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(order).not.toHaveBeenCalled();

    // The toggle itself is the gate: flipping it reranks the same query.
    replyFor = () => rankedReply([{ id: "b1", probability: 0.9 }]);
    fireEvent.click(await askToggle());
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    await waitFor(() => expect(order).toHaveBeenCalledWith(["b1"]));
  });

  it("turning Ask off again restores the local order and cancels reranking", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);
    fireEvent.click(await askToggle());

    replyFor = () => rankedReply([{ id: "b1", probability: 0.9 }]);
    typeQuery("alpha");
    await waitFor(() => expect(order).toHaveBeenCalledWith(["b1"]), {
      timeout: 3000,
    });

    fireEvent.click(await askToggle());
    expect(order).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("ask-status")).toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("a stale reply for a superseded query never overwrites the latest order", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);
    fireEvent.click(await askToggle());

    // Holder object: the resolve fn is assigned inside the `replyFor`
    // closure, which TS's straight-line narrowing cannot see.
    const stale = {
      resolve: null as ((reply: DecisionMessageResult) => void) | null,
    };
    replyFor = (query) => {
      if (query === "rust") {
        return new Promise((resolve) => {
          stale.resolve = resolve;
        });
      }
      return rankedReply([
        { id: "b9", probability: 0.9 },
        { id: "b8", probability: 0.1 },
      ]);
    };

    typeQuery("rust");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    typeQuery("rust lang");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    await waitFor(() =>
      expect(order).toHaveBeenCalledWith(["b9", "b8"]),
    );

    // The superseded reply lands late with a different order — dropped.
    stale.resolve?.(rankedReply([{ id: "b1", probability: 0.99 }]));
    await settle(150);
    expect(order).toHaveBeenLastCalledWith(["b9", "b8"]);
    expect(order).not.toHaveBeenCalledWith(["b1"]);
    expect(screen.getByTestId("ask-status").textContent).toMatch(/ranked/i);
  });

  it("a not-sent reply (blocklisted) falls back to local order with a quiet note", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);
    fireEvent.click(await askToggle());

    replyFor = () => rankedReply([{ id: "b1", probability: 0.9 }]);
    typeQuery("rust");
    await waitFor(() => expect(order).toHaveBeenCalledWith(["b1"]), {
      timeout: 3000,
    });

    replyFor = () =>
      ({
        ok: true,
        code: "rerank_ok",
        result: { sent: false, reason: "blocklisted", results: [] },
      }) satisfies DecisionMessageResult;
    typeQuery("secret");
    await waitFor(
      () =>
        expect(screen.getByTestId("ask-status").textContent).toMatch(
          /blocklist/i,
        ),
      { timeout: 3000 },
    );
    expect(order).toHaveBeenLastCalledWith(null);
  });

  it("renders an error reply quietly without crashing", async () => {
    await seedConsent();
    const order = vi.fn();
    renderSearchBar(order);
    fireEvent.click(await askToggle());

    replyFor = () =>
      ({
        ok: false,
        code: "api",
        message: "The provider is offline.",
      }) satisfies DecisionMessageResult;
    typeQuery("rust");

    await waitFor(
      () =>
        expect(screen.getByTestId("ask-status").textContent).toContain(
          "The provider is offline.",
        ),
      { timeout: 3000 },
    );
    expect(order).not.toHaveBeenCalled();
    // The panel stays usable — the input is still there and editable.
    typeQuery("rust again");
    expect((searchbox() as HTMLInputElement).value).toBe("rust again");
  });
});

describe("App integration (existing call site)", () => {
  it("mounts the toggle inside the real App and keeps plain search local", async () => {
    render(<App />);
    await waitFor(() =>
      expect(
        screen.queryByRole("listbox", { name: "Bookmarks" }),
      ).not.toBeNull(),
    );
    // No consent → no toggle, even though SearchBar always mounts the hook.
    expect(screen.queryByRole("switch", { name: "Ask" })).toBeNull();

    await seedConsent();
    await screen.findByRole("switch", { name: "Ask" });

    // Plain search with the toggle present but OFF stays purely local.
    fireEvent.change(screen.getByRole("combobox", { name: "Search bookmarks" }), {
      target: { value: "alpha" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("search-status").textContent).toContain(
        "1 result",
      ),
    );
    await settle();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
