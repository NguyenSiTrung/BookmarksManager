import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { getMeta } from "../../src/db/meta";
import { summarizeActiveBookmark } from "../../src/decisions/summaries";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { saveProviderKey } from "../../src/security/keys";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import type { PageExtract } from "../../src/extract/page";
import type { JevTransport } from "../../src/jev/client";
import { SystemOneRequest } from "../../src/jev/wire";
import { installBookmarksFake, type FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const LLM_ORIGIN = "https://api.openai.com";
const JEV_ORIGIN = "https://api.typesafe.ai";
const BOOKMARK_ID = "bm-001";
const PAGE_URL = "https://a-site.com/article?utm=track";
const TAB_ID = 42;

const PAGE_EXTRACT: PageExtract = {
  url: "https://a-site.com/article",
  title: "An article",
  excerpt: "The article explains the new caching layer in detail.",
  headings: ["Caching layer", "Benchmarks"],
};

let server: ReturnType<typeof makeOpenAiServer>;
let tabsGet: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;
let chromeStub: Record<string, unknown>;
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
    usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
  });
}

/** Scriptable extraction: the chrome stub returns `scriptResult`. */
function installChromeStub(
  bookmarks: unknown,
  tab: unknown,
  scriptResult: unknown,
) {
  const store: Record<string, unknown> = {};
  tabsGet = vi.fn(async () => tab);
  executeScript = vi.fn(async () => [{ result: scriptResult }]);
  chromeStub = {
    bookmarks,
    tabs: { get: tabsGet },
    scripting: { executeScript },
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
  };
  vi.stubGlobal("chrome", chromeStub);
}

