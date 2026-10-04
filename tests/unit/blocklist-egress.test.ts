import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { DECISION_BLOCKLIST_KEY } from "../../src/decisions/blocklist";
import { getDecision, persistDecision } from "../../src/decisions/store";
import { productionHandlers, runPersistedJob } from "../../src/entrypoints/background";
import { resetJevClientPools } from "../../src/jev/client";
import type { SystemOneRequest } from "../../src/jev/wire";
import { enqueueJob, getJob } from "../../src/jobs/queue";
import { explainDecision } from "../../src/llm/explain";
import { saveLlmProvider } from "../../src/llm/settings";
import { summarizePage } from "../../src/llm/summarize";
import { handleDecisionsMessage } from "../../src/messages/decisions";
import { handleLlmFeatureMessage } from "../../src/messages/llm-features";
import { handleRestructureMessage } from "../../src/messages/restructure";
import { handleSummarizeMessage } from "../../src/messages/summaries";
import { sendLlmConsented } from "../../src/net/llm-send";
import { sendConsented } from "../../src/net/send";
import { Decision } from "../../src/schemas/decision";
import { LLM_CONSENT_SCOPES } from "../../src/schemas/provider";
import { saveCredential } from "../../src/security/credentials";
import { saveProviderKey } from "../../src/security/keys";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";
import { makeOpenAiServer } from "../mock-servers/openai";
import { scopeRequest, TEST_LLM_SCOPES } from "../fakes/llm";

// Real services, provider stores, credentials, consent, gates and persistence;
// only Chrome, IndexedDB and the external provider transport are synthetic.
declare const chrome: Record<string, unknown>;
const SENDER = { url: "chrome-extension://blocklist-test/sidepanel.html" };
const LLM_ID = "preset:openai";
const UUID = "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a";
const EXTRACT = {
  title: "Allowed article", url: "https://allowed-site.dev/article",
  excerpt: "A synthetic article about caching.", headings: ["Caching"],
};
const BOOKMARK = { id: "bm-001", title: EXTRACT.title, url: EXTRACT.url };
const PROPOSAL = { folders: [{ path: "Articles", description: "" }] };
let llm: ReturnType<typeof makeOpenAiServer>;
let providerCalls: number;
let jobId: string;
let runJob = vi.fn(async () => {});

