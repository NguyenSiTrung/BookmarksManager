import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
} from "../../src/consent/records";
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
let wireRequests: unknown[];

const APPROVAL = {
  consentVersion: 4,
  llm: { origin: LLM_ORIGIN, providerId: PROVIDER_ID, model: "gpt-4o-mini", endpoint: `${LLM_ORIGIN}/v1/chat/completions` },
  jev: { origin: JEV_ORIGIN, providerId: "typesafe", model: "jev-latest", endpoint: `${JEV_ORIGIN}/v1/systemone` },
};

async function preflightApproval() {
  const reply = await handleSummarizeMessage({ type: "LLM_SUMMARY_PREFLIGHT" }, TRUSTED);
  expect(reply).toMatchObject({ ok: true, code: "summary_consent" });
  return (reply as unknown as { consent: { approval: typeof APPROVAL } }).consent.approval;
}

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
        url: PAGE_URL,
        documentIdentity: 1000,
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

async function seedProvider(model = "gpt-4o-mini") {
  const record: LlmProviderRecord = {
    providerId: PROVIDER_ID,
    provider: { kind: "preset", preset: "openai", model },
    keySuffix: "1234",
    configuredAt: "2026-09-15T00:00:00.000Z",
  };
  await saveLlmProvider(record);
  await saveCredential(PROVIDER_ID, "sk-test-1234");
  // The Jev gate requires a stored typesafe key on every send.
  await saveProviderKey("typesafe", "jev-test-key-1234");
  // The verify hop resolves the ENABLED Jev provider: a stored settings
  // row plus the `jev_test` consent the enable flow records.
  await db.metadata.put({
    key: "typesafe",
    value: { preset: "typesafe", model: "jev-latest", keySuffix: "1234" },
  });
  await grantConsentAtOrigin("jev_test", JEV_ORIGIN);
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
    wireRequests.push(JSON.parse(String(init?.body ?? "{}")));
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

const resetEnv = async () => {
  wireRequests = [];
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
};

beforeEach(resetEnv);

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

  it("grants both consents only after bound approval, then separately hits the cost gate", async () => {
    // An unlisted preset model has no built-in price, so the click stops at
    // the unknown-cost confirmation instead of sending.
    await seedProvider("gpt-4o-mini-2024-07-18");
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval: await preflightApproval() },
      TRUSTED,
    );
    // The Summarize click IS the consent trigger (spec FR3): both
    // origin-scoped grants are written before the gated send, and the
    // unpriced model stops on confirmation_required — never no_consent.
    await expect(
      hasConsentAtOrigin("llm_summary", LLM_ORIGIN),
    ).resolves.toBe(true);
    await expect(
      hasConsentAtOrigin("jev_summary_verify", JEV_ORIGIN),
    ).resolves.toBe(true);
    expect(reply).toMatchObject({ ok: false, code: "confirmation_required" });
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
        consentApproval: await preflightApproval(),
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
    await seedProvider("gpt-4o-mini-2024-07-18");
    await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
    await grantConsentAtOrigin("jev_summary_verify", JEV_ORIGIN);
    const reply = await handleSummarizeMessage(
      { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval: await preflightApproval() },
      TRUSTED,
    );
    expect(reply).toMatchObject({
      ok: false,
      code: "confirmation_required",
      destinationOrigin: LLM_ORIGIN,
      stage: "summarize",
    });
  });

  it("preflights exact recipients/version/grants read-only without extracting or sending", async () => {
    await seedProvider();
    const stale = { scope: "llm_summary" as const, origin: LLM_ORIGIN, consentVersion: 3, acceptedAt: "2026-09-25T10:00:00.000Z" };
    await db.consents.put(stale);
    const before = await db.consents.toArray();
    expect(await handleSummarizeMessage({ type: "LLM_SUMMARY_PREFLIGHT" }, TRUSTED)).toEqual({
      ok: true, code: "summary_consent",
      consent: { approval: APPROVAL, llmGranted: false, jevGranted: false },
    });
    expect(await db.consents.toArray()).toEqual(before);
    expect(tabsGet).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(wireRequests).toHaveLength(0);
  });

  it("requires displayed approval at the message boundary even with current grants", async () => {
    await seedProvider();
    await grantConsentAtOrigin("llm_summary", LLM_ORIGIN);
    await grantConsentAtOrigin("jev_summary_verify", JEV_ORIGIN);
    const before = await db.consents.toArray();
    expect(await handleSummarizeMessage({
      type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID,
    }, TRUSTED)).toMatchObject({ ok: false, code: "no_consent", stage: "consent" });
    expect(await db.consents.toArray()).toEqual(before);
    expect(executeScript).not.toHaveBeenCalled();
    expect(wireRequests).toHaveLength(0);
  });

  it("rechecks the accepted binding after extraction before any provider send", async () => {
    await seedProvider();
    const consentApproval = await preflightApproval();
    executeScript.mockImplementationOnce(async () => {
      await seedProvider("gpt-4o-mini-2024-07-18");
      return [{ result: { url: PAGE_URL, documentIdentity: 1000, title: PAGE_EXTRACT.title, excerpt: PAGE_EXTRACT.excerpt, headings: PAGE_EXTRACT.headings } }];
    });
    expect(await handleSummarizeMessage({
      type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval,
    }, TRUSTED)).toMatchObject({ ok: false, code: "no_consent" });
    expect(executeScript.mock.calls.filter(([injection]) =>
      (injection as { files?: string[] }).files?.includes("extract.js"),
    )).toHaveLength(1);
    expect(wireRequests).toHaveLength(0);
    expect(await getMeta(BOOKMARK_ID)).toBeUndefined();
  });

  it("refuses missing or mismatched approval fields before any grant, extraction, or egress", async () => {
    for (const kind of ["missing", "stale version", "LLM origin", "Jev origin", "LLM model", "Jev endpoint"] as const) {
      await resetEnv();
      await seedProvider();
      await db.consents.put({ scope: "llm_summary", origin: LLM_ORIGIN, consentVersion: 3, acceptedAt: "2026-09-25T10:00:00.000Z" });
      const before = await db.consents.toArray();
      const approval = structuredClone(APPROVAL);
      if (kind === "stale version") approval.consentVersion = 3;
      if (kind === "LLM origin") approval.llm.origin = "https://wrong-provider.dev";
      if (kind === "Jev origin") approval.jev.origin = "https://wrong-provider.dev";
      if (kind === "LLM model") approval.llm.model = "different-model";
      if (kind === "Jev endpoint") approval.jev.endpoint = `${JEV_ORIGIN}/other/systemone`;
      expect(await handleSummarizeMessage({
        type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID,
        ...(kind === "missing" ? {} : { consentApproval: approval }),
      }, TRUSTED), kind).toMatchObject({ ok: false, code: "no_consent", stage: "consent" });
      expect(await db.consents.toArray(), kind).toEqual(before);
      expect(tabsGet, kind).not.toHaveBeenCalled();
      expect(executeScript, kind).not.toHaveBeenCalled();
      expect(wireRequests, kind).toHaveLength(0);
    }
  });

  it("rejects a changed origin or model after preflight rather than granting the new provider", async () => {
    for (const change of ["LLM origin", "LLM model", "Jev origin", "Jev model"] as const) {
      await resetEnv();
      await seedProvider();
      const approval = await preflightApproval();
      if (change === "LLM origin") {
        await saveLlmProvider({
          providerId: "preset:openrouter",
          provider: { kind: "preset", preset: "openrouter", model: "openai/gpt-4o-mini" },
          keySuffix: "1234", configuredAt: "2026-09-15T00:00:00.000Z",
        });
      } else if (change === "LLM model") {
        await seedProvider("gpt-4o-mini-2024-07-18");
      } else if (change === "Jev origin") {
        await db.metadata.delete("typesafe");
        await db.metadata.put({ key: "openrouter", value: { preset: "openrouter", model: "jev-latest", keySuffix: "1234" } });
        await grantConsentAtOrigin("jev_test", "https://openrouter.ai");
      } else {
        await db.metadata.put({ key: "typesafe", value: { preset: "typesafe", model: "jev-1.13.0", keySuffix: "1234" } });
      }
      const before = await db.consents.toArray();
      expect(await handleSummarizeMessage({
        type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval: approval,
      }, TRUSTED), change).toMatchObject({ ok: false, code: "no_consent" });
      expect(await db.consents.toArray(), change).toEqual(before);
      expect(executeScript, change).not.toHaveBeenCalled();
      expect(wireRequests, change).toHaveLength(0);
    }
  });

  it("rejects untrusted LLM_SUMMARY_PREFLIGHT and LLM_SUMMARIZE without granting or extracting", async () => {
    for (const type of ["LLM_SUMMARY_PREFLIGHT", "LLM_SUMMARIZE"] as const) {
      await resetEnv();
      await seedProvider();
      const before = await db.consents.toArray();
      const message = type === "LLM_SUMMARY_PREFLIGHT" ? { type } : {
        type, tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval: APPROVAL,
      };
      expect(await handleSummarizeMessage(message, { url: "https://evil.example.com/" }), type).toMatchObject({ ok: false, code: "untrusted_sender" });
      expect(await db.consents.toArray(), type).toEqual(before);
      expect(executeScript, type).not.toHaveBeenCalled();
      expect(wireRequests, type).toHaveLength(0);
    }
  });

  it("retains cost-confirmation binding and refuses a changed provider on resend", async () => {
    await seedProvider("gpt-4o-mini-2024-07-18");
    const consentApproval = await preflightApproval();
    const message = { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval };
    expect(await handleSummarizeMessage(message, TRUSTED)).toMatchObject({ ok: false, code: "confirmation_required", destinationOrigin: LLM_ORIGIN });
    const extracted = executeScript.mock.calls.length;
    await seedProvider("gpt-4o-mini");
    expect(await handleSummarizeMessage({ ...message, unknownCostConfirmed: true }, TRUSTED)).toMatchObject({ ok: false, code: "no_consent" });
    expect(executeScript).toHaveBeenCalledTimes(extracted);
    expect(wireRequests).toHaveLength(0);
  });

  it("does not reacquire revoked llm_summary or jev_summary_verify consent from a cost-confirmation resend", async () => {
    for (const scope of ["llm_summary", "jev_summary_verify"] as const) {
      await resetEnv();
      await seedProvider("gpt-4o-mini-2024-07-18");
      const consentApproval = await preflightApproval();
      const message = { type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval };
      expect(await handleSummarizeMessage(message, TRUSTED)).toMatchObject({ ok: false, code: "confirmation_required" });
      const extractionCount = executeScript.mock.calls.length;
      const origin = scope === "llm_summary" ? LLM_ORIGIN : JEV_ORIGIN;
      await db.consents.delete([scope, origin]);
      expect(await handleSummarizeMessage({
        ...message, unknownCostConfirmed: true,
      }, TRUSTED), scope).toMatchObject({ ok: false, code: "no_consent", stage: "consent" });
      expect(await db.consents.get([scope, origin]), scope).toBeUndefined();
      expect(executeScript, scope).toHaveBeenCalledTimes(extractionCount);
      expect(wireRequests, scope).toHaveLength(0);
    }
  });

  it("strictly refuses malformed approval data before any sensitive operation", async () => {
    await seedProvider();
    const before = await db.consents.toArray();
    expect(await handleSummarizeMessage({
      type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID,
      consentApproval: { ...APPROVAL, unexpected: "not disclosed" },
    }, TRUSTED)).toMatchObject({ ok: false, code: "malformed_message" });
    expect(await db.consents.toArray()).toEqual(before);
    expect(executeScript).not.toHaveBeenCalled();
    expect(wireRequests).toHaveLength(0);
  });

  it("reacquires stale grants only for valid displayed recipients and succeeds", async () => {
    await seedProvider();
    await db.consents.put({ scope: "llm_summary", origin: LLM_ORIGIN, consentVersion: 3, acceptedAt: "2026-09-25T10:00:00.000Z" });
    const consentApproval = await preflightApproval();
    expect(await handleSummarizeMessage({
      type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval,
    }, TRUSTED)).toMatchObject({ ok: true, code: "summary_ok" });
    expect(await hasConsentAtOrigin("llm_summary", LLM_ORIGIN)).toBe(true);
    expect(await hasConsentAtOrigin("jev_summary_verify", JEV_ORIGIN)).toBe(true);
    expect(executeScript.mock.calls.filter(([injection]) =>
      (injection as { files?: string[] }).files?.includes("extract.js"),
    )).toHaveLength(1);
    expect(wireRequests).toHaveLength(2);
  });

  it("relays a summarize transport abort as aborted, not internal_error", async () => {
    await seedProvider();
    const consentApproval = await preflightApproval();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.openai.com")) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return server.fetch(input as never, init as never) as Promise<Response>;
    });
    expect(await handleSummarizeMessage({
      type: "LLM_SUMMARIZE", tabId: 42, bookmarkId: BOOKMARK_ID, consentApproval,
    }, TRUSTED)).toMatchObject({ ok: false, code: "aborted" });
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
