import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const manifestScript = path.join(repoRoot, "scripts/check-manifest.mjs");
const bundleScript = path.join(repoRoot, "scripts/check-bundle.mjs");

const PERMISSIONS_MD = [
  "# Permission inventory",
  "",
  "| Permission | Level | Justification |",
  "|---|---|---|",
  "| `sidePanel` | required | side panel UI |",
  "| `storage` | required | local settings |",
  "",
  "| Pattern | Level | Used for |",
  "|---|---|---|",
  "| `https://api.typesafe.ai/*` | optional | Jev test |",
  "| `https://openrouter.ai/*` | optional | Jev test |",
  "",
].join("\n");

const BASE_MANIFEST = {
  manifest_version: 3,
  name: "Bookmarks Manager",
  permissions: ["storage", "sidePanel"],
  optional_host_permissions: [
    "https://api.typesafe.ai/*",
    "https://openrouter.ai/*",
  ],
};

const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-compliance-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[]): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runManifestCheck(manifest: unknown, doc = PERMISSIONS_MD): RunResult {
  const dir = makeTmpDir();
  writeTree(dir, {
    "manifest.json": JSON.stringify(manifest),
    "permissions.md": doc,
  });
  return run(manifestScript, [
    path.join(dir, "manifest.json"),
    path.join(dir, "permissions.md"),
  ]);
}

function runBundleCheck(files: Record<string, string>): RunResult {
  const dir = makeTmpDir();
  writeTree(dir, files);
  return run(bundleScript, [dir]);
}

describe("check-manifest.mjs", () => {
  it("fails and names an extra required permission", () => {
    const manifest = {
      ...BASE_MANIFEST,
      permissions: [...BASE_MANIFEST.permissions, "tabs"],
    };
    const res = runManifestCheck(manifest);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("tabs");
  });

  it("fails and names a missing optional host pattern", () => {
    const manifest = {
      ...BASE_MANIFEST,
      optional_host_permissions: ["https://api.typesafe.ai/*"],
    };
    const res = runManifestCheck(manifest);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("https://openrouter.ai/*");
  });

  it("fails on a host_permission the doc does not list", () => {
    const manifest = {
      ...BASE_MANIFEST,
      host_permissions: ["https://example.com/*"],
    };
    const res = runManifestCheck(manifest);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("https://example.com/*");
  });

  it("passes when manifest and permission table match", () => {
    const res = runManifestCheck(BASE_MANIFEST);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });
});

describe("check-bundle.mjs", () => {
  it("fails and names the file containing eval(", () => {
    const res = runBundleCheck({
      "chunks/app.js": 'const answer = eval("1 + 1");\n',
    });
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("app.js");
    expect(res.stderr + res.stdout).toContain("eval");
  });

  it("fails and names the file containing new Function", () => {
    const res = runBundleCheck({
      "background.js": 'const fn = new Function("return 1");\n',
    });
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("background.js");
    expect(res.stderr + res.stdout).toContain("new Function");
  });

  it("fails and names the html file with a remote script tag", () => {
    const res = runBundleCheck({
      "popup.html":
        '<html><head><script src="https://cdn.example.com/lib.js"></script></head></html>\n',
    });
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("popup.html");
  });

  it("passes a clean bundle with local script tags", () => {
    const res = runBundleCheck({
      "chunks/app.js": "const answer = 1 + 1;\nexport { answer };\n",
      "popup.html":
        '<html><head><script type="module" src="./popup.js"></script></head></html>\n',
      "options.html":
        '<html><head><script src="/assets/options.js"></script></head></html>\n',
      "assets/style.css": "body { margin: 0; }\n",
    });
    expect(res.status).toBe(0);
  });

  it("fails with a build hint when the output directory is missing", () => {
    const missing = path.join(makeTmpDir(), "does-not-exist");
    const res = run(bundleScript, [missing]);
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).toContain("npm run build");
  });
});
