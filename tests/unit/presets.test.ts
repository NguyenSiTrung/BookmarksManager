import { describe, expect, it } from "vitest";
import { PRESETS, resolvePreset } from "../../src/net/presets";
import { PRESET_MODELS, type PresetId } from "../../src/schemas/provider";

const PRESET_IDS = ["typesafe", "openrouter"] as const;

describe("PRESETS registry", () => {
  it("contains exactly the TypeSafe and OpenRouter presets", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(["openrouter", "typesafe"]);
  });

  it("pins the TypeSafe System One destination from §8.1", () => {
    expect(PRESETS.typesafe).toEqual({
      origin: "https://api.typesafe.ai",
      url: "https://api.typesafe.ai/v1/systemone",
      permissionPattern: "https://api.typesafe.ai/*",
      models: ["jev-latest", "jev-preview", "jev-1.13.0"],
    });
  });

  it("pins the OpenRouter System One destination from §8.1", () => {
    expect(PRESETS.openrouter).toEqual({
      origin: "https://openrouter.ai",
      url: "https://openrouter.ai/api/v1/systemone",
      permissionPattern: "https://openrouter.ai/*",
      models: ["jev-latest", "jev-1.13", "typesafe/jev-1.13"],
    });
  });

  it("shares the schema-level model allowlists", () => {
    for (const id of PRESET_IDS) {
      expect(PRESETS[id].models).toEqual(PRESET_MODELS[id]);
    }
  });

  it("only ever holds HTTPS destinations whose origin matches the URL", () => {
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id];
      expect(new URL(preset.url).protocol).toBe("https:");
      expect(new URL(preset.origin).protocol).toBe("https:");
      expect(preset.origin).toBe(new URL(preset.url).origin);
      expect(preset.permissionPattern).toBe(`${preset.origin}/*`);
      // A non-HTTPS variant of the same host is never a preset.
      expect(preset.url.startsWith("http://")).toBe(false);
      expect(preset.origin.startsWith("http://")).toBe(false);
      expect(preset.permissionPattern.startsWith("http://")).toBe(false);
    }
  });

  it("is deeply immutable at runtime", () => {
    expect(Object.isFrozen(PRESETS)).toBe(true);
    for (const id of PRESET_IDS) {
      expect(Object.isFrozen(PRESETS[id])).toBe(true);
      expect(Object.isFrozen(PRESETS[id].models)).toBe(true);
    }
    // Modules are strict mode, so writes to frozen members throw.
    expect(() => {
      (PRESETS.openrouter as { url: string }).url = "https://evil.example";
    }).toThrow(TypeError);
    expect(() => {
      (PRESETS.typesafe.models as unknown as string[]).push("evil-model");
    }).toThrow(TypeError);
  });

  it("resolvePreset returns the registry entry for every preset id", () => {
    for (const id of PRESET_IDS) {
      expect(resolvePreset(id)).toBe(PRESETS[id]);
    }
  });

  it("resolvePreset rejects unknown preset ids instead of returning undefined", () => {
    expect(() => resolvePreset("anthropic" as unknown as PresetId)).toThrow();
    expect(() => resolvePreset("" as unknown as PresetId)).toThrow();
    expect(() =>
      resolvePreset("https://evil.example" as unknown as PresetId),
    ).toThrow();
  });
});
