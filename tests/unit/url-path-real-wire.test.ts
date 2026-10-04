import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { cleanUrl } from "../../src/decisions/minimize";
import { persistDecision } from "../../src/decisions/store";
import { productionHandlers } from "../../src/entrypoints/background";
import { resetJevClientPools } from "../../src/jev/client";
import type { SystemOneRequest } from "../../src/jev/wire";
import { explainDecision } from "../../src/llm/explain";
import { saveLlmProvider } from "../../src/llm/settings";
import { handleDecisionsMessage } from "../../src/messages/decisions";
import { handleSummarizeMessage } from "../../src/messages/summaries";
import { sendLlmConsented } from "../../src/net/llm-send";
import { sendConsented } from "../../src/net/send";
import { saveCredential } from "../../src/security/credentials";
import { saveProviderKey } from "../../src/security/keys";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { scopeRequest } from "../fakes/llm";
import { decisionBase } from "../fixtures/base-records";
import { makeOpenAiServer } from "../mock-servers/openai";

// Real minimizers, feature services, gates, credentials, consent and stores.
// Only Chrome/IndexedDB and the external provider transport are synthetic.
const LLM_ID = "preset:openai";
const TITLE = "Synthetic article";
const SENDER = { url: "chrome-extension://path-test/sidepanel.html" };
let savedUrl: string;
let activeUrl: string;
let bookmarks: ReturnType<typeof installBookmarksFake>;
let llm: ReturnType<typeof makeOpenAiServer>;
let wires: Array<{ destination: string; serialized: string; body: SystemOneRequest }>;

function configureLlm(payload: object) {
  llm = makeOpenAiServer({
    completion: (body) => ({
      model: body.model,
      choices: [{ message: { role: "assistant", content: JSON.stringify(payload) },
        finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
}

function jevResponse(request: SystemOneRequest) {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => {
    if (question.type === "noul") return [name, { type: "noul", noul: 0.9 }];
    if (question.type === "score") return [name, {
      type: "score", score: 3, confidence: 0.9, probabilities: { "3": 1 },
      legend: Object.fromEntries(question.criteria.map((value, i) => [String(i + 1), value])),
    }];
    const choices = Object.keys(question.criteria);
    const choice = choices.includes("supported") ? "supported"
      : choices.find((key) => key !== "none")!;
    return [name, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.9 }];
  }));
  return new Response(JSON.stringify({
    model: request.model, answers, usage: { input_tokens: 10, output_tokens: 2 },
  }), { status: 200 });
}

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  resetJevClientPools();
  savedUrl = activeUrl = "https://example.com/ordinary";
  bookmarks = installBookmarksFake({ bookmarksBar: [{ id: "bm-001", title: TITLE, url: savedUrl }] });
  const storage: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    bookmarks,
    runtime: { getURL: (path: string) => `chrome-extension://path-test/${path}` },
    permissions: { contains: async () => true },
    tabs: { get: async () => ({ id: 42, url: activeUrl, incognito: false }) },
    scripting: { executeScript: async () => [{ result: {
      url: activeUrl, documentIdentity: 1000, title: TITLE,
      excerpt: "A synthetic article about caching.", headings: ["Caching"],
    } }] },
    storage: { local: {
      get: async (keys?: string | string[] | null) => {
        const wanted = keys == null ? Object.keys(storage) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((key) => key in storage).map((key) => [key, storage[key]]));
      },
      set: async (items: Record<string, unknown>) => { Object.assign(storage, items); },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      },
    } },
  });
  await db.delete();
  await db.open();
  await saveLlmProvider({
    providerId: LLM_ID, provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
    configuredAt: "2026-10-05T00:00:00.000Z", monthlyBudgetUsd: 5,
  });
  await saveCredential(LLM_ID, "synthetic-llm-key");
  await saveProviderKey("typesafe", "synthetic-jev-key");
  await db.metadata.put({
    key: "typesafe", value: { preset: "typesafe", model: "jev-latest", keySuffix: "test" },
  });
  for (const scope of ["llm_summary", "llm_explain", "llm_escalate"] as const) {
    await grantConsentAtOrigin(scope, "https://api.openai.com");
  }
  for (const scope of ["jev_test", "jev_decisions", "jev_summary_verify"] as const) {
    await grantConsentAtOrigin(scope, "https://api.typesafe.ai");
  }
  configureLlm({ summary: "Synthetic caching summary." });
  wires = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const destination = String(input);
    const serialized = String(init?.body);
    const body = JSON.parse(serialized) as SystemOneRequest;
    wires.push({ destination, serialized, body });
    if (destination === "https://api.typesafe.ai/v1/systemone") return jevResponse(body);
    if (destination !== "https://api.openai.com/v1/chat/completions") {
      throw new Error("Unexpected synthetic destination.");
    }
    return llm.fetch(input, init);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

