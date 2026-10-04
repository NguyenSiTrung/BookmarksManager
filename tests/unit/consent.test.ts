import "fake-indexeddb/auto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_VERSION,
  ConsentRevokeError,
  grantConsent,
  grantConsentAtOrigin,
  grantTestConsent,
  hasConsent,
  hasConsentAtOrigin,
  hasTestConsent,
  revokeConsent,
  revokeConsentAtOrigin,
  revokeConsentsAtOrigin,
  revokeProviderConsents,
  revokeTestConsent,
} from "../../src/consent/records";
import { db } from "../../src/db/database";
import { PRESETS } from "../../src/net/presets";
import {
  CONSENT_SCOPE,
  DECISIONS_CONSENT_SCOPE,
  ConsentRecord,
  CONSENT_SCOPES,
  type PresetId,
} from "../../src/schemas/provider";

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
});

const PRESET_IDS = ["typesafe", "openrouter"] as const;

/** Build a consents-table row directly, loosening the literal scope type so
 * tests can seed foreign-scope rows a writer should never produce. */
function consentRow(
  overrides: {
    scope?: string;
    origin?: string;
    consentVersion?: number;
    acceptedAt?: string;
  } = {},
): ConsentRecord {
  return {
    scope: overrides.scope ?? CONSENT_SCOPE,
    origin: overrides.origin ?? PRESETS.typesafe.origin,
    consentVersion: overrides.consentVersion ?? CONSENT_VERSION,
    acceptedAt: overrides.acceptedAt ?? "2026-09-25T10:00:00.000Z",
  } as ConsentRecord;
}

describe("versioned consent records", () => {
  it("pins CONSENT_VERSION to 4 and reports no consent before any grant", async () => {
    expect(CONSENT_VERSION).toBe(4);
    for (const id of PRESET_IDS) {
      expect(await hasTestConsent(id)).toBe(false);
    }
  });

  it("grant then has round-trips for each preset", async () => {
    for (const id of PRESET_IDS) {
      await grantTestConsent(id);
      expect(await hasTestConsent(id)).toBe(true);
    }
    // One row per (scope, origin) pair — two presets, two rows.
    expect(await db.consents.count()).toBe(2);
  });

  it("stores only the scoped, versioned grant fields — no keys or bookmark data", async () => {
    await grantTestConsent("typesafe");
    const stored = await db.consents.get([
      CONSENT_SCOPE,
      PRESETS.typesafe.origin,
    ]);
    expect(stored).toBeDefined();
    expect(Object.keys(stored!).sort()).toEqual([
      "acceptedAt",
      "consentVersion",
      "origin",
      "scope",
    ]);
    expect(() => ConsentRecord.parse(stored)).not.toThrow();
    expect(stored).toMatchObject({
      scope: "jev_test",
      origin: "https://api.typesafe.ai",
      consentVersion: CONSENT_VERSION,
    });
  });

  it("revoke deletes the row, is safe when no grant exists, and round-trips grant → revoke → grant", async () => {
    await grantTestConsent("typesafe");
    await revokeTestConsent("typesafe");
    expect(await hasTestConsent("typesafe")).toBe(false);
    expect(
      await db.consents.get([CONSENT_SCOPE, PRESETS.typesafe.origin]),
    ).toBeUndefined();
    await expect(revokeTestConsent("openrouter")).resolves.toBeUndefined();
    await grantTestConsent("openrouter");
    expect(await hasTestConsent("openrouter")).toBe(true);
    await revokeTestConsent("openrouter");
    expect(await hasTestConsent("openrouter")).toBe(false);
    await grantTestConsent("openrouter");
    expect(await hasTestConsent("openrouter")).toBe(true);
  });

  it("scopes grants per origin — one preset does not imply the other", async () => {
    await grantTestConsent("typesafe");
    expect(await hasTestConsent("typesafe")).toBe(true);
    expect(await hasTestConsent("openrouter")).toBe(false);
  });

  it("rejects stale versions and grants recorded for other origins or scopes", async () => {
    await db.consents.put(
      consentRow({ consentVersion: CONSENT_VERSION + 1 }),
    );
    expect(await hasTestConsent("typesafe"), "version+1").toBe(false);
    await db.consents.put(consentRow({ consentVersion: 99 }));
    expect(await hasTestConsent("typesafe"), "version 99").toBe(false);
    await db.consents.clear();
    await db.consents.put(consentRow({ origin: "https://evil.example.com" }));
    expect(await hasTestConsent("typesafe"), "foreign origin").toBe(false);
    expect(await hasTestConsent("openrouter"), "foreign origin").toBe(false);
    await db.consents.clear();
    await db.consents.put(consentRow({ scope: "bookmark_analysis" }));
    expect(await hasTestConsent("typesafe"), "foreign scope").toBe(false);
  });

  it("re-granting upserts the row and refreshes acceptedAt", async () => {
    await db.consents.put(
      consentRow({ acceptedAt: "2020-01-01T00:00:00.000Z" }),
    );
    await grantTestConsent("typesafe");
    const stored = await db.consents.get([
      CONSENT_SCOPE,
      PRESETS.typesafe.origin,
    ]);
    expect(stored?.acceptedAt).not.toBe("2020-01-01T00:00:00.000Z");
    expect(stored?.consentVersion).toBe(CONSENT_VERSION);
    // Upsert, not a second row.
    expect(await db.consents.count()).toBe(1);
    expect(await hasTestConsent("typesafe")).toBe(true);
  });

  it("rejects unknown preset ids on every entry point", async () => {
    const bogus = "anthropic" as unknown as PresetId;
    await expect(grantTestConsent(bogus)).rejects.toThrow();
    await expect(hasTestConsent(bogus)).rejects.toThrow();
    await expect(revokeTestConsent(bogus)).rejects.toThrow();
    // A failed grant must not leave a row behind.
    expect(await db.consents.count()).toBe(0);
  });
});

