import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The assertions above read the CONFIG object, which only proves what WXT was
 * asked to emit. `npm run check:manifest` and the e2e keyboard assertion cover
 * the built artifact, but a cheap check here closes the gap where a WXT
 * change could drop or rewrite the command without any test noticing.
 *
 * The generated manifest only exists after `npm run build`, so this skips (with
 * a clear message) rather than failing when the tests run without a build.
 */
const GENERATED_MANIFEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.output/chrome-mv3/manifest.json",
);

const hasBuild = existsSync(GENERATED_MANIFEST);

describe.skipIf(!hasBuild)("generated manifest (built in the worktree)", () => {
  const generated = hasBuild
    ? (JSON.parse(readFileSync(GENERATED_MANIFEST, "utf8")) as {
        commands?: Record<
          string,
          {
            suggested_key?: { default?: string; mac?: string };
            description?: string;
          }
        >;
      })
    : undefined;

  it("ships the _execute_action command with the configured shortcut", () => {
    const command = generated?.commands?._execute_action;
    expect(command).toBeDefined();
    expect(command).toEqual(manifest?.commands?._execute_action);
    expect(command?.suggested_key?.default).toBe("Ctrl+Shift+Y");
    expect(command?.suggested_key?.mac).toBe("Command+Shift+Y");
  });
});

if (!hasBuild) {
  // Surfaced in the run output so a missing build is never mistaken for a pass.
  console.warn(
    `manifest-commands: skipping the generated-manifest check — ${GENERATED_MANIFEST} not found (run \`npm run build\` first)`,
  );
}
