import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

/**
 * Extract one job's YAML block by its two-space-indented key. The block ends
 * at the next top-level job key (another line indented by exactly two spaces).
 */
function jobBlock(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return "";
  const block = [lines[start] ?? ""];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^ {2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

/** Every top-level key directly under `jobs:` (two-space-indented). */
function jobNames(): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\S/.test(line)) break;
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) names.push(match[1] ?? "");
  }
  return names;
}

/**
 * A non-read-only permission value: `write`, `write-all`, or a
 * `write`-suffixed scope (`contents: write`, `packages: write`).
 */
const WRITE_PERMISSION = /\bwrite(-all)?\b/;

describe("ci workflow routing", () => {
  it("runs on pull requests, releases, and dispatch — never on pushes to main", () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    // Deliberately absent: merges to main do not spend CI on every commit.
    expect(workflow).not.toMatch(/push:/);
  });

  it("requests only read-only repository contents permission", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(workflow).not.toMatch(/contents:\s*write/);
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
  });

  it("has no write permission anywhere, including job-level overrides", () => {
    // Read-only at the workflow level: `permissions:` may only be followed by
    // `contents: read`, never a `write`/`write-all` value or scope.
    const lines = workflow.split("\n");
    lines.forEach((line, index) => {
      if (!/^\s*permissions:\s/.test(line)) return;
      expect(line).not.toMatch(WRITE_PERMISSION);
      const next = lines[index + 1] ?? "";
      expect(next).not.toMatch(WRITE_PERMISSION);
    });
    // No job may widen its own permissions with a job-level `permissions:` key.
    for (const name of jobNames()) {
      expect(jobBlock(name)).not.toMatch(/^\s*permissions:/m);
    }
    // Belt-and-braces: no write-granting token appears under any job either.
    for (const name of jobNames()) {
      expect(jobBlock(name)).not.toMatch(/\bwrite(-all)?\b/);
    }
  });

  it("defines exactly the quality and release-checks jobs", () => {
    expect(jobNames()).toEqual(["quality", "release-checks"]);
  });

  it("gates every job except quality behind an if: condition", () => {
    // Only `release-checks` may add `if:`/publish behavior; an extra job
    // added to the workflow makes this set comparison fail.
    const gated = jobNames().filter((name) =>
      /^\s*if:/m.test(jobBlock(name)),
    );
    expect(gated).toEqual(["release-checks"]);
    const publishing = jobNames().filter((name) =>
      /\b(npm publish|npm run zip|gh release)\b/.test(jobBlock(name)),
    );
    expect(publishing).toEqual([]);
  });

  it("keeps the routine quality job on Node 22 with a dependency install", () => {
    const quality = jobBlock("quality");
    expect(quality).not.toBe("");
    expect(quality).toContain("node-version: 22");
    expect(quality).toContain("npm ci");
    for (const step of [
      "npm run lint",
      "npm run typecheck",
      "npm run test -- --run",
      "npm run build",
      "npm run check:manifest",
      "npm run check:bundle",
      "npm run check:site",
    ]) {
      expect(quality).toContain(step);
    }
  });

  it("sets up headed Chromium under Xvfb before the E2E suite", () => {
    const quality = jobBlock("quality");
    const chromium = quality.indexOf(
      "npx playwright install --with-deps chromium",
    );
    const xvfb = quality.indexOf("install -y xvfb");
    const e2e = quality.indexOf("xvfb-run -a npm run test:e2e");
    expect(chromium).toBeGreaterThan(-1);
    expect(xvfb).toBeGreaterThan(chromium);
    expect(e2e).toBeGreaterThan(xvfb);
  });
});

describe("ci workflow release separation", () => {
  it("only triggers the strict store job for published releases or dispatch", () => {
    const release = jobBlock("release-checks");
    expect(release).not.toBe("");
    expect(release).toContain("npm run check:store");
    expect(release).toMatch(/needs:\s*quality/);
    expect(release).toMatch(/github\.event_name\s*==\s*'release'/);
    expect(release).toMatch(/github\.event_name\s*==\s*'workflow_dispatch'/);
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
  });

  it("keeps release-strict store packaging out of routine PR verification", () => {
    const quality = jobBlock("quality");
    expect(quality).not.toContain("check:store");
    expect(quality).not.toContain("npm run zip");
  });
});
