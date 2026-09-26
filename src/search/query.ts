import { Category } from "../schemas/bookmark";

/**
 * Query parser for the search query language (spec §2). Pure: no `chrome`,
 * DOM, or React — safe in workers, entrypoints, and tests.
 *
 * The parser is TOTAL: `parseQuery` never throws on arbitrary input and
 * always returns a typed AST plus user-visible warnings. Malformed input is
 * either demoted to free text (unknown `key:` tokens, so pasted URLs still
 * search) or dropped with a warning (bad values for known keys).
 *
 * Grammar (informal):
 *   query   := token*                      — whitespace-separated
 *   token   := ["-"] segment+
 *   segment := '"' ... ('"' | EOL)         — quotes may embed whitespace;
 *                                            an unterminated quote consumes
 *                                            the rest of the input
 *            | [^space"]+
 *
 * Semantics the AST exposes to the executor (see `QueryFilter`):
 *  - `terms` are free text, ANDed. `exact` marks a "quoted phrase" — the
 *    executor treats it as a literal phrase rather than fuzzy terms.
 *  - Repeated `tag:` filters AND; repeated single-valued keys (`folder`,
 *    `domain`, `category`) OR within the key; different keys always AND.
 *    `negated` inverts any filter or term.
 *  - `before:`/`after:` carry a parsed `DateBound`; resolving the local-time
 *    boundary (`after:` includes the period, `before:` excludes it) is the
 *    executor's job.
 *  - `is:dead` never reaches the AST: it warns "Link checking isn't
 *    available yet" and is ignored (it needs the release-1.1 link checker).
 *  - `warnings` keep the user's raw token so the UI can show it inline.
 */

/** Filter keys the parser recognizes, in declaration order. */
export const FILTER_KEYS = [
  "tag",
  "folder",
  "domain",
  "category",
  "before",
  "after",
  "is",
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

/**
 * Every `is:` value the syntax recognizes. `dead` parses and warns but never
 * reaches the AST — see `IsFlag`.
 */
export const IS_VALUES = ["duplicate", "untagged", "dead"] as const;
export type IsValue = (typeof IS_VALUES)[number];

/** `is:` values that produce a filter (`dead` is warn-and-ignore). */
export type IsFlag = Exclude<IsValue, "dead">;

/**
 * A `before:`/`after:` bound as typed, validated to be a real calendar date.
 * `precision` records which fields were given — `month` (1–12) is present for
 * "month" and "day", `day` (1–31) only for "day". The executor turns this
 * into local-time millisecond boundaries.
 */
export type DateBound =
  | { precision: "year"; year: number }
  | { precision: "month"; year: number; month: number }
  | { precision: "day"; year: number; month: number; day: number };

/**
 * One `key:value` filter in source order. `key` discriminates the value
 * shape: a plain string for tag/folder/domain, `Category` for category, a
 * `DateBound` for before/after, and an `IsFlag` for is.
 */
export type QueryFilter =
  | { key: "tag" | "folder" | "domain"; value: string; negated: boolean }
  | { key: "category"; value: Category; negated: boolean }
  | { key: "before" | "after"; value: DateBound; negated: boolean }
  | { key: "is"; value: IsFlag; negated: boolean };

/** A free-text term; all terms in a query are ANDed. */
export interface QueryTerm {
  /**
   * Quote-stripped text. May contain spaces when a quoted segment was embedded
   * in a larger token (`a"b c"d` → `ab cd`); non-exact terms should be
   * matched word-wise (ANDed).
   */
  text: string;
  /**
   * True when the whole token was one `"…"` segment — an exact phrase to
   * match literally rather than as fuzzy/prefix terms.
   */
  exact: boolean;
  negated: boolean;
}

/** A non-fatal parse problem, surfaced inline under the search input. */
export interface QueryWarning {
  /** The token exactly as typed, including a leading `-` and quotes. */
  token: string;
  message: string;
}

/** The typed AST `parseQuery` returns — always, for any input. */
export interface ParsedQuery {
  terms: QueryTerm[];
  filters: QueryFilter[];
  warnings: QueryWarning[];
}

// ---------------------------------------------------------------------------
// Internals

const FILTER_KEY_SET: ReadonlySet<string> = new Set<string>(FILTER_KEYS);
const CATEGORY_SET: ReadonlySet<string> = new Set<string>(Category.options);

const WHITESPACE = /\s/;
/** A filter prefix: ASCII letters followed by `:`. */
const KEY_PATTERN = /^([A-Za-z]+):/;
/** Exactly `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`. */
const DATE_PATTERN = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;

const MESSAGE_DATE = "Invalid date — use YYYY, YYYY-MM, or YYYY-MM-DD";
const MESSAGE_CATEGORY = `Unknown category — expected one of: ${Category.options.join(", ")}`;
const MESSAGE_IS = `Unknown is: value — expected one of: ${IS_VALUES.join(", ")}`;
const MESSAGE_DEAD = "Link checking isn't available yet";

interface Token {
  /** The token exactly as typed, including a leading `-` and quotes. */
  raw: string;
  /** True when the token began with `-` (a negation marker). */
  negated: boolean;
  /** Token body after the `-` with every `"` removed. */
  text: string;
  /** True when the body was exactly one `"…"` segment. */
  quoted: boolean;
}

/**
 * Splits `input` into tokens on whitespace, honoring `"…"` spans (which may
 * contain whitespace) and a leading `-`. Shell-like concatenation applies to
 * mixed tokens (`a"b c"d` is one token with text `ab cd`). An unterminated
 * quote consumes the rest of the input — still a complete, total parse.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    while (i < n && WHITESPACE.test(input.charAt(i))) i++;
    if (i >= n) break;
    const start = i;
    let negated = false;
    // `-` is a negation marker only when immediately followed by more token.
    if (
      input.charAt(i) === "-" &&
      i + 1 < n &&
      !WHITESPACE.test(input.charAt(i + 1))
    ) {
      negated = true;
      i++;
    }
    let text = "";
    let segments = 0;
    let quotedSegments = 0;
    while (i < n && !WHITESPACE.test(input.charAt(i))) {
      if (input.charAt(i) === '"') {
        const close = input.indexOf('"', i + 1);
        if (close === -1) {
          text += input.slice(i + 1);
          i = n;
        } else {
          text += input.slice(i + 1, close);
          i = close + 1;
        }
        quotedSegments++;
      } else {
        let j = i;
        while (
          j < n &&
          !WHITESPACE.test(input.charAt(j)) &&
          input.charAt(j) !== '"'
        ) {
          j++;
        }
        text += input.slice(i, j);
        i = j;
      }
      segments++;
    }
    tokens.push({
      raw: input.slice(start, i),
      negated,
      text,
      quoted: segments === 1 && quotedSegments === 1,
    });
  }
  return tokens;
}

/** Returns the recognized filter key at the start of `text`, if any. */
function filterKeyOf(text: string): FilterKey | undefined {
  const key = KEY_PATTERN.exec(text)?.[1];
  return key !== undefined && FILTER_KEY_SET.has(key)
    ? (key as FilterKey)
    : undefined;
}

function isCategory(value: string): value is Category {
  return CATEGORY_SET.has(value);
}

/**
 * Parses `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` into a `DateBound`, rejecting
 * impossible calendar dates (month 13, Feb 30, non-leap Feb 29). Returns
 * undefined on any shape or range failure.
 */
function parseDateBound(text: string): DateBound | undefined {
  const m = DATE_PATTERN.exec(text);
  if (m === null) return undefined;
  const year = Number(m[1]);
  const monthText = m[2];
  if (monthText === undefined) return { precision: "year", year };
  const month = Number(monthText);
  const dayText = m[3];
  if (dayText === undefined) {
    return month >= 1 && month <= 12
      ? { precision: "month", year, month }
      : undefined;
  }
  const day = Number(dayText);
  // Round-trip through Date to reject impossible dates. `setFullYear` (not
  // the constructor) so years < 100 don't pick up the 1900 offset.
  const d = new Date(0);
  d.setFullYear(year, month - 1, day);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return undefined;
  }
  return { precision: "day", year, month, day };
}

