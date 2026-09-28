#!/usr/bin/env node
/**
 * check-site.mjs — static GitHub Pages site gate (Phase 6 Task 1).
 *
 * `checkSite({ root })` scans the built static site directory (default:
 * `site/`) and reports every violation in one run. The site must be fully
 * self-contained: no remote code, no trackers, no forms, no cookies, no
 * external assets (fonts included). Internal links must resolve, every page
 * needs landmarks/metadata, and the privacy page must carry every required
 * field from `store/privacy-policy.md` (checked when the repo file exists).
 *
 * Checks: missing-file, links, landmarks, metadata, remote-code, trackers,
 * forms, cookies, external-assets, policy-drift.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_FILES = ["index.html", "privacy/index.html", "styles.css", "404.html"];

const TRACKER_PATTERNS = [
  /googletagmanager/i,
  /google-analytics/i,
  /gtag\/js|gtag\(/i,
  /connect\.facebook\.net/i,
  /fbq\(/i,
  /segment\.(com|io)/i,
  /hotjar/i,
  /mixpanel/i,
  /clarity\.ms/i,
];

const COOKIE_PATTERNS = [/document\.cookie/, /navigator\.sendBeacon/];

/** Fields the published policy must carry (material-equivalence floor). */
const POLICY_FIELDS = [
  "NguyenSiTrung",
  "trungnsai95@gmail.com",
  "Effective date",
  "2026-09-28",
  "Limited Use",
  "Chrome Web Store User Data Policy",
  "jev_test",
  "jev_decisions",
  "llm_summary",
  "llm_restructure",
  "consentVersion",
  "AES-GCM",
  "IndexedDB",
  "capability only",
  "not directed at children under 13",
  "never",
  "Authorization: Bearer",
  "https://nguyensitrung.github.io/BookmarksManager/privacy/",
];

function isExternalHref(href) {
  return /^https?:\/\//i.test(href) || /^\/\//.test(href);
}

/**
 * Scan a site directory.
 * @param {{root: string, policyPath?: string}} options
 * @returns {{ok: boolean, violations: {check: string, file?: string, message: string}[]}}
 */
