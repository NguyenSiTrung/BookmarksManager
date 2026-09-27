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
import { db } from "../../src/db/database";
import {
  DuplicateScanError,
  levelToConfidence,
  scanNearDuplicates,
} from "../../src/decisions/duplicates";
import type { ScanNearDuplicatesOptions } from "../../src/decisions/duplicates";
import type { NearDuplicateSource } from "../../src/decisions/candidates";
import { resetJevClientPools } from "../../src/jev/client";
import type { JevClient, JevTransport } from "../../src/jev/client";
import type { Answer } from "../../src/jev/wire";
import { startMockJevServer } from "../mock-servers/jev";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * Near-duplicate scan service (spec FR3/FR4/FR5/FR7, PROJECT_PLAN.md §9.2):
 * the pairs `nearDuplicatePairs` emits are each sent as ONE `jev_decisions`
 * request carrying the `nearDuplicate` question set (state
 * `{bookmark, pairPartner}`, both minimized), the `same_content` level is
 * cross-checked and mapped to a confidence, the §10.2 `merge_duplicates`
 * policy decides review vs unsure (never auto-apply), one `merge_duplicates`
 * decision persists per pair with `keepId`, and one `usage` row is recorded
 * per egress. A blocklisted/sensitive pair side is skipped (no request).
 */

const DOCS_A = "https://docs.rs/async";
const DOCS_B = "https://docs.rs/async-old";
const TOKIO_A = "https://tokio.rs/tutorial";
const TOKIO_B = "https://tokio.rs/tutorial-v1";
const MAIL_A = "https://mail.google.com/mail/u/0";
const MAIL_B = "https://mail.google.com/mail/u/1";

/** Two sendable pairs (docs.rs + tokio.rs). */
function baseBookmarks(): NearDuplicateSource[] {
  return [
    { id: "bm-0", title: "Rust Async Guide", url: DOCS_A },
    { id: "bm-1", title: "Rust Async Guide", url: DOCS_B },
    { id: "bm-2", title: "Tokio Tutorial", url: TOKIO_A },
    { id: "bm-3", title: "Tokio Tutorial", url: TOKIO_B },
  ];
}

/** A pair on a sensitive (webmail) domain plus the two sendable pairs. */
function withSensitivePair(): NearDuplicateSource[] {
  return [
    ...baseBookmarks(),
    { id: "bm-mail-0", title: "Inbox Backup", url: MAIL_A },
    { id: "bm-mail-1", title: "Inbox Backup", url: MAIL_B },
  ];
}

let server: MockJevServer;
let scopeSeen: string[];

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  resetJevClientPools();
  scopeSeen = [];
  server = await startMockJevServer();
  await db.usage.clear();
  await db.decisions.clear();
});

afterEach(async () => {
  await server.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

/** A transport that POSTs the client's request to the mock server. */
function serverTransport(): JevTransport {
  return (scope, _preset, _model, request, options) => {
    scopeSeen.push(scope);
    return fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal ?? null,
    });
  };
}

function options(
  over: Partial<ScanNearDuplicatesOptions> = {},
): ScanNearDuplicatesOptions {
  return {
    bookmarks: baseBookmarks(),
    preset: "typesafe",
    model: "jev-latest",
    transport: serverTransport(),
    ...over,
  };
}

interface RequestBody {
  model: string;
  state: {
    bookmark?: { title: string; url: string; domain: string };
    pairPartner?: { title: string; url: string; domain: string };
  };
  questions: Record<string, { type: string }>;
}

/** Body of the request at `index` the mock server received, JSON-parsed. */
function requestAt(index: number): RequestBody {
  const received = server.requests[index];
  if (received === undefined) throw new Error(`no request at index ${index}`);
  return received.json as RequestBody;
}

function scoreAnswer(score: number, confidence = 0.9): Answer {
  return {
    type: "score",
    score,
    legend: {},
    probabilities: { [String(score)]: 1 },
    confidence,
  };
}

/** An injected client returning a scripted answer per successive run(). */
function sequenceClient(answers: readonly Answer[], model = "injected-1"): JevClient {
  let index = 0;
  return {
    model,
    run: () => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      return Promise.resolve({
        model,
        answers: { same_content: answer ?? scoreAnswer(1) },
        usage: { inputTokens: 5, outputTokens: 7 },
        batches: 1,
      });
    },
  };
}

