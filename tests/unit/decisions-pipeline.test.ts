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
import { startMockJevServer } from "../mock-servers/jev";
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

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  resetJevClientPools();
  scopeSeen = [];
  server = await startMockJevServer();
  const fake = installBookmarksFake({
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
    preset: "typesafe",
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
          row.kind === "set_category" ? "categorize-v1" : "tags-v1",
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
    expect(decisions.every((d) => d.status === "applied")).toBe(true);

    // The guarded apply path ran: meta rows and audit rows exist.
    const meta = await db.bookmarkMeta.get("bm-1");
    expect(meta?.category).toBe("docs");
    expect(meta?.tags.sort()).toEqual(["async", "rust"]);
    const audit = await db.audit.toArray();
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.actor === "policy")).toBe(true);
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

  it("rejects an answer ID that was not among the sent candidates", async () => {
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
    expect(await db.usage.count()).toBe(0);
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
