import "fake-indexeddb/auto";
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
import { approveDecision } from "../../src/decisions/apply";
import { POPUP_DECISION_LIMIT } from "../../src/decisions/store";
import {
  DECISION_SETTINGS_KEY,
  default as backgroundDefinition,
  productionHandlers,
} from "../../src/entrypoints/background";
import { resetJevClientPools } from "../../src/jev/client";
import { handleDecisionsMessage } from "../../src/messages/decisions";
import { sendConsented } from "../../src/net/send";
import { Decision } from "../../src/schemas/decision";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import type { TagDef } from "../../src/schemas/meta";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { startMockJevServer } from "../mock-servers/jev";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * Save-suggest wiring regression (plan §9.1/FR10 + §10.2): `SAVE_SUGGEST`
 * analyzes a NOT-YET-SAVED page — the synthetic `popup:<uuid>` id names no
 * real bookmark node — so its `set_category`/`add_tags`/`move` outputs are
 * proposals the user accepts via the popup chips, NEVER auto-applied
 * actions. The worker therefore forces every auto-apply toggle off for this
 * flow (`SAVE_SUGGEST_SETTINGS` in background.ts). Before that guard, a user
 * with `add_tags`/`set_category` auto-apply ON and a ≥0.85 answer sent the
 * draft through `approveDecision`, whose staleness guard rejects the
 * `popup:` id (`bookmark_gone`) — the whole suggestion failed `apply_failed`
 * and the chips never appeared.
 *
 * These tests run the REAL production handler + REAL pipeline end-to-end:
 * only `sendConsented` is mocked to POST to the local mock Jev server (the
 * jev-connection.test.ts pattern), and `approveDecision` is wrapped in a
 * pass-through spy so the test proves the guarded apply path never runs for
 * the synthetic id — while `ANALYZE_BOOKMARK` on a real node still
 * auto-applies, keeping the suppression scoped to the proposal flow.
 */

vi.mock("../../src/net/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/net/send")>();
  return { ...actual, sendConsented: vi.fn() };
});

vi.mock("../../src/decisions/apply", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/decisions/apply")>();
  // The real guarded apply, wrapped so calls are observable.
  return { ...actual, approveDecision: vi.fn(actual.approveDecision) };
});

const send = vi.mocked(sendConsented);
const approve = vi.mocked(approveDecision);

const EXTENSION_ID = "test-extension-id";
const SIDEPANEL_URL = `chrome-extension://${EXTENSION_ID}/sidepanel.html`;
const sender = { url: SIDEPANEL_URL };

const NOW = "2026-09-27T10:00:00.000Z";
const PAGE_TITLE = "Tokio tutorial: async in depth";
const PAGE_URL = "https://tokio.rs/tokio/tutorial/async";
const POPUP_ID = "popup:5d4f8d0e-0000-4000-8000-000000000001";

const tagDefs: readonly TagDef[] = [
  {
    name: "rust",
    nameKey: "rust",
    description: "The Rust programming language",
    createdAt: NOW,
    updatedAt: NOW,
  },
  {
    name: "async",
    nameKey: "async",
    description: "Asynchronous programming",
    createdAt: NOW,
    updatedAt: NOW,
  },
];

let server: MockJevServer;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  resetJevClientPools();
  server = await startMockJevServer();
  const bookmarks = installBookmarksFake({
    bookmarksBar: [
      {
        id: "f-dev",
        title: "Dev",
        children: [{ id: "bm-1", title: PAGE_TITLE, url: PAGE_URL }],
      },
      { id: "f-work", title: "Work" },
    ],
  });
  // installBookmarksFake stubs `{bookmarks}` only; the message layer also
  // needs `runtime.getURL` for the trusted-sender check.
  vi.stubGlobal("chrome", {
    bookmarks,
    runtime: {
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
    },
  });

  // The consented gate's send resolves to a POST against the mock server —
  // the pipeline's default transport, scoped `jev_decisions` like production.
  send.mockReset();
  send.mockImplementation((_scope, _preset, _model, request, options) =>
    fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal ?? null,
    }),
  );
  approve.mockClear();

  await Promise.all([
    db.decisions.clear(),
    db.audit.clear(),
    db.usage.clear(),
    db.bookmarkMeta.clear(),
    db.undo.clear(),
    db.metadata.clear(),
    db.consents.clear(),
    db.tags.clear(),
    db.jobs.clear(),
    db.sentLog.clear(),
  ]);

  // A fully-enabled provider for the decisions flow.
  await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
  await db.metadata.put({
    key: "typesafe",
    value: { preset: "typesafe", model: "jev-latest", keySuffix: "test" },
  });
  // The user's REAL persisted settings have BOTH auto-apply toggles ON —
  // the regression setup.
  await db.metadata.put({
    key: DECISION_SETTINGS_KEY,
    value: { autoApply: { add_tags: true, set_category: true } },
  });
  for (const def of tagDefs) {
    await db.tags.put(def);
  }
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

