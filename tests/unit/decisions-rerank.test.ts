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
import { RerankError, rerankSearch } from "../../src/decisions/rerank";
import type { RerankSearchOptions } from "../../src/decisions/rerank";
import { RERANK_NO_MATCH_BAR } from "../../src/decisions/policy";
import { resetJevClientPools } from "../../src/jev/client";
import type { JevClient, JevTransport } from "../../src/jev/client";
import type { Answer } from "../../src/jev/wire";
import type { SearchHit } from "../../src/search/index";
import { startMockJevServer } from "../mock-servers/jev";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * "Ask" rerank service (spec FR3–FR6, PROJECT_PLAN.md §9.4/§10.2): MiniSearch
 * hits are projected (`rerankCandidates`) and minimized to `SentBookmark`s,
 * one `rerank` question set is built, and ONE `jev_decisions` request is sent
 * through a `createJevClient`. Answers map positionally (`candidate_<i>`),
 * every answer ID is cross-checked against the candidates actually sent, the
 * ranked list is sorted by probability (descending), the no-match bar
 * (`isNoMatch`) is applied, and one `usage` row is recorded per egress. An
 * empty or all-blocklisted shortlist makes NO request.
 */

const QUERY = "rust async executors";
const GITHUB_URL = "https://github.com/rust/async";
const TOKIO_URL = "https://tokio.rs/tokio/tutorial";
const WEBMAIL_URL = "https://mail.google.com/mail/u/0";

/** A minimal `SearchHit` with the fields the rerank projection reads. */
function hit(id: string, title: string, url: string, domain: string): SearchHit {
  return {
    id,
    title,
    url,
    domain,
    folderIds: [],
    folderTitles: [],
    tagKeys: [],
    score: 1,
    terms: [],
    queryTerms: [],
    match: {},
  };
}