async function setUrls(saved: string, active = saved) {
  savedUrl = saved;
  activeUrl = active;
  await bookmarks.update("bm-001", { url: saved });
}

async function summarize() {
  const preflight = await handleSummarizeMessage({ type: "LLM_SUMMARY_PREFLIGHT" }, SENDER);
  if (preflight?.ok !== true || preflight.code !== "summary_consent") {
    throw new Error("Synthetic summary preflight failed.");
  }
  return handleSummarizeMessage({
    type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: "bm-001",
    consentApproval: preflight.consent.approval,
  }, SENDER);
}

describe("URL path secrets at the real provider wire", () => {
  it.each([
    [`/s/${"A".repeat(40)}`, "/s/_redacted_"],
    ["/p;jsessionid=synthetic-session/next", "/p/next"],
    [`/s/${"%41".repeat(40)}%3Bjsessionid=synthetic-session`, "/s/_redacted_"],
    ["/p%253Bjsessionid=synthetic-session/next", "/p/next"],
    ["/docs/short", "/docs/short"],
  ])("minimizes analyze, explain and both summary hops for %s", async (path, outbound) => {
    await setUrls(`https://example.com${path}?utm_source=synthetic#route`);
    expect(await handleDecisionsMessage({
      type: "ANALYZE_BOOKMARK", bookmarkId: "bm-001",
    }, SENDER, productionHandlers())).toMatchObject({
      ok: true, code: "analyze_ok", result: { sent: true },
    });
    await persistDecision({
      ...decisionBase, kind: "set_category", category: "article",
      probabilities: { article: 0.8, docs: 0.2 },
    });
    configureLlm({ rationale: "Synthetic rationale." });
    expect(await explainDecision(decisionBase.id, LLM_ID)).toMatchObject({
      rationale: "Synthetic rationale.",
    });
    configureLlm({ summary: "Synthetic caching summary." });
    expect(await summarize()).toMatchObject({
      ok: true, code: "summary_ok", summary: "Synthetic caching summary.",
    });
    expect(wires).toHaveLength(4);
    for (const wire of wires) {
      expect(wire.serialized).not.toContain("jsessionid");
      expect(wire.serialized).not.toContain("synthetic-session");
      expect(wire.serialized).not.toContain("A".repeat(40));
      expect(wire.serialized).not.toContain("%41".repeat(40));
      expect(wire.serialized).not.toContain("utm_source");
      expect(wire.serialized).not.toContain("#route");
      if (wire.destination.includes("typesafe")) {
        expect(wire.body.state).toMatchObject({ bookmark: { url: `https://example.com${outbound}` } });
      } else {
        const chat = JSON.parse(wire.serialized);
        const payload = JSON.parse(chat.messages[1].content);
        if (wire === wires[1]) {
          expect(payload.bookmarks).toEqual([
            { title: TITLE, url: `https://example.com${outbound}`, domain: "example.com" },
          ]);
        } else {
          expect(payload.url).toBe(`https://example.com${outbound}`);
        }
      }
    }
    const logs = await db.sentLog.toArray();
    expect(logs.map((log) => log.feature)).toEqual([
      "jev_decisions", "llm_explain", "llm_summary", "jev_summary_verify",
    ]);
    expect(logs.every((log) => log.outcome === "ok")).toBe(true);
    expect((await bookmarks.get("bm-001"))[0]!.url).toBe(savedUrl);
  });

  it.each([
    `/s/${"A".repeat(40)}`, "/p;jsessionid=synthetic-session",
    `/s/${"%2541".repeat(40)}`, "/p%25%33%42jsessionid=synthetic-session",
    "/p;jsessionid=synthetic-session/../short",
  ])("independent Jev and LLM gates refuse raw path %s before dispatch", async (path) => {
    const bookmark = { title: TITLE, url: `https://example.com${path}`, domain: "example.com" };
    const questions = { useful: { type: "noul" as const, instructions: "Is this useful?" } };
    for (const state of [
      { bookmark }, { candidateBookmarks: [bookmark] }, { pairPartner: bookmark },
    ]) {
      await expect(sendConsented("jev_decisions", "typesafe", "jev-latest", {
        model: "jev-latest", state, questions,
      })).rejects.toMatchObject({ code: "request_not_allowed" });
    }
    await expect(sendConsented("jev_summary_verify", "typesafe", "jev-latest", {
      model: "jev-latest", questions, state: {
        bookmark, excerpt: "Synthetic excerpt.", headings: [], summary: "Synthetic summary.",
      },
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    for (const scope of ["llm_summary", "llm_explain", "llm_escalate"] as const) {
      const request = scopeRequest(scope, "gpt-4o-mini");
      const payload = JSON.parse(request.messages[1]!.content);
      if (scope === "llm_summary") payload.url = bookmark.url;
      else payload.bookmarks = [bookmark];
      request.messages[1]!.content = JSON.stringify(payload);
      await expect(sendLlmConsented({
        providerId: LLM_ID, scope, request, kind: "manual",
        maxInputTokens: 100, maxOutputTokens: 50,
      })).rejects.toMatchObject({ code: "request_not_allowed" });
    }
    expect(wires).toHaveLength(0);
    expect(await db.sentLog.count()).toBe(0);
    expect(await db.llmReservations.count()).toBe(0);
  });

  it.each(["llm_summary", "llm_explain", "llm_escalate"] as const)(
    "%s independently rejects matrix and opaque paths", async (scope) => {
      for (const path of ["/p;jsessionid=synthetic-session", `/s/${"A".repeat(40)}`]) {
        const request = scopeRequest(scope, "gpt-4o-mini");
        const payload = JSON.parse(request.messages[1]!.content);
        const url = `https://example.com${path}`;
        if (scope === "llm_summary") payload.url = url;
        else payload.bookmarks = [{ title: TITLE, url, domain: "example.com" }];
        request.messages[1]!.content = JSON.stringify(payload);
        await expect(sendLlmConsented({
          providerId: LLM_ID, scope, request, kind: "manual",
          maxInputTokens: 100, maxOutputTokens: 50,
        })).rejects.toMatchObject({ code: "request_not_allowed" });
      }
      expect(wires).toHaveLength(0);
      expect(await db.sentLog.count()).toBe(0);
      expect(await db.llmReservations.count()).toBe(0);
    },
  );

  it("Jev summary independently rejects a raw matrix path", async () => {
    await expect(sendConsented("jev_summary_verify", "typesafe", "jev-latest", {
      model: "jev-latest",
      questions: { useful: { type: "noul", instructions: "Is this useful?" } },
      state: {
        bookmark: { title: TITLE, url: "https://example.com/p;jsessionid=synthetic-session", domain: "example.com" },
        excerpt: "Synthetic excerpt.", headings: [], summary: "Synthetic summary.",
      },
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(wires).toHaveLength(0);
    expect(await db.sentLog.count()).toBe(0);
  });

  it.each([
    ["/p;jsessionid=synthetic-A", "/p;jsessionid=synthetic-B"],
    [`/s/${"A".repeat(40)}`, `/s/${"B".repeat(40)}`],
    [`/s/${"%41".repeat(40)}`, `/s/${"%42".repeat(40)}`],
  ])("rejects summary mismatch despite equal outbound copies: %s vs %s", async (saved, active) => {
    await setUrls(`https://example.com${saved}`, `https://example.com${active}`);
    expect(cleanUrl(savedUrl)).toBe(cleanUrl(activeUrl));
    expect(await summarize()).toMatchObject({ ok: false, code: "mismatch", stage: "match" });
    expect(wires).toHaveLength(0);
    expect(await db.sentLog.count()).toBe(0);
    expect((await bookmarks.get("bm-001"))[0]!.url).toBe(savedUrl);
  });
});
