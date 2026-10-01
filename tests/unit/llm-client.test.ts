import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin } from "../../src/consent/records";
import { readBlocklist } from "../../src/decisions/blocklist";
import { db } from "../../src/db/database";
import { createLlmClient, LlmHttpError } from "../../src/llm/client";
import { LlmGateError } from "../../src/net/llm-send";
import { LlmCapabilityError } from "../../src/llm/structured";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { makeOpenAiServer } from "../mock-servers/openai";
import type { LlmProviderRecord } from "../../src/schemas/llm";

vi.stubGlobal("crypto", webcrypto);

const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";

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
          for (const k of Array.isArray(keys) ? keys : [keys])
            delete store[k];
        },
      },
    },
    permissions: { contains: async () => true },
  });
}

const record: LlmProviderRecord = {
  providerId: PROVIDER_ID,
  provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
  configuredAt: "2026-09-15T00:00:00.000Z",
  monthlyBudgetUsd: 5,
};

const REQUEST = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
};

function client(fetchImpl: typeof fetch, beforeSend?: () => Promise<void>) {
  return createLlmClient(PROVIDER_ID, {
    scope: "llm_test",
    kind: "manual",
    maxInputTokens: 100,
    maxOutputTokens: 50,
    unknownCostConfirmed: true,
    fetchImpl,
    ...(beforeSend !== undefined ? { beforeSend } : {}),
  });
}

beforeEach(async () => {
  installChromeStub();
  await db.delete();
  await db.open();
  await saveLlmProvider(record);
  await grantConsentAtOrigin("llm_test", ORIGIN);
  await saveCredential(PROVIDER_ID, "sk-test");
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("createLlmClient", () => {
  it.each(["429", "transport"] as const)(
    "carries feature admission through an internal %s retry and accounts prior exposure",
    async (failure) => {
      const server = makeOpenAiServer({
        failures: [failure === "429" ? { status: 429 } : { throw: new TypeError("reset") }],
      });
      const fetchImpl: typeof fetch = async (...args) => {
        try {
          return await server.fetch(...args);
        } finally {
          await db.metadata.put({ key: "decisions:blocklist", value: ["a-site.com"] });
        }
      };
      const beforeSend = async () => {
        if ((await readBlocklist()).includes("a-site.com")) {
          throw new LlmGateError("request_not_allowed", "Feature admission refused.");
        }
      };
      await expect(client(fetchImpl, beforeSend).send(REQUEST)).rejects.toMatchObject({
        code: "request_not_allowed",
      });
      expect(server.requests).toHaveLength(1);
      expect((await db.llmReservations.toArray())[0]?.status).toBe("settled");
      expect(await db.llmUsage.toArray()).toMatchObject([{
        feature: "llm_test", inputTokens: 100, outputTokens: 50,
        estimatedCostUsd: expect.closeTo(0.000045, 10),
      }]);
    },
  );

  it("returns the parsed completion JSON and settles usage", async () => {
    const { fetch } = makeOpenAiServer({
      completion: (body) => ({
        id: "c1",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "{}" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
    });
    const raw = await client(fetch).send(REQUEST);
    expect(raw).toMatchObject({ model: "gpt-4o-mini" });
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      providerId: PROVIDER_ID,
      feature: "llm_test",
      configuredModel: "gpt-4o-mini",
      inputTokens: 12,
      outputTokens: 8,
    });
    // The reservation was settled, not left active.
    const reservations = await db.llmReservations.toArray();
    expect(reservations[0]?.status).toBe("settled");
  });

  it("throws LlmCapabilityError when the provider rejects response_format", async () => {
    const { fetch } = makeOpenAiServer({
      failures: [
        {
          status: 400,
          body: {
            error: { message: "response_format is not supported by this model" },
          },
        },
      ],
    });
    await expect(client(fetch).send(REQUEST)).rejects.toBeInstanceOf(
      LlmCapabilityError,
    );
  });

  it("throws LlmHttpError for ordinary 4xx without a capability hint", async () => {
    const { fetch } = makeOpenAiServer({
      failures: [{ status: 401, body: { error: { message: "bad key" } } }],
    });
    const error = (await client(fetch)
      .send(REQUEST)
      .catch((caught: unknown) => caught)) as LlmHttpError;
    expect(error).toBeInstanceOf(LlmHttpError);
    expect(error.status).toBe(401);
    // The message carries the status only — never the provider's body.
    expect(error.message).not.toContain("bad key");
  });

  it("settles zero-usage on a non-JSON body", async () => {
    const fetchImpl = (async () =>
      new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const error = await client(fetchImpl)
      .send(REQUEST)
      .catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    const usage = await db.llmUsage.toArray();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});
