import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  hasConsentAtOrigin,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { getDecision, persistDecision } from "../../src/decisions/store";
import { handleLlmFeatureMessage } from "../../src/messages/llm-features";
import { saveLlmProvider } from "../../src/llm/settings";
import { saveCredential } from "../../src/security/credentials";
import { Decision } from "../../src/schemas/decision";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";
import { makeOpenAiServer } from "../mock-servers/openai";

vi.stubGlobal("crypto", webcrypto);

/**
 * Worker protocol for the Phase-3 feature intents (plan Phase 3 Task 3):
 * Explain, escalation settings read/write, and the feature budget — total
 * handlers, trusted-sender checks, stable codes, and nothing confidential
 * crossing a reply.
 */

const PROVIDER_ID = "preset:openai";
const ORIGIN = "https://api.openai.com";
const EXT = "chrome-extension://testext";
const TRUSTED = { url: `${EXT}/sidepanel.html` };
const UNTRUSTED = { url: "https://evil.example/page" };
const UUID = "9b7b5f8e-2c3a-4d1e-9f0a-1b2c3d4e5f6a";

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
    usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
  });
}

function installChromeStub(bookmarks: unknown) {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    bookmarks,
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
    runtime: { getURL: (path: string) => `${EXT}/${path}` },
  });
}

function pendingDecision(over: Record<string, unknown> = {}) {
  return Decision.parse({
    ...decisionBase,
    id: UUID,
    kind: "set_category",
    category: "article",
    probabilities: { article: 0.62, news: 0.38 },
    ...over,
  });
}

async function seedProvider(opts: { consent?: boolean } = {}) {
  const { consent = true } = opts;
  const record: LlmProviderRecord = {
    providerId: PROVIDER_ID,
    provider: { kind: "preset", preset: "openai", model: "gpt-4o-mini" },
    keySuffix: "1234",
    configuredAt: "2026-09-15T00:00:00.000Z",
    monthlyBudgetUsd: 5,
  };
  await saveLlmProvider(record);
  await saveCredential(PROVIDER_ID, "sk-test-1234");
  if (consent) {
    await grantConsentAtOrigin("llm_explain", ORIGIN);
    await grantConsentAtOrigin("llm_escalate", ORIGIN);
  }
}