/** Two sendable hits and one blocklisted (webmail) hit. */
function baseHits(): SearchHit[] {
  return [
    hit("bm-1", "Rust async book", GITHUB_URL, "github.com"),
    hit("bm-2", "Tokio async runtime", TOKIO_URL, "tokio.rs"),
    hit("bm-mail", "Inbox", WEBMAIL_URL, "mail.google.com"),
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

function options(over: Partial<RerankSearchOptions> = {}): RerankSearchOptions {
  return {
    query: QUERY,
    hits: baseHits(),
    preset: "typesafe",
    model: "jev-latest",
    transport: serverTransport(),
    ...over,
  };
}

interface RequestBody {
  model: string;
  state: {
    query?: string;
    candidateBookmarks?: { title: string; url: string; domain: string }[];
  };
  questions: Record<
    string,
    { type: string; instructions: { goal: string; question: string } }
  >;
}

/** Body of the one request the mock server received, JSON-parsed. */
function firstRequest(): RequestBody {
  const received = server.requests[0];
  if (received === undefined) throw new Error("no request was sent");
  return received.json as RequestBody;
}

/** An injected client that returns `answers` unchanged (bypassing the wire). */
function fakeClient(
  answers: Record<string, Answer>,
  model = "injected-1",
): JevClient {
  return {
    model,
    run: () =>
      Promise.resolve({
        model,
        answers,
        usage: { inputTokens: 5, outputTokens: 7 },
        batches: 1,
      }),
  };
}

describe("rerankSearch", () => {
  it("sends the shortlist as ONE jev_decisions request with the rerank question set", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0" });

    const result = await rerankSearch(options());

    expect(result.sent).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(scopeSeen).toEqual(["jev_decisions"]);

    const body = firstRequest();
    expect(body.state.query).toBe(QUERY);
    // Only the two sendable hits were sent; each is minimized to {title,url,domain}.
    expect(body.state.candidateBookmarks).toEqual([
      { title: "Rust async book", url: GITHUB_URL, domain: "github.com" },
      { title: "Tokio async runtime", url: TOKIO_URL, domain: "tokio.rs" },
    ]);
    expect(Object.keys(body.questions)).toEqual(["candidate_0", "candidate_1"]);
    expect(body.questions.candidate_0?.type).toBe("noul");

    if (!result.sent) throw new Error("expected a sent result");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.results.map((r) => r.id)).toEqual(["bm-1", "bm-2"]);
    expect(result.noMatch).toBe(false);

    const usage = await db.usage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe("jev-1.13.0");
    expect(usage[0]?.inputTokens).toBeGreaterThan(0);
    expect(usage[0]?.recordedAt).toBeTruthy();
    expect(result.usage.id).toBe(usage[0]?.id);
  });

  it("sorts results by probability descending, mapping answers positionally", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        candidate_0: { type: "noul", noul: 0.2 },
        candidate_1: { type: "noul", noul: 0.85 },
      },
    });

    const result = await rerankSearch(options());

    if (!result.sent) throw new Error("expected a sent result");
    // candidate_1 (bm-2) outranks candidate_0 (bm-1); the blocklisted hit is
    // not a candidate, so indices refer to the SENT shortlist only.
    expect(result.results).toEqual([
      { id: "bm-2", probability: 0.85 },
      { id: "bm-1", probability: 0.2 },
    ]);
    expect(result.noMatch).toBe(false);
  });

  it("keys questions by the SENT (post-skip) index when a blocklisted hit precedes sendable hits", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        candidate_0: { type: "noul", noul: 0.9 },
        candidate_1: { type: "noul", noul: 0.1 },
      },
    });

    // The blocklisted webmail hit sits BEFORE the two sendable hits, so a
    // raw-shortlist-index implementation would key the sendables as
    // candidate_1/candidate_2. The positional keys must instead be built from
    // the sent (post-skip) list.
    const result = await rerankSearch(
      options({
        hits: [
          hit("bm-mail", "Inbox", WEBMAIL_URL, "mail.google.com"),
          hit("bm-1", "Rust async book", GITHUB_URL, "github.com"),
          hit("bm-2", "Tokio async runtime", TOKIO_URL, "tokio.rs"),
        ],
      }),
    );

    expect(result.sent).toBe(true);
    const body = firstRequest();
    // Only the two sendable bookmarks were sent, in shortlist order.
    expect(body.state.candidateBookmarks).toEqual([
      { title: "Rust async book", url: GITHUB_URL, domain: "github.com" },
      { title: "Tokio async runtime", url: TOKIO_URL, domain: "tokio.rs" },
    ]);
    // The keys are the post-skip indices 0 and 1, never 1 and 2.
    expect(Object.keys(body.questions)).toEqual(["candidate_0", "candidate_1"]);
    // The blocklisted URL/domain never left the device.
    const raw = server.requests[0]?.rawBody ?? "";
    expect(raw).not.toContain(WEBMAIL_URL);
    expect(raw).not.toContain("mail.google.com");

    if (!result.sent) throw new Error("expected a sent result");
    // The answers map back to the two sendable ids in the correct order.
    expect(result.results).toEqual([
      { id: "bm-1", probability: 0.9 },
      { id: "bm-2", probability: 0.1 },
    ]);
  });

  it("keeps shortlist order for candidates with equal probability", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        candidate_0: { type: "noul", noul: 0.8 },
        candidate_1: { type: "noul", noul: 0.8 },
      },
    });

    const result = await rerankSearch(options());

    if (!result.sent) throw new Error("expected a sent result");
    // Ties preserve the shortlist's own (relevance) order: bm-1 then bm-2.
    expect(result.results).toEqual([
      { id: "bm-1", probability: 0.8 },
      { id: "bm-2", probability: 0.8 },
    ]);
    expect(result.noMatch).toBe(false);
  });

  it("reports no match when every probability is below the bar", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        candidate_0: { type: "noul", noul: 0.3 },
        candidate_1: { type: "noul", noul: 0.2 },
      },
    });

    const result = await rerankSearch(options());

    if (!result.sent) throw new Error("expected a sent result");
    expect(result.noMatch).toBe(true);
    // The ranked list is still returned alongside the verdict.
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.probability < RERANK_NO_MATCH_BAR)).toBe(
      true,
    );
  });

  it("treats a probability exactly at the bar as a (weak) match", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        candidate_0: { type: "noul", noul: RERANK_NO_MATCH_BAR },
        candidate_1: { type: "noul", noul: 0.1 },
      },
    });

    const result = await rerankSearch(options());

    if (!result.sent) throw new Error("expected a sent result");
    expect(result.noMatch).toBe(false);
  });

  it("sends the query only as DecisionState.query, never in question text", async () => {
    server.queue({ kind: "answer" });

    await rerankSearch(options());

    const body = firstRequest();
    expect(body.state.query).toBe(QUERY);
    expect(JSON.stringify(body.questions)).not.toContain(QUERY);
    for (const question of Object.values(body.questions)) {
      expect(question.instructions.question).not.toContain(QUERY);
    }
  });

  it("never sends Chrome node ids or raw URL query/fragment to the device", async () => {
    server.queue({ kind: "answer" });
    const dirtyUrl = "https://dirty.io/secret?token=abc#frag";

    await rerankSearch(
      options({
        hits: [hit("bm-dirty", "Dirty", dirtyUrl, "dirty.io")],
      }),
    );

    const body = firstRequest();
    expect(body.state.candidateBookmarks).toEqual([
      { title: "Dirty", url: "https://dirty.io/secret", domain: "dirty.io" },
    ]);
    const raw = server.requests[0]?.rawBody ?? "";
    expect(raw).not.toContain("bm-dirty");
    expect(raw).not.toContain("token=abc");
    expect(raw).not.toContain("frag");
  });

  it("sends 30 candidates in one request and records one usage row", async () => {
    server.queue({ kind: "answer" });
    const many = Array.from({ length: 30 }, (_, i) =>
      hit(`bm-${i}`, `Title ${i}`, `https://s${i}.io/p`, `s${i}.io`),
    );

    const result = await rerankSearch(options({ hits: many }));

    if (!result.sent) throw new Error("expected a sent result");
    expect(server.requests).toHaveLength(1);
    expect(Object.keys(firstRequest().questions)).toHaveLength(30);
    expect(result.results).toHaveLength(30);
    expect(await db.usage.count()).toBe(1);
  });

  it("makes no request for an empty result and writes no usage row", async () => {
    const result = await rerankSearch(options({ hits: [] }));

    expect(result).toEqual({ sent: false, reason: "empty" });
    expect(server.requests).toHaveLength(0);
    expect(await db.usage.count()).toBe(0);
  });

  it("makes no request when every candidate is blocklisted", async () => {
    const result = await rerankSearch(
      options({ hits: [hit("bm-mail", "Inbox", WEBMAIL_URL, "mail.google.com")] }),
    );

    expect(result).toEqual({ sent: false, reason: "blocklisted" });
    expect(server.requests).toHaveLength(0);
    expect(await db.usage.count()).toBe(0);
  });

  it("rejects an answer ID that was not among the candidates sent (no usage row)", async () => {
    const error = await rerankSearch(
      options({
        client: fakeClient({
          candidate_0: { type: "noul", noul: 0.9 },
          candidate_1: { type: "noul", noul: 0.9 },
          candidate_9: { type: "noul", noul: 0.9 },
        }),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RerankError);
    expect((error as RerankError).code).toBe("answer_mismatch");
    expect(await db.usage.count()).toBe(0);
  });

  it("rejects an answer of the wrong type (no usage row)", async () => {
    const error = await rerankSearch(
      options({
        client: fakeClient({
          candidate_0: {
            type: "choice",
            choice: "x",
            probabilities: {},
            confidence: 0.9,
          },
          candidate_1: { type: "noul", noul: 0.9 },
        }),
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RerankError);
    expect((error as RerankError).code).toBe("answer_mismatch");
    expect(await db.usage.count()).toBe(0);
  });

  it("uses an injected client's model and records its usage", async () => {
    const result = await rerankSearch(
      options({
        client: fakeClient(
          {
            candidate_0: { type: "noul", noul: 0.9 },
            candidate_1: { type: "noul", noul: 0.9 },
          },
          "injected-9",
        ),
      }),
    );

    if (!result.sent) throw new Error("expected a sent result");
    expect(result.model).toBe("injected-9");
    expect(server.requests).toHaveLength(0);
    expect((await db.usage.toArray())[0]?.model).toBe("injected-9");
  });

  it("rejects a blank query before any request", async () => {
    const error = await rerankSearch(options({ query: "   " })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RerankError);
    expect((error as RerankError).code).toBe("invalid_input");
    expect(server.requests).toHaveLength(0);
    expect(await db.usage.count()).toBe(0);
  });

  it("surfaces provider failures typed and without content", async () => {
    server.queue({ kind: "status", status: 401 });

    const error = await rerankSearch(options()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RerankError);
    expect((error as RerankError).code).toBe("auth");
    const message = (error as Error).message;
    expect(message).not.toContain(QUERY);
    expect(message).not.toContain("Rust async book");
    expect(message).not.toContain(GITHUB_URL);
    expect(await db.usage.count()).toBe(0);
  });
});
