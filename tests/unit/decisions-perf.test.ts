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
import { productionHandlers } from "../../src/entrypoints/background";
import { resetJevClientPools } from "../../src/jev/client";
import { handleDecisionsMessage } from "../../src/messages/decisions";
import { sendConsented } from "../../src/net/send";
import { DECISIONS_CONSENT_SCOPE } from "../../src/schemas/provider";
import type { TagDef } from "../../src/schemas/meta";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { startMockJevServer } from "../mock-servers/jev";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * Analyze-on-save performance gate (spec §15 NFR, PROJECT_PLAN.md:927 — "Jev
 * analyze on save takes under 1.5 s end to end"): one full SAVE_SUGGEST round
 * trip — message layer → production handlers → minimize + candidates → ONE
 * request through the consented client → answer cross-check → policy → three
 * persisted `decisions` rows plus `usage`/`sentLog` — must complete in under
 * 1.5 s against a localhost mock answering instantly. The mock's default
 * replies are schema-valid and pass the pipeline's answer cross-check, so no
 * scripting is needed and the measurement covers the device-side path: the
 * budget is the regression tripwire for N+1 Dexie reads, per-question
 * fetches, or exponential candidate math, not network latency.
 *
 * The other two §15 gates hold in their own files and stay green in the same
 * `vitest run`: popup-open < 150 ms (tests/components/popup-save.test.tsx
 * "becomes interactive well under the 150 ms popup budget") and 10k search
 * (tests/unit/search-perf.test.ts — index build < 500 ms, median query
 * < 50 ms). They are referenced here, not duplicated.
 *
 * The seeded library is deterministic — fixed ids, titles, URLs, folders —
 * so every run computes the same candidate shortlists: 250 bookmarks across
 * 5 domains in 10 folders, 20 tag definitions, and meta rows on every 5th
 * bookmark (so the tag selector has a real same-domain signal for the
 * subject's host). Only `sendConsented` is redirected to the mock server
 * (the decisions-save-suggest.test.ts pattern); everything else is the real
 * production path. Each iteration analyzes a synthetic `popup:` id, so runs
 * never collide in the store.
 */

vi.mock("../../src/net/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/net/send")>();
  return { ...actual, sendConsented: vi.fn() };
});

const send = vi.mocked(sendConsented);

const EXTENSION_ID = "test-extension-id";
const NOW = "2026-09-27T10:00:00.000Z";
const SUBJECT_TITLE = "Tokio tutorial: async in depth";
const SUBJECT_URL = "https://tokio.rs/tokio/tutorial/async";

const DOMAINS = [
  "tokio.rs",
  "docs.dev",
  "github.com",
  "news.io",
  "shop.net",
] as const;
const FOLDERS = [
  ["Dev"],
  ["Dev", "Rust"],
  ["Dev", "Web"],
  ["Personal", "Recipes"],
  ["Reference"],
] as const;
const TAG_NAMES = [
  "rust", "async", "typescript", "reading list", "cooking", "later",
  "design", "parser", "storage", "offline", "sync", "tutorial",
  "reference", "release", "web", "recipes", "news", "shopping",
  "performance", "testing",
] as const;
const WORDS = [
  "async", "guide", "tutorial", "reference", "release", "design",
  "parser", "storage", "offline", "sync",
] as const;

const LIBRARY_SIZE = 250;
const WARMUP_RUNS = 3;
const MEASURED_RUNS = 10;
const BUDGET_MS = 1_500;

/** Deterministic tag definitions. */
const tagDefs: readonly TagDef[] = TAG_NAMES.map((name) => ({
  name,
  nameKey: name,
  description: `Tag for ${name}`,
  createdAt: NOW,
  updatedAt: NOW,
}));

