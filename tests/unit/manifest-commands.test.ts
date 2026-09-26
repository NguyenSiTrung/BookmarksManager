import { describe, expect, it } from "vitest";
import config from "../../wxt.config";

/**
 * Chrome's built-in extension shortcuts (chrome://extensions/shortcuts),
 * plus their macOS Command equivalents. A suggested key colliding with any of
 * these is ignored or shadowed by the browser, so the extension must pick
 * something outside this set.
 *
 * Source: Chrome's documented default shortcut list — Ctrl+Shift+B,
 * Ctrl+Shift+O, Ctrl+Shift+D, Ctrl+D, Ctrl+Shift+T, Ctrl+Shift+N, Ctrl+T,
 * Ctrl+N, Ctrl+W, Ctrl+Shift+W, Ctrl+Shift+Q, Ctrl+Shift+Delete,
 * Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+J, Ctrl+H, Ctrl+Shift+Space, F12 — with
 * each Ctrl combination mirrored as the Mac Command equivalent.
 */
const CHROME_DEFAULT_SHORTCUTS = new Set<string>([
  "Ctrl+Shift+B",
  "Ctrl+Shift+O",
  "Ctrl+Shift+D",
  "Ctrl+D",
  "Ctrl+Shift+T",
  "Ctrl+Shift+N",
  "Ctrl+T",
  "Ctrl+N",
  "Ctrl+W",
  "Ctrl+Shift+W",
  "Ctrl+Shift+Q",
  "Ctrl+Shift+Delete",
  "Ctrl+Shift+I",
  "Ctrl+Shift+J",
  "Ctrl+J",
  "Ctrl+H",
  "Ctrl+Shift+Space",
  "F12",
  "Command+Shift+B",
  "Command+Shift+O",
  "Command+Shift+D",
  "Command+D",
  "Command+Shift+T",
  "Command+Shift+N",
  "Command+T",
  "Command+N",
  "Command+W",
  "Command+Shift+W",
  "Command+Shift+Q",
  "Command+Shift+Delete",
  "Command+Shift+I",
  "Command+Shift+J",
  "Command+J",
  "Command+H",
  "Command+Shift+Space",
]);

/** Chrome's suggested_key grammar, e.g. `Ctrl+Shift+Y` or `Command+Shift+Y`. */
const SHORTCUT_SHAPE = /^(Ctrl|Alt|Command|MacCtrl)(\+Shift)?\+[A-Z0-9]$/;

const manifest = config.manifest as
  | {
      commands?: Record<
        string,
        {
          suggested_key?: { default?: string; mac?: string };
          description?: string;
        }
      >;
    }
  | undefined;

describe("manifest keyboard shortcut", () => {
  it("maps _execute_action to the quick-save popup", () => {
    const command = manifest?.commands?._execute_action;
    expect(command).toBeDefined();
    expect(command?.description?.trim().length ?? 0).toBeGreaterThan(0);
    expect(command?.suggested_key?.default?.trim().length ?? 0).toBeGreaterThan(
      0,
    );
  });

  it("suggests a macOS binding too", () => {
    const mac = manifest?.commands?._execute_action?.suggested_key?.mac;
    expect(mac).toBeTruthy();
    expect(SHORTCUT_SHAPE.test(mac ?? "")).toBe(true);
  });

  it("avoids Chrome's built-in default shortcuts", () => {
    const defaultKey = manifest?.commands?._execute_action?.suggested_key
      ?.default;
    expect(defaultKey).toBeTruthy();
    expect(CHROME_DEFAULT_SHORTCUTS.has(defaultKey ?? "")).toBe(false);
  });

  it("uses a well-formed suggested key", () => {
    const defaultKey = manifest?.commands?._execute_action?.suggested_key
      ?.default;
    expect(defaultKey).toBeTruthy();
    expect(SHORTCUT_SHAPE.test(defaultKey ?? "")).toBe(true);
  });
});
