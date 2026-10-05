import { ESLint } from "eslint";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * H03 lint coverage (BookmarksManager-bih): every egress-capable web API —
 * `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
 * `navigator.sendBeacon`, `importScripts` — is restricted by eslint config
 * in app code and permitted inside `src/net/**`. Fixtures are linted as
 * virtual files so the suite never touches the working tree.
 */

const REPO = join(import.meta.dirname, "..", "..");

// `importScripts` is a worker global absent from `globals.browser`; the
// `/* global */` comment keeps it a global reference (so the restriction
// rule still sees it) while silencing unrelated no-undef noise.
const EGRESS_FIXTURE = `
/* global importScripts */

export function leak(url: string): unknown[] {
  const xhr = new XMLHttpRequest();
  const ws = new WebSocket(url);
  const es = new EventSource(url);
  navigator.sendBeacon(url, "x");
  importScripts(url);
  return [xhr, ws, es, fetch(url)];
}
`;

const PROPERTY_FIXTURE = `
export function leak(url: string): void {
  void globalThis.fetch(url);
  void window.fetch(url);
  void self.fetch(url);
  void new globalThis.XMLHttpRequest();
  void new window.WebSocket(url);
  void new self.EventSource(url);
  globalThis.importScripts(url);
  self.importScripts(url);
  window.importScripts(url);
  window.navigator.sendBeacon(url, "x");
}
`;

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO });
});

async function lintAt(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

describe("egress lint boundary (H03)", () => {
  it("rejects every direct egress API outside src/net", async () => {
    const messages = await lintAt(join(REPO, "src/example.ts"), EGRESS_FIXTURE);
    const globalsHit = new Set(
      messages
        .filter((m) => m.ruleId === "no-restricted-globals")
        .map((m) => m.message),
    );
    // One restriction hit per banned global identifier.
    expect(
      messages.filter((m) => m.ruleId === "no-restricted-globals"),
    ).toHaveLength(5);
    const properties = messages.filter(
      (m) => m.ruleId === "no-restricted-properties",
    );
    expect(properties).toHaveLength(1); // navigator.sendBeacon
    for (const message of [...globalsHit, ...properties.map((m) => m.message)]) {
      expect(message).toContain("src/net/");
    }
  });

  it("rejects member-access forms outside src/net", async () => {
    const messages = await lintAt(
      join(REPO, "src/example2.ts"),
      PROPERTY_FIXTURE,
    );
    // 9 property hits (fetch×3, XHR×1, WebSocket×1, EventSource×1,
    // importScripts×3) — bare-identifier forms already covered above.
    expect(
      messages.filter((m) => m.ruleId === "no-restricted-properties").length,
    ).toBeGreaterThanOrEqual(9);
    // `window.navigator.sendBeacon` chains past the properties rule — the
    // no-restricted-syntax selector catches it instead.
    expect(
      messages.some((m) => m.ruleId === "no-restricted-syntax"),
    ).toBe(true);
  });

  it("permits the same APIs inside src/net", async () => {
    for (const code of [EGRESS_FIXTURE, PROPERTY_FIXTURE]) {
      const messages = await lintAt(
        join(REPO, "src/net/example.ts"),
        code,
      );
      expect(messages).toEqual([]);
    }
  });

  it("still rejects fetch in ui code (regression)", async () => {
    const messages = await lintAt(
      join(REPO, "src/ui/example.ts"),
      "export const x = () => fetch('/'); void x;",
    );
    expect(
      messages.some((m) => m.ruleId === "no-restricted-globals"),
    ).toBe(true);
  });
});
