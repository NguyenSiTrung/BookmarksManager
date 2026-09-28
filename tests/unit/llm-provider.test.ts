import { describe, expect, it } from "vitest";
import { resolveLlmDestination } from "../../src/llm/providers";
import {
  LlmAuthMode,
  LlmProviderSettings,
  StructuredOutputTier,
} from "../../src/schemas/llm";

const custom = (baseUrl: string, extra: Record<string, unknown> = {}) =>
  ({
    kind: "custom",
    baseUrl,
    model: "test-model",
    auth: "bearer",
    ...extra,
  }) satisfies Record<string, unknown>;

describe("LlmProviderSettings", () => {
  it("accepts curated openai and openrouter presets", () => {
    for (const preset of ["openai", "openrouter"] as const) {
      const parsed = LlmProviderSettings.parse({ kind: "preset", preset });
      if (parsed.kind !== "preset") {
        throw new Error("expected preset variant");
      }
      expect(parsed.preset).toBe(preset);
    }
  });

  it("accepts a custom provider with a /v1 base path", () => {
    const parsed = LlmProviderSettings.parse(custom("https://llm.example.com/v1"));
    expect(parsed).toMatchObject({
      kind: "custom",
      baseUrl: "https://llm.example.com/v1",
      model: "test-model",
      auth: "bearer",
    });
  });

  it("accepts optional input/output token pricing", () => {
    const parsed = LlmProviderSettings.parse(
      custom("https://llm.example.com", {
        pricing: { inputPerMillion: 0.5, outputPerMillion: 1.5 },
      }),
    );
    expect(parsed.kind).toBe("custom");
    if (parsed.kind === "custom") {
      expect(parsed.pricing).toEqual({
        inputPerMillion: 0.5,
        outputPerMillion: 1.5,
      });
    }
  });

  it("rejects negative pricing", () => {
    expect(() =>
      LlmProviderSettings.parse(
        custom("https://llm.example.com", {
          pricing: { inputPerMillion: -1, outputPerMillion: 1 },
        }),
      ),
    ).toThrow();
  });

  it("accepts all three auth modes", () => {
    for (const auth of ["bearer", "api-key", "none"] as const) {
      expect(LlmAuthMode.parse(auth)).toBe(auth);
      expect(
        LlmProviderSettings.parse(custom("https://llm.example.com", { auth })),
      ).toMatchObject({ auth });
    }
  });

  it("rejects a blank model identifier", () => {
    for (const model of ["", "   "]) {
      expect(() =>
        LlmProviderSettings.parse(custom("https://llm.example.com", { model })),
      ).toThrow();
    }
  });

  it("rejects arbitrary auth modes", () => {
    for (const auth of ["token", "x-api-key", "basic"]) {
      expect(() =>
        LlmProviderSettings.parse(custom("https://llm.example.com", { auth })),
      ).toThrow();
    }
  });

  it("rejects arbitrary user-defined headers and unknown keys", () => {
    expect(() =>
      LlmProviderSettings.parse(
        custom("https://llm.example.com", {
          headers: { "x-evil": "1" },
        }),
      ),
    ).toThrow();
    expect(() =>
      LlmProviderSettings.parse(custom("https://llm.example.com", { extra: 1 })),
    ).toThrow();
    expect(() =>
      LlmProviderSettings.parse({ kind: "preset", preset: "openai", extra: true }),
    ).toThrow();
  });

  it("rejects unknown preset ids and malformed values", () => {
    expect(() =>
      LlmProviderSettings.parse({ kind: "preset", preset: "acme" }),
    ).toThrow();
    for (const value of [null, 42, "https://x", { kind: "weird" }]) {
      expect(() => LlmProviderSettings.parse(value)).toThrow();
    }
  });

  it("exposes the three structured-output tiers", () => {
    expect(StructuredOutputTier.options).toEqual([
      "json_schema",
      "json_object",
      "prompt_only",
    ]);
  });
});

