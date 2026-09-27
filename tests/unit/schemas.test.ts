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
  it("accepts a valid record", () => {
    expect(Bookmark.safeParse(validBookmark).success).toBe(true);
  });

  it.each(["not a url", "example.com/path", "", "https://"])(
    "rejects invalid url %j",
    (url) => {
      expect(Bookmark.safeParse({ ...validBookmark, url }).success).toBe(false);
    },
  );

  it.each([["empty", ""], ["over 500 chars", "x".repeat(501)]])(
    "rejects title that is %s",
    (_label, title) => {
      expect(
        Bookmark.safeParse({ ...validBookmark, title }).success,
      ).toBe(false);
    },
  );

  it.each([["one char", "x"], ["500 chars", "x".repeat(500)]])(
    "accepts title that is %s",
    (_label, title) => {
      expect(Bookmark.safeParse({ ...validBookmark, title }).success).toBe(
        true,
      );
    },
  );

  it("defaults health to { status: \"unknown\" }", () => {
    expect(Bookmark.parse(validBookmark).health).toEqual({
      status: "unknown",
    });
  });

  it("defaults tags to []", () => {
    expect(Bookmark.parse(validBookmark).tags).toEqual([]);
  });

  it("keeps an explicit health record", () => {
    const parsed = Bookmark.parse({
      ...validBookmark,
      health: { status: "dead", httpCode: 404 },
    });
    expect(parsed.health).toEqual({ status: "dead", httpCode: 404 });
  });

  it.each([
    ["unknown category", { category: "not-a-category" }],
    ["wrong schemaVersion", { schemaVersion: 2 }],
    ["notes over 10k", { notes: "n".repeat(10_001) }],
    ["non-ISO createdAt", { createdAt: "last Tuesday" }],
    ["invalid health.finalUrl", {
      health: { status: "redirect", finalUrl: "not a url" },
    }],
  ])("rejects %s", (_label, patch) => {
    expect(
      Bookmark.safeParse({ ...validBookmark, ...patch }).success,
    ).toBe(false);
  });
});

describe("Tag", () => {
  it("accepts a valid tag", () => {
    expect(Tag.safeParse(validTag).success).toBe(true);
  });

  it.each([["empty", ""], ["over 64 chars", "n".repeat(65)]])(
    "rejects name that is %s",
    (_label, name) => {
      expect(Tag.safeParse({ ...validTag, name }).success).toBe(false);
    },
  );

  it("rejects a description over 300 chars", () => {
    expect(
      Tag.safeParse({ ...validTag, description: "d".repeat(301) }).success,
    ).toBe(false);
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

  it.each(kindPayloads)(
    "accepts kind %s with its matching payload",
    (kind, payload) => {
      expect(
        Decision.safeParse({ ...decisionBase, kind, ...payload }).success,
      ).toBe(true);
    },
  );

  it.each(kindPayloads)(
    "rejects kind %s when its payload is missing",
    (kind) => {
      expect(Decision.safeParse({ ...decisionBase, kind }).success).toBe(
        false,
      );
    },
  );

  it("rejects kind \"move\" when the record carries another kind's payload", () => {
    expect(Decision.safeParse({ ...validDecision, kind: "move" }).success).toBe(
      false,
    );
  });

  it.each([-0.01, 1.01, 2])("rejects confidence %s", (confidence) => {
    expect(
      Decision.safeParse({ ...validDecision, confidence }).success,
    ).toBe(false);
  });

  it.each([0, 1])("accepts boundary confidence %s", (confidence) => {
    expect(
      Decision.safeParse({ ...validDecision, confidence }).success,
    ).toBe(true);
  });

  it.each([
    ["non-uuid id", { id: "not-a-uuid" }],
    ["unknown status", { status: "maybe" }],
    ["empty bookmarkIds", { bookmarkIds: [] }],
    ["unknown engine", { source: { ...decisionBase.source, engine: "bot" } }],
  ])("rejects %s", (_label, patch) => {
    expect(
      Decision.safeParse({ ...validDecision, ...patch }).success,
    ).toBe(false);
  });
});

describe("ProviderSettings", () => {
  it("accepts a valid record", () => {
    expect(ProviderSettings.safeParse(validProviderSettings).success).toBe(
      true,
    );
  });

  it.each([...PRESET_MODELS.typesafe])(
    "accepts typesafe model %s",
    (model) => {
      expect(
        ProviderSettings.safeParse({
          ...validProviderSettings,
          preset: "typesafe",
          model,
        }).success,
      ).toBe(true);
    },
  );

  it.each([...PRESET_MODELS.openrouter])(
    "accepts openrouter model %s",
    (model) => {
      expect(
        ProviderSettings.safeParse({
          ...validProviderSettings,
          preset: "openrouter",
          model,
        }).success,
      ).toBe(true);
    },
  );

  // jev-latest is allowed on both presets; only preset-exclusive models are
  // used for the cross-preset rejection cases.
  const openrouterOnly = PRESET_MODELS.openrouter.filter(
    (model) => !(PRESET_MODELS.typesafe as readonly string[]).includes(model),
  );
  const typesafeOnly = PRESET_MODELS.typesafe.filter(
    (model) => !(PRESET_MODELS.openrouter as readonly string[]).includes(model),
  );

  it.each(openrouterOnly)(
    "rejects openrouter-only model %s on the typesafe preset",
    (model) => {
      expect(
        ProviderSettings.safeParse({
          ...validProviderSettings,
          preset: "typesafe",
          model,
        }).success,
      ).toBe(false);
    },
  );

  it.each(typesafeOnly)(
    "rejects typesafe-only model %s on the openrouter preset",
    (model) => {
      expect(
        ProviderSettings.safeParse({
          ...validProviderSettings,
          preset: "openrouter",
          model,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["unknown preset", { preset: "custom", model: "jev-latest" }],
    ["empty keySuffix", { keySuffix: "" }],
  ])("rejects %s", (_label, patch) => {
    expect(
      ProviderSettings.safeParse({ ...validProviderSettings, ...patch })
        .success,
    ).toBe(false);
  });
});

describe("ConsentRecord", () => {
  it("accepts a valid jev_test consent", () => {
    expect(ConsentRecord.safeParse(validConsent).success).toBe(true);
  });

  it("is scoped to the jev_test and jev_decisions scopes only", () => {
    expect(CONSENT_SCOPE).toBe("jev_test");
    expect(
      ConsentRecord.safeParse({
        ...validConsent,
        scope: "bookmark_analysis",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["http origin", "http://api.typesafe.ai"],
    ["trailing slash", "https://api.typesafe.ai/"],
    ["origin with path", "https://api.typesafe.ai/v1"],
    ["non-url", "api.typesafe.ai"],
  ])("rejects origin %s", (_label, origin) => {
    expect(
      ConsentRecord.safeParse({ ...validConsent, origin }).success,
    ).toBe(false);
  });

  it.each([
    ["zero version", { consentVersion: 0 }],
    ["fractional version", { consentVersion: 1.5 }],
    ["non-ISO acceptedAt", { acceptedAt: "2026-09-25" }],
  ])("rejects %s", (_label, patch) => {
    expect(
      ConsentRecord.safeParse({ ...validConsent, ...patch }).success,
    ).toBe(false);
  });
});
