#!/usr/bin/env node
/**
 * check-store.mjs — release-strict store-readiness gate (Phase 6).
 *
 * `checkStore({ root, release })` collects every structured violation across
 * the release surfaces — store docs, sources, manifest, assets, eval
 * evidence, and the release record — in ONE run (no fail-fast, no network).
 * `npm run check:store` exits 1 while any violation exists.
 *
 * Checks (the `check` id in each violation):
 *   unfinished-marker   release-placeholder text left in a store doc
 *   store-doc           a required store document is missing/unreadable
 *   publisher-contact   publisher identity or monitored contact missing
 *   public-urls         homepage / support / privacy URL absent
 *   version             package.json / wxt.config.ts disagree with release
 *   permissions         manifest ↔ store/permissions.md drift (or no build)
 *   limited-use         Limited Use / certification text missing
 *   custom-provider     broad-capability or custom-provider text missing
 *   reviewer-notes      reviewer walkthrough/dashboard content missing
 *   assets              icon / screenshot / promo missing or wrong size
 *   release-models      release defaults resolve to a moving alias or drift
 *   eval-evidence       the Jev 1.13 baseline doc is missing/incomplete
 *   release-record      store/releases/<release>.json missing or malformed
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { diffManifest } from "./check-manifest.mjs";

/** The public release URLs every surface must agree on. */
export const RELEASE_URLS = Object.freeze({
  homepage: "https://nguyensitrung.github.io/BookmarksManager/",
  privacy: "https://nguyensitrung.github.io/BookmarksManager/privacy/",
  support: "https://github.com/NguyenSiTrung/BookmarksManager/issues",
});

/** Marker phrases that must never survive into a submission. */
const UNFINISHED_MARKERS = [
  /release prerequisite/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bTBD\b/,
  /to be confirmed/i,
  /decide at release/i,
  /placeholders? to (fill|be)/i,
];

const STORE_DOCS = [
  "store/permissions.md",
  "store/privacy-policy.md",
  "store/privacy-practices.md",
  "store/listing.md",
  "store/reviewer-notes.md",
];

const SCREENSHOT_SIZES = [
  [1280, 800],
  [640, 400],
];