/**
 * Validates the value for a known `key:` and either appends a filter or a
 * warning for the raw token. Unknown values and empty values warn; the token
 * never reaches the AST in that case. `is:dead` always warns and drops.
 */
function pushFilter(
  key: FilterKey,
  value: string,
  token: Token,
  filters: QueryFilter[],
  warnings: QueryWarning[],
): void {
  const warn = (message: string): void => {
    warnings.push({ token: token.raw, message });
  };

  if (value === "") {
    warn(`Missing value for ${key}:`);
    return;
  }
  switch (key) {
    case "tag":
    case "folder":
    case "domain":
      filters.push({ key, value, negated: token.negated });
      return;
    case "category":
      if (isCategory(value)) {
        filters.push({ key, value, negated: token.negated });
      } else {
        warn(MESSAGE_CATEGORY);
      }
      return;
    case "before":
    case "after": {
      const bound = parseDateBound(value);
      if (bound === undefined) {
        warn(MESSAGE_DATE);
      } else {
        filters.push({ key, value: bound, negated: token.negated });
      }
      return;
    }
    case "is":
      if (value === "dead") {
        warn(MESSAGE_DEAD);
      } else if (value === "duplicate" || value === "untagged") {
        filters.push({ key, value, negated: token.negated });
      } else {
        warn(MESSAGE_IS);
      }
      return;
  }
}

/**
 * Parses `input` into a typed AST plus warnings. Total: never throws, and
 * unknown `key:` tokens (including pasted URLs) fall back to free text.
 */
export function parseQuery(input: string): ParsedQuery {
  const terms: QueryTerm[] = [];
  const filters: QueryFilter[] = [];
  const warnings: QueryWarning[] = [];

  for (const token of tokenize(input)) {
    // `""`, `-"`, a lone `"`, or a bare `-`: nothing to match or negate.
    if (token.text === "" || token.text === "-") continue;

    const key = filterKeyOf(token.text);
    if (key === undefined) {
      terms.push({
        text: token.text,
        exact: token.quoted,
        negated: token.negated,
      });
    } else {
      pushFilter(
        key,
        token.text.slice(key.length + 1),
        token,
        filters,
        warnings,
      );
    }
  }

  return { terms, filters, warnings };
}
