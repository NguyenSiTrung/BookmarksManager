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
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const UUID = "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a";
const UUID2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

let server: ReturnType<typeof makeOpenAiServer>;

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
  const bookmarks = installBookmarksFake({
    bookmarksBar: [
      { id: "bm-001", title: "A", url: "https://a-site.com/?q=secret" },
      { id: "bm-002", title: "B", url: "https://b-site.org/" },
    ],
  });
  installChromeStub(bookmarks);
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
