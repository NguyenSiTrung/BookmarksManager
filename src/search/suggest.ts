import { Category } from "../schemas/bookmark";
import { FILTER_KEYS, IS_VALUES } from "./query";
import type { FilterKey } from "./query";

/**
 * Autocomplete for the search query language (spec §3). Pure — no `chrome`,
 * DOM, React, or Dexie — so it runs identically in the side panel, command
 * palette, popup, and tests.
 *
 * `suggestFilters(text, cursor, sources)` inspects the token under the
 * cursor and returns either
 *  - KEY completions (`kind: "key"`) — the token is a partial key, i.e. an
 *    optional `-` followed by ASCII letters with no `:` or `"` yet; or
 *  - VALUE completions (`kind: "value"`) — the token is a recognized
 *    `tag:`/`folder:`/`category:`/`is:` filter and the cursor sits in its
 *    value region.
 *
 * Rules honored from the parser's tokenizer (`query.ts`):
 *  - A leading `-` is a negation marker and stays OUTSIDE the replacement
 *    span, so accepting `-f` → `folder:` yields `-folder:`.
 *  - No key suggestions inside a quoted span (`"mach|` is free text, not a
 *    key). A quote after `key:` belongs to the value, so `tag:"ma|` still
 *    completes values and the stray quote is inside the replaced span.
 *  - `before:`, `after:`, and `domain:` are free-form — no value
 *    suggestions. Unknown `key:` tokens are free text — none either.
 *  - Values containing whitespace are inserted wrapped in `"…"` so the
 *    spliced query tokenizes as a single filter value.
 *
 * Context rules (documented choices):
 *  - The cursor's token is the one whose raw span `[start, end]` contains
 *    it (endpoints included). A cursor on whitespace, at offset 0 of an
 *    empty query, or otherwise outside every token is a FRESH context: all
 *    filter keys with a zero-width span at the cursor.
 *  - A lone `-` is treated as the negation prefix even though the parser
 *    reads it as a term, so `-|` also offers every key.
 *  - When the cursor sits in a `key:` token's KEY region (before/on the
 *    colon) the span covers `key:` so picking `folder:` on `ta|g:rust`
 *    yields `folder:rust`.
 *  - Matching is case-insensitive: prefix matches rank before substring
 *    matches, then shorter candidates, then earlier match offset, then
 *    source order. An empty prefix preserves source order.
 *  - The function is TOTAL: any `text`/`cursor` input returns a list
 *    (possibly empty) and never throws.
 */

/** Runtime value sources the caller refreshes on each keystroke. */
export interface SuggestionSources {
  /** Tag display names eligible as `tag:` values. */
  tags: readonly string[];
  /** Folder titles eligible as `folder:` values. */
  folders: readonly string[];
}

/**
 * One suggestion the UI can splice into the query text. Accepting it means
 * `text = text.slice(0, replaceFrom) + insertText + text.slice(replaceTo)`.
 */
export interface Suggestion {
  /** `"key"` completes a filter key; `"value"` completes a `key:` value. */
  kind: "key" | "value";
  /**
   * The filter key involved: for `kind: "key"` the key being completed
   * (`insertText` is `${key}:`); for `kind: "value"` the key whose value is
   * being completed. Useful for styling per-key affordances.
   */
  key: FilterKey;
  /** Display text for the option row (`tag:`, `Work stuff`, …). */
  label: string;
  /**
   * Replacement text for the span. Value suggestions arrive already quoted
   * (`"machine learning"`) when the value contains whitespace.
   */
  insertText: string;
  /** Inclusive start offset into `text` of the span to replace. */
  replaceFrom: number;
  /** Exclusive end offset into `text` of the span to replace. */
  replaceTo: number;
}

// ---------------------------------------------------------------------------
// Internals — the scanner mirrors `query.ts` `tokenize` but keeps offsets.

const WHITESPACE = /\s/;
const ASCII_LETTER = /[A-Za-z]/;
const KEY_PREFIX = /^[A-Za-z]*$/;
const DOUBLE_QUOTE = /"/g;

const EMPTY_SOURCES: SuggestionSources = { tags: [], folders: [] };

interface TokenSpan {
  /** Offset of the token's first character (the `-` if negated). */
  start: number;
  /** Offset one past the token's last character. */
  end: number;
  /** Offset of the first character after a leading `-`. */
  bodyStart: number;
}

/**
 * Splits `text` into token spans on whitespace. `-` always detaches into
 * `bodyStart` (a lone `-` completes as a negation prefix). A `"` consumes
 * through the next `"` or — unterminated — the end of input, matching the
 * parser's segment rules.
 */
function scanTokens(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && WHITESPACE.test(text.charAt(i))) i++;
    if (i >= n) break;
    const start = i;
    let bodyStart = i;
    if (text.charAt(i) === "-") {
      bodyStart = i + 1;
      i++;
    }
    while (i < n && !WHITESPACE.test(text.charAt(i))) {
      if (text.charAt(i) === '"') {
        const close = text.indexOf('"', i + 1);
        i = close === -1 ? n : close + 1;
      } else {
        let j = i;
        while (
          j < n &&
          !WHITESPACE.test(text.charAt(j)) &&
          text.charAt(j) !== '"'
        ) {
          j++;
        }
        i = j;
      }
    }
    spans.push({ start, end: i, bodyStart });
  }
  return spans;
}

