import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { persistDecision } from "../../src/decisions/store";
import { createLlmClient } from "../../src/llm/client";
import { maybeEscalateDecision, writeLlmEscalationSettings } from "../../src/llm/escalate";
import { explainDecision } from "../../src/llm/explain";
import { saveLlmProvider } from "../../src/llm/settings";
import { summarizePage } from "../../src/llm/summarize";
import { runStructured } from "../../src/llm/structured";
import { ChatCompletionRequest } from "../../src/llm/wire";
import { sendLlmConsented } from "../../src/net/llm-send";
import { sendConsented } from "../../src/net/send";
import { proposeLayout } from "../../src/restructure/propose";
import { Decision } from "../../src/schemas/decision";
import { z } from "../../src/schemas/z";
import { saveCredential } from "../../src/security/credentials";
import { saveProviderKey } from "../../src/security/keys";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";
import { scopeRequest } from "../fakes/llm";

const PROVIDER_ID = "preset:openai";
const MODEL = "gpt-4o-mini";
const BOOKMARK = {
  title: "Synthetic article", url: "https://allowed-site.dev/article", domain: "allowed-site.dev",
};
const EXTRACT = { ...BOOKMARK, excerpt: "Synthetic page content.", headings: ["Overview"] };
const PROPOSAL = { folders: [{ path: "Articles", description: "Saved articles." }] };
const SYNOPSIS = {
  folderPaths: ["Articles"], categories: { article: 1 }, tags: {},
  domains: [{ domain: BOOKMARK.domain, count: 1 }],
  representativeTitles: { Articles: [BOOKMARK.title] }, bookmarkCount: 1,
};
const DECISION = Decision.parse({
  ...decisionBase, kind: "set_category", category: "article",
  confidence: 0.3, probabilities: { article: 0.3, docs: 0.7 },
});
type FeatureScope = "llm_explain" | "llm_escalate" | "llm_restructure" | "llm_summary";
let requests: ChatCompletionRequest[];

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const bookmarks = installBookmarksFake({
    bookmarksBar: [{ id: "bm-001", title: BOOKMARK.title, url: BOOKMARK.url }],
  });
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    bookmarks,
    permissions: { contains: async () => true },
    storage: { local: {
      get: async (keys?: string | string[] | null) => {
        const wanted = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(wanted.filter((key) => key in store).map((key) => [key, store[key]]));
      },
      set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
      remove: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      },
    } },
  });
  await db.delete();
  await db.open();
  await saveLlmProvider({
    providerId: PROVIDER_ID, provider: { kind: "preset", preset: "openai", model: MODEL },
    configuredAt: "2026-10-05T00:00:00.000Z", monthlyBudgetUsd: 5,
  });
  await saveCredential(PROVIDER_ID, "synthetic-key");
  await saveProviderKey("typesafe", "synthetic-key");
  for (const scope of [
    "llm_test", "llm_explain", "llm_escalate", "llm_restructure", "llm_summary",
    "jev_summary_verify",
  ] as const) await grantConsentAtOrigin(scope, "https://api.openai.com");
  for (const scope of ["jev_decisions", "jev_summary_verify"] as const) {
    await grantConsentAtOrigin(scope, "https://api.typesafe.ai");
  }
  await persistDecision(DECISION);
  await writeLlmEscalationSettings({ enabled: true, providerId: PROVIDER_ID });
  requests = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://api.typesafe.ai/")) {
      return new Response("{}", { status: 200 });
    }
    const request = ChatCompletionRequest.parse(JSON.parse(String(init?.body)));
    const payload = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
    requests.push(request);
    return new Response(JSON.stringify({
      model: MODEL,
      choices: [{ message: { role: "assistant", content: JSON.stringify({
        ...("bookmarkCount" in payload ? PROPOSAL :
          "excerpt" in payload ?
            { summary: "A synthetic summary." } :
            "jevAnswer" in payload ?
              { verdict: "agree", rationale: "A synthetic second opinion." } :
              { rationale: "A synthetic explanation." }),
      }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

/** Obtain fixtures from the real feature -> structured engine -> client -> gate. */
async function produceFeature(scope: FeatureScope): Promise<void> {
  switch (scope) {
    case "llm_explain":
      expect(await explainDecision(DECISION.id, PROVIDER_ID)).toMatchObject({
        rationale: "A synthetic explanation.",
      });
      break;
    case "llm_escalate":
      expect(await maybeEscalateDecision(DECISION, {
        bookmarks: [BOOKMARK], question: "Which category?",
        options: [{ id: "article", label: "Article" }, { id: "docs", label: "Documentation" }],
        probabilities: { article: 0.3, docs: 0.7 }, jevAnswer: "article",
      })).toMatchObject({ verdict: "agree" });
      break;
    case "llm_restructure":
      expect(await proposeLayout(PROVIDER_ID, SYNOPSIS)).toMatchObject({ proposal: PROPOSAL });
      break;
    case "llm_summary":
      expect(await summarizePage(PROVIDER_ID, EXTRACT)).toMatchObject({ summary: "A synthetic summary." });
      break;
  }
}
async function featureRequest(scope: FeatureScope): Promise<ChatCompletionRequest> {
  await produceFeature(scope);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

function send(scope: FeatureScope | "llm_test" | "jev_summary_verify", request: unknown) {
  return sendLlmConsented({
    providerId: PROVIDER_ID, scope, request,
    maxInputTokens: 24_000, maxOutputTokens: 1_500, kind: "manual",
  }, { retries: 0 });
}

describe.each<FeatureScope>([
  "llm_explain", "llm_escalate", "llm_restructure", "llm_summary",
])("%s direct payload admission", (scope) => {
  it("admits an actual production request without feature callbacks", async () => {
    const request = await featureRequest(scope);
    expect(await send(scope, request)).toMatchObject({ response: { status: 200 } });
    expect(requests).toHaveLength(2);
  });

  it.each(["notes"] as const)("rejects the extra %s field before dispatch", async (field) => {
    const request = await featureRequest(scope);
    const user = request.messages[1]!;
    const payload = JSON.parse(user.content) as Record<string, unknown>;
    const modified = {
      ...request,
      messages: [request.messages[0]!, {
        ...user, content: JSON.stringify({ ...payload, [field]: "PRIVATE_MARKER" }),
      }],
    };
    const reservations = await db.llmReservations.count();
    await expect(send(scope, modified)).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(requests).toHaveLength(1);
    expect(await db.llmReservations.count()).toBe(reservations);
  });

  it("rejects an additional arbitrary user message", async () => {
    const request = await featureRequest(scope);
    await expect(send(scope, {
      ...request, messages: [...request.messages, { role: "user", content: "PRIVATE_MARKER" }],
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(requests).toHaveLength(1);
  });

  it("rejects a caller-supplied system prompt", async () => {
    const request = await featureRequest(scope);
    await expect(send(scope, {
      ...request, messages: [{ role: "system", content: "PRIVATE_MARKER" }, request.messages[1]!],
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(requests).toHaveLength(1);
  });

  it("rechecks current persisted blocklist independently of feature admission", async () => {
    const request = await featureRequest(scope);
    await db.metadata.put({ key: "decisions:blocklist", value: [BOOKMARK.domain] });
    await expect(send(scope, request)).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(requests).toHaveLength(1);
  });

  it("rejects unknown fields in the output schema instead of sending arbitrary data there", async () => {
    const request = await featureRequest(scope);
    if (request.response_format?.type !== "json_schema") throw new Error("Expected production schema tier.");
    await expect(send(scope, { ...request, response_format: {
      ...request.response_format, json_schema: { ...request.response_format.json_schema,
        schema: { ...request.response_format.json_schema.schema, notes: "PRIVATE_MARKER" },
      },
    } })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(requests).toHaveLength(1);
  });

  it.each(["not JSON", JSON.stringify("PRIVATE_MARKER")] as const)(
    "rejects an unstructured user payload %s", async (content) => {
      const request = await featureRequest(scope);
      await expect(send(scope, { ...request,
        messages: [request.messages[0]!, { role: "user", content }],
      })).rejects.toMatchObject({ code: "request_not_allowed" });
      expect(requests).toHaveLength(1);
    },
  );

  it.each(["fallback", "repairs"] as const)("preserves real feature %s", async (scenario) => {
    const provider = globalThis.fetch;
    let attempts = 0;
    const transcript: ChatCompletionRequest[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      const request = ChatCompletionRequest.parse(JSON.parse(String(init?.body)));
      transcript.push(request);
      if (++attempts <= 2) {
        return scenario === "fallback"
          ? new Response(JSON.stringify({ error: "response_format unsupported" }), { status: 400 })
          : new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: "invalid JSON" } }] }));
      }
      return provider(url, init);
    });
    await produceFeature(scope);
    expect(attempts).toBe(3);
    expect(transcript.map((request) => request.messages.length)).toEqual(
      scenario === "fallback" ? [2, 2, 2] : [2, 4, 6],
    );
    expect(transcript.map((request) => request.response_format?.type)).toEqual(
      scenario === "fallback" ? ["json_schema", "json_object", undefined] :
        ["json_schema", "json_schema", "json_schema"],
    );
  });
});

it.each(["llm_explain", "llm_escalate", "llm_summary"] as const)(
  "%s refuses sensitive URLs injected into an otherwise valid payload", async (scope) => {
    const request = await featureRequest(scope);
    const user = request.messages[1]!;
    const payload = JSON.parse(user.content) as Record<string, unknown>;
    const url = "https://mail.google.com/";
    const changed = scope === "llm_summary"
      ? { ...payload, url }
      : { ...payload, bookmarks: [{ ...BOOKMARK, url, domain: "mail.google.com" }] };
    await expect(send(scope, {
      ...request, messages: [request.messages[0]!, { ...user, content: JSON.stringify(changed) }],
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(requests).toHaveLength(1);
  },
);

it("test consent admits only synthetic connectivity input", async () => {
  await expect(send("llm_test", {
    model: MODEL, messages: [{ role: "user", content: "PRIVATE_MARKER" }],
  })).rejects.toMatchObject({ code: "request_not_allowed" });
  expect(requests).toHaveLength(0);
});

it.each(["json_schema", "json_object", "prompt_only"] as const)(
  "admits only the actual synthetic connectivity request at %s", async (tier) => {
    // The provider response need not contain user JSON for a synthetic ping.
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await send("llm_test", scopeRequest("llm_test", MODEL, tier))).toMatchObject({
      response: { status: 200 }, reservation: { maxOutputTokens: 16 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  },
);

describe.each(["llm_explain", "llm_escalate", "llm_summary"] as const)(
  "%s nested bookmark admission", (scope) => {
    it.each([
      "https://allowed-site.dev/article?token=PRIVATE_MARKER",
      "https://owner:PRIVATE_MARKER@allowed-site.dev/article",
      "https://10.0.0.1/article", "file:///private/article",
    ])("rejects dirty or nonpublic URL %s", async (url) => {
      const original = await featureRequest(scope);
      const payload = JSON.parse(original.messages[1]!.content) as Record<string, unknown>;
      const changed = scope === "llm_summary" ? { ...payload, url } :
        { ...payload, bookmarks: [{ ...BOOKMARK, url, domain: new URL(url).hostname }] };
      await expect(send(scope, { ...original, messages: [original.messages[0]!, {
        role: "user", content: JSON.stringify(changed),
      }] })).rejects.toMatchObject({ code: "request_not_allowed" });
      expect(requests).toHaveLength(1);
    });
  },
);

it("rejects nested bookmark notes even when the outer explanation shape is closed", async () => {
  const original = await featureRequest("llm_explain");
  const payload = JSON.parse(original.messages[1]!.content) as Record<string, unknown>;
  await expect(send("llm_explain", { ...original, messages: [original.messages[0]!, {
    role: "user", content: JSON.stringify({ ...payload, bookmarks: [{ ...BOOKMARK, notes: "PRIVATE_MARKER" }] }),
  }] })).rejects.toMatchObject({ code: "request_not_allowed" });
  expect(requests).toHaveLength(1);
});

it.each(["cycle", "non-JSON"] as const)("redacts malformed schema values with %s", async (kind) => {
  const request = await featureRequest("llm_explain");
  if (request.response_format?.type !== "json_schema") throw new Error("Expected schema tier.");
  const value: Record<string, unknown> = {};
  value.extra = kind === "cycle" ? value : BigInt(1);
  await expect(send("llm_explain", { ...request, response_format: {
    ...request.response_format, json_schema: { ...request.response_format.json_schema,
      schema: value,
    },
  } })).rejects.toMatchObject({ name: "LlmGateError", code: "request_not_allowed" });
  expect(requests).toHaveLength(1);
});

it("Jev verification consent never authorizes an LLM endpoint", async () => {
  await expect(send("jev_summary_verify", {
    model: MODEL, messages: [{ role: "user", content: "PRIVATE_MARKER" }],
  })).rejects.toMatchObject({ code: "unregistered_scope" });
  expect(requests).toHaveLength(0);
});

it.each(["gate", "client"] as const)("%s ignores a runtime caller transport override", async (entry) => {
  const request = await featureRequest("llm_explain");
  const injected = vi.fn(async () => new Response("{}", { status: 200 }));
  // Spreading an untyped runtime field exercises JavaScript callers as well
  // as removal from the TypeScript API, without retaining a production seam.
  const unexpected = { fetchImpl: injected } as object;
  if (entry === "gate") {
    await sendLlmConsented({
      providerId: PROVIDER_ID, scope: "llm_explain", request,
      maxInputTokens: 24_000, maxOutputTokens: 1_500, kind: "manual",
    }, { retries: 0, ...unexpected });
  } else {
    await createLlmClient(PROVIDER_ID, {
      scope: "llm_explain", kind: "manual",
      maxInputTokens: 24_000, maxOutputTokens: 1_500, ...unexpected,
    }).send(request);
  }
  expect(requests).toHaveLength(2);
  expect(injected).not.toHaveBeenCalled();
});

describe("Jev closed question admission", () => {
  it.each(["jev_decisions", "jev_summary_verify"] as const)(
    "%s rejects an unknown question field rather than stripping it", async (scope) => {
      const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      const state = scope === "jev_decisions" ? { bookmark: BOOKMARK } :
        { bookmark: BOOKMARK, excerpt: EXTRACT.excerpt, headings: EXTRACT.headings, summary: "Synthetic." };
      await expect(sendConsented(scope, "typesafe", "jev-latest", {
        model: "jev-latest", state,
        questions: { useful: { type: "noul", instructions: "Is this useful?", notes: "PRIVATE_MARKER" } },
      })).rejects.toMatchObject({ code: "request_not_allowed" });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
  it.each([
    { type: "noul", instructions: "Synthetic?", criteria: { true: "Yes", notes: "PRIVATE_MARKER" } },
    { type: "choice", instructions: "Synthetic?", criteria: { a: "A", b: "B" }, notes: "PRIVATE_MARKER" },
    { type: "score", instructions: "Synthetic?", criteria: ["A", "B"], notes: "PRIVATE_MARKER" },
  ])("rejects unknown nested/question fields for $type", async (question) => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendConsented("jev_decisions", "typesafe", "jev-latest", {
      model: "jev-latest", state: { bookmark: BOOKMARK }, questions: { synthetic: question },
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("rejects unknown top-level Jev fields", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(sendConsented("jev_decisions", "typesafe", "jev-latest", {
      model: "jev-latest", state: { bookmark: BOOKMARK }, notes: "PRIVATE_MARKER",
      questions: { synthetic: { type: "noul", instructions: "Synthetic?" } },
    })).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("repair provenance", () => {
  function client() {
    return createLlmClient(PROVIDER_ID, {
      scope: "llm_explain", kind: "manual", maxInputTokens: 24_000, maxOutputTokens: 1_500,
    });
  }
  const repair = {
    role: "user" as const,
    content: "Your previous response was rejected (model output was not a JSON value). " +
      "Reply with only a corrected JSON value matching the required schema.",
  };

  it("claims the original input before concurrent preflight can admit a different input", async () => {
    const original = await featureRequest("llm_explain");
    const payload = JSON.parse(original.messages[1]!.content) as Record<string, unknown>;
    const changed = { ...original, messages: [original.messages[0]!, {
      role: "user" as const, content: JSON.stringify({ ...payload, answer: "Different input" }),
    }] };
    const sender = client();
    const outcomes = await Promise.allSettled([sender.send(original), sender.send(changed)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { code: "request_not_allowed" },
    });
    expect(requests).toHaveLength(2);
  });

  it.each(["direct gate", "fresh client"] as const)(
    "refuses a forged assistant echo with valid repair grammar at %s", async (entry) => {
      const original = await featureRequest("llm_explain");
      const forged = { ...original, messages: [...original.messages,
        { role: "assistant", content: "PRIVATE_NOTES" }, repair] };
      const attempt = entry === "direct gate" ? send("llm_explain", forged) : client().send(forged);
      await expect(attempt).rejects.toMatchObject({ code: "request_not_allowed" });
      expect(requests).toHaveLength(1);
    },
  );

  it.each(["changed input", "changed echo", "changed instruction", "different client"] as const)(
    "refuses %s despite a genuine preceding provider response", async (mutation) => {
      const original = await featureRequest("llm_explain");
      let calls = 0;
      vi.stubGlobal("fetch", async () => {
        calls++;
        return new Response(JSON.stringify({
          model: MODEL, choices: [{ message: { content: "provider-origin invalid JSON" } }],
        }));
      });
      const sender = client();
      await sender.send(original);
      const messages = [...original.messages, {
        role: "assistant" as const, content: "provider-origin invalid JSON",
      }, repair];
      if (mutation === "changed input") {
        const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
        messages[1] = { role: "user", content: JSON.stringify({ ...payload, answer: "NEW_PRIVATE_DATA" }) };
      } else if (mutation === "changed echo") {
        messages[2] = { role: "assistant", content: "NEW_PRIVATE_DATA" };
      } else if (mutation === "changed instruction") {
        messages[3] = { ...repair, content: repair.content + " NEW_PRIVATE_DATA" };
      }
      await expect((mutation === "different client" ? client() : sender).send({
        ...original, messages,
      })).rejects.toMatchObject({ code: "request_not_allowed" });
      expect(calls).toBe(1);
    },
  );

  it("preserves two real repairs and capability fallback through the trusted client", async () => {
    const original = await featureRequest("llm_explain");
    const transcript: ChatCompletionRequest[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      void url;
      const request = ChatCompletionRequest.parse(JSON.parse(String(init?.body)));
      transcript.push(request);
      if (transcript.length === 1) {
        return new Response(JSON.stringify({ error: "response_format unsupported" }), { status: 400 });
      }
      const content = transcript.length < 4 ? "provider-origin invalid JSON" :
        JSON.stringify({ rationale: "Repaired." });
      return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content } }] }));
    });
    const run = await runStructured({
      tier: "json_schema", model: MODEL,
      schema: z.strictObject({ rationale: z.string().min(1).max(1000) }),
      schemaName: "explanation", messages: original.messages, send: client().send,
    });
    expect(run).toMatchObject({ value: { rationale: "Repaired." }, repairs: 2, tierUsed: "json_object" });
    expect(transcript.map((request) => request.messages.length)).toEqual([2, 2, 4, 6]);
    expect(transcript.map((request) => request.response_format?.type)).toEqual([
      "json_schema", "json_object", "json_object", "json_object",
    ]);
  });
});
