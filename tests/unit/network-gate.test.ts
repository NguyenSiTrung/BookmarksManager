import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_VERSION,
  grantConsent,
  grantConsentAtOrigin,
  grantTestConsent,
  revokeTestConsent,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { DECISION_BLOCKLIST_KEY } from "../../src/decisions/blocklist";
import { makeSyntheticRequest } from "../../src/jev/wire";
import { PRESETS } from "../../src/net/presets";
import { NetworkGateError, sendConsented, sendConsentedTest } from "../../src/net/send";
import {
  CONSENT_SCOPE,
  type ConsentRecord,
  type PresetId,
} from "../../src/schemas/provider";
import { ProviderKeyError, readProviderKey } from "../../src/security/keys";

/**
 * `readProviderKey` is mocked so the gate can be driven without real CryptoKey
 * material; `ProviderKeyError` stays real so propagation is asserted against
 * the genuine class. Consent records and the sent log use the real Dexie
 * tables on fake-indexeddb.
 */
vi.mock("../../src/security/keys", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/security/keys")>();
  return { ...actual, readProviderKey: vi.fn() };
});

const readKey = vi.mocked(readProviderKey);

let fetchSpy: ReturnType<typeof vi.fn>;
let containsSpy: ReturnType<typeof vi.fn>;

const PLAINTEXT_KEY = "test-provider-key-material";