beforeEach(async () => {
  const bookmarks = installBookmarksFake({
    bookmarksBar: [
      { id: "bm-001", title: "A", url: "https://a-site.com/?q=secret" },
    ],
  });
  installChromeStub(bookmarks);
  server = makeOpenAiServer({
    completion: completionWith({ rationale: "Because it reads like docs." }),
  });
  vi.stubGlobal("fetch", server.fetch);
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("handleLlmFeatureMessage", () => {
  it("ignores message types it does not own", async () => {
    expect(
      await handleLlmFeatureMessage({ type: "ANALYZE_BOOKMARK" }, TRUSTED),
    ).toBeUndefined();
    expect(await handleLlmFeatureMessage("nonsense", TRUSTED)).toBeUndefined();
    expect(
      await handleLlmFeatureMessage({ type: "LLM_TEST" }, TRUSTED),
    ).toBeUndefined();
  });

  it("rejects untrusted senders for every owned type", async () => {
    for (const type of [
      "LLM_EXPLAIN",
      "LLM_ESCALATION_STATUS",
      "LLM_ESCALATION_SET",
      "LLM_FEATURE_BUDGET",
    ]) {
      const reply = await handleLlmFeatureMessage(
        { type, decisionId: "x", enabled: false },
        UNTRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "untrusted_sender" });
    }
  });

  it("rejects malformed owned messages with a stable code", async () => {
    expect(
      await handleLlmFeatureMessage({ type: "LLM_EXPLAIN" }, TRUSTED),
    ).toMatchObject({ ok: false, code: "malformed_message" });
    expect(
      await handleLlmFeatureMessage(
        { type: "LLM_ESCALATION_SET", enabled: "yes" },
        TRUSTED,
      ),
    ).toMatchObject({ ok: false, code: "malformed_message" });
  });

  describe("LLM_ESCALATION_STATUS / LLM_ESCALATION_SET", () => {
    it("reports disabled with no provider configured", async () => {
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_ESCALATION_STATUS" },
        TRUSTED,
      );
      expect(reply).toMatchObject({
        ok: true,
        code: "escalation_status",
        escalation: {
          enabled: false,
          providerConfigured: false,
          monthlyBudgetUsd: null,
        },
      });
    });

    it("enables escalation for the named provider", async () => {
      await seedProvider();
      const reply = await handleLlmFeatureMessage(
        {
          type: "LLM_ESCALATION_SET",
          enabled: true,
          providerId: PROVIDER_ID,
        },
        TRUSTED,
      );
      expect(reply).toMatchObject({
        ok: true,
        escalation: {
          enabled: true,
          providerId: PROVIDER_ID,
          providerConfigured: true,
          monthlyBudgetUsd: 5,
        },
      });
    });

    it("defaults to the active provider when enabling without an id", async () => {
      await seedProvider();
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_ESCALATION_SET", enabled: true },
        TRUSTED,
      );
      expect(reply).toMatchObject({
        ok: true,
        escalation: { enabled: true, providerId: PROVIDER_ID },
      });
    });

    it("refuses to enable without a configured provider", async () => {
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_ESCALATION_SET", enabled: true },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "no_provider" });
      // Nothing was persisted as enabled.
      expect(
        await handleLlmFeatureMessage(
          { type: "LLM_ESCALATION_STATUS" },
          TRUSTED,
        ),
      ).toMatchObject({ escalation: { enabled: false } });
    });

    it("disables escalation and keeps the stored provider id", async () => {
      await seedProvider();
      await handleLlmFeatureMessage(
        {
          type: "LLM_ESCALATION_SET",
          enabled: true,
          providerId: PROVIDER_ID,
        },
        TRUSTED,
      );
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_ESCALATION_SET", enabled: false },
        TRUSTED,
      );
      expect(reply).toMatchObject({
        ok: true,
        escalation: { enabled: false, providerId: PROVIDER_ID },
      });
    });
  });

  describe("LLM_FEATURE_BUDGET", () => {
    it("reports the snapshot for the escalation provider", async () => {
      await seedProvider();
      await handleLlmFeatureMessage(
        {
          type: "LLM_ESCALATION_SET",
          enabled: true,
          providerId: PROVIDER_ID,
        },
        TRUSTED,
      );
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_FEATURE_BUDGET" },
        TRUSTED,
      );
      expect(reply).toMatchObject({
        ok: true,
        code: "budget_snapshot",
        snapshot: { budgetUsd: 5, requestCount: 0 },
      });
    });

    it("returns no_provider when nothing is configured", async () => {
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_FEATURE_BUDGET" },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "no_provider" });
    });
  });

  describe("LLM_EXPLAIN", () => {
    it("returns no_provider when nothing is configured", async () => {
      await persistDecision(pendingDecision());
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "no_provider" });
    });

    it("requires the manual cost confirmation, then honors the resend flag", async () => {
      await seedProvider();
      await persistDecision(pendingDecision());
      // An unpriced manual request stops at confirmation_required — the
      // CostConfirmationDialog path; nothing was sent yet.
      const first = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      expect(first).toMatchObject({
        ok: false,
        code: "confirmation_required",
      });
      expect(server.requests).toHaveLength(0);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();

      const second = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID, unknownCostConfirmed: true },
        TRUSTED,
      );
      expect(second).toMatchObject({
        ok: true,
        code: "explain_ok",
        result: {
          decisionId: UUID,
          rationale: "Because it reads like docs.",
          model: "gpt-4o-mini",
        },
      });
      const row = await getDecision(UUID);
      expect(row?.rationale).toBe("Because it reads like docs.");
      expect(server.requests).toHaveLength(1);
    });

    it("leaks no title, url, or key material in any reply", async () => {
      await seedProvider();
      await persistDecision(pendingDecision());
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID, unknownCostConfirmed: true },
        TRUSTED,
      );
      const text = JSON.stringify(reply);
      expect(text).not.toContain("a-site.com");
      expect(text).not.toContain("sk-test-1234");
      expect(text).not.toContain("?q=secret");
    });

    it("returns not_found for an unknown decision", async () => {
      await seedProvider();
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: "no-such-id" },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "not_found" });
    });

    it("returns not_pending for a decision outside the review queue", async () => {
      await seedProvider();
      await persistDecision(pendingDecision({ status: "unsure" }));
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "not_pending" });
      expect(server.requests).toHaveLength(0);
    });

    it("grants llm_explain at the click, then hits the next gate", async () => {
      await seedProvider({ consent: false });
      await persistDecision(pendingDecision());
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      // The click IS the consent trigger (spec FR3): the origin-scoped
      // grant is written, and the unpriced model then stops on
      // confirmation_required — never on a missing consent row.
      expect(reply).toMatchObject({ ok: false, code: "confirmation_required" });
      await expect(hasConsentAtOrigin("llm_explain", ORIGIN)).resolves.toBe(true);
      // The decision is untouched — an explanation never mutates state.
      const row = await getDecision(UUID);
      expect(row?.status).toBe("pending");
      expect(row?.rationale).toBeUndefined();
    });
  });
});