/**
 * ≥AUTO_APPLY_THRESHOLD answers for the categorize + tags checks. The client
 * rejects any answer for an unrequested question (§8.2), so each run
 * overrides exactly the keys its checks ask for.
 */
const CATEGORY_TAGS_ANSWERS = {
  category: {
    type: "choice" as const,
    choice: "docs",
    probabilities: { docs: 0.9, other: 0.1 },
    confidence: 0.9,
  },
  tag_rust: { type: "noul" as const, noul: 0.97 },
  tag_async: { type: "noul" as const, noul: 0.97 },
};

/** The same, plus a confident folder placement for the save-suggest run. */
const SAVE_SUGGEST_ANSWERS = {
  ...CATEGORY_TAGS_ANSWERS,
  folder: {
    type: "choice" as const,
    choice: "f-work",
    probabilities: { "f-work": 0.8, none: 0.2 },
    confidence: 0.8,
  },
};

describe("saveSuggest auto-apply suppression", () => {
  it("persists proposals as pending and never touches the apply path, even with both toggles ON", async () => {
    server.queue({
      kind: "answer",
      model: "jev-1.13.0",
      answerOverrides: SAVE_SUGGEST_ANSWERS,
    });

    const result = await handleDecisionsMessage(
      {
        type: "SAVE_SUGGEST",
        bookmark: { id: POPUP_ID, title: PAGE_TITLE, url: PAGE_URL },
      },
      sender,
      productionHandlers(),
    );

    // The pre-fix failure mode was the whole call failing `apply_failed`.
    expect(result).toMatchObject({
      ok: true,
      code: "analyze_ok",
      result: { sent: true, model: "jev-1.13.0" },
    });
    expect(server.requests).toHaveLength(1);

    // set_category + add_tags + move rows — every one a proposal.
    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(3);
    expect(decisions.map((row) => row.kind).sort()).toEqual([
      "add_tags",
      "move",
      "set_category",
    ]);
    for (const row of decisions) {
      expect(row.bookmarkIds).toEqual([POPUP_ID]);
      expect(row.status).toBe("pending");
      expect(row.status).not.toBe("auto_applied");
      expect(row.status).not.toBe("applied");
    }

    // The guarded apply never ran for the synthetic id: no audit rows, no
    // meta rows, no undo snapshots — and approveDecision was never entered.
    expect(approve).not.toHaveBeenCalled();
    expect(await db.audit.count()).toBe(0);
    expect(await db.bookmarkMeta.count()).toBe(0);
    expect(await db.undo.count()).toBe(0);
  });

  it("still auto-applies for ANALYZE_BOOKMARK on a real node (suppression is save-suggest only)", async () => {
    server.queue({
      kind: "answer",
      model: "jev-1.13.0",
      answerOverrides: CATEGORY_TAGS_ANSWERS,
    });

    const result = await handleDecisionsMessage(
      { type: "ANALYZE_BOOKMARK", bookmarkId: "bm-1" },
      sender,
      productionHandlers(),
    );

    expect(result).toMatchObject({ ok: true, code: "analyze_ok" });
    const decisions = await db.decisions.toArray();
    // Default checks (categorize + tags): both auto-applied per §10.2.
    expect(decisions).toHaveLength(2);
    expect(decisions.every((row) => row.status === "auto_applied")).toBe(true);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve).toHaveBeenCalledWith(
      expect.any(String),
      "policy",
      "auto_applied",
    );
    const meta = await db.bookmarkMeta.get("bm-1");
    expect(meta?.category).toBe("docs");
    expect(meta?.tags.sort()).toEqual(["async", "rust"]);
  });
});

