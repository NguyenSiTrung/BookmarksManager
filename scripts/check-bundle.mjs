#!/usr/bin/env node
/**
 * check-bundle.mjs — scans the emitted extension bundle for constructs that
 * violate the Chrome Web Store MV3 code rules:
 *   - `eval(`            dynamic code evaluation
 *   - `new Function`     dynamic code evaluation
 *   - remote `<script src="http(s)://...">` or `src="//..."` tags in HTML
 *     (local relative/absolute-extension paths such as "./app.js" or
 *     "/assets/app.js" are fine — only remote URLs are violations)
 *
 * Usage:
 *   node scripts/check-bundle.mjs [outputDir]
 *   CHECK_BUNDLE_DIR env var works as a fallback.
 *
 * Exit 0: no violations. Exit 1: violations (each reported as file:line) or a
 * missing/unreadable output directory.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT_DIR = ".output/chrome-mv3";
const SCANNED_EXTENSIONS = new Set([".js", ".html"]);

const RULES = [
  {
    label: "eval() call",
    pattern: /\beval\s*\(/,
  },
  {
    label: "new Function() constructor",
    pattern: /\bnew\s+Function\s*\(/,
  },
  {
    label: "remote <script src>",
    pattern: /<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i,
  },
];

/**
 * Scan one file's source text.
 * @param {string} fileName name used in reports (usually the relative path)
 * @param {string} source
 * @returns {{file: string, line: number, rule: string, snippet: string}[]}
 */
export function scanSource(fileName, source) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.pattern.test(lines[i])) {
        violations.push({
          file: fileName,
          line: i + 1,
          rule: rule.label,
          snippet: lines[i].trim().slice(0, 160),
        });
      }
    }
  }
  return violations;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

/**
 * Scan every .js/.html file under dir (recursive).
 * @param {string} dir
 * @returns {{file: string, line: number, rule: string, snippet: string}[]}
 */
export function scanBundle(dir) {
  const violations = [];
  for (const abs of walk(dir)) {
    if (!SCANNED_EXTENSIONS.has(path.extname(abs).toLowerCase())) continue;
    const rel = path.relative(dir, abs) || abs;
    violations.push(...scanSource(rel, readFileSync(abs, "utf8")));
  }
  return violations;
}

function main() {
  const outputDir = path.resolve(
    process.argv[2] ?? process.env.CHECK_BUNDLE_DIR ?? DEFAULT_OUTPUT_DIR,
  );
  if (!existsSync(outputDir)) {
    console.error(
      `FAIL: bundle directory ${outputDir} does not exist — run \`npm run build\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  let violations;
  try {
    violations = scanBundle(outputDir);
  } catch (err) {
    console.error(`FAIL: cannot scan ${outputDir}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (violations.length > 0) {
    console.error(
      `FAIL: forbidden constructs found in ${path.relative(process.cwd(), outputDir) || outputDir}:`,
    );
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line}: ${v.rule} — ${v.snippet}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `OK: no eval(), new Function(), or remote <script src> in ${path.relative(process.cwd(), outputDir) || outputDir}.`,
  );
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main();
}
