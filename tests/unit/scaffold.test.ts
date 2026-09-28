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
  it("declares the required permissions", () => {
    // `bookmarks` joined the initial set in Phase 1 Task 6 (worker sync:
    // cascade delete + startup reconcile read/write the native tree);
    // `favicon` joined in Phase 4 Task 1 (Chrome's `_favicon` renderer
    // serves site icons for the manager UI — no host access needed);
    // `activeTab` joined in Phase 5 Task 1 (the quick-save popup reads the
    // active tab's title/URL on the user's action); `contextMenus` joined in
    // Phase 5 Task 3 (the right-click "Save page"/"Save link" items).
    // `scripting` joined in the Phase 5 LLM track (opt-in page extraction
    // injects `extract.js` into the active tab, on explicit action only).
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

  it("declares only capability-level optional host patterns", () => {
    // The broad https/loopback patterns are only a *capability*: the user
    // grants the exact configured origin at runtime, and the egress gate
    // re-checks origin + consent before any request (spec FR2.1).
    expect(manifest?.optional_host_permissions).toEqual([
      "https://api.typesafe.ai/*",
      "https://openrouter.ai/*",
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
      "http://[::1]/*",
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