// ---------------------------------------------------------------------------
// Popup retention (I05): synthetic `popup:` rows are bounded after each save
// and by a fail-soft startup/next-save legacy sweep, without ever breaking
// popup saving.
// ---------------------------------------------------------------------------

/** Far enough in the past that freshly persisted popup rows sort newer. */
const LEGACY_EPOCH = Date.UTC(2020, 0, 1);

function syntheticUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** One older synthetic popup row, as an earlier worker session left it. */
function legacyPopupRow(n: number): Decision {
  return Decision.parse({
    id: syntheticUuid(n),
    bookmarkIds: [`popup:${syntheticUuid(n)}`],
    confidence: 0.9,
    status: "pending",
    source: {
      engine: "jev",
      providerId: "typesafe",
      model: "jev-1.13.0",
      questionSetVersion: "1",
    },
    createdAt: new Date(LEGACY_EPOCH + n * 1_000).toISOString(),
    kind: "add_tags",
    tags: ["legacy"],
  });
}

async function seedPopupBacklog(count: number): Promise<void> {
  await db.decisions.bulkPut(
    Array.from({ length: count }, (_, n) => legacyPopupRow(n)),
  );
}

function saveSuggest(id: string) {
  return {
    type: "SAVE_SUGGEST" as const,
    bookmark: { id, title: PAGE_TITLE, url: PAGE_URL },
  };
}

/** Queue one successful ≥threshold answer for the save-suggest checks. */
function queueSaveSuggestAnswer(): void {
  server.queue({
    kind: "answer",
    model: "jev-1.13.0",
    answerOverrides: SAVE_SUGGEST_ANSWERS,
  });
}