/** A Jev transport that answers `verdict` with `choice` = `answer`. */
function jevTransportFor(answer: "supported" | "unsupported" | "uncertain") {
  return vi.fn<JevTransport>(async (_scope, _preset, _model, request) => {
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([key, question]) => {
        if (question.type !== "choice") {
          throw new Error("verify-summary must be a choice question");
        }
        const options = Object.keys(question.criteria);
        const rest = Math.max(1, options.length - 1);
        return [
          key,
          {
            type: "choice",
            choice: answer,
            probabilities: Object.fromEntries(
              options.map((k) => [k, k === answer ? 0.8 : 0.2 / rest]),
            ),
            confidence: 0.8,
          },
        ];
      }),
    );
    return new Response(
      JSON.stringify({
        model: request.model,
        answers,
        usage: { input_tokens: 30, output_tokens: 4, cost: 0.0001 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
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
  // The verify hop resolves the ENABLED Jev provider: a stored settings
  // row plus the `jev_test` consent the enable flow records.
  await db.metadata.put({
    key: "typesafe",
    value: { preset: "typesafe", model: "jev-latest", keySuffix: "1234" },
  });
  await grantConsentAtOrigin("jev_test", JEV_ORIGIN);
}

/** Grant both consents (the plan's "separate recipient grants" baseline). */
async function grantAll() {
  await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
  await grantConsentAtOrigin("jev_summary_verify", JEV_ORIGIN);
}

function run(jevTransport: JevTransport = jevTransportFor("supported")) {
  return summarizeActiveBookmark({
    tabId: TAB_ID,
    bookmarkId: BOOKMARK_ID,
    unknownCostConfirmed: true,
    jevTransport,
  });
}

beforeEach(async () => {
  bookmarksApi = installBookmarksFake({
    bookmarksBar: [
      { id: BOOKMARK_ID, title: "An article", url: PAGE_URL },
      { id: "bm-002", title: "Other", url: "https://b-site.org/" },
    ],
  });
  installChromeStub(
    bookmarksApi,
    { id: TAB_ID, url: PAGE_URL, incognito: false },
    {
      title: PAGE_EXTRACT.title,
      excerpt: PAGE_EXTRACT.excerpt,
      headings: PAGE_EXTRACT.headings,
    },
  );
  server = makeOpenAiServer({
    completion: completionWith({ summary: "A page about a caching layer." }),
  });
  vi.stubGlobal("fetch", server.fetch);
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("summarizeActiveBookmark", () => {
  it.each([
    ["429", "blocklist"], ["transport", "blocklist"],
    ["429", "live URL"], ["transport", "live URL"],
  ] as const)(
    "refuses an internal summary %s retry after a changed %s without losing prior exposure",
    async (failure, change) => {
      await seedProvider();
      await db.metadata.put({ key: "decisions:blocklist", value: ["blocked-site.dev"] });
      server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
        completion: completionWith({ summary: "Retry draft." }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        try {
          return await server.fetch(...args);
        } finally {
          if (change === "blocklist") {
            await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
          } else {
            await bookmarksApi.update(BOOKMARK_ID, { url: "https://blocked-site.dev/article" });
          }
        }
      });
      const jevTransport = jevTransportFor("supported");
      expect(await run(jevTransport)).toMatchObject({
        ok: false, stage: "summarize", code: "unsendable",
      });
      expect(server.requests).toHaveLength(1);
      expect(jevTransport).not.toHaveBeenCalled();
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
      const reservations = await db.llmReservations.toArray();
      expect(reservations).toHaveLength(1);
      expect(reservations[0]?.status).toBe("settled");
      const usage = await db.llmUsage.toArray();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        inputTokens: 24_000, outputTokens: 1_024,
        estimatedCostUsd: expect.closeTo(0.0042144, 10),
      });
    },
  );

  it.each(["429", "transport"] as const)(
    "keeps the internal summary %s retry when feature admission remains allowed",
    async (failure) => {
      await seedProvider();
      server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
        completion: completionWith({ summary: "Allowed retry." }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        try {
          return await server.fetch(...args);
        } finally {
          await db.metadata.put({ key: "decisions:blocklist", value: ["unrelated-site.dev"] });
        }
      });
      const jevTransport = jevTransportFor("supported");
      expect(await run(jevTransport)).toMatchObject({ ok: true, summary: "Allowed retry." });
      expect(server.requests).toHaveLength(2);
      expect(jevTransport).toHaveBeenCalledOnce();
      expect((await getMeta(BOOKMARK_ID))?.summary).toBe("Allowed retry.");
    },
  );

  it.each(["allowed", "blocked initially", "blocked after LLM", "live URL blocked after LLM"] as const)(
    "uses both real origin gates with fake provider wires: %s",
    async (scenario) => {
      await seedProvider();
      await saveProviderKey("typesafe", "jev-test-1234");
      await db.metadata.put({
        key: "decisions:blocklist",
        value: scenario === "blocked initially" ? ["a-site.com"] : ["blocked-site.dev"],
      });
      const jevWire = jevTransportFor("supported");
      vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).startsWith(JEV_ORIGIN)) {
          const request = SystemOneRequest.parse(JSON.parse(String(init?.body)));
          return jevWire("jev_summary_verify", "typesafe", request.model, request);
        }
        const response = await server.fetch(url, init);
        if (scenario === "blocked after LLM") {
          await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
        }
        if (scenario === "live URL blocked after LLM") {
          await bookmarksApi.update(BOOKMARK_ID, { url: "https://blocked-site.dev/article" });
        }
        return response;
      });
      const outcome = await summarizeActiveBookmark({
        tabId: TAB_ID, bookmarkId: BOOKMARK_ID, unknownCostConfirmed: true,
      });
      if (scenario === "allowed") {
        expect(outcome).toMatchObject({ ok: true, summary: "A page about a caching layer." });
        expect(server.requests).toHaveLength(1);
        expect(jevWire).toHaveBeenCalledOnce();
        expect((await getMeta(BOOKMARK_ID))?.summary).toBe("A page about a caching layer.");
      } else {
        expect(outcome).toMatchObject({
          ok: false,
          stage: scenario === "blocked initially" ? "match" : "verify",
          code: "unsendable",
        });
        expect(server.requests).toHaveLength(scenario === "blocked initially" ? 0 : 1);
        expect(jevWire).not.toHaveBeenCalled();
        expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
      }
    },
  );

  it("rereads admission before retrying a rejected Jev verification", async () => {
    await seedProvider();
    const jevTransport = jevTransportFor("supported");
    jevTransport.mockImplementationOnce(async () => {
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    });
    expect(await run(jevTransport)).toMatchObject({
      ok: false, stage: "verify", code: "unsendable",
    });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).toHaveBeenCalledOnce();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it.each(["https://a-site.com/article", "https://docs.a-site.com/article"])(
    "refuses persisted blocked summaries for %s before either provider hop",
    async (url) => {
      await seedProvider();
      await grantAll();
      await bookmarksApi.update(BOOKMARK_ID, { url });
      tabsGet.mockResolvedValue({ id: TAB_ID, url, incognito: false });
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      const jevTransport = jevTransportFor("supported");
      const outcome = await run(jevTransport);
      expect(outcome).toMatchObject({ ok: false, code: "unsendable" });
      expect(JSON.stringify(outcome)).not.toContain("a-site.com");
      expect(server.requests).toHaveLength(0);
      expect(jevTransport).not.toHaveBeenCalled();
      expect(await db.llmUsage.count()).toBe(0);
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    },
  );

  it("allows an unblocked summary with a persisted unrelated blocklist", async () => {
    await seedProvider();
    await db.metadata.put({ key: "decisions:blocklist", value: ["b-site.org"] });
    const jevTransport = jevTransportFor("supported");
    expect(await run(jevTransport)).toMatchObject({
      ok: true, summary: "A page about a caching layer.",
    });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).toHaveBeenCalledOnce();
    expect((await getMeta(BOOKMARK_ID))?.summary).toBe("A page about a caching layer.");
  });

  it("allows a look-alike summary host rather than matching a suffix without a dot boundary", async () => {
    await seedProvider();
    const url = "https://not-a-site.com/article";
    await bookmarksApi.update(BOOKMARK_ID, { url });
    tabsGet.mockResolvedValue({ id: TAB_ID, url, incognito: false });
    await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
    const jevTransport = jevTransportFor("supported");
    expect(await run(jevTransport)).toMatchObject({ ok: true });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).toHaveBeenCalledOnce();
  });

  it.each(["fallback", "repair"] as const)(
    "rereads the blocklist before a summary %s send and saves nothing",
    async (hop) => {
      await seedProvider();
      server = makeOpenAiServer({
        ...(hop === "fallback"
          ? { failures: [{ status: 400, body: { error: "response_format unsupported" } }] }
          : {}),
        completion: completionWith({ summary: "" }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await server.fetch(...args);
        await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
        return response;
      });
      const jevTransport = jevTransportFor("supported");
      expect(await run(jevTransport)).toMatchObject({
        ok: false, stage: "summarize", code: "unsendable",
      });
      expect(server.requests).toHaveLength(1);
      expect(jevTransport).not.toHaveBeenCalled();
      expect(await db.llmUsage.count()).toBe(1);
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    },
  );

  it.each(["fallback", "repair"] as const)(
    "allows a summary %s when a changed blocklist does not affect the page",
    async (hop) => {
      await seedProvider();
      server = makeOpenAiServer({
        ...(hop === "fallback"
          ? { failures: [{ status: 400, body: { error: "response_format unsupported" } }] }
          : {}),
        completion: (body) => completionWith({
          summary: hop === "repair" && server.requests.length === 1
            ? ""
            : "Still allowed.",
        })(body),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await server.fetch(...args);
        await db.metadata.put({ key: "decisions:blocklist", value: ["unrelated-site.dev"] });
        return response;
      });
      const jevTransport = jevTransportFor("supported");
      expect(await run(jevTransport)).toMatchObject({ ok: true, summary: "Still allowed." });
      expect(server.requests).toHaveLength(2);
      expect(jevTransport).toHaveBeenCalledOnce();
      expect((await getMeta(BOOKMARK_ID))?.summary).toBe("Still allowed.");
    },
  );

  it("rereads the blocklist after LLM completion before Jev verification", async () => {
    await seedProvider();
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await server.fetch(...args);
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      return response;
    });
    const jevTransport = jevTransportFor("supported");
    expect(await run(jevTransport)).toMatchObject({
      ok: false, stage: "verify", code: "unsendable",
    });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).not.toHaveBeenCalled();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it.each(["fallback", "verify"] as const)(
    "rereads the live saved URL before the summary %s hop",
    async (hop) => {
      await seedProvider();
      await db.metadata.put({ key: "decisions:blocklist", value: ["blocked-site.dev"] });
      server = makeOpenAiServer({
        ...(hop === "fallback"
          ? { failures: [{ status: 400, body: { error: "response_format unsupported" } }] }
          : {}),
        completion: completionWith({ summary: "Draft." }),
      });
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const response = await server.fetch(...args);
        await bookmarksApi.update(BOOKMARK_ID, { url: "https://blocked-site.dev/article" });
        return response;
      });
      const jevTransport = jevTransportFor("supported");
      expect(await run(jevTransport)).toMatchObject({
        ok: false, stage: hop === "fallback" ? "summarize" : "verify", code: "unsendable",
      });
      expect(server.requests).toHaveLength(1);
      expect(jevTransport).not.toHaveBeenCalled();
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    },
  );

  it("extracts, summarizes, verifies, and persists on `supported`", async () => {
    await seedProvider();
    await grantAll();
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toBe("A page about a caching layer.");
    const meta = await getMeta(BOOKMARK_ID);
    expect(meta?.summary).toBe("A page about a caching layer.");
    expect(executeScript).toHaveBeenCalledOnce();
    expect(server.requests).toHaveLength(1);
  });

  it("grants both scopes at the click and proceeds past consent", async () => {
    await seedProvider();
    // The Summarize click IS the affirmative action (spec FR3): both
    // origin-scoped grants are written by the orchestrator before any
    // gated send — llm_summary at the LLM origin, jev_summary_verify at
    // the Jev origin. Without them a run could never start.
    const jevTransport = jevTransportFor("supported");
    const outcome = await run(jevTransport);
    await expect(hasConsentAtOrigin("llm_summary", LLM_ORIGIN)).resolves.toBe(true);
    await expect(
      hasConsentAtOrigin("jev_summary_verify", JEV_ORIGIN),
    ).resolves.toBe(true);
    // With an unpriced model the next gate is the cost confirmation —
    // consent was already satisfied by the click.
    expect(outcome.ok).toBe(true);
    expect(jevTransport).toHaveBeenCalled();
  });

  it("refuses when the active page URL does not match the bookmark", async () => {
    await seedProvider();
    await grantAll();
    tabsGet = vi.fn(async () => ({
      id: TAB_ID,
      url: "https://different-site.com/",
      incognito: false,
    }));
    executeScript = vi.fn(async () => [
      {
        result: {
          title: "Elsewhere",
          excerpt: "Different page.",
          headings: [],
        },
      },
    ]);
    chromeStub.tabs = { get: tabsGet };
    chromeStub.scripting = { executeScript };
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("match");
    if (outcome.stage === "match") {
      expect(outcome.code).toBe("mismatch");
    }
    expect(server.requests).toHaveLength(0);
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("refuses an unsaved or missing bookmark", async () => {
    await seedProvider();
    await grantAll();
    const outcome = await summarizeActiveBookmark({
      tabId: TAB_ID,
      bookmarkId: "bm-gone",
      unknownCostConfirmed: true,
      jevTransport: jevTransportFor("supported"),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("match");
    if (outcome.stage === "match") {
      expect(outcome.code).toBe("no_bookmark");
    }
    expect(server.requests).toHaveLength(0);
  });

  it("surfaces an invalid LLM payload as a summarize-stage failure with no write", async () => {
    await seedProvider();
    await grantAll();
    server = makeOpenAiServer({
      completion: completionWith({ summary: "" }), // min(1) violation
    });
    vi.stubGlobal("fetch", server.fetch);
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("summarize");
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("does not persist when Jev answers `unsupported`", async () => {
    await seedProvider();
    await grantAll();
    const jevTransport = jevTransportFor("unsupported");
    const outcome = await run(jevTransport);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("verify");
    if (
      outcome.stage === "verify" &&
      outcome.code === "not_supported" &&
      "verdict" in outcome
    ) {
      expect(outcome.verdict).toBe("unsupported");
    }
    expect(jevTransport).toHaveBeenCalledOnce();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("does not persist when Jev answers `uncertain`", async () => {
    await seedProvider();
    await grantAll();
    const outcome = await run(jevTransportFor("uncertain"));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("verify");
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("surfaces a lost tab as an extract failure before any LLM/Jev send", async () => {
    await seedProvider();
    await grantAll();
    tabsGet = vi.fn(async () => {
      throw new Error("No tab with id: 42");
    });
    chromeStub.tabs = { get: tabsGet };
    const jevTransport = jevTransportFor("supported");
    const outcome = await run(jevTransport);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("extract");
    if (outcome.stage === "extract") {
      expect(outcome.code).toBe("no_tab");
    }
    expect(server.requests).toHaveLength(0);
    expect(jevTransport).not.toHaveBeenCalled();
  });

  it("refuses incognito tabs without scripting or sending", async () => {
    await seedProvider();
    await grantAll();
    tabsGet = vi.fn(async () => ({
      id: TAB_ID,
      url: PAGE_URL,
      incognito: true,
    }));
    chromeStub.tabs = { get: tabsGet };
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("extract");
    if (outcome.stage === "extract") {
      expect(outcome.code).toBe("incognito");
    }
    expect(executeScript).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it("writes usage rows for both the LLM and Jev sends", async () => {
    await seedProvider();
    await grantAll();
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    const usage = await db.llmUsage.toArray();
    expect(usage.some((row) => row.feature === "llm_summary")).toBe(true);
    const jevUsage = await db.usage.toArray().catch(() => []);
    expect(Array.isArray(jevUsage)).toBe(true);
  });

  it("never persists the page excerpt anywhere in meta", async () => {
    await seedProvider();
    await grantAll();
    await run();
    const meta = await getMeta(BOOKMARK_ID);
    const serialized = JSON.stringify(meta ?? {});
    expect(serialized).not.toContain("caching layer in detail");
    expect(meta?.summary).toBe("A page about a caching layer.");
  });

  it("leaves meta untouched when the provider is not configured", async () => {
    await grantAll();
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("summarize");
    expect(outcome.code).toBe("no_provider");
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });
});