describe("resolveLlmDestination", () => {
  it("resolves the openai preset", () => {
    const dest = resolveLlmDestination({ kind: "preset", preset: "openai" });
    expect(dest.origin).toBe("https://api.openai.com");
    expect(dest.baseUrl).toBe("https://api.openai.com/v1");
    expect(dest.chatCompletionsUrl).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(dest.modelsUrl).toBe("https://api.openai.com/v1/models");
    expect(dest.permissionPattern).toBe("https://api.openai.com/*");
    expect(dest.auth).toBe("bearer");
    expect(dest.providerId).toBe("preset:openai");
  });

  it("resolves the openrouter preset", () => {
    const dest = resolveLlmDestination({
      kind: "preset",
      preset: "openrouter",
    });
    expect(dest.origin).toBe("https://openrouter.ai");
    expect(dest.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(dest.chatCompletionsUrl).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(dest.permissionPattern).toBe("https://openrouter.ai/*");
    expect(dest.auth).toBe("bearer");
    expect(dest.providerId).toBe("preset:openrouter");
  });

  it("carries the configured model on presets", () => {
    const dest = resolveLlmDestination({
      kind: "preset",
      preset: "openai",
      model: "gpt-5-mini",
    });
    expect(dest.model).toBe("gpt-5-mini");
  });

  it("joins endpoints onto custom base paths", () => {
    const dest = resolveLlmDestination(
      LlmProviderSettings.parse({
        kind: "custom",
        baseUrl: "https://llm.internal.example.com/v2/api",
        model: "m",
        auth: "none",
      }),
    );
    expect(dest.origin).toBe("https://llm.internal.example.com");
    expect(dest.baseUrl).toBe("https://llm.internal.example.com/v2/api");
    expect(dest.chatCompletionsUrl).toBe(
      "https://llm.internal.example.com/v2/api/chat/completions",
    );
    expect(dest.modelsUrl).toBe(
      "https://llm.internal.example.com/v2/api/models",
    );
    expect(dest.providerId).toBe(
      "custom:https://llm.internal.example.com/v2/api",
    );
  });

  it("permits plain HTTP only for literal loopback hosts across ports", () => {
    for (const baseUrl of [
      "http://localhost:11434",
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v1",
      "http://[::1]:9000/v1",
    ]) {
      const dest = resolveLlmDestination(
        LlmProviderSettings.parse({
          kind: "custom",
          baseUrl,
          model: "m",
          auth: "none",
        }),
      );
      expect(dest.baseUrl).toBe(baseUrl);
    }
  });

  it("derives a host-only permission pattern (ports are not expressible)", () => {
    const dest = resolveLlmDestination(
      LlmProviderSettings.parse({
        kind: "custom",
        baseUrl: "http://localhost:11434",
        model: "m",
        auth: "none",
      }),
    );
    expect(dest.origin).toBe("http://localhost:11434");
    expect(dest.permissionPattern).toBe("http://localhost/*");
  });

  it("rejects non-loopback plain HTTP", () => {
    for (const baseUrl of [
      "http://example.com/v1",
      "http://192.168.1.5/v1",
      "http://10.0.0.2",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
    ]) {
      expect(() =>
        LlmProviderSettings.parse({
          kind: "custom",
          baseUrl,
          model: "m",
          auth: "none",
        }),
      ).toThrow();
    }
  });

  it("rejects userinfo, query strings, and fragments", () => {
    for (const baseUrl of [
      "https://user:pass@api.example.com/v1",
      "https://user@api.example.com/v1",
      "https://api.example.com/v1?key=1",
      "https://api.example.com/v1#frag",
      "https://api.example.com/v1?",
    ]) {
      expect(() =>
        LlmProviderSettings.parse({
          kind: "custom",
          baseUrl,
          model: "m",
          auth: "none",
        }),
      ).toThrow();
    }
  });

  it("rejects unsupported schemes", () => {
    for (const baseUrl of [
      "ftp://api.example.com/v1",
      "file:///etc/passwd",
      "ws://localhost:1234",
      "chrome-extension://abc/v1",
      "notaurl",
      "",
    ]) {
      expect(() =>
        LlmProviderSettings.parse({
          kind: "custom",
          baseUrl,
          model: "m",
          auth: "none",
        }),
      ).toThrow();
    }
  });

  it("rejects non-canonical origins and paths", () => {
    for (const baseUrl of [
      "https://api.example.com/v1/",
      "https://api.example.com/",
      "https://API.EXAMPLE.COM/v1",
      "https://api.example.com:443/v1",
      "https://api.example.com/v1/../v2",
      "https://api.example.com//v1",
      "http://localhost:80",
    ]) {
      expect(() =>
        LlmProviderSettings.parse({
          kind: "custom",
          baseUrl,
          model: "m",
          auth: "none",
        }),
      ).toThrow();
    }
  });
});
