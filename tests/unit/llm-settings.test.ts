import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/db/database";
import {
  deleteLlmProvider,
  readActiveLlmProvider,
  readLlmProvider,
  saveLlmProvider,
} from "../../src/llm/settings";
import {
  readCredential,
  saveCredential,
} from "../../src/security/credentials";

function installChromeStub(): void {
  const store: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(keys?: string | string[] | null) {
          if (keys == null) return { ...store };
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (key in store) out[key] = store[key];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(store, items);
        },
        async remove(keys: string | string[]) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete store[key];
          }
        },
      },
    },
  });
}

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  installChromeStub();
  await db.delete();
  await db.open();
});

afterAll(() => {
  db.close();
  vi.unstubAllGlobals();
});

const PRESET_SETTINGS = {
  kind: "preset" as const,
  preset: "openai" as const,
};

const CUSTOM_SETTINGS = {
  kind: "custom" as const,
  baseUrl: "https://api.example.com/v1",
  model: "llama-3",
  auth: "bearer" as const,
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "preset:openai",
    provider: PRESET_SETTINGS,
    configuredAt: "2026-09-28T00:00:00Z",
    ...overrides,
  };
}

describe("saveLlmProvider / readLlmProvider", () => {
  it("round-trips a preset provider record", async () => {
    await saveLlmProvider(record());
    const stored = await readLlmProvider("preset:openai");
    expect(stored).toMatchObject({
      providerId: "preset:openai",
      provider: { kind: "preset", preset: "openai" },
    });
  });

  it("round-trips a custom provider record with tier and masked suffix", async () => {
    await saveLlmProvider(
      record({
        providerId: "custom:https://api.example.com/v1",
        provider: CUSTOM_SETTINGS,
        keySuffix: "…wxyz",
        tier: "json_object",
      }),
    );
    const stored = await readLlmProvider(
      "custom:https://api.example.com/v1",
    );
    expect(stored).toMatchObject({
      providerId: "custom:https://api.example.com/v1",
      provider: CUSTOM_SETTINGS,
      keySuffix: "…wxyz",
      tier: "json_object",
    });
  });

  it("returns null for an unconfigured provider", async () => {
    expect(await readLlmProvider("preset:openrouter")).toBeNull();
  });

  it("rejects a record whose provider settings fail the schema", async () => {
    await expect(
      saveLlmProvider(
        record({ provider: { kind: "custom", baseUrl: "http://evil.com" } }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a record that smuggles a raw credential field", async () => {
    await expect(
      saveLlmProvider(record({ apiKey: "sk-secret" })),
    ).rejects.toThrow();
    expect(await readLlmProvider("preset:openai")).toBeNull();
  });

  it("rejects a record that is both capped and unlimited", async () => {
    await expect(
      saveLlmProvider(
        record({ monthlyBudgetUsd: 5, monthlyBudgetUnlimited: true }),
      ),
    ).rejects.toThrow();
    expect(await readLlmProvider("preset:openai")).toBeNull();
  });

  it("round-trips an explicitly unlimited ceiling", async () => {
    await saveLlmProvider(record({ monthlyBudgetUnlimited: true }));
    const stored = await readLlmProvider("preset:openai");
    expect(stored?.monthlyBudgetUnlimited).toBe(true);
    expect(stored?.monthlyBudgetUsd).toBeUndefined();
  });

  it("round-trips a preset pricing override", async () => {
    await saveLlmProvider(
      record({
        provider: {
          kind: "preset",
          preset: "openai",
          model: "gpt-4o-2024-11-20",
          pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
        },
      }),
    );
    const stored = await readLlmProvider("preset:openai");
    expect(stored?.provider).toMatchObject({
      pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
    });
  });

  it("never persists raw credential material in IndexedDB", async () => {
    const secret = "sk-live-secret-value";
    await saveCredential("preset:openai", secret);
    await saveLlmProvider(record({ keySuffix: "…alue" }));

    for (const row of await db.metadata.toArray()) {
      expect(JSON.stringify(row.value)).not.toContain(secret);
    }
    // The record stores only the masked suffix.
    const stored = await readLlmProvider("preset:openai");
    expect(JSON.stringify(stored)).not.toContain(secret);
  });
});

describe("readActiveLlmProvider", () => {
  it("returns null when no provider is configured", async () => {
    expect(await readActiveLlmProvider()).toBeNull();
  });

  it("returns the provider most recently saved", async () => {
    await saveLlmProvider(record());
    await saveLlmProvider(
      record({
        providerId: "custom:https://api.example.com/v1",
        provider: CUSTOM_SETTINGS,
      }),
    );
    const active = await readActiveLlmProvider();
    expect(active?.providerId).toBe("custom:https://api.example.com/v1");
  });
});

describe("deleteLlmProvider", () => {
  it("removes the record, credential, and active pointer", async () => {
    await saveCredential("preset:openai", "sk-secret");
    await saveLlmProvider(record());

    await deleteLlmProvider("preset:openai");

    expect(await readLlmProvider("preset:openai")).toBeNull();
    expect(await readCredential("preset:openai")).toBeNull();
    expect(await readActiveLlmProvider()).toBeNull();
  });

  it("keeps a different active provider when deleting another", async () => {
    await saveLlmProvider(record());
    await saveLlmProvider(
      record({
        providerId: "custom:https://api.example.com/v1",
        provider: CUSTOM_SETTINGS,
      }),
    );

    await deleteLlmProvider("preset:openai");

    const active = await readActiveLlmProvider();
    expect(active?.providerId).toBe("custom:https://api.example.com/v1");
  });

  it("clears the provider's reservation rows", async () => {
    await saveLlmProvider(record());
    await db.llmReservations.put({
      id: "res-1",
      providerId: "preset:openai",
      model: "m",
      month: "2026-09",
      reservedUsd: 0.5,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      kind: "manual",
      status: "active",
      createdAt: "2026-09-28T00:00:00Z",
    });
    await db.llmReservations.put({
      id: "res-other",
      providerId: "preset:openrouter",
      model: "m",
      month: "2026-09",
      reservedUsd: 0.5,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      kind: "manual",
      status: "active",
      createdAt: "2026-09-28T00:00:00Z",
    });

    await deleteLlmProvider("preset:openai");

    expect(await db.llmReservations.get("res-1")).toBeUndefined();
    expect(await db.llmReservations.get("res-other")).toBeDefined();
  });

  it("is a no-op for an unconfigured provider", async () => {
    await expect(
      deleteLlmProvider("preset:openrouter"),
    ).resolves.toBeUndefined();
  });
});
