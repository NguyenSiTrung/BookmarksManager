import { describe, expect, it } from "vitest";
import { z } from "../../src/schemas/z";
import { Bookmark, Tag } from "../../src/schemas/bookmark";
import { Decision } from "../../src/schemas/decision";
import {
  CONSENT_SCOPE,
  ConsentRecord,
  PRESET_MODELS,
  ProviderSettings,
} from "../../src/schemas/provider";
import {
  decisionBase,
  validBookmark,
  validConsent,
  validDecision,
  validProviderSettings,
  validTag,
} from "../fixtures/base-records";

describe("shared zod config", () => {
  it("runs in jitless mode for MV3 CSP", () => {
    expect(z.config().jitless).toBe(true);
  });
});

describe("Bookmark", () => {
  it("accepts valid bookmarks with defaults and explicit health", () => {
    expect(Bookmark.safeParse(validBookmark).success).toBe(true);
    expect(Bookmark.parse(validBookmark).health).toEqual({ status: "unknown" });
    expect(Bookmark.parse(validBookmark).tags).toEqual([]);

    const parsed = Bookmark.parse({
      ...validBookmark,
      health: { status: "dead", httpCode: 404 },
    });
    expect(parsed.health).toEqual({ status: "dead", httpCode: 404 });
  });

  it("validates title bounds and URL formatting", () => {
    for (const url of ["not a url", "example.com/path", "", "https://"]) {
      expect(Bookmark.safeParse({ ...validBookmark, url }).success).toBe(false);
    }
    expect(Bookmark.safeParse({ ...validBookmark, title: "" }).success).toBe(false);
    expect(Bookmark.safeParse({ ...validBookmark, title: "x".repeat(501) }).success).toBe(false);
    expect(Bookmark.safeParse({ ...validBookmark, title: "x" }).success).toBe(true);
    expect(Bookmark.safeParse({ ...validBookmark, title: "x".repeat(500) }).success).toBe(true);
  });

  it("rejects invalid patches", () => {
    const patches = [
      { category: "not-a-category" },
      { schemaVersion: 2 },
      { notes: "n".repeat(10_001) },
      { createdAt: "last Tuesday" },
      { health: { status: "redirect", finalUrl: "not a url" } },
    ];
    for (const patch of patches) {
      expect(Bookmark.safeParse({ ...validBookmark, ...patch }).success).toBe(false);
    }
  });
});

describe("Tag", () => {
  it("accepts a valid tag and enforces name and description bounds", () => {
    expect(Tag.safeParse(validTag).success).toBe(true);
    expect(Tag.safeParse({ ...validTag, name: "" }).success).toBe(false);
    expect(Tag.safeParse({ ...validTag, name: "n".repeat(65) }).success).toBe(false);
    expect(Tag.safeParse({ ...validTag, description: "d".repeat(301) }).success).toBe(false);
  });
});

describe("Decision", () => {
  const kindPayloads: [string, Record<string, unknown>][] = [
    ["set_category", { category: "docs" }],
    ["add_tags", { tags: ["typescript"] }],
    ["move", { targetFolderId: "folder-9" }],
    ["mark_dead", { evidence: "http" }],
    ["merge_duplicates", { keepId: "bm-002" }],
    ["rename", { newTitle: "A better title" }],
    ["create_folder", { path: ["Reading", "2026"], description: "d" }],
  ];

  it("accepts matching kind payloads and rejects missing or mismatched payloads", () => {
    for (const [kind, payload] of kindPayloads) {
      expect(
        Decision.safeParse({ ...decisionBase, kind, ...payload }).success,
      ).toBe(true);
      expect(Decision.safeParse({ ...decisionBase, kind }).success).toBe(false);
    }
    expect(Decision.safeParse({ ...validDecision, kind: "move" }).success).toBe(false);
  });

  it("validates confidence bounds and general decision fields", () => {
    for (const confidence of [-0.01, 1.01, 2]) {
      expect(Decision.safeParse({ ...validDecision, confidence }).success).toBe(false);
    }
    for (const confidence of [0, 1]) {
      expect(Decision.safeParse({ ...validDecision, confidence }).success).toBe(true);
    }

    const patches = [
      { id: "not-a-uuid" },
      { status: "maybe" },
      { bookmarkIds: [] },
      { source: { ...decisionBase.source, engine: "bot" } },
    ];
    for (const patch of patches) {
      expect(Decision.safeParse({ ...validDecision, ...patch }).success).toBe(false);
    }
  });
});