describe("scoped consent helpers", () => {
  it("grantConsent/hasConsent/revokeConsent round-trip under an explicit scope", async () => {
    await grantConsent("jev_test", "typesafe");
    expect(await hasConsent("jev_test", "typesafe")).toBe(true);
    expect(await hasTestConsent("typesafe")).toBe(true);
    await revokeConsent("jev_test", "typesafe");
    expect(await hasConsent("jev_test", "typesafe")).toBe(false);
  });

  it("hasConsent checks scope, origin, and version on the row", async () => {
    await grantConsent("jev_test", "typesafe");
    // Origin mismatch — an openrouter read must not see typesafe's row.
    expect(await hasConsent("jev_test", "openrouter")).toBe(false);
    // Stale version on the row fails the check.
    await db.consents.put(
      consentRow({ consentVersion: CONSENT_VERSION + 1 }),
    );
    expect(await hasConsent("jev_test", "typesafe")).toBe(false);
    // A row under a foreign scope never satisfies a jev_test read.
    await db.consents.put(
      consentRow({ scope: "bookmark_analysis" as never }),
    );
    expect(await hasConsent("jev_test", "typesafe")).toBe(false);
  });

  it("a foreign-scope row only answers its own scope", async () => {
    const foreign = "bookmark_analysis";
    await db.consents.put(consentRow({ scope: foreign as never }));
    // Read through the scoped helper cast to a registered-looking scope:
    // the helper compares the stored scope string, so a different scope name
    // on the row at [jev_test, origin] is still refused…
    expect(await hasConsent("jev_test", "typesafe")).toBe(false);
    // …and the foreign row is only visible at its own [scope, origin] key.
    expect(await hasConsent(foreign as never, "typesafe")).toBe(true);
  });

  it("the TestConsent wrappers are thin aliases over the scoped helpers", async () => {
    await grantTestConsent("openrouter");
    const stored = await db.consents.get([
      CONSENT_SCOPE,
      PRESETS.openrouter.origin,
    ]);
    expect(stored?.scope).toBe("jev_test");
    expect(await hasConsent("jev_test", "openrouter")).toBe(true);
    await revokeTestConsent("openrouter");
    expect(await hasConsent("jev_test", "openrouter")).toBe(false);
  });
});

