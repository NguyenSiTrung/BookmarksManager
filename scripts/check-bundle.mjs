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
 * Files are matched as whole text (not line-by-line), so a construct is still
 * caught when it is split across lines — e.g. `eval\n(...)`, `new\nFunction()`,
 * or a `<script ... src="https://...">` tag wrapped over several lines.
 *
 * Usage:
 *   node scripts/check-bundle.mjs [outputDir]
 *   CHECK_BUNDLE_DIR env var works as a fallback.
 *
 * Exit 0: no violations. Exit 1: violations (each reported as file:line, with
 * the matched span flattened to one line) or a missing/unreadable output
 * directory.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_OUTPUT_DIR = ".output/chrome-mv3";
const SCANNED_EXTENSIONS = new Set([".js", ".html"]);

// Patterns carry /g so String#matchAll iterates every occurrence in the file;
// \s in each pattern spans newlines, so constructs wrapped over lines match.
const RULES = [
  {
    label: "eval() call",
    pattern: /\beval\s*\(/g,
  },
  {
    label: "new Function() constructor",
    pattern: /\bnew\s+Function\s*\(/g,
  },
  {
    label: "remote <script src>",
    pattern: /<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//gi,
  },
];

/**
 * 0-based index of the line containing a character offset.
 * @param {number[]} lineStarts char offsets of each line's first character
 * @param {number} index char offset in the same source
 */
function lineIndexAt(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Scan one file's source text. The whole file is matched at once so banned
 * constructs split across lines are still caught; each violation is reported
 * at the line where its match begins, with the full matched span (all the
 * lines it covers) flattened into the snippet so remote URLs stay visible.
 * @param {string} fileName name used in reports (usually the relative path)
 * @param {string} source
 * @returns {{file: string, line: number, rule: string, snippet: string}[]}
 */
export function scanSource(fileName, source) {
  const violations = [];
  const lines = source.split(/\r?\n/);
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i !== -1; i = source.indexOf("\n", i + 1)) {
    lineStarts.push(i + 1);
  }
  const seen = new Set();
  for (const rule of RULES) {
    for (const match of source.matchAll(rule.pattern)) {
      const start = lineIndexAt(lineStarts, match.index);
      const end = lineIndexAt(lineStarts, match.index + match[0].length);
      const key = `${rule.label}:${start}`;
      if (seen.has(key)) continue; // one report per rule per line, as before
      seen.add(key);
      violations.push({
        file: fileName,
        line: start + 1,
        rule: rule.label,
        snippet: lines
          .slice(start, end + 1)
          .map((line) => line.trim())
          .join(" ")
          .slice(0, 160),
      });
    }
  }
  violations.sort((a, b) => a.line - b.line);
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
