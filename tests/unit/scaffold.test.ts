import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../wxt.config";

const manifest = config.manifest as
  | {
      permissions?: string[];
      optional_host_permissions?: string[];
      host_permissions?: string[];
    }
  | undefined;

describe("extension scaffold", () => {
  it("declares only the initial required permissions", () => {
    expect(manifest?.permissions).toEqual(["storage", "sidePanel"]);
  });

  it("declares only the initial host patterns", () => {
    expect(manifest?.optional_host_permissions).toEqual([
      "https://api.typesafe.ai/*",
      "https://openrouter.ai/*",
    ]);
  });

  it("declares no required host permissions", () => {
    expect(manifest?.host_permissions ?? []).toEqual([]);
  });

  it("has a background entrypoint", () => {
    expect(existsSync("src/entrypoints/background.ts")).toBe(true);
  });

  it("has a popup entrypoint", () => {
    expect(existsSync("src/entrypoints/popup/index.html")).toBe(true);
  });

  it("has a side panel entrypoint", () => {
    expect(existsSync("src/entrypoints/sidepanel/index.html")).toBe(true);
  });

  it("has an Options entrypoint", () => {
    expect(existsSync("src/entrypoints/options/index.html")).toBe(true);
  });
});