beforeEach(async () => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  containsSpy = vi.fn(async () => true);
  vi.stubGlobal("chrome", { permissions: { contains: containsSpy } });
  readKey.mockReset().mockResolvedValue(PLAINTEXT_KEY);
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

/** Seed a consent row directly so stale versions a writer never produces can
 * be tested (same approach as consent.test.ts). */
function staleConsentRow(origin: string): ConsentRecord {
  return {
    scope: CONSENT_SCOPE,
    origin,
    consentVersion: CONSENT_VERSION + 1,
    acceptedAt: "2020-01-01T00:00:00.000Z",
  } as ConsentRecord;
}

async function expectGateBlock(
  call: Promise<unknown>,
  code: string,
): Promise<Error> {
  const error = await call.catch((caught: unknown) => caught as Error);
  expect(error).toBeInstanceOf(NetworkGateError);
  expect((error as NetworkGateError).code).toBe(code);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(await db.sentLog.count()).toBe(0);
  return error as Error;
}

describe("sendConsentedTest gate", () => {
  it("checks final caller admission after a held permission read without wrapping its refusal", async () => {
    await grantTestConsent("typesafe");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    containsSpy.mockImplementation(async () => { entered(); await held; return true; });
    const refusal = new Error("The job no longer admits outbound work.");
    let admitted = true;
    fetchSpy.mockResolvedValue(okResponse());
    const running = sendConsented("jev_test", "typesafe", "jev-latest",
      makeSyntheticRequest("jev-latest"), { beforeSend: async () => { if (!admitted) throw refusal; } });
    await started;
    admitted = false;
    release();
    await expect(running).rejects.toBe(refusal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("a permissive caller admission does not bypass the real consent gate", async () => {
    await expectGateBlock(sendConsented("jev_test", "typesafe", "jev-latest",
      makeSyntheticRequest("jev-latest"), { beforeSend: async () => {} }), "no_consent");
  });

  it("rejects with no_consent before any grant and never calls fetch", async () => {
    await expectGateBlock(
      sendConsentedTest("typesafe", "jev-latest"),
      "no_consent",
    );
    // Consent is checked before the permission API or the key store.
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });

  it("rejects stale-version consent rows as if absent", async () => {
    await db.consents.put(staleConsentRow(PRESETS.typesafe.origin));
    await expectGateBlock(
      sendConsentedTest("typesafe", "jev-latest"),
      "no_consent",
    );
  });

  it("rejects after consent is revoked", async () => {
    await grantTestConsent("typesafe");
    await revokeTestConsent("typesafe");
    await expectGateBlock(
      sendConsentedTest("typesafe", "jev-latest"),
      "no_consent",
    );
  });

  it("scopes the grant per preset — typesafe consent does not cover openrouter", async () => {
    await grantTestConsent("typesafe");
    await expectGateBlock(
      sendConsentedTest("openrouter", "jev-latest"),
      "no_consent",
    );
  });

  it("rejects with no_permission when the host permission is missing", async () => {
    await grantTestConsent("typesafe");
    containsSpy.mockResolvedValue(false);
    await expectGateBlock(
      sendConsentedTest("typesafe", "jev-latest"),
      "no_permission",
    );
    // Permission is checked before key material is touched.
    expect(readKey).not.toHaveBeenCalled();
  });

  it("fails closed when the permissions API throws", async () => {
    await grantTestConsent("typesafe");
    containsSpy.mockRejectedValue(new Error("permissions API unavailable"));
    await expectGateBlock(
      sendConsentedTest("typesafe", "jev-latest"),
      "no_permission",
    );
  });

  it("rejects with no_key when no key is stored", async () => {
    await grantTestConsent("typesafe");
    readKey.mockResolvedValue(null);
    await expectGateBlock(sendConsentedTest("typesafe", "jev-latest"), "no_key");
  });

  it("propagates ProviderKeyError unwrapped (already redacted)", async () => {
    await grantTestConsent("typesafe");
    readKey.mockRejectedValue(
      new ProviderKeyError(
        'Stored provider key for preset "typesafe" is malformed; reconnect to re-enter it.',
      ),
    );
    const error = await sendConsentedTest("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderKeyError);
    expect(error).not.toBeInstanceOf(NetworkGateError);
    expect((error as ProviderKeyError).code).toBe("reconnect");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("rejects models outside the preset allowlist before any check side-effects", async () => {
    await grantTestConsent("openrouter");
    // "jev-preview" is a typesafe-only model; "gpt-4o" is in no allowlist.
    await expectGateBlock(
      sendConsentedTest("openrouter", "jev-preview"),
      "unlisted_model",
    );
    await expectGateBlock(
      sendConsentedTest("openrouter", "gpt-4o"),
      "unlisted_model",
    );
    expect(readKey).not.toHaveBeenCalled();
  });

  it("rejects an unknown preset id", async () => {
    const bogus = "anthropic" as unknown as PresetId;
    await expect(sendConsentedTest(bogus, "jev-latest")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("rejects a non-HTTPS preset URL as https_only", async () => {
    await expect(
      sendWithTamperedPreset({ url: "http://api.typesafe.ai/v1/systemone" }),
    ).rejects.toMatchObject({ name: "NetworkGateError", code: "https_only" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a preset URL whose origin differs from the registry origin", async () => {
    await expect(
      sendWithTamperedPreset({ url: "https://evil.example.com/v1/systemone" }),
    ).rejects.toMatchObject({
      name: "NetworkGateError",
      code: "unlisted_origin",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends exactly the fixed synthetic request and resolves with the raw Response", async () => {
    await grantTestConsent("typesafe");
    const response = okResponse();
    fetchSpy.mockResolvedValue(response);

    const result = await sendConsentedTest("typesafe", "jev-latest");

    expect(result).toBe(response);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PRESETS.typesafe.url);
    expect(init.method).toBe("POST");
    // Cookies are omitted and redirects are refused outright.
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    // Exactly the two wire headers from §8.1 — nothing caller-supplied.
    expect(init.headers).toEqual({
      Authorization: `Bearer ${PLAINTEXT_KEY}`,
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body).toEqual({
      model: "jev-latest",
      state: "This is a synthetic connection test with no bookmark content.",
      questions: {
        test: {
          type: "noul",
          instructions: "Is this a synthetic connection test?",
        },
      },
    });
  });

  it("uses each preset's own URL, origin, and permission pattern", async () => {
    await grantTestConsent("openrouter");
    fetchSpy.mockResolvedValue(okResponse());
    await sendConsentedTest("openrouter", "typesafe/jev-1.13");
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PRESETS.openrouter.url);
    expect(containsSpy).toHaveBeenCalledWith({
      origins: [PRESETS.openrouter.permissionPattern],
    });
    expect(readKey).toHaveBeenCalledWith("openrouter");
  });

  it("admits no caller-supplied state or questions — the signature takes only preset and model", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    const sendWithExtraArg = sendConsentedTest as (
      ...args: unknown[]
    ) => Promise<Response>;
    await sendWithExtraArg("typesafe", "jev-latest", {
      state: "caller-supplied bookmark data",
      questions: { evil: { type: "noul" } },
      headers: { Authorization: "Bearer attacker" },
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.state).toBe(
      "This is a synthetic connection test with no bookmark content.",
    );
    expect(Object.keys(body.questions as object)).toEqual(["test"]);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${PLAINTEXT_KEY}`,
      "Content-Type": "application/json",
    });
  });

  it("writes a sent-log row with only time, origin, feature, and field names", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    await sendConsentedTest("typesafe", "jev-latest");
    const rows = await db.sentLog.toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual([
      "destination",
      "feature",
      "fieldNames",
      "id",
      "sentAt",
    ]);
    expect(row.destination).toBe(PRESETS.typesafe.origin);
    expect(row.feature).toBe("jev_test");
    expect(row.fieldNames).toEqual(["model", "state", "questions"]);
    expect(row.sentAt).toBe(new Date(row.sentAt).toISOString());
    // The audit row must never carry key material or payload contents.
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT_KEY);
    expect(JSON.stringify(row)).not.toContain("synthetic connection test");
  });

  it("resolves with the raw Response for HTTP error statuses and still logs", async () => {
    await grantTestConsent("typesafe");
    const unauthorized = new Response("nope", { status: 401 });
    fetchSpy.mockResolvedValue(unauthorized);
    const result = await sendConsentedTest("typesafe", "jev-latest");
    expect(result).toBe(unauthorized);
    expect(result.status).toBe(401);
    expect(await db.sentLog.count()).toBe(1);
  });

  it("maps a fetch rejection to a redacted transport error with no log row", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockRejectedValue(new TypeError("socket hangup"));
    const error = await sendConsentedTest("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("transport");
    // Fetch was invoked and rejected — no request went out, so no log row.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await db.sentLog.count()).toBe(0);
    expect((error as Error).message).not.toContain(PLAINTEXT_KEY);
    expect((error as Error).message).not.toContain("socket hangup");
  });

  it("rejects an opaque redirect response as a transport failure", async () => {
    await grantTestConsent("typesafe");
    // `redirect: "error"` makes real fetch reject; a non-conformant
    // implementation resolving opaqueredirect must still be refused. The
    // request did leave, so the audit row is written first.
    fetchSpy.mockResolvedValue({
      type: "opaqueredirect",
      status: 0,
    } as Response);
    const error = await sendConsentedTest("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("transport");
    expect(await db.sentLog.count()).toBe(1);
  });

  it("re-checks consent on every call — revoking between calls blocks", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    await sendConsentedTest("typesafe", "jev-latest");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await revokeTestConsent("typesafe");
    const error = await sendConsentedTest("typesafe", "jev-latest").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("no_consent");
    // The revoked call produced no second fetch and no second log row.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await db.sentLog.count()).toBe(1);
  });
});

describe("scoped sendConsented gate", () => {
  const synthetic = () => makeSyntheticRequest("jev-latest");

  it("rejects an unregistered scope before any consent, permission, key, or fetch read", async () => {
    await grantTestConsent("typesafe");
    const error = await sendConsented(
      "bookmark_analysis",
      "typesafe",
      "jev-latest",
      synthetic(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("unregistered_scope");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("rejects a non-synthetic jev_test request as request_not_allowed before key/permission reads", async () => {
    await grantTestConsent("typesafe");
    const realContentRequest = {
      model: "jev-latest",
      state: { bookmark: { title: "real user bookmark", url: "https://x.test" } },
      questions: { test: { type: "noul", instructions: "Is this a synthetic connection test?" } },
    };
    const error = await sendConsented(
      "jev_test",
      "typesafe",
      "jev-latest",
      realContentRequest,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("rejects a request differing from the synthetic only in state text", async () => {
    await grantTestConsent("typesafe");
    const drifted = {
      ...synthetic(),
      state: "This is a synthetic connection test with bookmark content.",
    };
    await expect(
      sendConsented("jev_test", "typesafe", "jev-latest", drifted),
    ).rejects.toMatchObject({ name: "NetworkGateError", code: "request_not_allowed" });
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a synthetic request built for a different model than the model arg", async () => {
    await grantTestConsent("typesafe");
    await expect(
      sendConsented(
        "jev_test",
        "typesafe",
        "jev-latest",
        makeSyntheticRequest("jev-preview"),
      ),
    ).rejects.toMatchObject({ code: "request_not_allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the admitted request and resolves with the raw Response", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    const response = await sendConsented(
      "jev_test",
      "typesafe",
      "jev-latest",
      synthetic(),
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PRESETS.typesafe.url);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.state).toBe(
      "This is a synthetic connection test with no bookmark content.",
    );
    expect(await db.sentLog.count()).toBe(1);
  });

  it("sendConsentedTest stays a thin wrapper over the scoped send", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    await sendConsentedTest("typesafe", "jev-latest");
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
  });

  it("maps a mid-flight fetch abort to timeout and writes no sentLog row", async () => {
    await grantTestConsent("typesafe");
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const controller = new AbortController();
    const pending = sendConsented(
      "jev_test",
      "typesafe",
      "jev-latest",
      synthetic(),
      { signal: controller.signal },
    );
    // Abort only once the request is actually in flight — the gate's async
    // consent/permission/key reads must resolve first.
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("timeout");
    // The request never completed, so nothing "left" — no sentLog row.
    expect(await db.sentLog.count()).toBe(0);
  });

  it("maps an abort raised during the gate's async checks to timeout", async () => {
    await grantTestConsent("typesafe");
    const controller = new AbortController();
    const pending = sendConsented(
      "jev_test",
      "typesafe",
      "jev-latest",
      synthetic(),
      { signal: controller.signal },
    );
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("timeout");
    // Aborted before fetch — nothing left the extension.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("refuses a pre-aborted signal as timeout without calling fetch", async () => {
    await grantTestConsent("typesafe");
    const controller = new AbortController();
    controller.abort();
    const error = await sendConsented(
      "jev_test",
      "typesafe",
      "jev-latest",
      synthetic(),
      { signal: controller.signal },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("timeout");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("still applies the model allowlist under the scoped entry point", async () => {
    await grantTestConsent("typesafe");
    await expect(
      sendConsented(
        "jev_test",
        "typesafe",
        "gpt-4o",
        makeSyntheticRequest("gpt-4o"),
      ),
    ).rejects.toMatchObject({ code: "unlisted_model" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("jev_decisions gate", () => {
  /** A DecisionState that passes the strict guard: one cleaned, non-sensitive
   * bookmark whose `domain` matches its URL hostname. */
  const validState = {
    bookmark: {
      title: "Hacker News",
      url: "https://news.ycombinator.com/item",
      domain: "news.ycombinator.com",
    },
  };

  /** The full SystemOneRequest the gate sees — the state under test plus the
   * fixed wire envelope. `model` defaults to the allowlisted value the gate is
   * called with; tests pass a different one to exercise the model pin. */
  function decisionsRequest(
    state: unknown,
    model = "jev-latest",
  ): unknown {
    return {
      model,
      state,
      questions: { q: { type: "noul", instructions: "Is this a test?" } },
    };
  }

  it("refuses an unknown state field before any consent, permission, or key read", async () => {
    // No consent is granted: a `request_not_allowed` refusal (rather than
    // `no_consent`) proves the guard runs before the consent read.
    const withNotes = {
      ...validState,
      notes: "private notes that must never leave the device",
    };
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest(withNotes),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it.each([
    ["a query string", "https://news.ycombinator.com/item?id=1"],
    ["a fragment", "https://news.ycombinator.com/item#top"],
    ["userinfo", "https://user:pass@news.ycombinator.com/item"],
  ])("refuses a bookmark URL carrying %s before key/permission reads", async (_label, url) => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest({
        bookmark: { title: "T", url, domain: "news.ycombinator.com" },
      }),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a blocklisted bookmark URL as request_not_allowed", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest({
        bookmark: {
          title: "Inbox",
          url: "https://mail.google.com/",
          domain: "mail.google.com",
        },
      }),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a URL the USER blocklisted (defense-in-depth over the services)", async () => {
    // `news.ycombinator.com` is not built-in sensitive; it is only blocked
    // because the user persisted it in their own blocklist. The gate re-reads
    // that list, so a caller that skipped the service-level check is still
    // refused — and no consent, permission, or key read happens first.
    await db.metadata.put({
      key: DECISION_BLOCKLIST_KEY,
      value: ["news.ycombinator.com"],
    });
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest(validState),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("validates the pairPartner URL, not just the primary bookmark", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest({
        ...validState,
        pairPartner: {
          title: "Duplicate",
          url: "https://gmail.com/",
          domain: "gmail.com",
        },
      }),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates every candidateBookmarks URL", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest({
        ...validState,
        candidateBookmarks: [
          {
            title: "Fine",
            url: "https://news.ycombinator.com/other",
            domain: "news.ycombinator.com",
          },
          {
            title: "Dirty",
            url: "https://news.ycombinator.com/other?id=2",
            domain: "news.ycombinator.com",
          },
        ],
      }),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires its own consent — a jev_test grant does not cover jev_decisions", async () => {
    await grantTestConsent("typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest(validState),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("no_consent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a request whose model differs from the allowlist-checked argument", async () => {
    await grantConsent("jev_decisions", "typesafe");
    // Both models are in typesafe's allowlist, so the earlier model-allowlist
    // stage passes — only the guard's model pin can refuse this.
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest(validState, "jev-preview"),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.sentLog.count()).toBe(0);
  });

  it("admits a matching model and serializes exactly that model", async () => {
    await grantConsent("jev_decisions", "typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-preview",
      decisionsRequest(validState, "jev-preview"),
    );
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("jev-preview");
  });

  it("fails closed when the request is not an object", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      "not a request",
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the request omits state", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      {
        model: "jev-latest",
        questions: { q: { type: "noul", instructions: "Is this a test?" } },
      },
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on an empty {} state", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest({}),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("admits a DecisionState-conforming request and logs the jev_decisions scope", async () => {
    await grantConsent("jev_decisions", "typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    const response = await sendConsented(
      "jev_decisions",
      "typesafe",
      "jev-latest",
      decisionsRequest(validState),
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const rows = await db.sentLog.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.feature).toBe("jev_decisions");
  });
});

/**
 * Re-import the gate with a tampered preset registry entry to exercise the
 * https:/origin consistency checks that the frozen `PRESETS` cannot fail on
 * its own.
 */
async function sendWithTamperedPreset(
  overrides: Partial<{ url: string; origin: string }>,
): Promise<Response> {
  vi.resetModules();
  const base = {
    origin: "https://api.typesafe.ai",
    url: "https://api.typesafe.ai/v1/systemone",
    permissionPattern: "https://api.typesafe.ai/*",
    models: ["jev-latest"],
  };
  const tampered = { ...base, ...overrides };
  vi.doMock("../../src/net/presets", () => ({
    PRESETS: { typesafe: tampered, openrouter: tampered },
    resolvePreset: () => tampered,
  }));
  try {
    const { sendConsentedTest: send } = await import("../../src/net/send");
    return await send("typesafe", "jev-latest");
  } finally {
    vi.doUnmock("../../src/net/presets");
  }
}

describe("jev_summary_verify gate", () => {
  const validState = {
    bookmark: {
      title: "T",
      url: "https://blog.a-site.com/x",
      domain: "blog.a-site.com",
    },
    excerpt: "Page text under verification.",
    headings: ["H"],
    summary: "A page summary.",
  };

  function verifyRequest(state: unknown, model = "jev-latest"): unknown {
    return {
      model,
      state,
      questions: {
        verdict: { type: "choice", instructions: "q", criteria: { a: "a", b: "b" } },
      },
    };
  }

  it("is a registered scope — requires consent like any other", async () => {
    const error = await sendConsented(
      "jev_summary_verify",
      "typesafe",
      "jev-latest",
      verifyRequest(validState),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkGateError);
    expect((error as NetworkGateError).code).toBe("no_consent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown state field (notes) before consent/permission/key reads", async () => {
    const error = await sendConsented(
      "jev_summary_verify",
      "typesafe",
      "jev-latest",
      verifyRequest({ ...validState, notes: "private" }),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a blocklisted bookmark URL even with consent granted", async () => {
    await grantConsent("jev_summary_verify", "typesafe");
    const error = await sendConsented(
      "jev_summary_verify",
      "typesafe",
      "jev-latest",
      verifyRequest({
        ...validState,
        bookmark: {
          title: "Mail",
          url: "https://mail.google.com/",
          domain: "mail.google.com",
        },
      }),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pins the request model to the allowlisted model argument", async () => {
    await grantConsent("jev_summary_verify", "typesafe");
    const error = await sendConsented(
      "jev_summary_verify",
      "typesafe",
      "jev-latest",
      verifyRequest(validState, "other-model"),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("request_not_allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the admitted request and resolves with the raw Response", async () => {
    await grantConsent("jev_summary_verify", "typesafe");
    fetchSpy.mockResolvedValue(okResponse());
    const response = await sendConsented(
      "jev_summary_verify",
      "typesafe",
      "jev-latest",
      verifyRequest(validState),
    );
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as { body: string }).body,
    );
    expect(body.state).toEqual(validState);
    // The sent-log row records the scope as its feature — page-text sends
    // are auditable separately from jev_decisions.
    const logs = await db.sentLog.toArray();
    expect(logs.some((row) => row.feature === "jev_summary_verify")).toBe(
      true,
    );
  });

  it("a jev_decisions grant does NOT cover jev_summary_verify", async () => {
    await grantConsent("jev_decisions", "typesafe");
    const error = await sendConsented(
      "jev_summary_verify",
      "typesafe",
      "jev-latest",
      verifyRequest(validState),
    ).catch((caught: unknown) => caught);
    expect((error as NetworkGateError).code).toBe("no_consent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("custom Jev provider gate", () => {
  const BASE_URL = "https://ai-gateway.example.com/api";
  const ORIGIN = "https://ai-gateway.example.com";

  /** The stored ProviderSettings row the ENABLE flow would have written. */
  async function seedCustomProvider(
    baseUrl: string = BASE_URL,
    model = "jev-edge",
  ): Promise<void> {
    await db.metadata.put({
      key: "custom",
      value: { preset: "custom", baseUrl, model, keySuffix: "cdef" },
    });
  }

  it("fails closed as unlisted_origin while no settings row exists", async () => {
    await expectGateBlock(
      sendConsentedTest("custom", "jev-edge"),
      "unlisted_origin",
    );
    // Destination resolution happens before consent, permission, or key.
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });

  it("fails closed when the stored row is malformed", async () => {
    await db.metadata.put({
      key: "custom",
      value: {
        preset: "custom",
        baseUrl: "not a url",
        model: "jev-edge",
        keySuffix: "cdef",
      },
    });
    await expectGateBlock(
      sendConsentedTest("custom", "jev-edge"),
      "unlisted_origin",
    );
  });

  it("sends to <baseUrl>/systemone with the stored model at its own origin", async () => {
    await seedCustomProvider();
    await grantConsentAtOrigin(CONSENT_SCOPE, ORIGIN);
    fetchSpy.mockResolvedValue(okResponse());

    await sendConsentedTest("custom", "jev-edge");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/systemone`);
    // The permission and key are scoped to the custom provider id.
    expect(containsSpy).toHaveBeenCalledWith({
      origins: ["https://ai-gateway.example.com/*"],
    });
    expect(readKey).toHaveBeenCalledWith("custom");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe("jev-edge");
    const logs = await db.sentLog.toArray();
    expect(logs[0]?.destination).toBe(ORIGIN);
  });

  it("requires consent at the custom origin — a preset grant does not cover it", async () => {
    await seedCustomProvider();
    await grantTestConsent("typesafe");
    await expectGateBlock(
      sendConsentedTest("custom", "jev-edge"),
      "no_consent",
    );
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });

  it("pins the model allowlist to the configured model id", async () => {
    await seedCustomProvider();
    await grantConsentAtOrigin(CONSENT_SCOPE, ORIGIN);
    await expectGateBlock(
      sendConsentedTest("custom", "jev-latest"),
      "unlisted_model",
    );
    expect(containsSpy).not.toHaveBeenCalled();
    expect(readKey).not.toHaveBeenCalled();
  });

  it("admits a loopback http base URL with its computed pattern", async () => {
    await seedCustomProvider("http://localhost:11434/api", "jev-local");
    await grantConsentAtOrigin(CONSENT_SCOPE, "http://localhost:11434");
    fetchSpy.mockResolvedValue(okResponse());

    await sendConsentedTest("custom", "jev-local");

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/systemone");
    expect(containsSpy).toHaveBeenCalledWith({
      origins: ["http://localhost/*"],
    });
  });

  it("a re-pointed stored row cannot ride the previous origin's consent", async () => {
    await seedCustomProvider();
    await grantConsentAtOrigin(CONSENT_SCOPE, ORIGIN);
    // Rewriting the row to a different origin must require fresh consent —
    // consent keys off the resolved origin on every send.
    await db.metadata.put({
      key: "custom",
      value: {
        preset: "custom",
        baseUrl: "https://other-gateway.example.com/api",
        model: "jev-edge",
        keySuffix: "cdef",
      },
    });
    await expectGateBlock(
      sendConsentedTest("custom", "jev-edge"),
      "no_consent",
    );
  });
});
