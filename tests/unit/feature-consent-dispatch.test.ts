import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsentAtOrigin, revokeConsentAtOrigin } from "../../src/consent/records";
import { db } from "../../src/db/database";
import { DECISION_BLOCKLIST_KEY } from "../../src/decisions/blocklist";
import { getDecision, persistDecision } from "../../src/decisions/store";
import { saveLlmProvider } from "../../src/llm/settings";
import { handleLlmFeatureMessage } from "../../src/messages/llm-features";
import { handleRestructureMessage } from "../../src/messages/restructure";
import type { FeatureConsentApproval } from "../../src/schemas/feature-consent";
import { Decision } from "../../src/schemas/decision";
import type { LlmProviderRecord } from "../../src/schemas/llm";
import { saveCredential } from "../../src/security/credentials";
import { createFakeBookmarks } from "../fakes/chrome-bookmarks";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { decisionBase } from "../fixtures/base-records";
import { makeOpenAiServer } from "../mock-servers/openai";

const ORIGIN = "https://api.openai.com";
const PROVIDER = "preset:openai";
const NOW = "2026-09-15T00:00:00.000Z";
const SENDER = { url: "chrome-extension://dispatch-test/sidepanel.html" };
const features = ["llm_explain", "llm_restructure"] as const;
type Feature = typeof features[number];
let api: FakeBookmarksApi;
let permission: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let server: ReturnType<typeof makeOpenAiServer>;
const runJob = vi.fn(async () => undefined);