/** The token whose raw `[start, end]` span contains `cursor`, if any. */
function activeToken(spans: TokenSpan[], cursor: number): TokenSpan | undefined {
  for (const span of spans) {
    if (span.start > cursor) break;
    if (cursor <= span.end) return span;
  }
  return undefined;
}

/** Drops candidates differing only by case; first occurrence's casing wins. */
function dedupe<T extends string>(candidates: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of candidates) {
    const folded = c.toLowerCase();
    if (!seen.has(folded)) {
      seen.add(folded);
      out.push(c);
    }
  }
  return out;
}

/**
 * Ranks `candidates` against `prefix`, case-insensitively: prefix matches
 * first (shorter wins), then substring matches (earlier offset wins, then
 * shorter), with source order as the final deterministic tiebreak. An empty
 * prefix returns the deduped source order.
 */
function rankCandidates<T extends string>(
  prefix: string,
  candidates: readonly T[],
): T[] {
  const unique = dedupe(candidates);
  const needle = prefix.toLowerCase();
  if (needle === "") return unique;
  interface Scored {
    value: T;
    group: number;
    distance: number;
    length: number;
    order: number;
  }
  const scored: Scored[] = [];
  unique.forEach((value, order) => {
    const lower = value.toLowerCase();
    if (lower.startsWith(needle)) {
      scored.push({ value, group: 0, distance: 0, length: lower.length, order });
      return;
    }
    const distance = lower.indexOf(needle);
    if (distance !== -1) {
      scored.push({ value, group: 1, distance, length: lower.length, order });
    }
  });
  scored.sort(
    (a, b) =>
      a.group - b.group ||
      a.distance - b.distance ||
      a.length - b.length ||
      a.order - b.order,
  );
  return scored.map((s) => s.value);
}

/** Wraps a value in `"…"` when it cannot survive as a bare token. */
function quoteIfNeeded(value: string): string {
  return WHITESPACE.test(value) ? `"${value}"` : value;
}

function keySuggestions(prefix: string, from: number, to: number): Suggestion[] {
  return rankCandidates(prefix, FILTER_KEYS).map((key) => ({
    kind: "key",
    key,
    label: `${key}:`,
    insertText: `${key}:`,
    replaceFrom: from,
    replaceTo: to,
  }));
}

/**
 * Value candidates for a recognized key, or undefined when the key is
 * unknown or free-form (`domain`, `before`, `after`) — those get no
 * suggestions by spec.
 */
function valueCandidates(
  key: string,
  sources: SuggestionSources,
): readonly string[] | undefined {
  switch (key) {
    case "tag":
      return sources.tags;
    case "folder":
      return sources.folders;
    case "category":
      return Category.options;
    case "is":
      return IS_VALUES;
    default:
      return undefined;
  }
}

/**
 * Suggests completions for `text` with the caret at `cursor`. See the module
 * docstring for the context rules; total — never throws, and the returned
 * spans always satisfy `0 <= replaceFrom <= replaceTo <= text.length`.
 */
export function suggestFilters(
  text: string,
  cursor: number,
  sources: SuggestionSources = EMPTY_SOURCES,
): Suggestion[] {
  if (typeof text !== "string") return [];
  const c = Number.isFinite(cursor)
    ? Math.min(Math.max(Math.trunc(cursor), 0), text.length)
    : 0;

  const token = activeToken(scanTokens(text), c);
  if (token === undefined) {
    // Fresh context — cursor on whitespace or in an empty query.
    return keySuggestions("", c, c);
  }

  // A `key:` prefix exists iff the token body opens with ASCII letters
  // followed by a colon before any quote.
  let i = token.bodyStart;
  while (i < token.end && ASCII_LETTER.test(text.charAt(i))) i++;
  const colon =
    i < token.end && text.charAt(i) === ":" ? i : -1;

  if (colon !== -1) {
    if (c <= colon) {
      // Cursor sits in the key region — complete the key and keep any
      // already-typed value by ending the span after the colon.
      return keySuggestions(
        text.slice(token.bodyStart, c),
        token.bodyStart,
        colon + 1,
      );
    }
    const candidates = valueCandidates(
      text.slice(token.bodyStart, colon),
      sources,
    );
    if (candidates === undefined) return [];
    const valuePrefix = text
      .slice(colon + 1, c)
      .replace(DOUBLE_QUOTE, "");
    return rankCandidates(valuePrefix, candidates).map((value) => ({
      kind: "value",
      key: text.slice(token.bodyStart, colon) as FilterKey,
      label: value,
      insertText: quoteIfNeeded(value),
      replaceFrom: colon + 1,
      replaceTo: token.end,
    }));
  }

  // No `key:` before any quote. Inside an unterminated/closed quoted span
  // (odd quote count before the cursor) this is free text — no suggestions.
  const before = text.slice(token.bodyStart, c);
  let quotes = 0;
  for (const ch of before) if (ch === '"') quotes++;
  if (quotes % 2 === 1 || !KEY_PREFIX.test(before)) return [];
  return keySuggestions(before, token.bodyStart, token.end);
}