function configureLlm(payload: object) {
  llm = makeOpenAiServer({
    completion: (body) => ({
      id: "chatcmpl-blocklist", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) },
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
    if (question.type !== "choice") throw new Error("Unexpected synthetic question.");
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
  const bookmarks = installBookmarksFake({ bookmarksBar: [BOOKMARK] });
  const storage: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    bookmarks,
    runtime: { getURL: (path: string) => `chrome-extension://blocklist-test/${path}` },
    permissions: { contains: async () => true },
    tabs: { get: async () => ({ id: 42, url: EXTRACT.url, incognito: false }) },
    scripting: { executeScript: async () => [{ result: {
      title: EXTRACT.title, excerpt: EXTRACT.excerpt, headings: EXTRACT.headings,
      url: EXTRACT.url, documentIdentity: 1000,
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
  for (const scope of LLM_CONSENT_SCOPES) {
    await grantConsentAtOrigin(scope, "https://api.openai.com");
  }
  for (const scope of ["jev_test", "jev_decisions", "jev_summary_verify"] as const) {
    await grantConsentAtOrigin(scope, "https://api.typesafe.ai");
  }
  await persistDecision(Decision.parse({
    ...decisionBase, id: UUID, kind: "set_category", category: "article",
    probabilities: { article: 0.8, news: 0.2 },
  }));
  configureLlm({ rationale: "Synthetic rationale." });
  providerCalls = 0;
  runJob = vi.fn(async () => {});
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    providerCalls += 1;
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      return jevResponse(JSON.parse(String(init?.body)) as SystemOneRequest);
    }
    if (!String(url).startsWith("https://api.openai.com/")) {
      throw new Error("Unexpected synthetic destination.");
    }
    return llm.fetch(url, init);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

const badRows = [
  { label: "throwing metadata.get", throws: true },
  { label: "non-array row", value: { host: "sensitive-row-detail.dev" } },
  { label: "mixed entry types", value: ["sensitive-row-detail.dev", 42] },
  { label: "empty host", value: [""] },
  { label: "malformed host", value: ["sensitive row detail"] },
];
async function installBadRow(row: typeof badRows[number]) {
  if (row.throws) {
    const get = db.metadata.get.bind(db.metadata);
    vi.spyOn(db.metadata, "get").mockImplementation((key: unknown) => {
      if (key === DECISION_BLOCKLIST_KEY) {
        throw new Error("sensitive-row-detail.dev");
      }
      return get(key as string);
    });
  } else {
    await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value: row.value });
  }
}

interface Surface {
  name: string;
  prepare?: () => Promise<void>;
  run: () => Promise<unknown>;
  refusal: object;
  allowed: object;
}
const readerRefusal = { name: "BlocklistReadError", code: "request_not_allowed" };
const messageRefusal = { ok: false, code: "request_not_allowed" };
const question = { type: "noul", instructions: "Is this useful?" };
const surfaces: Surface[] = [
  {
    name: "production analyze handler",
    run: () => handleDecisionsMessage({ type: "ANALYZE_BOOKMARK", bookmarkId: "bm-001" },
      SENDER, productionHandlers()),
    refusal: messageRefusal, allowed: { ok: true, code: "analyze_ok", result: { sent: true } },
  },
  {
    name: "production save-suggest handler",
    run: () => handleDecisionsMessage({ type: "SAVE_SUGGEST", bookmark: BOOKMARK },
      SENDER, productionHandlers()),
    refusal: messageRefusal, allowed: { ok: true, code: "analyze_ok", result: { sent: true } },
  },
  {
    name: "production rerank handler",
    run: () => handleDecisionsMessage({ type: "RERANK", query: "Allowed" }, SENDER, productionHandlers()),
    refusal: messageRefusal, allowed: { ok: true, code: "rerank_ok", result: { sent: true } },
  },
  ...(["analyze_selection", "restructure"] as const).map((kind): Surface => ({
    name: `persisted ${kind} job`,
    prepare: async () => {
      jobId = (await enqueueJob({ kind, bookmarkIds: ["bm-001"],
        ...(kind === "restructure" ? { restructureProposal: PROPOSAL } : {}) })).id;
    },
    run: async () => {
      await runPersistedJob(jobId);
      return { status: (await getJob(jobId))?.status };
    },
    refusal: readerRefusal, allowed: { status: "completed" },
  })),
  {
    name: "direct explain service", run: () => explainDecision(UUID, LLM_ID),
    refusal: readerRefusal, allowed: { rationale: "Synthetic rationale." },
  },
  {
    name: "explain message handler",
    run: () => handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID }, SENDER),
    refusal: messageRefusal, allowed: { ok: true, code: "explain_ok" },
  },
  {
    name: "direct summarize service",
    prepare: async () => { configureLlm({ summary: "Synthetic summary." }); },
    run: () => summarizePage(LLM_ID, EXTRACT),
    refusal: readerRefusal, allowed: { summary: "Synthetic summary." },
  },
  {
    name: "summary message pipeline",
    prepare: async () => { configureLlm({ summary: "Synthetic summary." }); },
    run: async () => {
      const preflight = await handleSummarizeMessage({ type: "LLM_SUMMARY_PREFLIGHT" }, SENDER);
      if (preflight?.ok !== true || preflight.code !== "summary_consent") return preflight;
      return handleSummarizeMessage({ type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: "bm-001",
        consentApproval: preflight.consent.approval }, SENDER);
    },
    refusal: { ok: false, code: "unsendable", stage: "match" },
    allowed: { ok: true, code: "summary_ok", summary: "Synthetic summary." },
  },
  {
    name: "independent Jev decision gate",
    run: () => sendConsented("jev_decisions", "typesafe", "jev-latest", {
      model: "jev-latest", state: { bookmark: { title: EXTRACT.title, url: EXTRACT.url,
        domain: "allowed-site.dev" } }, questions: { useful: question },
    }),
    refusal: { name: "NetworkGateError", code: "request_not_allowed" }, allowed: { status: 200 },
  },
  {
    name: "independent Jev summary gate",
    run: () => sendConsented("jev_summary_verify", "typesafe", "jev-latest", {
      model: "jev-latest", state: { bookmark: { title: EXTRACT.title, url: EXTRACT.url,
        domain: "allowed-site.dev" }, excerpt: EXTRACT.excerpt, headings: EXTRACT.headings,
        summary: "Synthetic summary." }, questions: { useful: question },
    }),
    refusal: { name: "NetworkGateError", code: "request_not_allowed" }, allowed: { status: 200 },
  },
  ...TEST_LLM_SCOPES.map((scope): Surface => ({
    name: `independent ${scope} gate without feature admission`,
    run: () => sendLlmConsented({
      providerId: LLM_ID, scope, request: scopeRequest(scope, "gpt-4o-mini"),
      maxInputTokens: 100, maxOutputTokens: 50, kind: "manual",
    }),
    refusal: { name: "LlmGateError", code: "request_not_allowed" },
    allowed: { response: { status: 200 } },
  })),
  {
    name: "restructure start message",
    prepare: async () => { configureLlm(PROPOSAL); },
    run: () => handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active" },
      SENDER, { runJob }),
    refusal: messageRefusal, allowed: { ok: true, code: "job_ok" },
  },
];

for (const surface of surfaces) {
  describe(surface.name, () => {
    it.each(badRows)("refuses $label before any provider call", async (row) => {
      await surface.prepare?.();
      await installBadRow(row);
      const reply: unknown = await surface.run().catch((cause: unknown) => cause);
      expect(reply).toMatchObject(surface.refusal);
      expect(providerCalls).toBe(0);
      expect(await db.sentLog.count()).toBe(0);
      expect(await db.llmUsage.count()).toBe(0);
      expect(await db.llmReservations.count()).toBe(0);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();
      expect(await db.bookmarkMeta.get("bm-001")).toBeUndefined();
      expect(runJob).not.toHaveBeenCalled();
      if (surface.name === "restructure start message") expect(await db.jobs.count()).toBe(0);
      for (const text of [String(reply), JSON.stringify(reply), inspect(reply)]) {
        expect(text).not.toContain("sensitive-row-detail.dev");
        expect(text).not.toContain("sensitive row detail");
        expect(text).not.toContain("synthetic-llm-key");
        expect(text).not.toContain("synthetic-jev-key");
        expect(text).not.toContain(EXTRACT.excerpt);
        expect(text).not.toContain(EXTRACT.url);
      }
    });

    it.each(["unset", "empty", "valid unrelated"] as const)("sends with a %s blocklist control", async (control) => {
      await surface.prepare?.();
      if (control !== "unset") {
        await db.metadata.put({ key: DECISION_BLOCKLIST_KEY,
          value: control === "empty" ? [] : ["unrelated-site.dev"] });
      }
      expect(await surface.run()).toMatchObject(surface.allowed);
      expect(providerCalls).toBeGreaterThan(0);
      expect(await db.sentLog.count()).toBe(providerCalls);
    });
  });
}

it("restructure sends no blocked-only paths or bookmark-derived synopsis data", async () => {
  // installBookmarksFake replaces the entire global Chrome surface.
  const chromeStub = chrome;
  const bookmarks = installBookmarksFake({ bookmarksBar: [
    { id: "private", title: "Blocked-only folder", children: [
      { id: "private-child", title: "Blocked-only child", children: [
        { id: "secret", title: "Blocked title", url: "https://blocked-site.dev/private" },
      ] },
    ] },
    { id: "mixed", title: "Mixed", children: [
      { id: "mixed-blocked", title: "Hidden child", children: [
        { id: "secret2", title: "Other blocked title", url: "https://blocked-site.dev/other" },
      ] },
      { id: "allowed-folder", title: "Allowed descendant", children: [BOOKMARK] },
    ] },
    { id: "empty", title: "Harmless empty folder", children: [] },
  ] });
  // Keep the fully enabled provider/storage/permission setup above intact.
  vi.stubGlobal("chrome", { ...chromeStub, bookmarks });
  await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value: ["blocked-site.dev"] });
  await db.bookmarkMeta.bulkPut([
    { id: "secret", tags: ["private-tag"], category: "tool", updatedAt: "2026-10-05T00:00:00.000Z" },
    { id: "secret2", tags: ["private-tag"], category: "tool", updatedAt: "2026-10-05T00:00:00.000Z" },
    { id: "bm-001", tags: ["allowed-tag"], category: "article", updatedAt: "2026-10-05T00:00:00.000Z" },
  ]);
  configureLlm(PROPOSAL);
  const reply = await handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active" },
    SENDER, { runJob });
  expect(reply).toMatchObject({ ok: true, code: "job_ok" });
  expect(providerCalls).toBe(1);
  const request = llm.requests[0]!.body as { messages: { role: string; content: string }[] };
  const synopsis: unknown = JSON.parse(request.messages.find((m) => m.role === "user")!.content);
  expect(synopsis).toEqual({
    folderPaths: ["Bookmarks bar", "Bookmarks bar/Harmless empty folder",
      "Bookmarks bar/Mixed", "Bookmarks bar/Mixed/Allowed descendant",
      "Mobile bookmarks", "Other bookmarks"],
    categories: { article: 1 }, tags: { "allowed-tag": 1 },
    domains: [{ domain: "allowed-site.dev", count: 1 }],
    representativeTitles: { "Bookmarks bar/Mixed/Allowed descendant": ["Allowed article"] },
    bookmarkCount: 1,
  });
  expect(JSON.stringify(synopsis)).not.toContain("Blocked");
  expect(JSON.stringify(synopsis)).not.toContain("blocked-site.dev");
  expect(JSON.stringify(synopsis)).not.toContain("private-tag");
});