function completion(feature: Feature, malformed = false) {
  return (body: { model: string }) => ({
    id: "synthetic-completion", object: "chat.completion", model: body.model,
    choices: [{ index: 0, message: { role: "assistant",
      content: malformed ? "{}" : JSON.stringify(feature === "llm_explain"
        ? { rationale: "A synthetic explanation." }
        : { folders: [{ path: "Reading", description: "Resources" }] }),
    }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
  });
}

function installChrome(bookmarks: FakeBookmarksApi) {
  const store: Record<string, unknown> = {};
  permission = vi.fn(async () => true);
  vi.stubGlobal("chrome", {
    bookmarks,
    permissions: { contains: permission },
    runtime: { getURL: (path: string) => `chrome-extension://dispatch-test/${path}` },
    storage: { local: {
      async get(key: string) { return { [key]: store[key] }; },
      async set(values: Record<string, unknown>) { Object.assign(store, values); },
      async remove(key: string) { delete store[key]; },
    } },
  });
}

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  api = createFakeBookmarks({ bookmarksBar: [
    { id: "folder", title: "Private source folder", children: [
      { id: "bm-001", title: "Private source title", url: "https://allowed-source.dev/article" },
    ] },
  ] });
  installChrome(api);
  await db.delete();
  await db.open();
  runJob.mockClear();
  await persistDecision(Decision.parse({ ...decisionBase, kind: "set_category", category: "article" }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => db.close());

async function seed(feature: Feature, costRetry = false): Promise<FeatureConsentApproval> {
  const model = costRetry ? "gpt-4o-mini-2024-07-18" : "gpt-4o-mini";
  await saveLlmProvider({
    providerId: PROVIDER, provider: { kind: "preset", preset: "openai", model },
    configuredAt: NOW, keySuffix: "1234", monthlyBudgetUsd: 5,
  });
  await saveCredential(PROVIDER, "sk-synthetic-1234");
  await grantConsentAtOrigin(feature, ORIGIN);
  server = makeOpenAiServer({ completion: completion(feature) });
  vi.stubGlobal("fetch", server.fetch);
  return { providerId: PROVIDER, origin: ORIGIN, model,
    endpoint: `${ORIGIN}/v1/chat/completions`, consentVersion: 5 };
}

function invoke(feature: Feature, approval: FeatureConsentApproval, costRetry = false) {
  const binding = { consentApproval: approval, ...(costRetry ? { unknownCostConfirmed: true } : {}) };
  return feature === "llm_explain"
    ? handleLlmFeatureMessage({ type: "LLM_EXPLAIN", decisionId: decisionBase.id, ...binding }, SENDER)
    : handleRestructureMessage({ type: "RESTRUCTURE_START", providerId: "active", ...binding }, SENDER, { runJob });
}

async function changeRecipient(feature: Feature, change: "model" | "active" | "origin" | "revoke") {
  if (change === "revoke") {
    await revokeConsentAtOrigin(feature, ORIGIN);
    return;
  }
  const record: LlmProviderRecord = change === "model"
    ? { providerId: PROVIDER, provider: { kind: "preset", preset: "openai",
      model: "changed-model", pricing: { inputPerMillion: 1, outputPerMillion: 1 } }, configuredAt: NOW }
    : change === "active"
      ? { providerId: "preset:openrouter", provider: { kind: "preset", preset: "openrouter",
        model: "openai/gpt-4o-mini" }, configuredAt: NOW }
      : { providerId: "custom:http://localhost:11435/v1", provider: { kind: "custom",
        baseUrl: "http://localhost:11435/v1", model: "local-model", auth: "none",
        pricing: { inputPerMillion: 1, outputPerMillion: 1 } }, configuredAt: NOW };
  await saveLlmProvider(record);
  // Even an independently granted new recipient must not consume the old approval.
  await grantConsentAtOrigin(feature, change === "model" ? ORIGIN
    : change === "active" ? "https://openrouter.ai" : "http://localhost:11435");
}

function holdRead(feature: Feature, checkpoint: "native" | "permission") {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  if (checkpoint === "permission") {
    permission.mockImplementationOnce(async () => { entered = true; await held; return true; });
  } else if (feature === "llm_explain") {
    const get = api.get.bind(api);
    vi.spyOn(api, "get").mockImplementationOnce(async (id) => {
      const captured = await get(id);
      entered = true;
      await held;
      return captured;
    });
  } else {
    const getSubTree = api.getSubTree.bind(api);
    vi.spyOn(api, "getSubTree").mockImplementationOnce(async (id) => {
      const captured = await getSubTree(id);
      entered = true;
      await held;
      return captured;
    });
  }
  return { release, entered: () => entered };
}

for (const feature of features) {
  describe(`${feature} dispatch authority`, () => {
    for (const costRetry of [false, true]) {
      for (const checkpoint of ["native", "permission"] as const) {
        it.each(["model", "active", "origin", "revoke"] as const)(
          `${costRetry ? "cost retry" : "affirmative retry"} refuses %s changed during ${checkpoint} preflight`,
          async (change) => {
            const approval = await seed(feature, costRetry);
            if (costRetry) {
              expect(await invoke(feature, approval)).toMatchObject({ ok: false,
                code: "confirmation_required", consentApproval: approval });
              expect(server.requests).toHaveLength(0);
            }
            const held = holdRead(feature, checkpoint);
            const pending = invoke(feature, approval, costRetry);
            try {
              await vi.waitFor(() => expect(held.entered()).toBe(true));
              await changeRecipient(feature, change);
              const grants = await db.consents.toArray();
              held.release();
              const reply = await pending;
              expect(reply).toMatchObject({ ok: false, code: "consent_required",
                consent: { scope: feature } });
              if (change === "model") expect(reply).toMatchObject({ consent: { approval: { model: "changed-model" } } });
              if (change === "origin") expect(reply).toMatchObject({ consent: { approval: { origin: "http://localhost:11435" } } });
              expect(server.requests).toHaveLength(0);
              expect(await db.consents.toArray()).toEqual(grants);
              expect(await db.sentLog.count()).toBe(0);
              expect(await db.jobs.count()).toBe(0);
              expect(runJob).not.toHaveBeenCalled();
              expect((await getDecision(decisionBase.id))?.rationale).toBeUndefined();
              expect((await db.llmReservations.toArray()).filter((row) => row.status === "active")).toHaveLength(0);
              expect(JSON.stringify(reply)).not.toContain("Private source");
            } finally {
              held.release();
              await pending;
            }
          },
        );
      }
    }

    for (const costRetry of [false, true]) {
      for (const retry of ["capability", "repair", "transport", "http"] as const) {
        it.each(["model", "active", "origin", "revoke"] as const)(
          `rechecks ${costRetry ? "cost" : "affirmative"} authority before the subsequent ${retry} dispatch after %s`,
          async (change) => {
            const approval = await seed(feature, costRetry);
            if (costRetry) {
              expect(await invoke(feature, approval)).toMatchObject({ ok: false,
                code: "confirmation_required", consentApproval: approval });
              expect(server.requests).toHaveLength(0);
            }
            const original = makeOpenAiServer({
              completion: completion(feature, retry === "repair"),
              ...(retry === "capability" ? { failures: [{ status: 400, body: {
                error: { message: "unsupported response_format json_schema", param: "response_format" },
              } }] } : retry === "transport" ? { failures: [{ throw: new TypeError("Synthetic transport failure") }] }
                : retry === "http" ? { failures: [{ status: 503 }] } : {}),
            });
            server = original;
            vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
              try {
                return await original.fetch(input, init);
              } finally {
                if (original.requests.length === 1) await changeRecipient(feature, change);
              }
            }) as typeof fetch);
            const reply = await invoke(feature, approval, costRetry);
            expect(reply).toMatchObject({ ok: false, code: "consent_required" });
            expect(server.requests).toHaveLength(1);
            expect((await db.llmReservations.toArray()).filter((row) => row.status === "active")).toHaveLength(0);
            expect(await db.jobs.count()).toBe(0);
            expect((await getDecision(decisionBase.id))?.rationale).toBeUndefined();
          },
        );
      }

    }

    it("succeeds through the real service/client/gate with unchanged authority", async () => {
      const approval = await seed(feature);
      expect(await invoke(feature, approval)).toMatchObject({ ok: true,
        code: feature === "llm_explain" ? "explain_ok" : "job_ok" });
      expect(server.requests).toHaveLength(1);
    });
  });
}

