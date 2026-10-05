import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  DecisionPipelineError,
  analyzeBookmark,
} from "../../src/decisions/pipeline";
import type { AnalyzeBookmarkOptions } from "../../src/decisions/pipeline";
import { DecisionSettings } from "../../src/decisions/policy";
import { resetJevClientPools } from "../../src/jev/client";
import type { JevTransport } from "../../src/jev/client";
import type { TagDef } from "../../src/schemas/meta";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { startMockJevServer } from "../mock-servers/jev";
import { grantConsentAtOrigin } from "../../src/consent/records";
import {
  writeLlmEscalationSettings,
} from "../../src/llm/escalate";
import { enqueueJob } from "../../src/jobs/queue";
import { persistDecision } from "../../src/decisions/store";
import type { DecisionRow } from "../../src/decisions/store";
import { Decision } from "../../src/schemas/decision";
import { decisionBase } from "../fixtures/base-records";
import { saveLlmProvider } from "../../src/llm/settings";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { makeOpenAiServer } from "../mock-servers/openai";
import type { MockJevServer } from "../mock-servers/jev";

/**
 * Analyze pipeline (spec FR2–FR6, PROJECT_PLAN.md §6.2/§9.1/§10.2): one
 * bookmark is minimized, the candidate shortlists are computed in code, the
 * question sets are built and sent as ONE `jev_decisions` request, every
 * answer ID is cross-checked against the candidates actually sent, the §10.2
 * policy is applied, and the resulting `Decision` rows plus a `usage` row are
 * persisted. Blocklisted bookmarks make no request; auto-apply happens only
 * with the kind's toggle on; failures are typed and redacted.
 *
 * Seeded tree:
 * ```
 * 0 root
 * └─ 1 Bookmarks bar
 *    └─ f-dev  Dev
 *       └─ bm-1  Tokio async tutorial   https://tokio.rs/tokio/tutorial/async
 * ```
 */

const NOW = "2026-09-27T10:00:00.000Z";
const BOOKMARK_TITLE = "Tokio tutorial: async in depth";
const BOOKMARK_URL = "https://tokio.rs/tokio/tutorial/async";
const SECRET_NOTE = "SECRET NOTE that must never leave the device";

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

const corpus = {
  bookmarks: [{ id: "bm-1", url: BOOKMARK_URL }],
  metas: [],
};

let server: MockJevServer;
let scopeSeen: string[];
let tree: FlattenedTree;
let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  resetJevClientPools();
  scopeSeen = [];
  server = await startMockJevServer();
  fake = installBookmarksFake({
    bookmarksBar: [
      {
        id: "f-dev",
        title: "Dev",
        children: [{ id: "bm-1", title: BOOKMARK_TITLE, url: BOOKMARK_URL }],
      },
      { id: "f-work", title: "Work" },
    ],
  });
  tree = flattenTree(await fake.getTree());
  await db.decisions.clear();
  await db.audit.clear();
  await db.usage.clear();
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();
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
  over: Partial<AnalyzeBookmarkOptions> = {},
): AnalyzeBookmarkOptions {
  return {
    bookmark: {
      id: "bm-1",
      title: BOOKMARK_TITLE,
      url: BOOKMARK_URL,
      parentId: "f-dev",
      notes: SECRET_NOTE,
    },
    context: { tagDefs, corpus, tree },
    providerId: "typesafe",
    model: "jev-latest",
    transport: serverTransport(),
    ...over,
  };
}

/** Body of the one request the mock server received, JSON-parsed. */
function firstRequest(): {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  model: string;
} {
  const received = server.requests[0];
  if (received === undefined) throw new Error("no request was sent");
  return received.json as never;
}

const HIGH_CONFIDENCE = {
  category: {
    type: "choice" as const,
    choice: "docs",
    probabilities: { docs: 0.9, other: 0.1 },
    confidence: 0.9,
  },
  tag_rust: { type: "noul" as const, noul: 0.97 },
  tag_async: { type: "noul" as const, noul: 0.97 },
};