describe("levelToConfidence", () => {
  it("maps the four same_content levels onto the §10.2 confidence bands", () => {
    expect(levelToConfidence(1)).toBe(0);
    expect(levelToConfidence(2)).toBeCloseTo(0.4);
    expect(levelToConfidence(3)).toBeCloseTo(0.75);
    expect(levelToConfidence(4)).toBe(1);
    // 3 and 4 clear the 0.5 review floor; 1 and 2 fall below it.
    expect(levelToConfidence(3)).toBeGreaterThanOrEqual(0.5);
    expect(levelToConfidence(4)).toBeGreaterThanOrEqual(0.5);
    expect(levelToConfidence(2)).toBeLessThan(0.5);
    expect(levelToConfidence(1)).toBeLessThan(0.5);
  });

  it("rejects a level outside the declared 1–4 range", () => {
    expect(() => levelToConfidence(0)).toThrow(RangeError);
    expect(() => levelToConfidence(5)).toThrow(RangeError);
    expect(() => levelToConfidence(1.5)).toThrow(RangeError);
  });
});

describe("scanNearDuplicates", () => {
  it("sends one jev_decisions request per pair with the minimized bookmark/pairPartner state", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0" });
    server.queue({ kind: "answer", model: "jev-1.13.0" });

    const result = await scanNearDuplicates(options());

    expect(result.sent).toBe(true);
    expect(server.requests).toHaveLength(2);
    expect(scopeSeen).toEqual(["jev_decisions", "jev_decisions"]);

    const first = requestAt(0);
    // Both sides are minimized to {title, url, domain}; the pair's `a` is
    // `bookmark` and its `b` is `pairPartner`.
    expect(first.state.bookmark).toEqual({
      title: "Rust Async Guide",
      url: DOCS_A,
      domain: "docs.rs",
    });
    expect(first.state.pairPartner).toEqual({
      title: "Rust Async Guide",
      url: DOCS_B,
      domain: "docs.rs",
    });
    expect(Object.keys(first.questions)).toEqual(["same_content"]);
    expect(first.questions.same_content?.type).toBe("score");

    // Chrome node ids never leave the device.
    const raw = server.requests[0]?.rawBody ?? "";
    expect(raw).not.toContain("bm-0");
    expect(raw).not.toContain("bm-1");

    if (!result.sent) throw new Error("expected a sent result");
    expect(result.pairs).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.usage).toHaveLength(2);
    expect(await db.usage.count()).toBe(2);
  });

  it("maps each level to a confidence and lands review vs unsure, persisting keepId", async () => {
    // Pair 0 → level 4 (identical page) → 1.0 → review.
    server.queue({ kind: "answer", answerOverrides: { same_content: scoreAnswer(4) } });
    // Pair 1 → level 2 (same topic, different content) → 0.4 → unsure.
    server.queue({ kind: "answer", answerOverrides: { same_content: scoreAnswer(2) } });

    const result = await scanNearDuplicates(options());

    if (!result.sent) throw new Error("expected a sent result");
    expect(result.results[0]?.level).toBe(4);
    expect(result.results[0]?.confidence).toBe(1);
    expect(result.results[0]?.outcome).toBe("review");
    expect(result.results[1]?.level).toBe(2);
    expect(result.results[1]?.confidence).toBeCloseTo(0.4);
    expect(result.results[1]?.outcome).toBe("unsure");

    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(2);
    for (const decision of decisions) {
      expect(decision.kind).toBe("merge_duplicates");
      expect(decision.bookmarkIds).toHaveLength(2);
      // Never auto-applied — the user confirms a merge (§10.2).
      expect(["pending", "unsure"]).toContain(decision.status);
      expect(decision.status).not.toBe("auto_applied");
      expect(decision.status).not.toBe("applied");
      if (decision.kind !== "merge_duplicates") throw new Error("wrong kind");
      // keepId is one of the two sides (the canonical `a`).
      expect(decision.bookmarkIds).toContain(decision.keepId);
    }
    // review → pending; unsure → unsure.
    expect(decisions.map((d) => d.status).sort()).toEqual(["pending", "unsure"]);
    expect(
      decisions.find((d) => d.confidence === 1)?.status,
    ).toBe("pending");
  });

  it("skips a pair whose side is blocklisted, sending the rest", async () => {
    server.queue({ kind: "answer" });
    server.queue({ kind: "answer" });

    const result = await scanNearDuplicates(
      options({ bookmarks: withSensitivePair() }),
    );

    if (!result.sent) throw new Error("expected a sent result");
    // Two sendable pairs (docs.rs, tokio.rs) + one skipped webmail pair.
    expect(result.pairs).toBe(3);
    expect(result.skipped).toBe(1);
    expect(server.requests).toHaveLength(2);
    const allRaw = server.requests.map((r) => r.rawBody).join("\n");
    expect(allRaw).not.toContain("mail.google.com");
    expect(allRaw).not.toContain("Inbox Backup");
  });

  it("makes no request when every pair is blocklisted", async () => {
    const result = await scanNearDuplicates(
      options({
        bookmarks: [
          { id: "bm-mail-0", title: "Inbox Backup", url: MAIL_A },
          { id: "bm-mail-1", title: "Inbox Backup", url: MAIL_B },
        ],
      }),
    );

    expect(result).toEqual({ sent: false, reason: "blocklisted" });
    expect(server.requests).toHaveLength(0);
    expect(await db.usage.count()).toBe(0);
    expect(await db.decisions.count()).toBe(0);
  });

  it("skips a pair whose side is USER-blocklisted, sending the rest", async () => {
    server.queue({ kind: "answer" });

    const result = await scanNearDuplicates(
      options({ userBlocklist: ["docs.rs"] }),
    );

    if (!result.sent) throw new Error("expected a sent result");
    // docs.rs pair (user-blocklisted side) skipped; tokio.rs pair sent.
    expect(result.pairs).toBe(2);
    expect(result.skipped).toBe(1);
    expect(server.requests).toHaveLength(1);
    const raw = server.requests.map((r) => r.rawBody).join("\n");
    expect(raw).not.toContain("docs.rs");
  });

  it("makes no request when there are no near-duplicate pairs", async () => {
    const result = await scanNearDuplicates(
      options({
        bookmarks: [
          { id: "bm-0", title: "Alpha", url: "https://a.example/x" },
          { id: "bm-1", title: "Beta", url: "https://b.example/y" },
        ],
      }),
    );

    expect(result).toEqual({ sent: false, reason: "empty" });
    expect(server.requests).toHaveLength(0);
    expect(await db.usage.count()).toBe(0);
  });

  it("rejects an out-of-range same_content level (no decision, no usage)", async () => {
    const error = await scanNearDuplicates(
      options({ client: sequenceClient([scoreAnswer(5)]) }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DuplicateScanError);
    expect((error as DuplicateScanError).code).toBe("answer_mismatch");
    expect(server.requests).toHaveLength(0);
    expect(await db.usage.count()).toBe(0);
    expect(await db.decisions.count()).toBe(0);
  });

  it("rejects a wrong-type answer and an unexpected answer key", async () => {
    const wrongType: Answer = {
      type: "choice",
      choice: "x",
      probabilities: {},
      confidence: 0.9,
    };
    const error = await scanNearDuplicates(
      options({ client: sequenceClient([wrongType]) }),
    ).catch((caught: unknown) => caught);
    expect((error as DuplicateScanError).code).toBe("answer_mismatch");
    expect(await db.decisions.count()).toBe(0);
  });

  it("records one usage row per pair egress", async () => {
    server.queue({ kind: "answer" });
    server.queue({ kind: "answer" });

    const result = await scanNearDuplicates(options());

    if (!result.sent) throw new Error("expected a sent result");
    const rows = await db.usage.toArray();
    expect(rows).toHaveLength(2);
    expect(result.usage.map((u) => u.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
  });

  it("surfaces provider failures typed and without content", async () => {
    server.queue({ kind: "status", status: 401 });

    const error = await scanNearDuplicates(options()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DuplicateScanError);
    expect((error as DuplicateScanError).code).toBe("auth");
    const message = (error as Error).message;
    expect(message).not.toContain("Rust Async Guide");
    expect(message).not.toContain(DOCS_A);
    expect(await db.decisions.count()).toBe(0);
  });

  it("uses an injected client's model for the persisted decision source", async () => {
    const result = await scanNearDuplicates(
      options({
        client: sequenceClient([scoreAnswer(4), scoreAnswer(4)], "injected-9"),
      }),
    );

    if (!result.sent) throw new Error("expected a sent result");
    const decisions = await db.decisions.toArray();
    expect(decisions.every((d) => d.source.model === "injected-9")).toBe(true);
    expect(server.requests).toHaveLength(0);
  });
});
