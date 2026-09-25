#!/usr/bin/env node
/**
 * check-manifest.mjs — verifies the generated MV3 manifest's permission
 * fields match the permission inventory in store/permissions.md.
 *
 * Store-doc row format (parsed verbatim):
 *   | `storage`                    | required | local settings |
 *   | `https://api.typesafe.ai/*`  | optional | Jev test       |
 *
 * A row counts when its second cell is exactly "required" or "optional" and
 * its first cell is a backtick-quoted name. Rows with any other level — e.g.
 * "not requested", "none", "—" — are informational and never count as
 * documented permissions, so permissions listed only in "Not requested"
 * sections still fail the check if they appear in the manifest. Names
 * containing "://" (or the literal `<all_urls>`) are host patterns; anything
 * else is a permission name.
 *
 * Compared fields (sorted equality, each difference reported by name):
 *   required permission rows    <-> manifest.permissions
 *   required host-pattern rows  <-> manifest.host_permissions
 *   optional permission rows    <-> manifest.optional_permissions
 *   optional host-pattern rows  <-> manifest.optional_host_permissions
 *
 * Usage:
 *   node scripts/check-manifest.mjs [manifestPath] [permissionsDocPath]
 *   CHECK_MANIFEST_PATH / PERMISSIONS_DOC_PATH env vars work as fallbacks.
 *
 * Exit 0: manifest and inventory agree. Exit 1: differences or bad input.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = ".output/chrome-mv3/manifest.json";
const DEFAULT_DOC = "store/permissions.md";

/** Match patterns look like `https://host/*`, `<all_urls>`, or `*://host/*`. */
function isHostPattern(name) {
  return name === "<all_urls>" || name.includes("://");
}

/**
 * Parse permission rows out of a markdown document.
 * @param {string} markdown
 * @returns {{entries: {name: string, level: string}[], errors: string[]}}
 */
export function parsePermissionTable(markdown) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|") || !line.endsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const level = cells[1].toLowerCase();
    if (level !== "required" && level !== "optional") continue;
    const nameMatch = /^`(.+)`$/.exec(cells[0]);
    if (!nameMatch) {
      errors.push(
        `line ${i + 1}: permission/pattern name must be wrapped in backticks: ${cells[0]}`,
      );
      continue;
    }
    const name = nameMatch[1];
    const key = `${level}:${name}`;
    if (seen.has(key)) {
      errors.push(`line ${i + 1}: duplicate ${level} row for "${name}"`);
      continue;
    }
    seen.add(key);
    entries.push({ name, level });
  }
  return { entries, errors };
}

/**
 * Diff one manifest field against the documented set, in both directions.
 * @returns {string[]} human-readable differences, one per entry
 */
function diffField(field, documented, actual) {
  const errors = [];
  const doc = new Set(documented);
  const man = new Set(actual ?? []);
  for (const value of [...man].sort()) {
    if (!doc.has(value)) {
      errors.push(
        `${field}: manifest contains "${value}" but store/permissions.md does not list it`,
      );
    }
  }
  for (const value of [...doc].sort()) {
    if (!man.has(value)) {
      errors.push(
        `${field}: store/permissions.md lists "${value}" but the manifest does not contain it`,
      );
    }
  }
  return errors;
}

/**
 * Compare a parsed manifest object against the markdown inventory.
 * @param {object} manifest
 * @param {string} permissionsMarkdown
 * @returns {string[]} differences (empty means compliant)
 */
export function diffManifest(manifest, permissionsMarkdown) {
  const { entries, errors } = parsePermissionTable(permissionsMarkdown);
  const requiredPermissions = [];
  const requiredHostPatterns = [];
  const optionalPermissions = [];
  const optionalHostPatterns = [];
  for (const { name, level } of entries) {
    const host = isHostPattern(name);
    if (level === "required") {
      (host ? requiredHostPatterns : requiredPermissions).push(name);
    } else {
      (host ? optionalHostPatterns : optionalPermissions).push(name);
    }
  }
  return [
    ...errors,
    ...diffField("permissions", requiredPermissions, manifest.permissions),
    ...diffField(
      "host_permissions",
      requiredHostPatterns,
      manifest.host_permissions,
    ),
    ...diffField(
      "optional_permissions",
      optionalPermissions,
      manifest.optional_permissions,
    ),
    ...diffField(
      "optional_host_permissions",
      optionalHostPatterns,
      manifest.optional_host_permissions,
    ),
  ];
}

function main() {
  const manifestPath = path.resolve(
    process.argv[2] ?? process.env.CHECK_MANIFEST_PATH ?? DEFAULT_MANIFEST,
  );
  const docPath = path.resolve(
    process.argv[3] ?? process.env.PERMISSIONS_DOC_PATH ?? DEFAULT_DOC,
  );

  let manifestRaw;
  try {
    manifestRaw = readFileSync(manifestPath, "utf8");
  } catch {
    console.error(
      `FAIL: cannot read manifest at ${manifestPath} — run \`npm run build\` first.`,
    );
    process.exitCode = 1;
    return;
  }
  let docRaw;
  try {
    docRaw = readFileSync(docPath, "utf8");
  } catch {
    console.error(`FAIL: cannot read permission inventory at ${docPath}.`);
    process.exitCode = 1;
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    console.error(`FAIL: ${manifestPath} is not valid JSON: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const diffs = diffManifest(manifest, docRaw);
  if (diffs.length > 0) {
    console.error(
      `FAIL: manifest permissions disagree with ${path.relative(process.cwd(), docPath) || docPath}:`,
    );
    for (const diff of diffs) {
      console.error(`  - ${diff}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `OK: ${path.relative(process.cwd(), manifestPath) || manifestPath} permissions match ${path.relative(process.cwd(), docPath) || docPath}.`,
  );
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main();
}
