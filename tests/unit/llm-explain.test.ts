import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { getDecision, persistDecision } from "../../src/decisions/store";
import { explainDecision, ExplainError } from "../../src/llm/explain";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { Decision } from "../../src/schemas/decision";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { installBookmarksFake, type FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const UUID = "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a";
const UUID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

let server: ReturnType<typeof makeOpenAiServer>;
let bookmarksApi: FakeBookmarksApi;

function completionWith(payload: Record<string, unknown>) {
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
    usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
  });
}

function installChromeStub(bookmarks: unknown) {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    bookmarks,
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
}

function decision(over: Record<string, unknown> = {}) {
  return Decision.parse({
    ...decisionBase,
    kind: "set_category",
    category: "article",
    probabilities: { article: 0.62, news: 0.38 },
    ...over,
  });
}

async function seedEnabledProvider(consent = true, model = "gpt-4o-mini") {
  const record: LlmProviderRecord = {
    providerId: PROVIDER_ID,
    provider: { kind: "preset", preset: "openai", model },
    keySuffix: "1234",
    configuredAt: "2026-09-15T00:00:00.000Z",
  };
  await saveLlmProvider(record);
  await saveCredential(PROVIDER_ID, "sk-test-1234");
  if (consent) await grantConsentAtOrigin("llm_explain", ORIGIN);
}