describe("jev_decisions scope", () => {
  it("grants/has/revokes per (scope, origin)", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(true);
    // Per origin — the other preset is not implied.
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "openrouter")).toBe(false);
    // Per scope — a jev_decisions grant is not a jev_test grant.
    expect(await hasTestConsent("typesafe")).toBe(false);
    await revokeConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(false);
  });

  it("stores the jev_decisions literal and still refuses a foreign scope", async () => {
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    const stored = await db.consents.get([
      DECISIONS_CONSENT_SCOPE,
      PRESETS.typesafe.origin,
    ]);
    expect(stored?.scope).toBe("jev_decisions");
    expect(() => ConsentRecord.parse(stored)).not.toThrow();
    expect(
      ConsentRecord.safeParse({ ...stored, scope: "bookmark_analysis" }).success,
    ).toBe(false);
  });

  it("keeps one row per (scope, origin) — the two scopes coexist", async () => {
    await grantConsent(CONSENT_SCOPE, "typesafe");
    await grantConsent(DECISIONS_CONSENT_SCOPE, "typesafe");
    expect(await db.consents.count()).toBe(2);
    expect(await hasConsent(CONSENT_SCOPE, "typesafe")).toBe(true);
    expect(await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe")).toBe(true);
  });
});

describe("stale v1/v2/v3 records after the CONSENT_VERSION 4 bump", () => {
  it("v1/v2/v3 jev_test rows fail hasConsent", async () => {
    for (const version of [1, 2, 3]) {
      await db.consents.put(
        consentRow({ scope: "jev_test", consentVersion: version }),
      );
      expect(await hasConsent("jev_test", "typesafe"), `v${version}`).toBe(false);
      expect(await hasTestConsent("typesafe"), `v${version}`).toBe(false);
    }
  });

  it("v1/v2/v3 jev_decisions and llm-scope rows fail their checks", async () => {
    for (const version of [1, 2, 3]) {
      await db.consents.put(
        consentRow({ scope: "jev_decisions", consentVersion: version }),
      );
      expect(
        await hasConsent(DECISIONS_CONSENT_SCOPE, "typesafe"),
        `jev_decisions v${version}`,
      ).toBe(false);
      await db.consents.put(
        consentRow({
          scope: "llm_explain",
          origin: "https://api.example.com",
          consentVersion: version,
        }),
      );
      expect(
        await hasConsentAtOrigin("llm_explain", "https://api.example.com"),
        `llm_explain v${version}`,
      ).toBe(false);
    }
  });

  it("a fresh v4 grant passes for jev and llm scopes", async () => {
    await grantConsent("jev_test", "typesafe");
    await grantConsent("jev_decisions", "typesafe");
    await grantConsentAtOrigin("llm_summary", "https://api.example.com");
    expect(await hasConsent("jev_test", "typesafe")).toBe(true);
    expect(await hasConsent("jev_decisions", "typesafe")).toBe(true);
    expect(
      await hasConsentAtOrigin("llm_summary", "https://api.example.com"),
    ).toBe(true);
  });

  it("preserves a v3 grant as stale until reacquired for its exact origin", async () => {
    for (const scope of CONSENT_SCOPES) {
      await db.consents.clear();
      const origin = "http://localhost:11434";
      const otherOrigin = "http://localhost:11435";
      const old = consentRow({ scope, origin, consentVersion: 3 });
      const other = consentRow({ scope, origin: otherOrigin, consentVersion: 3 });
      await db.consents.bulkPut([old, other]);
      expect(await hasConsentAtOrigin(scope, origin)).toBe(false);
      expect(await hasConsentAtOrigin(scope, otherOrigin)).toBe(false);
      expect(await db.consents.get([scope, origin])).toEqual(old);
      await grantConsentAtOrigin(scope, origin);
      expect(await hasConsentAtOrigin(scope, origin)).toBe(true);
      expect(await db.consents.get([scope, origin])).toMatchObject({
        scope, origin, consentVersion: ["llm_explain", "llm_restructure"].includes(scope) ? 5 : 4,
      });
      expect(await hasConsentAtOrigin(scope, otherOrigin)).toBe(false);
      expect(await db.consents.get([scope, otherOrigin])).toEqual(other);
      expect(await db.consents.count()).toBe(2);
    }
  });
});

describe("feature-specific consent disclosure versions", () => {
  it("invalidates only version4 Explain and Restructure grants until explicit reacceptance", async () => {
    const origin = "https://api.example.com";
    for (const scope of CONSENT_SCOPES) {
      await db.consents.put(consentRow({ scope, origin, consentVersion: 4 }));
      expect(await hasConsentAtOrigin(scope, origin)).toBe(!["llm_explain", "llm_restructure"].includes(scope));
      await grantConsentAtOrigin(scope, origin);
      expect(await hasConsentAtOrigin(scope, origin)).toBe(true);
      expect((await db.consents.get([scope, origin]))?.consentVersion)
        .toBe(["llm_explain", "llm_restructure"].includes(scope) ? 5 : 4);
    }
    expect(CONSENT_VERSION).toBe(4);
  });
});