describe("saveSuggest popup retention", () => {
  it("sweeps legacy synthetic popup rows down to the bound after a save", async () => {
    queueSaveSuggestAnswer();
    await seedPopupBacklog(POPUP_DECISION_LIMIT + 5);

    const result = await handleDecisionsMessage(
      saveSuggest(POPUP_ID),
      sender,
      productionHandlers(),
    );

    expect(result).toMatchObject({
      ok: true,
      code: "analyze_ok",
      result: { sent: true },
    });
    const rows = await db.decisions.toArray();
    const synthetic = rows.filter((row) =>
      row.bookmarkIds.every((id) => id.startsWith("popup:")),
    );
    expect(synthetic).toHaveLength(POPUP_DECISION_LIMIT);
    // The three just-persisted rows survive the sweep.
    expect(rows.filter((row) => row.bookmarkIds.includes(POPUP_ID))).toHaveLength(
      3,
    );
  });

  it("preserves real rows while sweeping the popup backlog", async () => {
    queueSaveSuggestAnswer();
    await seedPopupBacklog(POPUP_DECISION_LIMIT + 5);
    await db.decisions.put(
      Decision.parse({
        ...legacyPopupRow(900),
        id: syntheticUuid(901),
        bookmarkIds: ["bm-1"],
        createdAt: new Date(Date.UTC(2021, 0, 1)).toISOString(),
      }),
    );

    await handleDecisionsMessage(
      saveSuggest(POPUP_ID),
      sender,
      productionHandlers(),
    );

    expect(await db.decisions.get(syntheticUuid(901))).toBeDefined();
  });

  it("still saves popup suggestions when the retention sweep rejects", async () => {
    queueSaveSuggestAnswer();
    const prunePopup = vi.fn(async () => {
      throw new Error("retention sweep failed");
    });

    const result = await handleDecisionsMessage(
      saveSuggest(POPUP_ID),
      sender,
      productionHandlers({ prunePopup }),
    );

    expect(result).toMatchObject({
      ok: true,
      code: "analyze_ok",
      result: { sent: true },
    });
    expect(prunePopup).toHaveBeenCalledTimes(1);
    expect(await db.decisions.count()).toBe(3);
  });

  it("keeps concurrent popup opens' rows independent under the same bound", async () => {
    queueSaveSuggestAnswer();
    queueSaveSuggestAnswer();
    const [a, b] = await Promise.all([
      handleDecisionsMessage(
        saveSuggest("popup:concurrent-a"),
        sender,
        productionHandlers(),
      ),
      handleDecisionsMessage(
        saveSuggest("popup:concurrent-b"),
        sender,
        productionHandlers(),
      ),
    ]);

    expect(a).toMatchObject({ ok: true, code: "analyze_ok" });
    expect(b).toMatchObject({ ok: true, code: "analyze_ok" });
    const rows = await db.decisions.toArray();
    expect(rows).toHaveLength(6);
    expect(
      rows.filter((row) => row.bookmarkIds.includes("popup:concurrent-a")),
    ).toHaveLength(3);
    expect(
      rows.filter((row) => row.bookmarkIds.includes("popup:concurrent-b")),
    ).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Worker startup (I05): the legacy sweep runs fire-and-forget and is total —
// a rejected sweep must neither surface as an unhandled rejection nor stop
// the rest of the worker wiring (the message-handler registration below it).
// ---------------------------------------------------------------------------

describe("background startup popup sweep", () => {
  /** Minimal `chrome` stub: the sync slices only need additive surfaces. */
  function installWorkerChrome(): { listeners: number } {
    const stub = {
      listeners: 0,
      bookmarks: {
        onCreated: { addListener: vi.fn() },
        onChanged: { addListener: vi.fn() },
        onMoved: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onChildrenReordered: { addListener: vi.fn() },
        getTree: vi.fn(async () => []),
      },
      runtime: {
        onMessage: {
          addListener: vi.fn(() => {
            stub.listeners += 1;
          }),
        },
        getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      },
    };
    vi.stubGlobal("chrome", stub);
    return stub;
  }

  it("runs the legacy sweep at startup without breaking worker registration", async () => {
    const worker = installWorkerChrome();
    await seedPopupBacklog(POPUP_DECISION_LIMIT + 5);

    backgroundDefinition.main();

    // Fire-and-forget: registration is synchronous and already complete...
    expect(worker.listeners).toBeGreaterThanOrEqual(1);
    // ...while the sweep is a bounded, best-effort background task. The real
    // `prunePopupDecisions` is exercised (no store mock in this file), so the
    // trimmed backlog is the proof it ran.
    await vi.waitFor(async () => {
      expect(await db.decisions.count()).toBe(POPUP_DECISION_LIMIT);
    });
  });

  it("swallows a rejected startup sweep and still registers the handler", async () => {
    const worker = installWorkerChrome();
    // Make the REAL sweep reject: a failing transaction on the decisions
    // table is the production failure mode (storage error / worker eviction).
    // A `vi.mock` factory cannot stand in here — Vitest's mock wrappers
    // install their own rejection plumbing, which would hide an unhandled
    // rejection from the probe below.
    const readWrite = vi.spyOn(db, "transaction").mockImplementationOnce(() => {
      throw new Error("startup sweep failed");
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    // Vitest installs its own `unhandledRejection` listener, which takes the
    // rejection first and fails the run asynchronously instead of recording
    // it. Detach the ambient listeners for the duration of the probe so a
    // rejection escaping `defineBackground` is observable right here.
    const ambient = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", onUnhandled);

    try {
      backgroundDefinition.main();
      expect(worker.listeners).toBeGreaterThanOrEqual(1);
      // Let the sweep's microtasks/macrotasks settle without vi.waitFor
      // (which installs its own error plumbing).
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // The real sweep did run (and failed) through this path.
      expect(readWrite).toHaveBeenCalled();
      expect(unhandled).toEqual([]);

      // Control: a bare unhandled rejection IS visible through this probe, so
      // the empty result above means "swallowed", not "unobservable".
      void Promise.reject(new Error("control"));
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(unhandled).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      for (const listener of ambient) {
        process.on("unhandledRejection", listener);
      }
      readWrite.mockRestore();
    }

    // ...and the worker finished wiring its message handler regardless.
    expect(worker.listeners).toBeGreaterThanOrEqual(1);
  });
});
