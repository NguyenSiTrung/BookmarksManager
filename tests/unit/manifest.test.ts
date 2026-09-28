import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../wxt.config";

/**
 * Static manifest assertions for the LLM host-permission capability
 * (spec FR2.1): the extension may declare the broad HTTPS capability plus
 * narrowly scoped loopback HTTP patterns as *optional* hosts — requested at
 * runtime per exact origin, from a direct user gesture. Required
 * `permissions` and `host_permissions` must stay zero-egress.
 */

const manifest = (config as { manifest?: Record<string, unknown> }).manifest;

describe("manifest host permissions", () => {
  it("declares only optional hosts — no static host_permissions", () => {
    expect(manifest).toBeDefined();
    expect(manifest?.host_permissions).toBeUndefined();
  });

  it("keeps the exact optional host list: presets + https capability + loopback", () => {
    expect(manifest?.optional_host_permissions).toEqual([
      "https://api.typesafe.ai/*",
      "https://openrouter.ai/*",
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "http://[::1]/*",
    ]);
  });

  it("keeps the required permission set unchanged", () => {
    expect(manifest?.permissions).toEqual([
      "activeTab",
      "bookmarks",
      "contextMenus",
      "favicon",
      "scripting",
      "storage",
      "sidePanel",
    ]);
  });
});

const ROOT = resolve(__dirname, "..", "..");

function pngDims(path: string): { w: number; h: number } {
  const buf = readFileSync(path);
  expect(buf.readUInt32BE(0), `${path} PNG signature`).toBe(0x89504e47);
  expect(buf.toString("ascii", 12, 16), `${path} IHDR`).toBe("IHDR");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("manifest icons and store assets", () => {
  it("declares 16/32/48/128 icons that exist as correctly-sized PNGs", () => {
    const icons = manifest?.icons as Record<string, string> | undefined;
    expect(icons).toBeDefined();
    for (const size of ["16", "32", "48", "128"]) {
      const rel = icons?.[size];
      expect(rel, `icons["${size}"]`).toBeDefined();
      const abs = join(ROOT, "public", rel!);
      expect(existsSync(abs), `${rel} exists`).toBe(true);
      expect(pngDims(abs), `${rel} dimensions`).toEqual({
        w: Number(size),
        h: Number(size),
      });
    }
  });

  it("ships a 128×128 store icon and a 440×280 promo tile", () => {
    const icon = join(ROOT, "store", "assets", "icon-128.png");
    const promo = join(ROOT, "store", "assets", "promo-440x280.png");
    expect(existsSync(icon)).toBe(true);
    expect(pngDims(icon)).toEqual({ w: 128, h: 128 });
    expect(existsSync(promo)).toBe(true);
    expect(pngDims(promo)).toEqual({ w: 440, h: 280 });
  });
});