describe("analyzeBookmark", () => {
  it("minimizes, sends one jev_decisions request, and persists decisions + usage", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0" });

    const result = await analyzeBookmark(options());

    expect(result.sent).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(scopeSeen).toEqual(["jev_decisions"]);

    const body = firstRequest();
    expect(body.state.bookmark).toEqual({
      title: BOOKMARK_TITLE,
      url: BOOKMARK_URL,
      domain: "tokio.rs",
    });
    expect(
      (body.state.candidateTags as { name: string }[])
        .map((t) => t.name)
        .sort(),
    ).toEqual(["async", "rust"]);
    expect(body.state.notes).toBeUndefined();
    expect(server.requests[0]?.rawBody).not.toContain(SECRET_NOTE);
    expect(Object.keys(body.questions)).toEqual(
      expect.arrayContaining(["category", "tag_rust", "tag_async"]),
    );

    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(2);
    const category = decisions.find((d) => d.kind === "set_category");
    const tags = decisions.find((d) => d.kind === "add_tags");
    if (category?.kind !== "set_category" || tags?.kind !== "add_tags") {
      throw new Error("expected set_category and add_tags decisions");
    }
    expect(category.category).toBe("article");
    expect(category.status).toBe("pending");
    expect(tags.tags.sort()).toEqual(["async", "rust"]);
    expect(tags.status).toBe("pending");

    // source.model comes from the RESPONSE, source.questionSetVersion from the task.
    for (const row of decisions) {
      expect(row.source).toEqual({
        engine: "jev",
        providerId: "typesafe",
        model: "jev-1.13.0",
        questionSetVersion:
          row.kind === "set_category" ? "categorize-v2" : "tags-v1",
      });
      expect(row.bookmarkIds).toEqual(["bm-1"]);
    }

    const usage = await db.usage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe("jev-1.13.0");
    expect(usage[0]?.inputTokens).toBeGreaterThan(0);
    expect(usage[0]?.recordedAt).toBeTruthy();
  });

  it("skips blocklisted bookmarks and makes no request", async () => {
    const result = await analyzeBookmark(
      options({
        bookmark: {
          id: "bm-1",
          title: "Inbox",
          url: "https://mail.google.com/mail/u/0",
          parentId: "f-dev",
        },
      }),
    );

    expect(result).toEqual({ sent: false, reason: "blocklisted" });
    expect(server.requests).toHaveLength(0);
    expect(await db.decisions.count()).toBe(0);
    expect(await db.usage.count()).toBe(0);
  });

  it("skips a USER-blocklisted bookmark and makes no request", async () => {
    // `tokio.rs` is not built-in sensitive; it is only blocked because the
    // caller passed it in the user blocklist.
    const result = await analyzeBookmark(
      options({ userBlocklist: ["tokio.rs"] }),
    );

    expect(result).toEqual({ sent: false, reason: "blocklisted" });
    expect(server.requests).toHaveLength(0);
    expect(await db.decisions.count()).toBe(0);
    expect(await db.usage.count()).toBe(0);
  });

  it("auto-applies only when the kind's toggle is on", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0", answerOverrides: HIGH_CONFIDENCE });
    const settings = DecisionSettings.parse({
      autoApply: { add_tags: true, set_category: true },
    });

    const result = await analyzeBookmark(
      options({ context: { tagDefs, corpus, tree, settings } }),
    );

    expect(result.sent).toBe(true);
    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.status === "auto_applied")).toBe(true);

    // The guarded apply path ran: meta rows and audit rows exist.
    const meta = await db.bookmarkMeta.get("bm-1");
    expect(meta?.category).toBe("docs");
    expect(meta?.tags.sort()).toEqual(["async", "rust"]);
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.actor === "policy")).toBe(true);
    // Auto-apply is `pending → auto_applied`, not the user-approval `applied`.
    expect(audit.every((a) => a.to === "auto_applied")).toBe(true);
  });

  it("captures the freshness guard from the sent snapshot (J05)", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0" });

    await analyzeBookmark(options());

    const rows = (await db.decisions.toArray()) as DecisionRow[];
    for (const row of rows) {
      // The RAW values the request was built from — not a later live read,
      // and not the minimized wire form.
      expect(row.guard?.placements).toEqual({ "bm-1": "f-dev" });
      expect(row.guard?.snapshots).toEqual({
        "bm-1": { url: BOOKMARK_URL, title: BOOKMARK_TITLE },
      });
    }
  });

  it("persists one decision per (job, bookmark, kind) under replay (J04)", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0" });
    server.queue({ kind: "answer", model: "jev-1.13.0" });

    const first = await analyzeBookmark(options());
    const second = await analyzeBookmark(options());

    expect(first.sent && second.sent).toBe(true);
    // Interactive re-analysis lands on the same deterministic ids — two
    // rows, not four.
    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(2);
    const firstIds = (first.sent ? first.decisions : []).map((d) => d.id).sort();
    const secondIds = (second.sent ? second.decisions : []).map((d) => d.id).sort();
    expect(secondIds).toEqual(firstIds);
  });

  it("a job's replayed batch yields one row per (jobId, bookmarkId, kind)", async () => {
    await db.jobs.clear();
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      batchSize: 1,
    });
    const owner = { id: job.id, ownerGeneration: job.ownerGeneration ?? 0 };
    server.queue({ kind: "answer", model: "jev-1.13.0" });
    server.queue({ kind: "answer", model: "jev-1.13.0" });

    const first = await analyzeBookmark(options({ job: owner }));
    const second = await analyzeBookmark(options({ job: owner }));

    expect(await db.decisions.count()).toBe(2);
    if (first.sent && second.sent) {
      expect(second.decisions.map((d) => d.id).sort()).toEqual(
        first.decisions.map((d) => d.id).sort(),
      );
    }
  });

  it("a replay cannot auto-apply over a decided same-slot row (J04)", async () => {
    // The resurrect sequence: job A's pending row was superseded (deleted)
    // by a later analysis whose proposal the user then APPLIED. When job
    // A's batch replays, its deterministic id lands a fresh pending row —
    // and must stay pending instead of overwriting the applied decision.
    const DECIDED = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a";
    await persistDecision(
      Decision.parse({
        ...decisionBase,
        id: DECIDED,
        kind: "set_category",
        category: "docs",
        bookmarkIds: ["bm-1"],
        status: "applied",
      }),
    );
    server.queue({ kind: "answer", model: "jev-1.13.0", answerOverrides: HIGH_CONFIDENCE });
    const settings = DecisionSettings.parse({
      autoApply: { add_tags: true, set_category: true },
    });

    const result = await analyzeBookmark(
      options({ context: { tagDefs, corpus, tree, settings } }),
    );

    expect(result.sent).toBe(true);
    // The resurrected row is parked pending; the decided row is untouched
    // and nothing was re-applied over it.
    const rows = await db.decisions.toArray();
    const setCategory = rows.filter((d) => d.kind === "set_category");
    expect(setCategory).toHaveLength(2);
    expect((await db.decisions.get(DECIDED))?.status).toBe("applied");
    expect(
      setCategory.filter((d) => d.status === "pending"),
    ).toHaveLength(1);
    // The unfenced add_tags draft still auto-applied — exactly one audit
    // row, and it belongs to add_tags, never the resurrected proposal.
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(1);
    const tagsRow = rows.find((d) => d.kind === "add_tags");
    expect(tagsRow?.status).toBe("auto_applied");
    expect(audit[0]?.decisionId).toBe(tagsRow?.id);
    const meta = await db.bookmarkMeta.get("bm-1");
    expect(meta?.category).toBeUndefined(); // set_category apply was fenced
    expect(meta?.tags.sort()).toEqual(["async", "rust"]);
  });

  it("a mid-scan edit is `stale` on auto-apply — skipped, never applied (J05)", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0", answerOverrides: HIGH_CONFIDENCE });
    const settings = DecisionSettings.parse({
      autoApply: { add_tags: true, set_category: true },
    });
    // The bookmark changes AFTER the request is built (the sent snapshot)
    // but before the guarded apply runs.
    const transport: JevTransport = async (scope, preset, model, request, opts) => {
      await fake.update("bm-1", { title: "Edited mid-scan" });
      return serverTransport()(scope, preset, model, request, opts);
    };

    const error = await analyzeBookmark(
      options({
        context: { tagDefs, corpus, tree, settings },
        transport,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("stale");
    // The item is skipped: its row was persisted but never applied.
    const rows = await db.decisions.toArray();
    expect(rows.every((d) => d.status === "pending")).toBe(true);
    expect(await db.bookmarkMeta.count()).toBe(0);
    expect(await db.undo.count()).toBe(0);
    expect(await db.usage.count()).toBe(1); // egress still accounted
  });

  it("a mid-scan delete is `stale`/`bookmark_gone` on auto-apply (J05)", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0", answerOverrides: HIGH_CONFIDENCE });
    const settings = DecisionSettings.parse({
      autoApply: { add_tags: true, set_category: true },
    });
    const transport: JevTransport = async (scope, preset, model, request, opts) => {
      const response = await serverTransport()(scope, preset, model, request, opts);
      await fake.remove("bm-1");
      return response;
    };

    const error = await analyzeBookmark(
      options({
        context: { tagDefs, corpus, tree, settings },
        transport,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("stale");
    expect((await db.decisions.toArray()).every((d) => d.status === "pending"))
      .toBe(true);
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("records the usage row even when persisting a decision fails", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0" });
    const putSpy = vi
      .spyOn(db.decisions, "put")
      .mockRejectedValue(new Error("write failed"));

    const error = await analyzeBookmark(options()).catch(
      (caught: unknown) => caught,
    );
    putSpy.mockRestore();

    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("persist_failed");
    // The request left the device, so its cost is still accounted for.
    expect(await db.usage.count()).toBe(1);
  });

  it("records the usage row even when auto-applying a decision fails", async () => {
    server.queue({ kind: "answer", model: "jev-1.13.0", answerOverrides: HIGH_CONFIDENCE });
    const settings = DecisionSettings.parse({
      autoApply: { add_tags: true, set_category: true },
    });
    const auditSpy = vi
      .spyOn(db.audit, "add")
      .mockRejectedValue(new Error("audit write failed"));

    const error = await analyzeBookmark(
      options({ context: { tagDefs, corpus, tree, settings } }),
    ).catch((caught: unknown) => caught);
    auditSpy.mockRestore();

    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("apply_failed");
    // The request left the device, so its cost is still accounted for.
    expect(await db.usage.count()).toBe(1);
  });

  it("leaves decisions pending and mutates nothing when toggles are off", async () => {
    server.queue({ kind: "answer", answerOverrides: HIGH_CONFIDENCE });

    const result = await analyzeBookmark(options());

    expect(result.sent).toBe(true);
    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.status === "pending")).toBe(true);
    expect(await db.bookmarkMeta.count()).toBe(0);
    expect(await db.audit.count()).toBe(0);
  });

  it("rejects an answer ID that was not among the sent candidates (usage still recorded)", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        folder: {
          type: "choice",
          choice: "9999",
          probabilities: {},
          confidence: 0.9,
        },
      },
    });

    const error = await analyzeBookmark(options({ checks: ["placement"] })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("answer_mismatch");
    expect(await db.decisions.count()).toBe(0);
    // The mismatched answers still egressed — the request's cost is recorded.
    expect(await db.usage.count()).toBe(1);
  });

  it("persists a pending move for a placement suggestion (never auto-applied)", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        folder: {
          type: "choice",
          choice: "f-dev",
          probabilities: { "f-dev": 0.8, none: 0.2 },
          confidence: 0.8,
        },
      },
    });

    await analyzeBookmark(options({ checks: ["placement"] }));

    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(1);
    const move = decisions[0];
    if (move?.kind !== "move") throw new Error("expected a move decision");
    expect(move.targetFolderId).toBe("f-dev");
    expect(move.status).toBe("pending");
    expect(await db.bookmarkMeta.count()).toBe(0);
    expect(await db.audit.count()).toBe(0);
  });

  it("skips the tags check when there are no tag candidates", async () => {
    server.queue({ kind: "answer" });

    await analyzeBookmark(options({ context: { tagDefs: [], corpus, tree } }));

    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("set_category");
  });

  it("persists a review move for a misfiled suggestion, none when it picks the current folder", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        folder: {
          type: "choice",
          choice: "f-work",
          probabilities: { "f-work": 0.8, "f-dev": 0.2 },
          confidence: 0.8,
        },
      },
    });

    await analyzeBookmark(options({ checks: ["misfiled"] }));

    const decisions = await db.decisions.toArray();
    expect(decisions).toHaveLength(1);
    const move = decisions[0];
    if (move?.kind !== "move") throw new Error("expected a move decision");
    expect(move.targetFolderId).toBe("f-work");
    expect(move.status).toBe("pending");
    // The current folder path was sent as `folderPath`.
    expect(firstRequest().state.folderPath).toEqual(["Bookmarks bar", "Dev"]);
  });

  it("makes no move decision when the misfiled scan keeps the current folder", async () => {
    server.queue({
      kind: "answer",
      answerOverrides: {
        folder: {
          type: "choice",
          choice: "f-dev",
          probabilities: { "f-dev": 0.9, none: 0.1 },
          confidence: 0.9,
        },
      },
    });

    await analyzeBookmark(options({ checks: ["misfiled"] }));

    expect(await db.decisions.count()).toBe(0);
  });

  it("treats an out-of-range answer confidence as unsure, never a throw (J07)", async () => {
    // The wire bounds `confidence` as a bare number — a contract-violating
    // provider can send 1.4. The policy demotes it to `unsure` and the row
    // clamps the unusable value to 0 rather than failing the analysis.
    server.queue({
      kind: "answer",
      answers: {
        category: {
          type: "choice",
          choice: "docs",
          probabilities: { docs: 0.9, other: 0.1 },
          confidence: 1.4,
        },
      },
    });

    const result = await analyzeBookmark(options({ checks: ["categorize"] }));

    if (!result.sent) throw new Error("expected sent");
    expect(result.decisions).toHaveLength(1);
    const row = result.decisions[0];
    expect(row?.kind).toBe("set_category");
    expect(row?.status).toBe("unsure");
    expect(row?.confidence).toBe(0);
    // The persisted row carries the same clamped value.
    expect((await db.decisions.get(row!.id))?.confidence).toBe(0);
  });

  it("surfaces provider failures typed and without content", async () => {
    server.queue({ kind: "status", status: 401 });

    const error = await analyzeBookmark(options()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("auth");
    const message = (error as Error).message;
    expect(message).not.toContain(BOOKMARK_TITLE);
    expect(message).not.toContain(SECRET_NOTE);
    expect(message).not.toContain(BOOKMARK_URL);
    expect(await db.decisions.count()).toBe(0);
  });

  it("rejects running placement and misfiled together", async () => {
    const error = await analyzeBookmark(
      options({ checks: ["placement", "misfiled"] }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("invalid_input");
    expect(server.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Automatic second opinions (spec FR6): a low-confidence draft may be
// escalated to the configured LLM provider — only inside this user-started
// analysis, only with the feature enabled, a monthly budget, consent and
// permission, and always landing back in the review queue (never auto-apply).
// ---------------------------------------------------------------------------

const LLM_ORIGIN = "https://llm.example.com";
const LLM_PROVIDER_ID = "custom:https://llm.example.com/v1";

const LOW_CONFIDENCE = {
  category: {
    type: "choice" as const,
    choice: "docs",
    probabilities: { docs: 0.35, other: 0.3 },
    confidence: 0.3,
  },
};

function llmCompletion(payload: Record<string, unknown>) {
  return (body: { model: string }) => ({
    id: "chatcmpl-x",
    object: "chat.completion",
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(payload) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  });
}

describe("low-confidence escalation", () => {
  let llmServer: ReturnType<typeof makeOpenAiServer>;
  let realFetch: typeof fetch;

  async function seedEscalation(opts: { enabled?: boolean; consent?: boolean } = {}) {
    const { enabled = true, consent = true } = opts;
    // The bookmarks fake owns the chrome global from the outer beforeEach —
    // compose the LLM surface onto it.
    const store: Record<string, unknown> = {};
    vi.stubGlobal("chrome", {
      bookmarks: fake,
      storage: {
        local: {
          async get(keys?: string | string[] | null) {
            const wanted =
              keys === undefined || keys === null
                ? Object.keys(store)
                : Array.isArray(keys)
                  ? keys
                  : [keys];
            const out: Record<string, unknown> = {};
            for (const k of wanted) {
              if (k in store) out[k] = store[k];
            }
            return out;
          },
          async set(items: Record<string, unknown>) {
            Object.assign(store, items);
          },
          async remove(keys: string | string[]) {
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              delete store[k];
            }
          },
        },
      },
      permissions: { contains: async () => true },
    });
    realFetch = globalThis.fetch;
    llmServer = makeOpenAiServer({
      completion: llmCompletion({ verdict: "agree", rationale: "Looks right." }),
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(LLM_ORIGIN)
        ? llmServer.fetch(input, init)
        : realFetch(input, init),
    );
    const record: LlmProviderRecord = {
      providerId: LLM_PROVIDER_ID,
      provider: {
        kind: "custom",
        baseUrl: "https://llm.example.com/v1",
        model: "m",
        auth: "none",
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      },
      configuredAt: "2026-09-15T00:00:00.000Z",
      monthlyBudgetUsd: 5,
    };
    await db.metadata.clear();
    await db.llmUsage.clear();
    await db.llmReservations.clear();
    await saveLlmProvider(record);
    if (consent) await grantConsentAtOrigin("llm_escalate", LLM_ORIGIN);
    await writeLlmEscalationSettings({ enabled, providerId: LLM_PROVIDER_ID });
  }

  function lowConfidenceOptions() {
    server.queue({
      kind: "answer",
      answers: { category: LOW_CONFIDENCE.category },
    });
    return options({ checks: ["categorize"] });
  }

  it("persists an agree verdict, model, and rationale on the unsure decision", async () => {
    await seedEscalation();
    const result = await analyzeBookmark(lowConfidenceOptions());
    if (!result.sent) throw new Error("expected sent");
    const row = result.decisions[0];
    expect(row?.status).toBe("unsure");
    expect(row?.escalation).toEqual({
      llmVerdict: "agree",
      llmModel: "m",
    });
    expect(row?.rationale).toBe("Looks right.");
    expect(llmServer.requests).toHaveLength(1);
    // The escalated call is the one usage row recorded.
    expect(await db.llmUsage.count()).toBe(1);
  });

  it("persists a disagree verdict with the allowed alternative", async () => {
    await seedEscalation();
    llmServer = makeOpenAiServer({
      completion: llmCompletion({
        verdict: "disagree",
        alternative: "other",
        rationale: "Not docs.",
      }),
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(LLM_ORIGIN)
        ? llmServer.fetch(input, init)
        : realFetch(input, init),
    );
    const result = await analyzeBookmark(lowConfidenceOptions());
    if (!result.sent) throw new Error("expected sent");
    const row = result.decisions[0];
    expect(row?.escalation).toEqual({
      llmVerdict: "disagree",
      llmModel: "m",
      llmAlternative: "other",
    });
    // Still review-only: escalation never applies anything.
    expect(row?.status).toBe("unsure");
  });

  it("rejects an invented alternative and leaves the decision unexplained", async () => {
    await seedEscalation();
    llmServer = makeOpenAiServer({
      completion: llmCompletion({
        verdict: "disagree",
        alternative: "not-a-real-category",
        rationale: "invented",
      }),
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(LLM_ORIGIN)
        ? llmServer.fetch(input, init)
        : realFetch(input, init),
    );
    const result = await analyzeBookmark(lowConfidenceOptions());
    if (!result.sent) throw new Error("expected sent");
    const row = result.decisions[0];
    expect(row?.status).toBe("unsure");
    expect(row?.escalation).toBeUndefined();
    expect(row?.rationale).toBeUndefined();
  });

  it("a failed escalation still lands the decision in the review queue", async () => {
    await seedEscalation();
    llmServer = makeOpenAiServer({
      failures: [{ status: 500 }],
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith(LLM_ORIGIN)
        ? llmServer.fetch(input, init)
        : realFetch(input, init),
    );
    const result = await analyzeBookmark(lowConfidenceOptions());
    if (!result.sent) throw new Error("expected sent");
    const row = result.decisions[0];
    expect(row?.status).toBe("unsure");
    expect(row?.escalation).toBeUndefined();
  });

  it("does not escalate at all when the feature is off", async () => {
    await seedEscalation({ enabled: false });
    const result = await analyzeBookmark(lowConfidenceOptions());
    if (!result.sent) throw new Error("expected sent");
    expect(result.decisions[0]?.status).toBe("unsure");
    expect(result.decisions[0]?.escalation).toBeUndefined();
    expect(llmServer.requests).toHaveLength(0);
  });

  it("never escalates a decision at or above the review floor", async () => {
    await seedEscalation();
    server.queue({
      kind: "answer",
      answers: { category: HIGH_CONFIDENCE.category },
    });
    const result = await analyzeBookmark(options({ checks: ["categorize"] }));
    if (!result.sent) throw new Error("expected sent");
    expect(result.decisions[0]?.status).toBe("pending");
    expect(result.decisions[0]?.escalation).toBeUndefined();
    expect(llmServer.requests).toHaveLength(0);
  });

  it("marks the row escalationSkipped:'budget' when the cap refuses the second opinion (J08)", async () => {
    await seedEscalation();
    // Reprice the cap below any reservation estimate — the gate refuses
    // `budget_exceeded`, which the row must surface rather than swallow.
    await saveLlmProvider({
      providerId: LLM_PROVIDER_ID,
      provider: {
        kind: "custom",
        baseUrl: "https://llm.example.com/v1",
        model: "m",
        auth: "none",
        pricing: { inputPerMillion: 1, outputPerMillion: 2 },
      },
      configuredAt: "2026-09-15T00:00:00.000Z",
      monthlyBudgetUsd: 0.0000001,
    });

    const result = await analyzeBookmark(lowConfidenceOptions());
    if (!result.sent) throw new Error("expected sent");
    const row = result.decisions[0];
    expect(row?.status).toBe("unsure");
    expect(row?.escalationSkipped).toBe("budget");
    expect(row?.escalation).toBeUndefined();
    expect(llmServer.requests).toHaveLength(0);
    // The sidecar persists on the row the review UI reads.
    const stored = (await db.decisions.get(row!.id)) as DecisionRow | undefined;
    expect(stored?.escalationSkipped).toBe("budget");
  });

  it("a job superseded mid-flow stops the escalation and aborts illegal_transition (J08)", async () => {
    await seedEscalation();
    await db.jobs.clear();
    const job = await enqueueJob({
      kind: "analyze_selection",
      bookmarkIds: ["bm-1"],
      batchSize: 1,
    });
    const owner = { id: job.id, ownerGeneration: job.ownerGeneration ?? 0 };
    // Valid at the Jev send's authority check; superseded by the time the
    // escalation's own beforeSend re-checks — the only two reads of
    // db.jobs.get in this flow are the two assertJobAuthority calls.
    const realGet = db.jobs.get.bind(db.jobs);
    let calls = 0;
    vi.spyOn(db.jobs, "get").mockImplementation(((id: string) =>
      calls++ === 0
        ? realGet(id)
        : Promise.resolve({
            ...job,
            ownerGeneration: owner.ownerGeneration + 1,
          })) as never);

    server.queue({
      kind: "answer",
      answers: { category: LOW_CONFIDENCE.category },
    });
    const error = await analyzeBookmark(
      options({ checks: ["categorize"], job: owner }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecisionPipelineError);
    expect((error as DecisionPipelineError).code).toBe("illegal_transition");
    // No second opinion, no decision row, no reservation left behind.
    expect(llmServer.requests).toHaveLength(0);
    expect(await db.decisions.count()).toBe(0);
  });
});
