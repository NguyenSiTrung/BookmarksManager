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
      "storage",
      "sidePanel",
    ]);
  });
});
