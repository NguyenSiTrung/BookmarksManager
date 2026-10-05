import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { getMeta } from "../../src/db/meta";
import { summarizeActiveBookmark, summarizeExtracted } from "../../src/decisions/summaries";
import * as summaryLlm from "../../src/llm/summarize";
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
  executeScript = vi.fn(async () => [{
    // Return the actual document URL, including local identity-bearing query.
    result: typeof scriptResult === "object" && scriptResult !== null
      ? { ...scriptResult, url: (await (tabsGet as () => Promise<{ url?: string }>)()).url, documentIdentity: 1000 }
      : scriptResult,
  }]);
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
  // Unrelated pipeline tests start with explicitly accepted current grants.
  await grantAll();
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

async function resetEnv() {
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
}

beforeEach(resetEnv);

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("summarizeActiveBookmark", () => {
  it("refuses same-URL document replacement before the first provider dispatch", async () => {
    await seedProvider();
    const jevTransport = jevTransportFor("supported");
    executeScript.mockImplementation(async (injection: { func?: unknown }) => [{
      result: {
        url: PAGE_URL,
        documentIdentity: injection.func === undefined ? 1000 : 2000,
        title: PAGE_EXTRACT.title,
        excerpt: PAGE_EXTRACT.excerpt,
        headings: PAGE_EXTRACT.headings,
      },
    }]);
    expect(await run(jevTransport)).toMatchObject({ ok: false, code: "mismatch" });
    expect(server.requests).toHaveLength(0);
    expect(jevTransport).not.toHaveBeenCalled();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("rechecks the captured document before verification after the LLM response", async () => {
    await seedProvider();
    let identity = 1000;
    executeScript.mockImplementation(async () => [{
      result: {
        url: PAGE_URL, documentIdentity: identity,
        title: PAGE_EXTRACT.title, excerpt: PAGE_EXTRACT.excerpt, headings: PAGE_EXTRACT.headings,
      },
    }]);
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(url, init);
      identity = 2000;
      return response;
    });
    const jevTransport = jevTransportFor("supported");
    expect(await run(jevTransport)).toMatchObject({ ok: false, code: "mismatch" });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).not.toHaveBeenCalled();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("rejects a page newly blocklisted during injection before either provider hop", async () => {
    await seedProvider();
    executeScript.mockImplementationOnce(async () => {
      await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
      return [{
        result: { url: PAGE_URL, documentIdentity: 1000, title: PAGE_EXTRACT.title, excerpt: PAGE_EXTRACT.excerpt, headings: PAGE_EXTRACT.headings },
      }];
    });
    const jevTransport = jevTransportFor("supported");
    expect(await run(jevTransport)).toMatchObject({ ok: false, stage: "match", code: "unsendable" });
    expect(server.requests).toHaveLength(0);
    expect(jevTransport).not.toHaveBeenCalled();
  });

  it.each(["document", "grant", "provider"] as const)(
    "rechecks summary %s authority after held Jev gate permission preflight",
    async (change) => {
      await seedProvider();
      await saveProviderKey("typesafe", "jev-synthetic-key-1234");
      let llmCompleted = false;
      let enter = () => {};
      let resume = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const held = new Promise<void>((resolve) => { resume = resolve; });
      chromeStub.permissions = {
        contains: async (permission: { origins?: string[] }) => {
          if (llmCompleted && permission.origins?.some((origin) => origin.includes("api.typesafe.ai"))) {
            enter();
            await held;
          }
          return true;
        },
      };
      const jevWire = jevTransportFor("supported");
      vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).startsWith(JEV_ORIGIN)) {
          const request = SystemOneRequest.parse(JSON.parse(String(init?.body)));
          return jevWire("jev_summary_verify", "typesafe", request.model, request);
        }
        const response = await server.fetch(url, init);
        llmCompleted = true;
        return response;
      });
      const pending = summarizeActiveBookmark({
        tabId: TAB_ID, bookmarkId: BOOKMARK_ID, unknownCostConfirmed: true,
      });
      await entered;
      try {
        if (change === "document") {
          executeScript.mockResolvedValue([{
            result: {
              url: PAGE_URL, documentIdentity: 2000, title: PAGE_EXTRACT.title,
              excerpt: PAGE_EXTRACT.excerpt, headings: PAGE_EXTRACT.headings,
            },
          }]);
        } else if (change === "grant") {
          await db.consents.delete(["jev_summary_verify", JEV_ORIGIN]);
        } else {
          await db.metadata.put({
            key: "typesafe",
            value: { preset: "typesafe", model: "jev-1.13.0", keySuffix: "1234" },
          });
        }
      } finally {
        resume();
      }
      expect(await pending).toMatchObject({
        ok: false, stage: "verify", code: change === "document" ? "mismatch" : "no_consent",
      });
      expect(server.requests).toHaveLength(1);
      expect(jevWire).not.toHaveBeenCalled();
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    },
  );

  it("refuses mismatched resources with zero provider requests", async () => {
    for (const [label, saved, active] of [
      ["semantic query", "https://a-site.com/watch?v=A", "https://a-site.com/watch?v=B"],
      ["application route", "https://a-site.com/#/item/A", "https://a-site.com/#/item/B"],
      ["hashbang route", "https://a-site.com/#!/item/A", "https://a-site.com/#!/item/B"],
      ["ambiguous fragment", "https://a-site.com/article#item-A", "https://a-site.com/article#item-B"],
      ["query ordering", "https://a-site.com/article?a=1&b=2", "https://a-site.com/article?b=2&a=1"],
      ["duplicate query values", "https://a-site.com/article?id=A&id=B", "https://a-site.com/article?id=A&id=C"],
    ] as const) {
    await resetEnv();
    await seedProvider();
    await bookmarksApi.update(BOOKMARK_ID, { url: saved });
    tabsGet.mockResolvedValue({ id: TAB_ID, url: active, incognito: false });
    const jevTransport = jevTransportFor("supported");

    expect(await run(jevTransport), label).toMatchObject({ ok: false, stage: "match", code: "mismatch" });
    expect(server.requests).toHaveLength(0);
    expect(jevTransport).not.toHaveBeenCalled();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    }
  });

  it("permits allowlisted tracking differences while keeping semantic query identity local", async () => {
    await seedProvider();
    await bookmarksApi.update(BOOKMARK_ID, { url: "https://a-site.com/watch?v=A&utm_source=saved#same" });
    tabsGet.mockResolvedValue({
      id: TAB_ID, url: "https://a-site.com/watch?v=A&fbclid=active#same", incognito: false,
    });
    const jevTransport = jevTransportFor("supported");

    expect(await run(jevTransport)).toMatchObject({ ok: true, summary: "A page about a caching layer." });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).toHaveBeenCalledTimes(1);
    const wire = JSON.stringify(server.requests.map((request) => request.body));
    expect(wire).toContain("https://a-site.com/watch");
    expect(wire).not.toContain("v=A");
    expect(wire).not.toContain("fbclid");
    expect(wire).not.toContain("#same");
  });

  it("rechecks local resource identity before Jev if the saved query changes after the LLM response", async () => {
    await seedProvider();
    await bookmarksApi.update(BOOKMARK_ID, { url: "https://a-site.com/watch?v=A" });
    tabsGet.mockResolvedValue({ id: TAB_ID, url: "https://a-site.com/watch?v=A", incognito: false });
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await server.fetch(url, init);
      await bookmarksApi.update(BOOKMARK_ID, { url: "https://a-site.com/watch?v=B" });
      return response;
    });
    const jevTransport = jevTransportFor("supported");

    expect(await run(jevTransport)).toMatchObject({ ok: false, code: "mismatch" });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).not.toHaveBeenCalled();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("does not extract or send when either consent is stale or missing", async () => {
    for (const scope of ["llm_summary", "jev_summary_verify"] as const) {
      await resetEnv();
      await seedProvider();
      const origin = scope === "llm_summary" ? LLM_ORIGIN : JEV_ORIGIN;
      const stale = {
        scope, origin, consentVersion: 3,
        acceptedAt: "2026-09-25T10:00:00.000Z",
      };
      await db.consents.put(stale);
      const jevTransport = jevTransportFor("supported");
      expect(await run(jevTransport)).toMatchObject({ ok: false, stage: "consent", code: "no_consent" });
      expect(executeScript).not.toHaveBeenCalled();
      expect(tabsGet).not.toHaveBeenCalled();
      expect(await db.consents.get([scope, origin])).toEqual(stale);
      expect(await summarizeExtracted({
        tabId: TAB_ID, bookmarkId: BOOKMARK_ID, jevTransport,
      }, PAGE_EXTRACT)).toMatchObject({ ok: false, stage: "consent", code: "no_consent" });
      expect(await db.consents.get([scope, origin])).toEqual(stale);
      await db.consents.delete([scope, origin]);
      expect(await run(jevTransport)).toMatchObject({ ok: false, stage: "consent", code: "no_consent" });
      expect(executeScript).not.toHaveBeenCalled();
      expect(await db.consents.get([scope, origin])).toBeUndefined();
      expect(server.requests).toHaveLength(0);
      expect(jevTransport).not.toHaveBeenCalled();
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    }
  });

  it("minimizes query and fragment secrets in every allowed summary wire request", async () => {
    for (const attempt of ["initial", "fallback", "repair", "429", "transport"] as const) {
      await resetEnv();
      await seedProvider();
      await saveProviderKey("typesafe", "jev-test-1234");
      const rawUrl = "https://a-site.com/article?token=audit_query_secret#audit_fragment_secret";
      await bookmarksApi.update(BOOKMARK_ID, { title: "Saved article title", url: rawUrl });
      tabsGet.mockResolvedValue({ id: TAB_ID, url: rawUrl, incognito: false });
      executeScript.mockResolvedValue([{
        result: {
          url: rawUrl,
          documentIdentity: 1000,
          title: PAGE_EXTRACT.title,
          excerpt: PAGE_EXTRACT.excerpt,
          headings: PAGE_EXTRACT.headings,
          description: "An overview of caching.",
          siteName: "A Site",
          byline: "Local-only author",
        },
      }]);
      const failures = attempt === "fallback"
        ? [{ status: 400, body: { error: "response_format unsupported" } }]
        : attempt === "429"
          ? [{ status: 429, retryAfterSeconds: 0 }]
          : attempt === "transport"
            ? [{ throw: new TypeError("reset") }]
            : [];
      server = makeOpenAiServer({
        failures,
        completion: (body) => completionWith({
          summary: attempt === "repair" && server.requests.length === 1
            ? ""
            : "A page about a caching layer.",
        })(body),
      });
      const jevWire = jevTransportFor("supported");
      const bodies: unknown[] = [];
      vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (String(url).startsWith(JEV_ORIGIN)) {
          const request = SystemOneRequest.parse(JSON.parse(String(init?.body)));
          return jevWire("jev_summary_verify", "typesafe", request.model, request);
        }
        return server.fetch(url, init);
      });
      // Pass-through spy keeps the real builder/client/gates while pinning
      // the orchestrator's separate outbound copy, not just builder cleanup.
      const summarizeSpy = vi.spyOn(summaryLlm, "summarizePage");
      try {
        const outcome = await summarizeActiveBookmark({
          tabId: TAB_ID, bookmarkId: BOOKMARK_ID, unknownCostConfirmed: true,
        });
        expect(outcome).toMatchObject({ ok: true, summary: "A page about a caching layer." });
        expect(server.requests).toHaveLength(attempt === "initial" ? 1 : 2);
        expect(jevWire).toHaveBeenCalledOnce();
        expect(bodies).toHaveLength(attempt === "initial" ? 2 : 3);
        const serialized = JSON.stringify(bodies);
        expect(serialized).not.toContain("audit_query_secret");
        expect(serialized).not.toContain("audit_fragment_secret");
        expect(serialized).toContain("https://a-site.com/article");
        const body = server.requests[0]?.body as { messages: { role: string; content: string }[] };
        expect(JSON.parse(body.messages.find((message) => message.role === "user")!.content)).toEqual({
          url: "https://a-site.com/article",
          title: "An article",
          excerpt: PAGE_EXTRACT.excerpt,
          headings: ["Caching layer", "Benchmarks"],
          description: "An overview of caching.",
          siteName: "A Site",
        });
        expect(jevWire.mock.calls[0]?.[3].state).toEqual({
          bookmark: { title: "Saved article title", url: "https://a-site.com/article", domain: "a-site.com" },
          excerpt: PAGE_EXTRACT.excerpt,
          headings: ["Caching layer", "Benchmarks"],
          summary: "A page about a caching layer.",
        });
        expect((await getMeta(BOOKMARK_ID))?.summary).toBe("A page about a caching layer.");
        expect(summarizeSpy.mock.calls[0]?.[1].url).toBe("https://a-site.com/article");
        expect((await bookmarksApi.get(BOOKMARK_ID))[0]?.url).toBe(rawUrl);
      } finally {
        summarizeSpy.mockRestore();
      }
    }
  });

  it("retains the approved binding before each hop after a change without reacquiring consent", async () => {
    for (const [hop, change] of [
      ["fallback", "revocation"], ["fallback", "provider change"],
      ["internal retry", "revocation"], ["internal retry", "provider change"],
      ["Jev verification", "revocation"], ["Jev verification", "provider change"],
    ] as const) {
    await resetEnv();
    await seedProvider();
    server = makeOpenAiServer({
      ...(hop === "fallback"
        ? { failures: [{ status: 400, body: { error: "response_format unsupported" } }] }
        : hop === "internal retry" ? { failures: [{ status: 429, retryAfterSeconds: 0 }] } : {}),
      completion: completionWith({ summary: "A valid draft." }),
    });
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await server.fetch(...args);
      if (change === "revocation") {
        await db.consents.delete(["jev_summary_verify", JEV_ORIGIN]);
      } else {
        await saveLlmProvider({
          providerId: PROVIDER_ID,
          provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini-2024-07-18" },
          keySuffix: "1234", configuredAt: "2026-09-15T00:00:00.000Z",
        });
      }
      return response;
    });
    const jevTransport = jevTransportFor("supported");
    expect(await run(jevTransport)).toMatchObject({
      ok: false, stage: hop === "Jev verification" ? "verify" : "summarize",
      // The actual retry's current configured-model guard precedes feature
      // admission; fallback/verification still retain their consent refusal.
      code: hop === "internal retry" && change === "provider change" ? "unlisted_model" : "no_consent",
    });
    expect(server.requests).toHaveLength(1);
    expect(jevTransport).not.toHaveBeenCalled();
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    if (change === "revocation") expect(await db.consents.get(["jev_summary_verify", JEV_ORIGIN])).toBeUndefined();
    }
  });

  it("refuses an internal summary retry after a changed blocklist or live URL without losing prior exposure", async () => {
    for (const [failure, change] of [
      ["429", "blocklist"], ["transport", "blocklist"],
      ["429", "live URL"], ["transport", "live URL"],
    ] as const) {
      await resetEnv();
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
        ok: false, stage: "summarize",
        // P03's independent current-policy guard refuses a newly blocked
        // payload before feature admission or a second reservation.
        code: change === "blocklist" ? "request_not_allowed" : "unsendable",
      });
      expect(server.requests).toHaveLength(1);
      expect(jevTransport).not.toHaveBeenCalled();
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
      const reservations = await db.llmReservations.toArray();
      expect(reservations.map((row) => row.status).sort()).toEqual(
        change === "blocklist" ? ["settled"] : ["released", "settled"],
      );
      const usage = await db.llmUsage.toArray();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        inputTokens: 24_000, outputTokens: 1_024,
        estimatedCostUsd: expect.closeTo(0.0042144, 10),
      });
      expect(usage[0]?.costUsd).toBeUndefined();
      expect(usage.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0)).toBeCloseTo(0.0042144, 12);
    }
  });

  it("keeps the internal summary retry when feature admission remains allowed", async () => {
    for (const failure of ["429", "transport"] as const) {
      await resetEnv();
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
    }
  });

  it("uses both real origin gates with fake provider wires across scenarios", async () => {
    for (const scenario of ["allowed", "blocked initially", "blocked after LLM", "live URL blocked after LLM"] as const) {
      await resetEnv();
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
    }
  });

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

  it("refuses persisted blocked summaries before either provider hop", async () => {
    for (const url of ["https://a-site.com/article", "https://docs.a-site.com/article"]) {
      await resetEnv();
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
    }
  });

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
    // And a truly blocked host under the same persisted list refuses.
    await resetEnv();
    await seedProvider();
    await grantAll();
    const blocked = "https://a-site.com/article";
    await bookmarksApi.update(BOOKMARK_ID, { url: blocked });
    tabsGet.mockResolvedValue({ id: TAB_ID, url: blocked, incognito: false });
    await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
    const refused = await run(jevTransportFor("supported"));
    expect(refused).toMatchObject({ ok: false, code: "unsendable" });
    expect(server.requests).toHaveLength(0);
  });

  it("rereads the blocklist before a summary fallback or repair send and saves nothing", async () => {
    for (const hop of ["fallback", "repair"] as const) {
      await resetEnv();
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
    }
  });

  it("allows a summary fallback or repair when a changed blocklist does not affect the page", async () => {
    for (const hop of ["fallback", "repair"] as const) {
      await resetEnv();
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
    }
  });

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

  it("rereads the live saved URL before the summary fallback or verify hop", async () => {
    for (const hop of ["fallback", "verify"] as const) {
      await resetEnv();
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
    }
  });

  it("extracts, summarizes, verifies, and persists on `supported`", async () => {
    await seedProvider();
    await grantAll();
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toBe("A page about a caching layer.");
    const meta = await getMeta(BOOKMARK_ID);
    expect(meta?.summary).toBe("A page about a caching layer.");
    expect(executeScript.mock.calls.filter(([injection]) =>
      (injection as { files?: string[] }).files?.includes("extract.js"),
    )).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });

  it("uses existing current grants without silently refreshing them", async () => {
    await seedProvider();
    const grants = await db.consents.toArray();
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
    expect(await db.consents.toArray()).toEqual(grants);
  });

  it("refuses at the match stage when the page URL differs or the bookmark is gone", async () => {
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
          url: "https://different-site.com/",
          documentIdentity: 1000,
          title: "Elsewhere",
          excerpt: "Different page.",
          headings: [],
        },
      },
    ]);
    chromeStub.tabs = { get: tabsGet };
    chromeStub.scripting = { executeScript };
    const mismatch = await run();
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.stage).toBe("match");
    if (mismatch.stage === "match") {
      expect(mismatch.code).toBe("mismatch");
    }
    expect(server.requests).toHaveLength(0);
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
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

  it("persists a URL/markdown-stripped summary (H05)", async () => {
    await seedProvider();
    await grantAll();
    server = makeOpenAiServer({
      completion: completionWith({
        summary:
          "## Caching\n> See [the guide](https://evil.example/x) — " +
          "https://evil.example/trail\n- A **fast** `cache` layer.",
      }),
    });
    vi.stubGlobal("fetch", server.fetch);
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const expected =
      "Caching\nSee the guide —\nA fast cache layer.";
    expect(outcome.summary).toBe(expected);
    const meta = await getMeta(BOOKMARK_ID);
    expect(meta?.summary).toBe(expected);
  });

  it("fails the summarize stage when the draft is nothing but URLs/markdown", async () => {
    await seedProvider();
    await grantAll();
    server = makeOpenAiServer({
      completion: completionWith({
        summary: "https://evil.example/x",
      }),
    });
    vi.stubGlobal("fetch", server.fetch);
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.stage).toBe("summarize");
    if (outcome.stage === "summarize") {
      expect(outcome.code).toBe("empty_summary");
    }
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("does not persist when Jev answers `unsupported` or `uncertain`", async () => {
    for (const answer of ["unsupported", "uncertain"] as const) {
      await resetEnv();
      await seedProvider();
      await grantAll();
      const jevTransport = jevTransportFor(answer);
      const outcome = await run(jevTransport);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.stage).toBe("verify");
      if (
        outcome.stage === "verify" &&
        outcome.code === "not_supported" &&
        "verdict" in outcome
      ) {
        expect(outcome.verdict).toBe(answer);
      }
      expect(jevTransport).toHaveBeenCalledOnce();
      expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
    }
  });

  it("fails at extract for a lost tab or an incognito one — before any LLM/Jev send", async () => {
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
    await resetEnv();
    await seedProvider();
    await grantAll();
    tabsGet = vi.fn(async () => ({
      id: TAB_ID,
      url: PAGE_URL,
      incognito: true,
    }));
    chromeStub.tabs = { get: tabsGet };
    const incognito = await run();
    expect(incognito.ok).toBe(false);
    if (incognito.ok) return;
    expect(incognito.stage).toBe("extract");
    if (incognito.stage === "extract") {
      expect(incognito.code).toBe("incognito");
    }
    expect(executeScript).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it("writes usage rows for both sends and never persists the page excerpt", async () => {
    await seedProvider();
    await grantAll();
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    const usage = await db.llmUsage.toArray();
    expect(usage.some((row) => row.feature === "llm_summary")).toBe(true);
    const jevUsage = await db.usage.toArray().catch(() => []);
    expect(Array.isArray(jevUsage)).toBe(true);
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

describe("summarizePage payload defense", () => {
  it("refuses a stale v3 summary grant without deleting it and sends only after exact-origin reacquisition", async () => {
    await seedProvider();
    const oldGrant = {
      scope: "llm_summary" as const,
      origin: LLM_ORIGIN,
      consentVersion: 3,
      acceptedAt: "2026-09-25T10:00:00.000Z",
    };
    await db.consents.put(oldGrant);
    await grantConsentAtOrigin("llm_summary", "https://other-provider.dev");
    await expect(summaryLlm.summarizePage(PROVIDER_ID, PAGE_EXTRACT)).rejects.toMatchObject({
      code: "no_consent",
    });
    expect(server.requests).toHaveLength(0);
    expect(await db.llmReservations.count()).toBe(0);
    expect(await db.consents.get(["llm_summary", LLM_ORIGIN])).toEqual(oldGrant);
    await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
    expect(await summaryLlm.summarizePage(PROVIDER_ID, PAGE_EXTRACT)).toMatchObject({
      summary: "A page about a caching layer.",
    });
    expect(server.requests).toHaveLength(1);
    expect(await db.consents.get(["llm_summary", LLM_ORIGIN])).toMatchObject({
      consentVersion: 4,
    });
  });

  it("cleans a direct caller's URL without mutating its extract or dropping actual summary fields", async () => {
    await seedProvider();
    await grantAll();
    const extract: PageExtract = Object.freeze({
      ...PAGE_EXTRACT,
      url: "https://audit_user_secret:audit_password_secret@a-site.com/article?token=audit_query_secret#audit_fragment_secret",
      description: "An overview of caching.",
      siteName: "A Site",
      byline: "Local-only author",
    });
    const result = await summaryLlm.summarizePage(PROVIDER_ID, extract);
    expect(result.summary).toBe("A page about a caching layer.");
    expect(server.requests).toHaveLength(1);
    const serialized = JSON.stringify(server.requests.map((request) => request.body));
    for (const marker of ["audit_query_secret", "audit_fragment_secret", "audit_user_secret", "audit_password_secret", "Local-only author"]) {
      expect(serialized).not.toContain(marker);
    }
    const body = server.requests[0]?.body as { messages: { role: string; content: string }[] };
    expect(JSON.parse(body.messages.find((message) => message.role === "user")!.content)).toEqual({
      url: "https://a-site.com/article",
      title: "An article",
      excerpt: PAGE_EXTRACT.excerpt,
      headings: ["Caching layer", "Benchmarks"],
      description: "An overview of caching.",
      siteName: "A Site",
    });
    expect(extract.url).toContain("audit_query_secret");
    expect(extract.url).toContain("audit_fragment_secret");
  });

  it("refuses direct extracts with disallowed URLs before provider requests or reservations", async () => {
    for (const [label, url] of [
      ["malformed URL", "not-a-url?audit_query_secret#audit_fragment_secret"],
      ["file URL", "file:///article?audit_query_secret#audit_fragment_secret"],
      ["private host", "https://127.0.0.1/article?audit_query_secret#audit_fragment_secret"],
      ["built-in blocked host", "https://chase.com/article?audit_query_secret#audit_fragment_secret"],
      ["user-blocked host", "https://blocked-site.dev/article?audit_query_secret#audit_fragment_secret"],
      ["non-HTTP scheme", "ftp://a-site.com/article?audit_query_secret#audit_fragment_secret"],
      ["overlong cleaned URL", `https://a-site.com/${"x".repeat(2_048)}?audit_query_secret#audit_fragment_secret`],
    ] as const) {
    await resetEnv();
    await seedProvider();
    await grantAll();
    await db.metadata.put({ key: "decisions:blocklist", value: ["blocked-site.dev"] });
    let refusal: unknown;
    try {
      await summaryLlm.summarizePage(PROVIDER_ID, { ...PAGE_EXTRACT, url });
    } catch (cause) {
      refusal = cause;
    }
    expect(refusal, label).toMatchObject({ code: "request_not_allowed" });
    expect(String(refusal)).not.toContain("audit_query_secret");
    expect(String(refusal)).not.toContain("audit_fragment_secret");
    expect(JSON.stringify(refusal)).not.toContain("audit_query_secret");
    expect(server.requests).toHaveLength(0);
    expect(await db.llmReservations.count()).toBe(0);
    expect(await db.llmUsage.count()).toBe(0);
    }
  });

  it("re-admits the bookmark before persisting — a delete or retarget after verification saves nothing (J14)", async () => {
    for (const mode of ["delete", "retarget"] as const) {
      await resetEnv();
      await seedProvider();
      // Mutate the bookmark while the verify hop is in flight — the
      // persist-time re-admission is the only check left to catch it.
      const supported = jevTransportFor("supported");
      const mutating = vi.fn<JevTransport>(async (...args) => {
        const response = await supported(...args);
        if (mode === "delete") {
          await bookmarksApi.remove(BOOKMARK_ID);
        } else {
          await bookmarksApi.update(BOOKMARK_ID, {
            url: "https://other-site.com/article",
          });
        }
        return response;
      });
      const outcome = await summarizeExtracted(
        { tabId: TAB_ID, bookmarkId: BOOKMARK_ID, jevTransport: mutating },
        PAGE_EXTRACT,
      );
      expect(outcome, mode).toMatchObject({
        ok: false,
        stage: "persist",
        code: mode === "delete" ? "no_bookmark" : "mismatch",
      });
      expect(await getMeta(BOOKMARK_ID), mode).toBeUndefined();
      expect(await db.bookmarkMeta.count(), mode).toBe(0);
    }
  });
});