function pngSize(path) {
  try {
    const buf = readFileSync(path);
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * Run every release check against `root`.
 * @param {{root: string, release: string}} options
 * @returns {{ok: boolean, violations: {check: string, file?: string, message: string}[]}}
 */
export function checkStore({ root, release }) {
  const violations = [];
  const bad = (check, message, file) =>
    violations.push({ check, file, message });
  const read = (rel) => {
    const path = join(root, rel);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  // --- store docs exist + carry no unfinished markers -------------------
  const docs = {};
  for (const rel of STORE_DOCS) {
    const text = read(rel);
    if (text === null) {
      bad("store-doc", `${rel} is missing or unreadable`, rel);
      continue;
    }
    docs[rel] = text;
    for (const marker of UNFINISHED_MARKERS) {
      const hit = marker.exec(text);
      if (hit) {
        bad(
          "unfinished-marker",
          `contains marker "${hit[0]}"`,
          rel,
        );
      }
    }
  }
  const policy = docs["store/privacy-policy.md"];
  const practices = docs["store/privacy-practices.md"];
  const listing = docs["store/listing.md"];
  const permissions = docs["store/permissions.md"];
  const reviewer = docs["store/reviewer-notes.md"];

  // --- publisher identity + monitored contact ---------------------------
  if (policy) {
    const publisher = /published by:[^\n]*/i.exec(policy)?.[0] ?? "";
    if (
      /_/.test(publisher) ||
      /release prerequisite|to be confirmed|TBD/i.test(publisher)
    ) {
      bad(
        "publisher-contact",
        "privacy policy has no real publisher identity",
        "store/privacy-policy.md",
      );
    }
    const contact = /Contact:[^\n]*/i.exec(policy)?.[0] ?? "";
    if (!/[\w.+-]+@[\w-]+\.[\w.]+/.test(contact)) {
      bad(
        "publisher-contact",
        "privacy policy has no monitored contact email",
        "store/privacy-policy.md",
      );
    }
  }

  // --- public URLs -------------------------------------------------------
  if (listing) {
    for (const [name, url] of Object.entries(RELEASE_URLS)) {
      if (!listing.includes(url)) {
        bad(
          "public-urls",
          `listing.md lacks the ${name} URL ${url}`,
          "store/listing.md",
        );
      }
    }
  }
  for (const [rel, text] of [
    ["store/privacy-policy.md", policy],
    ["store/privacy-practices.md", practices],
  ]) {
    if (text && !text.includes(RELEASE_URLS.privacy)) {
      bad(
        "public-urls",
        `${rel} lacks the hosted policy URL ${RELEASE_URLS.privacy}`,
        rel,
      );
    }
  }

  // --- version agreement -------------------------------------------------
  const pkgText = read("package.json");
  let pkgVersion = null;
  try {
    pkgVersion = pkgText ? JSON.parse(pkgText).version : null;
  } catch {
    pkgVersion = null;
  }
  if (pkgVersion !== release) {
    bad(
      "version",
      `package.json version ${pkgVersion ?? "(missing)"} !== release ${release}`,
      "package.json",
    );
  }
  const wxt = read("wxt.config.ts");
  const wxtVersion = /version:\s*"([^"]+)"/.exec(wxt ?? "")?.[1] ?? null;
  if (wxtVersion !== release) {
    bad(
      "version",
      `wxt.config.ts manifest version ${wxtVersion ?? "(missing)"} !== release ${release}`,
      "wxt.config.ts",
    );
  }

  // --- manifest ↔ permission inventory -----------------------------------
  const manifestText = read(".output/chrome-mv3/manifest.json");
  let manifest = null;
  try {
    manifest = manifestText ? JSON.parse(manifestText) : null;
  } catch {
    manifest = null;
  }
  if (!manifest) {
    bad(
      "permissions",
      "built manifest missing — run `npm run build` before the store check",
      ".output/chrome-mv3/manifest.json",
    );
  } else if (permissions) {
    for (const diff of diffManifest(manifest, permissions)) {
      bad("permissions", diff, "store/permissions.md");
    }
  }

  // --- Limited Use --------------------------------------------------------
  if (policy && !/Limited Use/.test(policy)) {
    bad(
      "limited-use",
      "privacy policy lacks a Limited Use statement",
      "store/privacy-policy.md",
    );
  }
  if (policy && !/Chrome\s+Web\s+Store\s+User\s+Data\s+Policy/.test(policy)) {
    bad(
      "limited-use",
      "privacy policy does not name the Chrome Web Store User Data Policy",
      "store/privacy-policy.md",
    );
  }
  if (practices) {
    for (const needle of [
      "not sold",
      "single purpose",
      "creditworthiness",
    ]) {
      if (!new RegExp(needle, "i").test(practices)) {
        bad(
          "limited-use",
          `privacy-practices.md lacks the "${needle}" certification`,
          "store/privacy-practices.md",
        );
      }
    }
  }

  // --- custom-provider scope + capability explanation ---------------------
  for (const [rel, text] of [
    ["store/listing.md", listing],
    ["store/privacy-policy.md", policy],
    ["store/reviewer-notes.md", reviewer],
  ]) {
    if (text && !/custom/i.test(text)) {
      bad(
        "custom-provider",
        `${rel} never mentions the custom OpenAI-compatible provider`,
        rel,
      );
    }
  }
  for (const [rel, text] of [
    ["store/permissions.md", permissions],
    ["store/privacy-policy.md", policy],
    ["store/reviewer-notes.md", reviewer],
  ]) {
    if (text && !/capabilit/i.test(text)) {
      bad(
        "custom-provider",
        `${rel} does not explain the broad host pattern is capability-only`,
        rel,
      );
    }
  }

  // --- reviewer/dashboard content -----------------------------------------
  if (reviewer) {
    for (const needle of [
      "Testing without an API key",
      "Testing the provider connection",
      "`scripting`",
    ]) {
      if (!reviewer.includes(needle)) {
        bad(
          "reviewer-notes",
          `reviewer-notes.md lacks "${needle}"`,
          "store/reviewer-notes.md",
        );
      }
    }
  }

  // --- assets ---------------------------------------------------------------
  const assetsDir = join(root, "store", "assets");
  const icon = pngSize(join(assetsDir, "icon-128.png"));
  if (!icon || icon.w !== 128 || icon.h !== 128) {
    bad(
      "assets",
      `store/assets/icon-128.png must be a 128×128 PNG (got ${icon ? `${icon.w}×${icon.h}` : "missing"})`,
      "store/assets/icon-128.png",
    );
  }
  const promo = pngSize(join(assetsDir, "promo-440x280.png"));
  if (!promo || promo.w !== 440 || promo.h !== 280) {
    bad(
      "assets",
      `store/assets/promo-440x280.png must be a 440×280 PNG (got ${promo ? `${promo.w}×${promo.h}` : "missing"})`,
      "store/assets/promo-440x280.png",
    );
  }
  let hasShot = false;
  try {
    for (const name of readdirSync(assetsDir)) {
      if (!/^screenshot-.*\.png$/.test(name)) continue;
      const size = pngSize(join(assetsDir, name));
      if (
        size &&
        SCREENSHOT_SIZES.some(([w, h]) => size.w === w && size.h === h)
      ) {
        hasShot = true;
      }
    }
  } catch {
    /* missing dir → no shots */
  }
  if (!hasShot) {
    bad(
      "assets",
      "no store/assets/screenshot-*.png at 1280×800 or 640×400",
      "store/assets/",
    );
  }

  // --- release model pins ---------------------------------------------------
  const releasePolicy = read("src/decisions/release-policy.ts");
  const schemaProvider = read("src/schemas/provider.ts");
  const providerInfo = read("src/net/provider-info.ts");
  const pinnedIds = new Set();
  if (releasePolicy) {
    for (const m of releasePolicy.matchAll(/request:\s*"([^"]+)"/g)) {
      pinnedIds.add(m[1]);
    }
    if (pinnedIds.size === 0) {
      bad(
        "release-models",
        "release-policy.ts defines no request ids",
        "src/decisions/release-policy.ts",
      );
    }
  } else {
    bad(
      "release-models",
      "src/decisions/release-policy.ts is missing",
      "src/decisions/release-policy.ts",
    );
  }
  const aliases = new Set();
  if (providerInfo) {
    for (const m of providerInfo.matchAll(/"(jev-[^"]+)"/g)) {
      aliases.add(m[1]);
    }
  }
  for (const id of pinnedIds) {
    if (aliases.has(id)) {
      bad(
        "release-models",
        `pinned release id "${id}" is also a moving alias`,
        "src/decisions/release-policy.ts",
      );
    }
  }
  if (schemaProvider) {
    const defaultsBlock =
      /DEFAULT_PROVIDER_MODEL\s*=\s*\{([^}]*)\}/.exec(schemaProvider)?.[1] ??
      "";
    for (const preset of ["typesafe", "openrouter"]) {
      const entry = new RegExp(`${preset}:\\s*([^,\\n]+)`).exec(
        defaultsBlock,
      )?.[1]?.trim();
      if (!entry) {
        bad(
          "release-models",
          `DEFAULT_PROVIDER_MODEL.${preset} missing`,
          "src/schemas/provider.ts",
        );
        continue;
      }
      const literal = /^"([^"]+)"/.exec(entry)?.[1];
      if (literal) {
        if (!pinnedIds.has(literal) || aliases.has(literal)) {
          bad(
            "release-models",
            `DEFAULT_PROVIDER_MODEL.${preset} is the non-pinned/moving id "${literal}"`,
            "src/schemas/provider.ts",
          );
        }
      } else if (!entry.startsWith("RELEASE_JEV_MODELS")) {
        bad(
          "release-models",
          `DEFAULT_PROVIDER_MODEL.${preset} does not derive from RELEASE_JEV_MODELS`,
          "src/schemas/provider.ts",
        );
      }
    }
  }

  // --- eval evidence --------------------------------------------------------
  const baseline = read("store/evals/jev-1.13-baseline.md");
  if (!baseline) {
    bad(
      "eval-evidence",
      "store/evals/jev-1.13-baseline.md is missing",
      "store/evals/jev-1.13-baseline.md",
    );
  } else {
    for (const id of pinnedIds) {
      if (!baseline.includes(`\`${id}\``)) {
        bad(
          "eval-evidence",
          `baseline doc does not name pinned id ${id}`,
          "store/evals/jev-1.13-baseline.md",
        );
      }
    }
    if (!/test-results\/eval/.test(baseline)) {
      bad(
        "eval-evidence",
        "baseline doc does not explain where eval artifacts land",
        "store/evals/jev-1.13-baseline.md",
      );
    }
  }

  // --- release record --------------------------------------------------------
  const recordPath = `store/releases/${release}.json`;
  const recordText = read(recordPath);
  if (recordText === null) {
    bad(
      "release-record",
      `no release record for ${release} — Phase 4 writes it`,
      recordPath,
    );
  } else {
    let record = null;
    try {
      record = JSON.parse(recordText);
    } catch {
      record = null;
    }
    if (!record || record.version !== release) {
      bad(
        "release-record",
        `${recordPath} version !== ${release} or is not valid JSON`,
        recordPath,
      );
    } else {
      if (!/^[0-9a-f]{40}$/i.test(record.commit ?? "")) {
        bad("release-record", `${recordPath} lacks a 40-hex commit`, recordPath);
      }
      if (!/^[0-9a-f]{64}$/i.test(record?.zip?.sha256 ?? "")) {
        bad(
          "release-record",
          `${recordPath} lacks zip.sha256 (64-hex)`,
          recordPath,
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

const isMain = (() => {
  try {
    return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const releaseArg = process.argv.find((a) => a.startsWith("--release="));
  const release = releaseArg?.split("=")[1] ?? "1.0.0";
  const root = process.cwd();
  const { ok, violations } = checkStore({ root, release });
  if (ok) {
    console.log(`OK: release ${release} store-readiness checks pass.`);
  } else {
    console.error(`FAIL: ${violations.length} store-readiness violation(s):`);
    for (const v of violations) {
      console.error(`  [${v.check}] ${v.file ?? "-"}: ${v.message}`);
    }
    process.exitCode = 1;
  }
}