describe("restructure complete local source provenance", () => {
  async function library() {
    // Fifty earlier equally frequent domains occupy the complete visible cap.
    // The last host still contributes its title, tag, category and folder path.
    api = createFakeBookmarks({ bookmarksBar: [
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `common-${index}`, title: `Common ${index}`, url: `https://a${index.toString().padStart(2, "0")}.dev/article`,
      })),
      { id: "omitted-folder", title: "Omitted source folder", children: [
        { id: "omitted", title: "Unique omitted-host title", url: "https://zz-omitted.dev/article" },
      ] },
      { id: "empty", title: "Harmless empty folder", children: [] },
      { id: "already-blocked-folder", title: "Already blocked folder", children: [
        { id: "already-blocked", title: "Already blocked title", url: "https://already-blocked.dev" },
      ] },
    ] });
    installChrome(api);
    await db.bookmarkMeta.put({ id: "omitted", tags: ["unique-omitted-tag"], category: "paper", updatedAt: NOW });
    await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value: ["already-blocked.dev"] });
    return seed("llm_restructure");
  }

  it.each(["omitted", "unrelated", "remove-existing-block"] as const)(
    "rechecks all retained source contributions after capability rejection: %s policy change",
    async (change) => {
      const approval = await library();
      const original = makeOpenAiServer({ completion: completion("llm_restructure"),
        failures: [{ status: 400, body: { error: {
          message: "unsupported response_format json_schema", param: "response_format",
        } } }] });
      server = original;
      vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await original.fetch(input, init);
        if (original.requests.length === 1) {
          await db.metadata.put({ key: DECISION_BLOCKLIST_KEY, value: change === "omitted"
            ? ["already-blocked.dev", "zz-omitted.dev"]
            : change === "unrelated" ? ["already-blocked.dev", "unrelated.dev"] : [] });
        }
        return response;
      }) as typeof fetch);
      const reply = await invoke("llm_restructure", approval);
      const body = server.requests[0]!.body as { messages: Array<{ content: string }> };
      const synopsis = JSON.parse(body.messages[1]!.content);
      expect(synopsis.domains).toHaveLength(50);
      expect(synopsis.domains.map((row: { domain: string }) => row.domain)).not.toContain("zz-omitted.dev");
      expect(synopsis).toMatchObject({
        bookmarkCount: 51, tags: { "unique-omitted-tag": 1 }, categories: { paper: 1 },
        representativeTitles: { "Bookmarks bar/Omitted source folder": ["Unique omitted-host title"] },
      });
      expect(synopsis.folderPaths).toContain("Bookmarks bar/Harmless empty folder");
      expect(JSON.stringify(synopsis)).not.toContain("Already blocked");
      expect(JSON.stringify(synopsis)).not.toContain("https://");
      expect(Object.keys(synopsis).sort()).toEqual(["bookmarkCount", "categories", "domains",
        "folderPaths", "representativeTitles", "tags"]);
      expect(reply).toMatchObject(change === "omitted"
        ? { ok: false, code: "request_not_allowed" } : { ok: true, code: "job_ok" });
      expect(server.requests).toHaveLength(change === "omitted" ? 1 : 2);
      if (change === "omitted") {
        expect(runJob).not.toHaveBeenCalled();
        expect(await db.jobs.count()).toBe(0);
        expect(JSON.stringify(reply)).not.toContain("zz-omitted");
        expect(JSON.stringify(reply)).not.toContain("Unique omitted-host");
      }
    },
  );
});
