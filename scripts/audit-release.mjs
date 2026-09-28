#!/usr/bin/env node
/**
 * audit-release.mjs — audit the built store ZIP before upload (Phase 4).
 *
 * `auditRelease({ zipPath, expectedVersion, permissionsMarkdown? })` lists the
 * archive with `unzip -Z1`, extracts `manifest.json`, and reports every
 * violation in one run: version mismatch, missing manifest/icons, forbidden
 * entries (source maps, .env, keys, databases, test/eval output, dev files),
 * and permission drift vs store/permissions.md.
 *
 * Returns `{ ok, violations, name, bytes, sha256, manifest }` — the name,
 * size, and SHA-256 are recorded in `store/releases/<version>.json`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { diffManifest } from "./check-manifest.mjs";

/** Entries that must never ship in a store ZIP. */
const FORBIDDEN_ENTRY = [
  { check: /\.map$/i, why: "source map" },
  { check: /(^|\/)\.env(\.|$)/i, why: "environment file" },
  { check: /\.(pem|key|p12|pfx)$/i, why: "key material" },
  { check: /(^|\/)(id_rsa|id_ed25519|credentials\.json|secrets?\.)/i, why: "credential file" },
  { check: /\.(sqlite|sqlite3|db|ldb|log)$/i, why: "database/log artifact" },
  { check: /(^|\/)test-results\//i, why: "test output" },
  { check: /(^|\/)(tests?|eval)\//i, why: "test/eval source" },
  { check: /(^|\/)(conductor|store|docs|\.beads|\.agents|\.github)\//i, why: "development file" },
  { check: /(^|\/)src\/.*\.(ts|tsx)$/i, why: "unbuilt source file" },
  { check: /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|wxt\.config\.ts|vitest[^/]*\.ts|playwright\.config\.ts)$/i, why: "project config" },
  { check: /(^|\/)\.git/i, why: "git metadata" },
  { check: /(^|\/)Dockerfile/i, why: "dev file" },
];

function listEntries(zipPath) {
  try {
    const out = execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function extract(zipPath, entry) {
  try {
    return execFileSync("unzip", ["-p", zipPath, entry], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Audit a store ZIP.
 * @param {{zipPath: string, expectedVersion: string, permissionsMarkdown?: string}} options
 */
export function auditRelease({ zipPath, expectedVersion, permissionsMarkdown }) {
  const violations = [];
  const bad = (check, message, file) => violations.push({ check, file, message });

  const result = {
    ok: false,
    violations,
    name: basename(zipPath),
    bytes: 0,
    sha256: null,
    manifest: null,
  };

  if (!existsSync(zipPath)) {
    bad("zip", `zip not found: ${zipPath}`, zipPath);
    return result;
  }
  result.bytes = statSync(zipPath).size;
  result.sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");

  const entries = listEntries(zipPath);
  if (entries === null) {
    bad("zip", `cannot list ${zipPath} — not a readable zip`, zipPath);
    return result;
  }

  // --- manifest ----------------------------------------------------------
  if (!entries.includes("manifest.json")) {
    bad("manifest", "archive has no manifest.json", "manifest.json");
  } else {
    const raw = extract(zipPath, "manifest.json");
    let manifest = null;
    try {
      manifest = raw ? JSON.parse(raw.toString("utf8")) : null;
    } catch {
      manifest = null;
    }
    if (!manifest) {
      bad("manifest", "manifest.json is unreadable or invalid JSON", "manifest.json");
    } else {
      result.manifest = {
        name: manifest.name ?? null,
        version: manifest.version ?? null,
        permissions: manifest.permissions ?? [],
        optional_host_permissions: manifest.optional_host_permissions ?? [],
        icons: manifest.icons ?? {},
      };
      if (manifest.version !== expectedVersion) {
        bad(
          "version",
          `manifest version ${manifest.version ?? "(missing)"} !== ${expectedVersion}`,
          "manifest.json",
        );
      }

      // --- icons ----------------------------------------------------------
      for (const [size, rel] of Object.entries(manifest.icons ?? {})) {
        const name = String(rel).replace(/^\//, "");
        const buf = entries.includes(name) ? extract(zipPath, name) : null;
        if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
          bad("icons", `icon ${rel} missing or not a PNG`, rel);
          continue;
        }
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        if (w !== Number(size) || h !== Number(size)) {
          bad(
            "icons",
            `icon ${rel} is ${w}×${h}, expected ${size}×${size}`,
            rel,
          );
        }
      }

      // --- permission drift -------------------------------------------------
      if (permissionsMarkdown) {
        for (const diff of diffManifest(manifest, permissionsMarkdown)) {
          bad("permissions", diff, "store/permissions.md");
        }
      }
    }
  }

  // --- forbidden entries ----------------------------------------------------
  for (const entry of entries) {
    for (const { check, why } of FORBIDDEN_ENTRY) {
      if (check.test(entry)) {
        bad("forbidden-entry", `${entry} — ${why} must not ship`, entry);
        break;
      }
    }
  }

  result.ok = violations.length === 0;
  return result;
}

const isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error("usage: node scripts/audit-release.mjs <zip> [--version=x.y.z]");
    process.exit(2);
  }
  const versionArg = process.argv.find((a) => a.startsWith("--version="));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedVersion = versionArg?.split("=")[1] ?? pkg.version;
  let permissionsMarkdown = null;
  try {
    permissionsMarkdown = readFileSync(
      join(root, "store", "permissions.md"),
      "utf8",
    );
  } catch {
    /* drift check skipped when the inventory is absent */
  }
  const result = auditRelease({
    zipPath: resolve(zipPath),
    expectedVersion,
    permissionsMarkdown: permissionsMarkdown ?? undefined,
  });
  if (result.ok) {
    console.log(
      `OK: ${result.name} — ${result.bytes} bytes, sha256 ${result.sha256}`,
    );
    console.log(`    manifest: ${result.manifest?.name} ${result.manifest?.version}`);
  } else {
    console.error(`FAIL: ${result.violations.length} violation(s) in ${result.name}:`);
    for (const v of result.violations) {
      console.error(`  [${v.check}] ${v.file ?? "-"}: ${v.message}`);
    }
    process.exitCode = 1;
  }
}
