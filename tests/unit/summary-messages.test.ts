import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { setBookmarkSummary, getMeta } from "../../src/db/meta";
import { handleSummarizeMessage } from "../../src/messages/summaries";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { saveProviderKey } from "../../src/security/keys";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import type { PageExtract } from "../../src/extract/page";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const LLM_ORIGIN = "https://api.openai.com";
const JEV_ORIGIN = "https://api.typesafe.ai";
const BOOKMARK_ID = "bm-001";
const PAGE_URL = "https://a-site.com/article?utm=track";
const EXTENSION_PAGE = "chrome-extension://test-id/sidepanel.html";
const TRUSTED = { url: EXTENSION_PAGE };

const PAGE_EXTRACT: PageExtract = {
  url: "https://a-site.com/article",
  title: "An article",
  excerpt: "The article explains the new caching layer in detail.",
  headings: ["Caching layer"],
};

let server: ReturnType<typeof makeOpenAiServer>;
let tabsGet: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;

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
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  });
}

function installChromeStub(bookmarks: unknown) {
  const store: Record<string, unknown> = {};
  tabsGet = vi.fn(async () => ({
    id: 42,
    url: PAGE_URL,
    incognito: false,
  }));
  executeScript = vi.fn(async () => [
    {
      result: {
        title: PAGE_EXTRACT.title,
        excerpt: PAGE_EXTRACT.excerpt,
        headings: PAGE_EXTRACT.headings,
      },
    },
  ]);
  vi.stubGlobal("chrome", {
    bookmarks,
    tabs: { get: tabsGet },
    scripting: { executeScript },
    runtime: { getURL: (p: string) => `chrome-extension://test-id/${p}` },
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

async function seedProvider() {
  const record: LlmProviderRecord = {
    providerId: PROVIDER_ID,
    provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
    keySuffix: "1234",
    configuredAt: "2026-09-15T00:00:00.000Z",
  };
  await saveLlmProvider(record);
  await saveCredential(PROVIDER_ID, "sk-test-1234");
  // The Jev gate requires a stored typesafe key on every send.
  await saveProviderKey("typesafe", "jev-test-key-1234");
}

/**
 * Inject the test transport by monkey-patching the orchestrator's client
 * creation — the handler builds its own `createJevClient`, so the seam is
 * on `SummarizeInput.jevTransport` which the handler does NOT expose on the
 * wire; instead tests stub the Jev preset via the transport-free path and
 * the mock fetch (the mock openai server answers `fetch`). For Jev we use
 * the injected fetch: `sendConsented` goes through global `fetch`, so the
 * OpenAI stub is swapped for a Jev-shaped responder when the URL is the
 * typesafe preset — handled by a combined fetch below.
 */
function combinedFetch(jevAnswer: "supported" | "unsupported" | "uncertain") {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.typesafe.ai")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const answers = Object.fromEntries(
        Object.entries(body.questions ?? {}).map(([key, question]) => {
          const q = question as { type: string; criteria?: object };
          if (q.type !== "choice") return [key, { type: "noul", noul: 0.9 }];
          const options = Object.keys(q.criteria ?? {});
          const rest = Math.max(1, options.length - 1);
          return [
            key,
            {
              type: "choice",
              choice: jevAnswer,
              probabilities: Object.fromEntries(
                options.map((k) => [k, k === jevAnswer ? 0.8 : 0.2 / rest]),
              ),
              confidence: 0.8,
            },
          ];
        }),
      );
      return new Response(
        JSON.stringify({
          model: body.model ?? "jev-latest",
          answers,
          usage: { input_tokens: 30, output_tokens: 4, cost: 0.0001 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return server.fetch(input as never, init as never) as Promise<Response>;
  };
}

beforeEach(async () => {
  const bookmarks = installBookmarksFake({
    bookmarksBar: [{ id: BOOKMARK_ID, title: "An article", url: PAGE_URL }],
  });
  installChromeStub(bookmarks);
  server = makeOpenAiServer({
    completion: completionWith({ summary: "A page about a caching layer." }),
  });
  vi.stubGlobal("fetch", combinedFetch("supported"));
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("handleSummarizeMessage", () => {
  it("rejects untrusted senders", async () => {
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: 1, bookmarkId: BOOKMARK_ID },
      { url: "https://evil.example.com/page" },
    );
    expect(reply).toMatchObject({ ok: false, code: "untrusted_sender" });
  });

  it("rejects malformed messages", async () => {
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: "not-a-number" },
      TRUSTED,
    );
    expect(reply).toMatchObject({ ok: false, code: "malformed_message" });
  });

  it("returns undefined for unowned message types", async () => {
    const reply = await handleSummarizeMessage(
      { type: "LLM_EXPLAIN", decisionId: "x" },
      TRUSTED,
    );
    expect(reply).toBeUndefined();
  });

  it("answers no_provider when no LLM is configured", async () => {
    await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
    await grantConsentAtOrigin("jev_summary_verify", JEV_ORIGIN);
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID },
      TRUSTED,
    );
    expect(reply).toMatchObject({ ok: false, code: "no_provider" });
  });

  it("answers no_consent before touching the network", async () => {
    await seedProvider();
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID },
      TRUSTED,
    );
    expect(reply).toMatchObject({ ok: false, code: "no_consent" });
    expect(server.requests).toHaveLength(0);
  });

  it("runs the pipeline and returns the stored summary", async () => {
    await seedProvider();
    await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
    await grantConsentAtOrigin("jev_summary_verify", JEV_ORIGIN);
    const reply = await handleSummarizeMessage(
      {
        type: "LLM_SUMMARIZE",
        tabId: 42,
        bookmarkId: BOOKMARK_ID,
        unknownCostConfirmed: true,
      },
      TRUSTED,
    );
    expect(reply).toMatchObject({
      ok: true,
      code: "summary_ok",
      summary: "A page about a caching layer.",
    });
    const meta = await getMeta(BOOKMARK_ID);
    expect(meta?.summary).toBe("A page about a caching layer.");
  });

  it("asks for confirmation and names the destination on unpriced providers", async () => {
    await seedProvider();
    await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
    await grantConsentAtOrigin("jev_summary_verify", JEV_ORIGIN);
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID },
      TRUSTED,
    );
    expect(reply).toMatchObject({
      ok: false,
      code: "confirmation_required",
      destinationOrigin: LLM_ORIGIN,
      stage: "summarize",
    });
  });

  it("LLM_SUMMARY_READ returns the persisted summary only", async () => {
    await setBookmarkSummary(BOOKMARK_ID, "Stored summary.");
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARY_READ", bookmarkId: BOOKMARK_ID },
      TRUSTED,
    );
    expect(reply).toMatchObject({
      ok: true,
      code: "summary_read",
      summary: "Stored summary.",
    });
  });

  it("LLM_SUMMARY_READ reports no summary without a stored one", async () => {
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARY_READ", bookmarkId: BOOKMARK_ID },
      TRUSTED,
    );
    expect(reply).toMatchObject({ ok: true, code: "summary_read" });
    expect(reply).not.toHaveProperty("summary");
  });
});