export function checkSite({ root, policyPath }) {
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

  const htmlFiles = {};
  for (const rel of REQUIRED_FILES) {
    const text = read(rel);
    if (text === null) {
      bad("missing-file", `site file ${rel} is missing`, rel);
      continue;
    }
    if (rel.endsWith(".html")) htmlFiles[rel] = text;
  }

  for (const [rel, html] of Object.entries(htmlFiles)) {
    // --- landmarks ------------------------------------------------------
    for (const [name, re] of [
      ["<html lang=...>", /<html[^>]*\slang="[a-z-]+"/i],
      ["<title>", /<title>[^<]*\S[^<]*<\/title>/i],
      ["<main>", /<main[\s>]/i],
    ]) {
      if (!re.test(html)) {
        bad("landmarks", `${rel} lacks ${name}`, rel);
      }
    }

    // --- metadata --------------------------------------------------------
    if (!/<meta[^>]+charset/i.test(html)) {
      bad("metadata", `${rel} lacks a charset meta`, rel);
    }
    if (!/<meta[^>]+name="viewport"/i.test(html)) {
      bad("metadata", `${rel} lacks a viewport meta`, rel);
    }
    if (!/<meta[^>]+name="description"[^>]+content="[^"]*\S[^"]*"/i.test(html)) {
      bad("metadata", `${rel} lacks a meta description`, rel);
    }

    // --- remote code / trackers / forms / cookies / external assets ------
    if (/<script[\s>]/i.test(html)) {
      bad("remote-code", `${rel} contains a <script> tag (site must be script-free)`, rel);
    }
    for (const re of TRACKER_PATTERNS) {
      if (re.test(html)) {
        bad("trackers", `${rel} references a tracker (${re.source})`, rel);
        break;
      }
    }
    if (/<form[\s>]/i.test(html)) {
      bad("forms", `${rel} contains a <form>`, rel);
    }
    for (const re of COOKIE_PATTERNS) {
      if (re.test(html)) {
        bad("cookies", `${rel} uses ${re.source}`, rel);
      }
    }
    // external assets: any non-anchor tag pointing at http(s)/protocol-relative
    for (const m of html.matchAll(/<(link|img|iframe|video|audio|source|embed|object)\b[^>]*(?:href|src)="([^"]+)"/gi)) {
      const [, tag, href] = m;
      if (isExternalHref(href)) {
        bad(
          "external-assets",
          `${rel} loads <${tag.toLowerCase()}> from ${href} — site must be self-contained`,
          rel,
        );
      }
    }
    const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) ?? [];
    for (const block of css) {
      if (/url\(\s*['"]?https?:/i.test(block)) {
        bad("external-assets", `${rel} has an inline style url(http...)`, rel);
      }
    }

    // --- internal links ---------------------------------------------------
    const baseDir = dirname(join(root, rel));
    for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"/gi)) {
      const href = m[1];
      if (
        isExternalHref(href) ||
        href.startsWith("#") ||
        href.startsWith("mailto:")
      ) {
        continue;
      }
      let target;
      if (href.startsWith("/")) {
        // absolute path — strip the Pages base (/BookmarksManager/) if present
        const stripped = href.replace(/^\/BookmarksManager\//, "/");
        target = join(root, stripped);
      } else {
        target = resolve(baseDir, href.split("#")[0]);
      }
      const candidates =
        href.endsWith("/") || target.endsWith("/")
          ? [join(target, "index.html")]
          : [target];
      if (!candidates.some((c) => existsSync(normalize(c)))) {
        bad("links", `${rel} links to ${href} — does not resolve`, rel);
      }
    }
  }

  // styles.css must be self-contained too
  const styles = read("styles.css");
  if (styles !== null) {
    if (/@import\s/i.test(styles) || /url\(\s*['"]?https?:/i.test(styles)) {
      bad(
        "external-assets",
        "styles.css uses @import or a remote url() — fonts/assets must be local",
        "styles.css",
      );
    }
  }

  // --- policy drift --------------------------------------------------------
  const policyHtml = htmlFiles["privacy/index.html"];
  const mdCandidates = policyPath
    ? [policyPath]
    : [
        join(root, "store", "privacy-policy.md"),
        join(root, "..", "store", "privacy-policy.md"),
      ];
  let policyMd = null;
  for (const mdPath of mdCandidates) {
    try {
      policyMd = readFileSync(mdPath, "utf8");
      break;
    } catch {
      /* try next candidate */
    }
  }
  if (policyHtml !== undefined && policyMd !== null) {
    for (const field of POLICY_FIELDS) {
      if (policyMd.includes(field) && !policyHtml.includes(field)) {
        bad(
          "policy-drift",
          `privacy/index.html drops "${field}" that store/privacy-policy.md carries`,
          "privacy/index.html",
        );
      }
    }
    // version + effective date must match the markdown source of truth
    const mdVersion = /\*\*Version:\*\*\s*(\S+)/.exec(policyMd)?.[1];
    if (mdVersion && !policyHtml.includes(`Version:</strong> ${mdVersion}`) && !policyHtml.includes(`Version: ${mdVersion}`)) {
      bad(
        "policy-drift",
        `policy version ${mdVersion} missing from privacy/index.html`,
        "privacy/index.html",
      );
    }
    const mdDate = /\*\*Effective date:\*\*\s*(\S+)/.exec(policyMd)?.[1];
    if (mdDate && !policyHtml.includes(mdDate)) {
      bad(
        "policy-drift",
        `effective date ${mdDate} missing from privacy/index.html`,
        "privacy/index.html",
      );
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
  const root = resolve(process.cwd(), "site");
  const { ok, violations } = checkSite({ root });
  if (ok) {
    console.log("OK: site checks pass.");
  } else {
    console.error(`FAIL: ${violations.length} site violation(s):`);
    for (const v of violations) {
      console.error(`  [${v.check}] ${v.file ?? "-"}: ${v.message}`);
    }
    process.exitCode = 1;
  }
}
