import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grantConsentAtOrigin,
  revokeConsentAtOrigin,
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

async function seedProvider(
  opts: { consent?: boolean; model?: string } = {},
) {
  const { consent = true, model = "gpt-4o-mini" } = opts;
  const record: LlmProviderRecord = {
    providerId: PROVIDER_ID,
    provider: { kind: "preset", preset: "openai", model },
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
          budget: "unset",
          pricingKnown: false,
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
          budget: "capped",
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
      // A preset model with no built-in price (and no override) is the only
      // way a manual request still needs the unknown-cost confirmation.
      await seedProvider({ model: "gpt-4o-mini-2024-07-18" });
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
        { type: "LLM_EXPLAIN", decisionId: UUID, unknownCostConfirmed: true,
          consentApproval: { providerId: PROVIDER_ID, origin: ORIGIN, model: "gpt-4o-mini-2024-07-18",
            endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5 } },
        TRUSTED,
      );
      expect(second).toMatchObject({
        ok: true,
        code: "explain_ok",
        result: {
          decisionId: UUID,
          rationale: "Because it reads like docs.",
          model: "gpt-4o-mini-2024-07-18",
        },
      });
      const row = await getDecision(UUID);
      expect(row?.rationale).toBe("Because it reads like docs.");
      expect(server.requests).toHaveLength(1);
    });

    it("explains without a confirmation when the preset model is priced", async () => {
      await seedProvider();
      await persistDecision(pendingDecision());
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      expect(reply).toMatchObject({
        ok: true,
        code: "explain_ok",
        result: { decisionId: UUID, model: "gpt-4o-mini" },
      });
      expect(server.requests).toHaveLength(1);
    });

    it("relays a transport abort as aborted, not timeout or internal_error", async () => {
      await seedProvider();
      await persistDecision(pendingDecision());
      vi.stubGlobal("fetch", async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      });
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: false, code: "aborted" });
    });

    it("leaks no title, url, or key material in any reply", async () => {
      await seedProvider();
      await persistDecision(pendingDecision());
      const reply = await handleLlmFeatureMessage(
        { type: "LLM_EXPLAIN", decisionId: UUID },
        TRUSTED,
      );
      expect(reply).toMatchObject({ ok: true, code: "explain_ok" });
      expect(server.requests).toHaveLength(1);
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

    it.each(["missing", "stale", "foreign"] as const)("refuses %s consent without creating a grant or sending", async (mode) => {
      await seedProvider({ consent: false });
      await persistDecision(pendingDecision());
      if (mode !== "missing") await db.consents.put({
        scope: "llm_explain", origin: mode === "foreign" ? "https://foreign.dev" : ORIGIN,
        consentVersion: mode === "foreign" ? 5 : 4, acceptedAt: "2020-01-01T00:00:00.000Z",
      });
      const before = await db.consents.toArray();
      const reply = await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID }, TRUSTED);
      expect(reply).toMatchObject({ ok: false, code: "consent_required", consent: {
        scope: "llm_explain", recipient: "OpenAI", approval: {
          providerId: PROVIDER_ID, origin: ORIGIN, model: "gpt-4o-mini",
          endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5,
        },
      } });
      expect(await db.consents.toArray()).toEqual(before);
      expect(server.requests).toHaveLength(0);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();
      expect(await db.jobs.count()).toBe(0);
    });

    it("honors an affirmative exact-origin grant and bound retry without refreshing it", async () => {
      await seedProvider({ consent: false });
      await persistDecision(pendingDecision());
      await grantConsentAtOrigin("llm_explain", ORIGIN);
      const before = await db.consents.toArray();
      const reply = await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID,
        consentApproval: { providerId: PROVIDER_ID, origin: ORIGIN, model: "gpt-4o-mini",
          endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5 } }, TRUSTED);
      expect(reply).toMatchObject({ ok: true, code: "explain_ok" });
      expect(server.requests).toHaveLength(1);
      expect(await db.consents.toArray()).toEqual(before);
    });

    it.each(["revoked", "model", "endpoint", "provider", "version"] as const)("refuses a bound retry after %s changed", async (change) => {
      await seedProvider();
      await persistDecision(pendingDecision());
      if (change === "revoked") await revokeConsentAtOrigin("llm_explain", ORIGIN);
      const approval = { providerId: PROVIDER_ID, origin: ORIGIN, model: "gpt-4o-mini",
        endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5 };
      if (change === "model") approval.model = "different-model";
      if (change === "endpoint") approval.endpoint = `${ORIGIN}/other/chat/completions`;
      if (change === "provider") approval.providerId = "preset:openrouter";
      if (change === "version") approval.consentVersion = 4;
      expect(await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID,
        unknownCostConfirmed: true, consentApproval: approval }, TRUSTED))
        .toMatchObject({ ok: false, code: "consent_required" });
      expect(server.requests).toHaveLength(0);
      expect((await getDecision(UUID))?.rationale).toBeUndefined();
    });

    it.each(["switch", "reconfigure"] as const)("re-resolves the current provider after a cost challenge and refuses %s", async (change) => {
      await seedProvider({ model: "gpt-4o-mini-2024-07-18" });
      await persistDecision(pendingDecision());
      const first = await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID }, TRUSTED);
      const bound = { providerId: PROVIDER_ID, origin: ORIGIN,
        model: "gpt-4o-mini-2024-07-18", endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5 };
      expect(first).toMatchObject({ ok: false, code: "confirmation_required", consentApproval: bound });
      if (change === "switch") {
        await saveLlmProvider({ providerId: "preset:openrouter", keySuffix: "1234",
          provider: { kind: "preset", preset: "openrouter", model: "openai/gpt-4o-mini" },
          configuredAt: "2026-09-15T00:00:00.000Z" });
        await grantConsentAtOrigin("llm_explain", "https://openrouter.ai");
      } else {
        await seedProvider({ model: "gpt-4o-mini" });
      }
      const before = await db.consents.toArray();
      expect(await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID,
        consentApproval: bound, unknownCostConfirmed: true }, TRUSTED))
        .toMatchObject({ ok: false, code: "consent_required" });
      expect(server.requests).toHaveLength(0);
      expect(await db.consents.toArray()).toEqual(before);
    });

    it("cost approval without a destination binding cannot authorize even a granted recipient", async () => {
      await seedProvider();
      await persistDecision(pendingDecision());
      expect(await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID,
        unknownCostConfirmed: true }, TRUSTED)).toMatchObject({ ok: false, code: "consent_required" });
      expect(server.requests).toHaveLength(0);
    });

    it("rejects content smuggled into the closed approval before any send", async () => {
      await seedProvider();
      expect(await handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: UUID,
        consentApproval: { providerId: PROVIDER_ID, origin: ORIGIN, model: "gpt-4o-mini",
          endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5, notes: "private-notes" } }, TRUSTED))
        .toMatchObject({ ok: false, code: "malformed_message" });
      expect(server.requests).toHaveLength(0);
    });
  });
});