describe("origin-generic consent (dynamic LLM providers)", () => {
  it("grants, checks, and revokes a scope at an arbitrary https origin", async () => {
    await grantConsentAtOrigin("llm_explain", "https://api.example.com");
    expect(
      await hasConsentAtOrigin("llm_explain", "https://api.example.com"),
    ).toBe(true);
    // A different scope at the same origin does not pass.
    expect(
      await hasConsentAtOrigin("llm_summary", "https://api.example.com"),
    ).toBe(false);
    // The same scope at another origin does not pass.
    expect(
      await hasConsentAtOrigin("llm_explain", "https://other.example.com"),
    ).toBe(false);
    await revokeConsentAtOrigin("llm_explain", "https://api.example.com");
    expect(
      await hasConsentAtOrigin("llm_explain", "https://api.example.com"),
    ).toBe(false);
  });

  it("accepts canonical loopback http origins (port included) and rejects non-canonical or disallowed ones", async () => {
    for (const origin of [
      "http://localhost:11434",
      "http://127.0.0.1:8080",
      "http://[::1]:9000",
    ]) {
      await grantConsentAtOrigin("llm_test", origin);
      expect(await hasConsentAtOrigin("llm_test", origin)).toBe(true);
    }
    // A different port is a different origin.
    expect(
      await hasConsentAtOrigin("llm_test", "http://localhost:9999"),
    ).toBe(false);
    for (const origin of [
      "http://api.example.com",
      "https://api.example.com/path",
      "https://api.example.com/",
      "http://evil-localhost.com:8080",
      "notaurl",
      "",
    ]) {
      await expect(
        grantConsentAtOrigin("llm_test", origin),
        origin,
      ).rejects.toThrow();
      expect(await hasConsentAtOrigin("llm_test", origin), origin).toBe(false);
    }
  });

  it("revokeConsentsAtOrigin sweeps every scope at the origin only", async () => {
    await grantConsentAtOrigin("llm_test", "https://api.example.com");
    await grantConsentAtOrigin("llm_summary", "https://api.example.com");
    await grantConsentAtOrigin("llm_summary", "https://other.example.com");

    await revokeConsentsAtOrigin("https://api.example.com");

    expect(
      await hasConsentAtOrigin("llm_test", "https://api.example.com"),
    ).toBe(false);
    expect(
      await hasConsentAtOrigin("llm_summary", "https://api.example.com"),
    ).toBe(false);
    expect(
      await hasConsentAtOrigin("llm_summary", "https://other.example.com"),
    ).toBe(true);
    expect(await db.consents.count()).toBe(1);
  });
});

describe("revokeProviderConsents", () => {
  it("deletes every scope at the preset's origin and leaves other origins alone", async () => {
    await grantConsent("jev_test", "typesafe");
    await grantConsent("jev_decisions", "typesafe");
    await grantConsent("jev_test", "openrouter");

    await revokeProviderConsents("typesafe");

    expect(await hasConsent("jev_test", "typesafe")).toBe(false);
    expect(await hasConsent("jev_decisions", "typesafe")).toBe(false);
    // The other provider's grant is untouched.
    expect(await hasConsent("jev_test", "openrouter")).toBe(true);
    expect(await db.consents.count()).toBe(1);
  });

  it("is safe when the provider holds no grants", async () => {
    await expect(revokeProviderConsents("openrouter")).resolves.toBeUndefined();
    expect(await db.consents.count()).toBe(0);
  });

  it("throws a typed failure when a scope deletion rejects, still deleting the rest", async () => {
    await grantConsent("jev_test", "typesafe");
    await grantConsent("jev_decisions", "typesafe");
    // First deletion (CONSENT_SCOPES order: jev_test) rejects.
    const deleteSpy = vi
      .spyOn(db.consents, "delete")
      .mockRejectedValueOnce(new Error("indexeddb unavailable"));

    await expect(revokeProviderConsents("typesafe")).rejects.toBeInstanceOf(
      ConsentRevokeError,
    );
    deleteSpy.mockRestore();

    // allSettled: the other scope's row was still deleted, so the failure is
    // surfaced rather than hidden — and no scope silently survives unnoticed.
    expect(await hasConsent("jev_test", "typesafe")).toBe(true);
    expect(await hasConsent("jev_decisions", "typesafe")).toBe(false);
  });
});