describe("ProviderSettings", () => {
  it("accepts valid records and supported models per preset", () => {
    expect(ProviderSettings.safeParse(validProviderSettings).success).toBe(true);

    for (const model of PRESET_MODELS.typesafe) {
      expect(
        ProviderSettings.safeParse({ ...validProviderSettings, preset: "typesafe", model }).success,
      ).toBe(true);
    }
    for (const model of PRESET_MODELS.openrouter) {
      expect(
        ProviderSettings.safeParse({ ...validProviderSettings, preset: "openrouter", model }).success,
      ).toBe(true);
    }
  });

  it("rejects cross-preset exclusive models and invalid presets", () => {
    const openrouterOnly = PRESET_MODELS.openrouter.filter(
      (m) => !(PRESET_MODELS.typesafe as readonly string[]).includes(m),
    );
    const typesafeOnly = PRESET_MODELS.typesafe.filter(
      (m) => !(PRESET_MODELS.openrouter as readonly string[]).includes(m),
    );

    for (const model of openrouterOnly) {
      expect(
        ProviderSettings.safeParse({ ...validProviderSettings, preset: "typesafe", model }).success,
      ).toBe(false);
    }
    for (const model of typesafeOnly) {
      expect(
        ProviderSettings.safeParse({ ...validProviderSettings, preset: "openrouter", model }).success,
      ).toBe(false);
    }

    expect(
      ProviderSettings.safeParse({ ...validProviderSettings, preset: "custom", model: "jev-latest" }).success,
    ).toBe(false);
    expect(
      ProviderSettings.safeParse({ ...validProviderSettings, keySuffix: "" }).success,
    ).toBe(false);
  });

  it("accepts the custom variant — canonical base URL and a free-form model id", () => {
    const custom = {
      preset: "custom",
      baseUrl: "https://ai-gateway.example.com/api",
      model: "some-vendor/jev-edge",
      keySuffix: "cdef",
    };
    const result = ProviderSettings.safeParse(custom);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(custom);
    }
    // A model id that is not on any preset allowlist is still fine here —
    // the allowlist is per provider, and custom's list is its own row.
    expect(
      ProviderSettings.safeParse({ ...custom, model: "unlisted-elsewhere" })
        .success,
    ).toBe(true);
    // Loopback http is allowed; remote http never is.
    expect(
      ProviderSettings.safeParse({ ...custom, baseUrl: "http://localhost:8080/api" })
        .success,
    ).toBe(true);
  });

  it("rejects the custom variant on a bad base URL, missing fields, or extra keys", () => {
    const base = {
      preset: "custom",
      baseUrl: "https://ai-gateway.example.com/api",
      model: "jev-edge",
      keySuffix: "cdef",
    };
    const invalid = [
      { ...base, baseUrl: "http://ai-gateway.example.com/api" }, // non-loopback http
      { ...base, baseUrl: "https://ai-gateway.example.com/api/" }, // non-canonical
      { ...base, baseUrl: "https://user:pw@ai-gateway.example.com/api" }, // credentials
      { ...base, baseUrl: "not a url" },
      { preset: "custom", model: "jev-edge", keySuffix: "cdef" }, // no baseUrl
      { ...base, model: "   " }, // blank model after trim
      { ...base, extra: true }, // strict object
    ];
    for (const row of invalid) {
      expect(ProviderSettings.safeParse(row).success).toBe(false);
    }
  });
});

describe("ConsentRecord", () => {
  it("accepts valid records and enforces scope bounds", () => {
    expect(ConsentRecord.safeParse(validConsent).success).toBe(true);
    expect(CONSENT_SCOPE).toBe("jev_test");
    expect(
      ConsentRecord.safeParse({ ...validConsent, scope: "bookmark_analysis" }).success,
    ).toBe(false);
  });

  it("validates origin formats and record fields", () => {
    for (const origin of ["http://api.typesafe.ai", "https://api.typesafe.ai/", "https://api.typesafe.ai/v1", "api.typesafe.ai"]) {
      expect(ConsentRecord.safeParse({ ...validConsent, origin }).success).toBe(false);
    }
    for (const patch of [{ consentVersion: 0 }, { consentVersion: 1.5 }, { acceptedAt: "2026-09-25" }]) {
      expect(ConsentRecord.safeParse({ ...validConsent, ...patch }).success).toBe(false);
    }
  });
});