beforeEach(async () => {
  bookmarksApi = installBookmarksFake({
    bookmarksBar: [
      { id: "bm-001", title: "A", url: "https://a-site.com/?q=secret" },
      { id: "bm-002", title: "B", url: "https://b-site.org/" },
    ],
  });
  installChromeStub(bookmarksApi);
  server = makeOpenAiServer({
    completion: completionWith({ rationale: "Jev ranked 'article' highest." }),
  });
  vi.stubGlobal("fetch", server.fetch);
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("explainDecision", () => {
  it.each([
    ["429", "blocklist"], ["transport", "blocklist"],
    ["429", "live URL"], ["transport", "live URL"],
  ] as const)(
    "refuses an internal %s retry after a changed %s without losing prior exposure",
    async (failure, change) => {
      await seedEnabledProvider();
      await persistDecision(decision({ bookmarkIds: ["bm-001", "bm-002"] }));
      await db.metadata.put({ key: "decisions:blocklist", value: ["blocked-site.dev"] });
      server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
        completion: completionWith({ rationale: "Retry rationale." }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        try {
          return await server.fetch(...args);
        } finally {
          if (change === "blocklist") {
            await db.metadata.put({ key: "decisions:blocklist", value: ["b-site.org"] });
          } else {
            await bookmarksApi.update("bm-002", { url: "https://blocked-site.dev/" });
          }
        }
      });
      await expect(explainDecision(UUID, PROVIDER_ID)).rejects.toMatchObject({ code: "stale" });
      expect(server.requests).toHaveLength(1);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();
      const reservations = await db.llmReservations.toArray();
      expect(reservations).toHaveLength(1);
      expect(reservations[0]?.status).toBe("settled");
      const usage = await db.llmUsage.toArray();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        inputTokens: 8_192, outputTokens: 1_024,
        estimatedCostUsd: expect.closeTo(0.0018432, 10),
      });
    },
  );

  it.each(["429", "transport"] as const)(
    "keeps the internal %s retry when feature admission remains allowed",
    async (failure) => {
      await seedEnabledProvider();
      await persistDecision(decision());
      server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
        completion: completionWith({ rationale: "Allowed retry." }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        try {
          return await server.fetch(...args);
        } finally {
          await db.metadata.put({ key: "decisions:blocklist", value: ["unrelated-site.dev"] });
        }
      });
      expect((await explainDecision(UUID, PROVIDER_ID)).rationale).toBe("Allowed retry.");
      expect(server.requests).toHaveLength(2);
      expect((await getDecision(UUID))?.rationale).toBe("Allowed retry.");
    },
  );

  it.each(["https://a-site.com/", "https://docs.a-site.com/"])(
    "refuses a persisted blocked explanation for %s without egress",
    async (url) => {
      await seedEnabledProvider();
      await bookmarksApi.update("bm-001", { url });
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      await persistDecision(decision({ bookmarkIds: ["bm-001"] }));
      const error = await explainDecision(UUID, PROVIDER_ID).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ExplainError);
      expect(error).toMatchObject({ code: "stale" });
      expect(String(error)).not.toContain("a-site.com");
      expect(server.requests).toHaveLength(0);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();
      expect(await db.llmUsage.count()).toBe(0);
    },
  );

  it("refuses the whole multi-bookmark explanation when only one reference is blocked", async () => {
    await seedEnabledProvider();
    await db.metadata.put({ key: "decisions:blocklist", value: ["b-site.org"] });
    await persistDecision(decision({ bookmarkIds: ["bm-001", "bm-002"] }));
    await expect(explainDecision(UUID, PROVIDER_ID)).rejects.toMatchObject({
      code: "stale",
    });
    expect(server.requests).toHaveLength(0);
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it("does not turn an unreadable blocked reference into a partial explanation", async () => {
    await seedEnabledProvider();
    await db.metadata.put({ key: "decisions:blocklist", value: ["b-site.org"] });
    await persistDecision(decision({ bookmarkIds: ["bm-001", "bm-002"] }));
    const get = bookmarksApi.get.bind(bookmarksApi);
    bookmarksApi.get = async (id) => {
      if (id === "bm-002") throw new Error("native_read_private_marker");
      return get(id);
    };
    const error = await explainDecision(UUID, PROVIDER_ID).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "stale" });
    expect(String(error)).not.toContain("native_read_private_marker");
    expect(server.requests).toHaveLength(0);
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it("allows look-alike suffixes without treating them as blocked subdomains", async () => {
    await seedEnabledProvider();
    await bookmarksApi.update("bm-001", { url: "https://not-a-site.com/" });
    await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
    await persistDecision(decision({ bookmarkIds: ["bm-001"] }));
    expect((await explainDecision(UUID, PROVIDER_ID)).rationale).toBe(
      "Jev ranked 'article' highest.",
    );
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(server.requests[0]!.body)).toContain("not-a-site.com");
  });

  it.each(["fallback", "repair"] as const)(
    "rereads the blocklist before an explanation %s send",
    async (hop) => {
      await seedEnabledProvider();
      await persistDecision(decision({ bookmarkIds: ["bm-001", "bm-002"] }));
      server = makeOpenAiServer({
        ...(hop === "fallback"
          ? { failures: [{ status: 400, body: { error: "response_format unsupported" } }] }
          : {}),
        completion: completionWith({ rationale: "" }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await server.fetch(...args);
        await db.metadata.put({ key: "decisions:blocklist", value: ["b-site.org"] });
        return response;
      });
      await expect(explainDecision(UUID, PROVIDER_ID)).rejects.toMatchObject({
        code: "stale",
      });
      expect(server.requests).toHaveLength(1);
      expect(await db.llmUsage.count()).toBe(1);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();
    },
  );

  it("rereads a referenced bookmark's live URL before explanation fallback", async () => {
    await seedEnabledProvider();
    await persistDecision(decision({ bookmarkIds: ["bm-001", "bm-002"] }));
    await db.metadata.put({ key: "decisions:blocklist", value: ["blocked-site.dev"] });
    server = makeOpenAiServer({
      failures: [{ status: 400, body: { error: "response_format unsupported" } }],
      completion: completionWith({ rationale: "Fallback rationale." }),
    });
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await server.fetch(...args);
      await bookmarksApi.update("bm-002", { url: "https://blocked-site.dev/" });
      return response;
    });
    await expect(explainDecision(UUID, PROVIDER_ID)).rejects.toMatchObject({
      code: "stale",
    });
    expect(server.requests).toHaveLength(1);
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it("refuses a newly blocked captured URL even when its live bookmark moved to an allowed host", async () => {
    await seedEnabledProvider();
    await persistDecision(decision({ bookmarkIds: ["bm-001"] }));
    server = makeOpenAiServer({
      failures: [{ status: 400, body: { error: "response_format unsupported" } }],
      completion: completionWith({ rationale: "Fallback rationale." }),
    });
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await server.fetch(...args);
      await bookmarksApi.update("bm-001", { url: "https://allowed-site.dev/" });
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      return response;
    });
    await expect(explainDecision(UUID, PROVIDER_ID)).rejects.toMatchObject({
      code: "stale",
    });
    expect(server.requests).toHaveLength(1);
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it.each(["fallback", "repair"] as const)(
    "allows an explanation %s when a changed blocklist does not affect its references",
    async (hop) => {
      await seedEnabledProvider();
      await persistDecision(decision());
      server = makeOpenAiServer({
        ...(hop === "fallback"
          ? { failures: [{ status: 400, body: { error: "response_format unsupported" } }] }
          : {}),
        completion: (body) => completionWith({
          rationale: hop === "repair" && server.requests.length === 1
            ? ""
            : "Still allowed.",
        })(body),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await server.fetch(...args);
        await db.metadata.put({ key: "decisions:blocklist", value: ["unrelated-site.dev"] });
        return response;
      });
      expect((await explainDecision(UUID, PROVIDER_ID)).rationale).toBe("Still allowed.");
      expect(server.requests).toHaveLength(2);
      expect((await getDecision(UUID))?.rationale).toBe("Still allowed.");
    },
  );

  it("sends only the minimized explain payload — no ids, notes, or raw URLs", async () => {
    await seedEnabledProvider();
    await persistDecision(decision());
    const result = await explainDecision(UUID, PROVIDER_ID, {
      unknownCostConfirmed: true,
    });
    expect(result.rationale).toBe("Jev ranked 'article' highest.");
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0]!.body as {
      messages: { role: string; content: string }[];
    };
    const user = body.messages.find((m) => m.role === "user");
    const payload = JSON.parse(user!.content) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "answer",
      "bookmarks",
      "candidates",
      "probabilities",
      "question",
    ]);
    const bookmarks = payload.bookmarks as Record<string, unknown>[];
    expect(Object.keys(bookmarks[0]!).sort()).toEqual([
      "domain",
      "title",
      "url",
    ]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("bm-001");
    expect(raw).not.toContain("?q=secret");
    expect(raw).not.toContain("sk-test-1234");
  });

  it("persists the rationale without touching status, audit, or undo", async () => {
    await seedEnabledProvider();
    await persistDecision(decision());
    const result = await explainDecision(UUID, PROVIDER_ID, {
      unknownCostConfirmed: true,
    });
    expect(result.model).toBe("gpt-4o-mini");
    const row = await getDecision(UUID);
    expect(row?.rationale).toBe("Jev ranked 'article' highest.");
    expect(row?.status).toBe("pending");
    expect(await db.audit.toArray()).toEqual([]);
    expect(await db.undo.toArray()).toEqual([]);
    // The settled usage row is the only egress accounting written.
    expect(await db.llmUsage.count()).toBe(1);
  });

  it("rejects a rationale over the 1,000-character cap", async () => {
    server = makeOpenAiServer({
      completion: completionWith({ rationale: "x".repeat(1_001) }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedEnabledProvider();
    await persistDecision(decision());
    await expect(
      explainDecision(UUID, PROVIDER_ID, { unknownCostConfirmed: true }),
    ).rejects.toThrow();
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it("rejects a response with unexpected keys", async () => {
    server = makeOpenAiServer({
      completion: completionWith({ rationale: "ok", extra: "field" }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedEnabledProvider();
    await persistDecision(decision());
    await expect(
      explainDecision(UUID, PROVIDER_ID, { unknownCostConfirmed: true }),
    ).rejects.toThrow();
    expect((await getDecision(UUID))?.rationale).toBeUndefined();
  });

  it("rejects a missing decision without sending anything", async () => {
    await seedEnabledProvider();
    await expect(
      explainDecision(UUID, PROVIDER_ID, { unknownCostConfirmed: true }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(server.requests).toHaveLength(0);
  });

  it("rejects a decision whose bookmarks are all gone without sending", async () => {
    await seedEnabledProvider();
    await persistDecision(decision({ id: UUID, bookmarkIds: ["gone-id"] }));
    await expect(
      explainDecision(UUID, PROVIDER_ID, { unknownCostConfirmed: true }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(server.requests).toHaveLength(0);
  });

  it("rejects a decision that is not pending", async () => {
    await seedEnabledProvider();
    await persistDecision(decision({ status: "applied" }));
    await expect(
      explainDecision(UUID, PROVIDER_ID, { unknownCostConfirmed: true }),
    ).rejects.toMatchObject({ code: "not_pending" });
    expect(server.requests).toHaveLength(0);
  });

  it("requires llm_explain consent — no request without it", async () => {
    await seedEnabledProvider(false);
    await persistDecision(decision());
    await expect(
      explainDecision(UUID, PROVIDER_ID, { unknownCostConfirmed: true }),
    ).rejects.toMatchObject({ code: "no_consent" });
    expect(server.requests).toHaveLength(0);
  });

  it("requires a one-shot unknown-cost confirmation when pricing is absent", async () => {
    // An unlisted preset model has no built-in price, so the manual request
    // must stop at the unknown-cost confirmation.
    await seedEnabledProvider(true, "gpt-4o-mini-2024-07-18");
    await persistDecision(decision());
    await expect(explainDecision(UUID, PROVIDER_ID)).rejects.toMatchObject({
      code: "confirmation_required",
    });
    expect(server.requests).toHaveLength(0);
  });

  it("explains a priced preset model without any confirmation", async () => {
    await seedEnabledProvider();
    await persistDecision(decision());
    const result = await explainDecision(UUID, PROVIDER_ID);
    expect(result).toMatchObject({ rationale: expect.any(String) });
    expect(server.requests).toHaveLength(1);
  });

  it("redacts provider failures — no credential or body content leaks", async () => {
    server = makeOpenAiServer({
      failures: [
        { status: 401, body: { error: "invalid key sk-live-SECRET999" } },
      ],
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedEnabledProvider();
    await persistDecision(decision());
    const error = (await explainDecision(UUID, PROVIDER_ID, {
      unknownCostConfirmed: true,
    }).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("sk-live-SECRET999");
    expect(error.message).not.toContain("invalid key");
  });

  it("throws ExplainError (typed) for store-level refusals", async () => {
    await expect(
      explainDecision(UUID2, PROVIDER_ID),
    ).rejects.toBeInstanceOf(ExplainError);
  });
});
