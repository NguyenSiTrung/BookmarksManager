import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import {
  maybeEscalateDecision,
  readLlmEscalationSettings,
  writeLlmEscalationSettings,
  type EscalationContext,
} from "../../src/llm/escalate";
import { saveLlmProvider } from "../../src/llm/settings";
import { Decision } from "../../src/schemas/decision";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { makeOpenAiServer } from "../mock-servers/openai";
import { decisionBase } from "../fixtures/base-records";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "custom:https://llm.example.com/v1";
const ORIGIN = "https://llm.example.com";

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
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  });
}

function installChromeStub() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
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

/** A low-confidence set_category decision — the only shape eligible. */
function lowConfidence(over: Record<string, unknown> = {}) {
  return Decision.parse({
    ...decisionBase,
    confidence: 0.3,
    status: "unsure",
    kind: "set_category",
    category: "article",
    probabilities: { article: 0.4, news: 0.6 },
    ...over,
  });
}

const CONTEXT: EscalationContext = {
  bookmarks: [{ title: "A", url: "https://a-site.com/", domain: "a-site.com" }],
  question: "Which single category should this bookmark be filed under?",
  options: [
    { id: "article", label: "article" },
    { id: "news", label: "news" },
  ],
  probabilities: { article: 0.4, news: 0.6 },
  jevAnswer: "article",
};

/** Priced custom provider + monthly cap + optional llm_escalate consent. */
async function seedProvider(opts: { consent?: boolean; pricing?: boolean; budget?: boolean } = {}) {
  const { consent = true, pricing = true, budget = true } = opts;
  const record: LlmProviderRecord = {
    providerId: PROVIDER_ID,
    provider: {
      kind: "custom",
      baseUrl: "https://llm.example.com/v1",
      model: "m",
      auth: "none",
      ...(pricing ? { pricing: { inputPerMillion: 1, outputPerMillion: 2 } } : {}),
    },
    configuredAt: "2026-09-15T00:00:00.000Z",
    ...(budget ? { monthlyBudgetUsd: 5 } : {}),
  };
  await saveLlmProvider(record);
  if (consent) await grantConsentAtOrigin("llm_escalate", ORIGIN);
}

beforeEach(async () => {
  installChromeStub();
  server = makeOpenAiServer({
    completion: completionWith({ verdict: "agree", rationale: "Consistent." }),
  });
  vi.stubGlobal("fetch", server.fetch);
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("escalation settings", () => {
  it("default to disabled — nothing is configured", async () => {
    expect(await readLlmEscalationSettings()).toEqual({ enabled: false });
  });

  it("round-trips an enabled configuration", async () => {
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    expect(await readLlmEscalationSettings()).toEqual({
      enabled: true,
      providerId: PROVIDER_ID,
    });
  });
});

describe("maybeEscalateDecision", () => {
  it("returns null for decisions at or above the review floor", async () => {
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    const result = await maybeEscalateDecision(
      lowConfidence({ confidence: 0.5 }),
      CONTEXT,
    );
    expect(result).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("is off by default — no settings row means no request", async () => {
    await seedProvider();
    const result = await maybeEscalateDecision(lowConfidence(), CONTEXT);
    expect(result).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("is off when the setting is disabled", async () => {
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: false, providerId: PROVIDER_ID });
    const result = await maybeEscalateDecision(lowConfidence(), CONTEXT);
    expect(result).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("returns agree with model and rationale", async () => {
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    const result = await maybeEscalateDecision(lowConfidence(), CONTEXT);
    expect(result).toMatchObject({
      verdict: "agree",
      rationale: "Consistent.",
      model: "m",
    });
    expect(server.requests).toHaveLength(1);
    // The wire payload carries only the minimized inputs.
    const raw = JSON.stringify(server.requests[0]!.body);
    expect(raw).not.toContain("bm-001");
  });

  it("returns disagree with a constrained alternative", async () => {
    server = makeOpenAiServer({
      completion: completionWith({
        verdict: "disagree",
        alternative: "news",
        rationale: "'news' fits better.",
      }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    const result = await maybeEscalateDecision(lowConfidence(), CONTEXT);
    expect(result).toMatchObject({ verdict: "disagree", alternative: "news" });
  });

  it("rejects a disagree verdict naming an unknown candidate", async () => {
    server = makeOpenAiServer({
      completion: completionWith({
        verdict: "disagree",
        alternative: "invented-category",
        rationale: "made up",
      }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    expect(await maybeEscalateDecision(lowConfidence(), CONTEXT)).toBeNull();
  });

  it("rejects a disagree verdict with no alternative", async () => {
    server = makeOpenAiServer({
      completion: completionWith({ verdict: "disagree", rationale: "no pick" }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    expect(await maybeEscalateDecision(lowConfidence(), CONTEXT)).toBeNull();
  });

  it("rejects a response with unknown keys or an invented verdict", async () => {
    server = makeOpenAiServer({
      completion: completionWith({ verdict: "auto_apply", rationale: "x" }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    expect(await maybeEscalateDecision(lowConfidence(), CONTEXT)).toBeNull();
  });

  it("falls back silently when consent is missing", async () => {
    await seedProvider({ consent: false });
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    const result = await maybeEscalateDecision(lowConfidence(), CONTEXT);
    expect(result).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("falls back when the provider has no usable pricing", async () => {
    await seedProvider({ pricing: false });
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    expect(await maybeEscalateDecision(lowConfidence(), CONTEXT)).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("falls back when no monthly budget is configured", async () => {
    await seedProvider({ budget: false });
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    expect(await maybeEscalateDecision(lowConfidence(), CONTEXT)).toBeNull();
    expect(server.requests).toHaveLength(0);
  });

  it("falls back on a provider failure instead of throwing", async () => {
    server = makeOpenAiServer({
      failures: [
        { status: 500, body: { error: "upstream secret sk-live-999" } },
      ],
    });
    vi.stubGlobal("fetch", server.fetch);
    await seedProvider();
    await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
    const result = await maybeEscalateDecision(lowConfidence(), CONTEXT);
    expect(result).toBeNull();
  });
});
