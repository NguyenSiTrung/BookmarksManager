import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { auditRelease } from "../../scripts/audit-release.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..");
const PERMISSIONS_MD = readFileSync(
  join(REPO_ROOT, "store", "permissions.md"),
  "utf8",
);

const MANIFEST = {
  manifest_version: 3,
  name: "Bookmarks Manager",
  version: "1.0.0",
  permissions: [
    "activeTab",
    "bookmarks",
    "contextMenus",
    "favicon",
    "scripting",
    "storage",
    "sidePanel",
  ],
  optional_host_permissions: [
    "https://api.typesafe.ai/*",
    "https://openrouter.ai/*",
    "https://*/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    "http://[::1]/*",
  ],
  icons: {
    "16": "icon/16.png",
    "32": "icon/32.png",
    "48": "icon/48.png",
    "128": "icon/128.png",
  },
};

/** Minimal PNG buffer with a valid signature + IHDR dimensions. */
function png(w: number, h: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

const roots: string[] = [];

/** Build a zip in a temp dir; extra/forbidden files injected per test. */
function makeZip(
  label: string,
  opts: {
    manifest?: Record<string, unknown> | null;
    files?: Record<string, Buffer | string>;
    dropIcons?: boolean;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), `audit-${label}-`));
  roots.push(root);
  const staged = join(root, "staged");
  mkdirSync(staged, { recursive: true });
  const put = (rel: string, content: Buffer | string) => {
    const abs = join(staged, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  const manifest = opts.manifest === undefined ? MANIFEST : opts.manifest;
  if (manifest !== null) put("manifest.json", JSON.stringify(manifest));
  const icons = (manifest?.icons ?? {}) as Record<string, string>;
  if (!opts.dropIcons) {
    for (const [size, rel] of Object.entries(icons)) {
      put(rel, png(Number(size), Number(size)));
    }
  }
  put("sidepanel.html", "<html></html>");
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    put(rel, content);
  }

  const zipPath = join(root, "candidate.zip");
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: staged });
  return zipPath;
}

function audit(zipPath: string) {
  return auditRelease({
    zipPath,
    expectedVersion: "1.0.0",
    permissionsMarkdown: PERMISSIONS_MD,
  });
}

function checks(v: { check: string }[]) {
  return [...new Set(v.map((x) => x.check))];
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("auditRelease", () => {
  it("passes on a well-formed candidate and reports name/size/sha256", () => {
    const result = audit(makeZip("good"));
    expect(result.ok).toBe(true);
    expect(result.name).toBe("candidate.zip");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest?.version).toBe("1.0.0");
  });

  it("flags a version mismatch", () => {
    const zipPath = makeZip("ver", {
      manifest: { ...MANIFEST, version: "0.9.9" },
    });
    expect(checks(audit(zipPath).violations)).toContain("version");
  });

  it("flags a missing manifest", () => {
    const zipPath = makeZip("nomanifest", { manifest: null });
    expect(checks(audit(zipPath).violations)).toContain("manifest");
  });

  it("flags missing icon files", () => {
    const zipPath = makeZip("noicons", { dropIcons: true });
    expect(checks(audit(zipPath).violations)).toContain("icons");
  });

  it("flags a source map", () => {
    const zipPath = makeZip("map", { files: { "chunks/app.js.map": "{}" } });
    expect(checks(audit(zipPath).violations)).toContain("forbidden-entry");
  });

  it("flags an .env file", () => {
    const zipPath = makeZip("env", { files: { ".env": "KEY=1" } });
    expect(checks(audit(zipPath).violations)).toContain("forbidden-entry");
  });

  it("flags a private key", () => {
    const zipPath = makeZip("key", {
      files: { "key.pem": "-----BEGIN PRIVATE KEY-----" },
    });
    expect(checks(audit(zipPath).violations)).toContain("forbidden-entry");
  });

  it("flags a database file", () => {
    const zipPath = makeZip("db", {
      files: { "data/indexeddb.sqlite": "x" },
    });
    expect(checks(audit(zipPath).violations)).toContain("forbidden-entry");
  });

  it("flags test/eval output", () => {
    const zipPath = makeZip("testout", {
      files: { "test-results/eval/report.json": "{}" },
    });
    expect(checks(audit(zipPath).violations)).toContain("forbidden-entry");
  });

  it("flags development files", () => {
    const zipPath = makeZip("dev", {
      files: { "conductor/workflow.md": "# dev", "src/app.ts": "x" },
    });
    expect(checks(audit(zipPath).violations)).toContain("forbidden-entry");
  });

  it("flags manifest/permissions drift", () => {
    const zipPath = makeZip("drift", {
      manifest: {
        ...MANIFEST,
        permissions: [...MANIFEST.permissions, "history"],
      },
    });
    expect(checks(audit(zipPath).violations)).toContain("permissions");
  });
});
