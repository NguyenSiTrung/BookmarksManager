import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { grantConsentAtOrigin } from "../../src/consent/records";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { makeOpenAiServer } from "../mock-servers/openai";
import { proposeLayout } from "../../src/restructure/propose";
import type { LibrarySynopsis } from "../../src/schemas/restructure";

/**
 * `proposeLayout` sends the bounded synopsis under the `llm_restructure`
 * scope as a `manual` request and returns a schema-validated
 * `RestructureProposal`. Over-limit or malformed proposals surface as the
 * structured engine's error — never a silently truncated plan.
 */

vi.stubGlobal("crypto", webcrypto);

/** Minimal chrome.storage.local backing for the credential store. */
function installChromeStub() {
  const store = new Map<string, unknown>();
  vi.stubGlobal("chrome", {
    permissions: { contains: async () => true },
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          if (keys === undefined || keys === null) {
            return Object.fromEntries(store);
          }
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            wanted.filter((k) => store.has(k)).map((k) => [k, store.get(k)]),
          );
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        async remove(keys: string | string[]) {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
  });
}
installChromeStub();

const PROVIDER_ID = "preset:openai";
const LLM_ORIGIN = "https://api.openai.com";

const SYNOPSIS: LibrarySynopsis = {
  folderPaths: ["Dev", "News", "News/World"],
  categories: { article: 3, docs: 1 },
  tags: { tools: 2 },
  domains: [
    { domain: "a-site.com", count: 2 },
    { domain: "news-site.com", count: 1 },
  ],
  representativeTitles: { Dev: ["Alpha tool"], News: ["Daily"] },
  bookmarkCount: 4,
};

const PROPOSAL = {
  folders: [
    { path: "dev/tools", description: "Developer utilities." },
    { path: "news", description: "News and press." },
  ],
};

function completion(payload: unknown) {
  return {
    model: "gpt-4o-mini-2024-07-18",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(payload) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 11 },
  };
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
  await grantConsentAtOrigin("llm_restructure", LLM_ORIGIN);
}

let server: ReturnType<typeof makeOpenAiServer>;

beforeEach(async () => {
  server = makeOpenAiServer({ completion: () => completion(PROPOSAL) });
  vi.stubGlobal("fetch", server.fetch);
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("proposeLayout", () => {
  it("sends the synopsis under llm_restructure and returns the proposal", async () => {
    await seedProvider();
    const result = await proposeLayout(PROVIDER_ID, SYNOPSIS, {
      unknownCostConfirmed: true,
    });
    expect(result.proposal.folders.map((f) => f.path)).toEqual([
      "dev/tools",
      "news",
    ]);
    expect(result.model).toBe("gpt-4o-mini-2024-07-18");

    const request = server.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) throw new Error("no request");
    expect(request.url).toBe(`${LLM_ORIGIN}/v1/chat/completions`);
    const body = request.body as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = body.messages.find((m) => m.role === "user");
    if (user === undefined) throw new Error("no user message");
    const sentSynopsis = JSON.parse(user.content);
    expect(sentSynopsis).toEqual(SYNOPSIS);
    // No URL, notes, or bookmark id may reach the provider.
    expect(user.content).not.toContain("a-site.com/");
    expect(user.content).not.toContain("notes");
  });

  it("rejects when consent for llm_restructure is missing", async () => {
    const record: LlmProviderRecord = {
      providerId: PROVIDER_ID,
      provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
      keySuffix: "1234",
      configuredAt: "2026-09-15T00:00:00.000Z",
    };
    await saveLlmProvider(record);
    await saveCredential(PROVIDER_ID, "sk-test-1234");
    await expect(
      proposeLayout(PROVIDER_ID, SYNOPSIS, { unknownCostConfirmed: true }),
    ).rejects.toMatchObject({ code: "no_consent" });
    expect(server.requests).toHaveLength(0);
  });

  it("surfaces confirmation_required for an unpriced provider", async () => {
    const record: LlmProviderRecord = {
      providerId: "custom:http://localhost:8787",
      provider: {
        kind: "custom",
        baseUrl: "http://localhost:8787",
        model: "local-model",
        auth: "none",
      },
      keySuffix: "none",
      configuredAt: "2026-09-15T00:00:00.000Z",
    };
    await saveLlmProvider(record);
    await grantConsentAtOrigin("llm_restructure", "http://localhost:8787");
    await expect(proposeLayout("custom:http://localhost:8787", SYNOPSIS)).rejects.toMatchObject({
      code: "confirmation_required",
    });
  });

  it("rejects an over-limit proposal instead of truncating", async () => {
    await seedProvider();
    server = makeOpenAiServer({
      completion: () => completion({
        folders: [{ path: "a/b/c/d/e", description: "" }],
      }),
    });
    vi.stubGlobal("fetch", server.fetch);
    await expect(
      proposeLayout(PROVIDER_ID, SYNOPSIS, { unknownCostConfirmed: true }),
    ).rejects.toThrow();
  });

  it("rejects an unknown provider id", async () => {
    await expect(
      proposeLayout("preset:missing", SYNOPSIS),
    ).rejects.toMatchObject({ code: "invalid_provider" });
  });
});