/** One url-bearing leaf as the chrome-bookmarks fake expects it. */
interface Leaf {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** One folder node; children mix subfolders and leaves, in creation order. */
interface Folder {
  readonly id: string;
  readonly title: string;
  readonly children: Array<Folder | Leaf>;
}

/**
 * The deterministic library. Bookmarks land round-robin in the folder
 * shapes; every 5th bookmark shares the subject's domain (`tokio.rs`) and
 * gets a meta row with two tags — that is the tag selector's same-domain
 * signal. Returns the bookmarks-bar children.
 */
function seedTree(): Folder[] {
  const byPath = new Map<string, Folder>();
  const roots: Folder[] = [];
  for (let i = 0; i < LIBRARY_SIZE; i += 1) {
    const path = FOLDERS[i % FOLDERS.length]!;
    let level: Array<Folder | Leaf> = roots;
    for (const [depth, title] of path.entries()) {
      const key = path.slice(0, depth + 1).join("/");
      let folder = byPath.get(key);
      if (folder === undefined) {
        folder = { id: `f-${key.replaceAll("/", "-")}`, title, children: [] };
        byPath.set(key, folder);
        level.push(folder);
      }
      level = folder.children;
    }
    const domain = DOMAINS[i % DOMAINS.length]!;
    level.push({
      id: `bm-${i}`,
      title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`,
      url: `https://${domain}/item/${i}`,
    });
  }
  return roots;
}

/** Meta rows for every 5th bookmark: two tags each, deterministic keys. */
function seedMetas(): Array<{ id: string; tags: string[]; updatedAt: string }> {
  const metas: Array<{ id: string; tags: string[]; updatedAt: string }> = [];
  for (let i = 0; i < LIBRARY_SIZE; i += 5) {
    metas.push({
      id: `bm-${i}`,
      tags: [
        TAG_NAMES[i % TAG_NAMES.length]!,
        TAG_NAMES[(i * 3) % TAG_NAMES.length]!,
      ],
      updatedAt: NOW,
    });
  }
  return metas;
}

let server: MockJevServer;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  resetJevClientPools();
  server = await startMockJevServer();
  const bookmarks = installBookmarksFake({ bookmarksBar: seedTree() });
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

  await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
  await db.metadata.put({
    key: "typesafe",
    value: { preset: "typesafe", model: "jev-latest", keySuffix: "test" },
  });
  for (const def of tagDefs) {
    await db.tags.put(def);
  }
  for (const meta of seedMetas()) {
    await db.bookmarkMeta.put(meta);
  }
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
});

afterAll(() => {
  db.close();
});

const sender = { url: `chrome-extension://${EXTENSION_ID}/sidepanel.html` };

/** One full analyze-on-save round trip, timed in ms. */
async function saveSuggestOnce(index: number): Promise<number> {
  const start = performance.now();
  const result = await handleDecisionsMessage(
    {
      type: "SAVE_SUGGEST",
      bookmark: {
        id: `popup:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        title: SUBJECT_TITLE,
        url: SUBJECT_URL,
      },
    },
    sender,
    productionHandlers(),
  );
  const elapsed = performance.now() - start;

  // A fast FAILURE must not pass the gate: every round trip really asked one
  // question set, got a valid answer, and persisted its proposal rows.
  expect(result).toMatchObject({
    ok: true,
    code: "analyze_ok",
    result: { sent: true },
  });
  return elapsed;
}

describe("analyze-on-save performance", () => {
  it(`completes a full SAVE_SUGGEST round trip in under ${BUDGET_MS} ms`, async () => {
    // Warmup absorbs one-time costs the per-save budget is not about:
    // module init, JIT, Dexie open, and the client pool.
    for (let i = 0; i < WARMUP_RUNS; i += 1) {
      await saveSuggestOnce(i);
    }
    expect(server.requests).toHaveLength(WARMUP_RUNS);

    const samples: number[] = [];
    for (let i = WARMUP_RUNS; i < WARMUP_RUNS + MEASURED_RUNS; i += 1) {
      samples.push(await saveSuggestOnce(i));
    }
    expect(server.requests).toHaveLength(WARMUP_RUNS + MEASURED_RUNS);

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const max = sorted[sorted.length - 1]!;
    // The gate is the WORST measured run: one slow save is a real user-facing
    // miss of the §15 budget, not noise to average away.
    console.log(
      `[perf] analyze-on-save over ${MEASURED_RUNS} runs: ` +
        `median=${median.toFixed(1)}ms max=${max.toFixed(1)}ms ` +
        `(budget ${BUDGET_MS}ms; library ${LIBRARY_SIZE} bookmarks, ` +
        `${tagDefs.length} tags)`,
    );
    expect(max).toBeLessThan(BUDGET_MS);
  });
});
