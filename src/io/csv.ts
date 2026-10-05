import { z } from "../schemas/z";
import { Category } from "../schemas/bookmark";
import { MAX_FILE_BYTES } from "./netscape";

/**
 * CSV export/import for bookmarks. Pure functions — no DOM, no `chrome`, no
 * Dexie, no `fetch`. Both directions live here so the format contract sits in
 * exactly one file.
 *
 * ## Format
 *
 * Exact header (this exact name set, this order on export):
 *
 *     title,url,folder_path,tags,category,notes,created
 *
 * - `title`       — bookmark title, may be empty.
 * - `url`         — absolute http(s) URL. Required on import; anything not
 *                   parseable or not `http:`/`https:` (incl. `javascript:`,
 *                   `data:`, `chrome:`, `file:`, `ftp:`, `mailto:`) lands in
 *                   `invalid` — it is collected, never silently imported.
 * - `folder_path` — `/`-joined ancestor folder titles, topmost first
 *                   (`Work/Docs`); "" means top level. The string is carried
 *                   verbatim — the import writer owns splitting/validation.
 *                   Segments are `\`-escaped on the wire so a folder title
 *                   containing `/` or `\` round-trips (see
 *                   {@link joinFolderPath}/{@link splitFolderPath}); callers
 *                   building the cell MUST use `joinFolderPath`, and the
 *                   import writer splits with `splitFolderPath`. A
 *                   hand-written file with raw `/` still splits per the
 *                   legacy behavior — only escape pairs `\/` and `\\`
 *                   are special.
 * - `tags`        — `;`-separated tag names inside ONE cell (`;` because `,`
 *                   is the CSV delimiter). Tag names carrying `;` or `\`
 *                   are `\`-escaped (see {@link joinTags}/{@link splitTags}).
 *                   Import splits, trims each, drops empties.
 * - `category`    — a `Category` enum value or empty (⇔ `undefined`).
 * - `notes`       — free text, verbatim.
 * - `created`     — ISO 8601 date or datetime, or empty (⇔ `undefined`).
 *
 * ## Wire rules
 *
 * - Records are separated by CRLF; export always ends the file with CRLF.
 * - Quoting is RFC 4180: a cell containing `"`, `,`, CR or LF is wrapped in
 *   `"`, and internal `"` is doubled.
 * - Formula-injection escape: any cell whose FIRST raw character is `=`,
 *   `+`, `-`, `@`, TAB or CR gets a leading `'` BEFORE quoting (the
 *   spreadsheet-escape convention). The check looks at the raw first char
 *   only — no trim: every major spreadsheet treats a whitespace-prefixed
 *   cell as text, so escaping it would be a false positive that import (see
 *   below) could never undo.
 * - Import strips ONE leading `'` when — and only when — the character
 *   after it is a formula trigger (`= + - @ TAB CR`). That is exactly the
 *   inverse of the export escape, so our own `'-5 degrees` / `'+1 tip` /
 *   `'@handle` cells come back as the user wrote them. The trade-off is
 *   unavoidable: a foreign file's literal `'=x` title also loses its `'` —
 *   the escape was never distinguishable from real data — while a foreign
 *   `=evil()` with no `'` stays verbatim in stored data (the `'` only ever
 *   mattered to spreadsheet apps reading the FILE, never to us).
 *
 * ## Import semantics
 *
 * - A proper RFC 4180 state-machine parser (quoted cells, `""` escapes,
 *   embedded newlines, lone-LF/CR endings tolerated, UTF-8 BOM stripped).
 * - Header validation is by exact column NAME, order-insensitive; required
 *   set = all of {@link CSV_COLUMNS}. Unknown extra columns are ignored;
 *   duplicate required names resolve to the first occurrence. Missing names
 *   are the only fatal condition (`{ok:false, code:"missing_columns"}`).
 * - Blank records (a single field that is empty/whitespace) are skipped.
 * - Per-row validation collects `{row, reason}` into `invalid` — never
 *   fatal. `row` counts the header as row 1, matching spreadsheet display.
 *   Defects checked: quoting defects, more cells than the header (fewer are
 *   tolerated as empty), missing/invalid/non-http(s) url, unknown category,
 *   non-ISO created. `url`, `category`, `created`, `folder_path` are trimmed;
 *   `title` and `notes` stay verbatim.
 * - Unterminated-quote recovery: a `"` that never closes would legally
 *   swallow every following line into one cell (embedded newlines are valid
 *   inside quotes). The parser instead ends the record at the first
 *   physical line break inside the open cell, reports the head as invalid
 *   (`unterminated quoted field`), and re-parses the remainder as fresh
 *   records — so the rows after the broken one are recovered rather than
 *   silently swallowed.
 */

/** The exact export header line. */
export const CSV_COLUMNS = [
  "title",
  "url",
  "folder_path",
  "tags",
  "category",
  "notes",
  "created",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** `CSV_COLUMNS` joined by commas — the first line of every export. */
export const CSV_HEADER = CSV_COLUMNS.join(",");

/** In-cell tag list separator (commas are the CSV delimiter). */
export const TAG_SEPARATOR = ";";

/**
 * `\`-escape a single `folder_path` segment or tag name so the wire
 * delimiters (`/` in paths, `;` in tag cells) can live inside real titles.
 * Only `\` and the delimiter are escaped; any other character is verbatim.
 */
function escapeDelimited(text: string, delimiter: "/" | ";"): string {
  return text.replaceAll("\\", "\\\\").replaceAll(delimiter, `\\${delimiter}`);
}

/**
 * Inverse of {@link escapeDelimited}: split on UNESCAPED delimiters and
 * restore `\/`/`\;`/`\\` pairs. A `\` followed by any other character
 * is kept literally (forward-compatible — foreign files lose nothing).
 */
function splitDelimited(text: string, delimiter: "/" | ";"): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === "\\") {
      const next = text.charAt(i + 1);
      if (next === delimiter || next === "\\") {
        current += next;
        i++;
      } else {
        current += c;
      }
      continue;
    }
    if (c === delimiter) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/**
 * Wire form of a `folder_path` cell from ancestor folder titles (topmost
 * first): each title is `\`-escaped and the segments joined with `/`.
 * Counterpart of {@link splitFolderPath}.
 */
export function joinFolderPath(ancestors: readonly string[]): string {
  return ancestors.map((title) => escapeDelimited(title, "/")).join("/");
}

/**
 * Split a `folder_path` cell into ancestor titles. Unescaped `/` separates
 * segments (the legacy behavior for hand-written files); `\/` and `\\`
 * unescape back into the title text. Trimming/emptiness policy lives with
 * the import writer, not here.
 */
export function splitFolderPath(path: string): string[] {
  if (path === "") return [];
  return splitDelimited(path, "/");
}

/** Join real tag names into the single `;`-delimited `tags` cell. */
export function joinTags(tags: readonly string[]): string {
  return tags.map((tag) => escapeDelimited(tag, ";")).join(TAG_SEPARATOR);
}

/** Split the `tags` cell into tag names: unescaped `;` separates, escapes restore. */
export function splitTags(cell: string): string[] {
  if (cell === "") return [];
  return splitDelimited(cell, TAG_SEPARATOR);
}

/** One bookmark as a flat CSV record — input to {@link exportCsv}, output of {@link parseCsv}. */
export interface CsvBookmarkRow {
  /** `title` cell, verbatim. */
  title: string;
  /** `url` cell — absolute http(s) URL (enforced on import). */
  url: string;
  /** `folder_path` cell: `/`-joined ancestor folder titles; "" = top level. */
  folderPath: string;
  /** Tag names; serialized as one `;`-joined cell. */
  tags: string[];
  /** `category` cell; `undefined` ⇔ empty cell. */
  category?: Category;
  /** `notes` cell; `undefined` ⇔ empty cell. */
  notes?: string;
  /** `created` cell: ISO 8601 date/datetime; `undefined` ⇔ empty cell. */
  created?: string;
}

/** A data record that failed validation. Never fatal — see {@link parseCsv}. */
export interface InvalidCsvRow {
  /** 1-based record number counting the header as row 1 (spreadsheet-style). */
  row: number;
  /** Human-readable rejection reason. */
  reason: string;
}

export interface CsvParseSuccess {
  ok: true;
  rows: CsvBookmarkRow[];
  invalid: InvalidCsvRow[];
}

export interface CsvParseFailure {
  ok: false;
  code: "empty" | "missing_columns" | "too_large";
  message: string;
}

export type CsvParseResult = CsvParseSuccess | CsvParseFailure;

/**
 * First-char triggers for spreadsheet formula injection (OWASP CSV escape
 * convention): `=` `+` `-` `@` TAB CR. Checked on the RAW cell — leading
 * whitespace is not trimmed because whitespace-prefixed cells are inert text
 * in Excel/LibreOffice/Sheets.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;
const ESCAPE_PREFIX = "'";

/** Escape + quote one cell (formula escape first, then RFC 4180 quoting). */
function escapeCell(raw: string): string {
  const escaped = FORMULA_TRIGGER.test(raw) ? ESCAPE_PREFIX + raw : raw;
  return NEEDS_QUOTING.test(escaped)
    ? `"${escaped.replaceAll('"', '""')}"`
    : escaped;
}

/**
 * Serialize rows to a CSV document: header line, one record per row, CRLF
 * separators, trailing CRLF. `exportCsv([])` is a header-only file.
 */
export function exportCsv(rows: readonly CsvBookmarkRow[]): string {
  const lines = rows.map((row) =>
    [
      escapeCell(row.title),
      escapeCell(row.url),
      escapeCell(row.folderPath),
      escapeCell(joinTags(row.tags)),
      escapeCell(row.category ?? ""),
      escapeCell(row.notes ?? ""),
      escapeCell(row.created ?? ""),
    ].join(","),
  );
  return [CSV_HEADER, ...lines].map((line) => `${line}\r\n`).join("");
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ParserState = "fieldStart" | "unquoted" | "quoted" | "quoteClosed";

interface RawRecord {
  fields: string[];
  /**
   * Set when the record broke quoting rules (unterminated quoted field, or
   * stray content after a closing quote). The value doubles as the invalid
   * reason — the record is reported, not trusted.
   */
  defect?: string;
}

const BOM = 0xfeff;

/**
 * RFC 4180 state machine. Tolerates lone LF and lone CR line endings in
 * addition to CRLF, and a leading UTF-8 BOM. Malformed quoting never throws:
 * the record is marked with `defect` and reported as an invalid row.
 */
function parseRecords(text: string, recoverUnterminated = true): RawRecord[] {
  const records: RawRecord[] = [];
  let fields: string[] = [];
  let cell = "";
  let state: ParserState = "fieldStart";
  let defect: string | undefined;

  const pushRecord = (): void => {
    fields.push(cell);
    records.push({ fields, defect });
    fields = [];
    cell = "";
    defect = undefined;
    state = "fieldStart";
  };

  const start = text.charCodeAt(0) === BOM ? 1 : 0;
  for (let i = start; i < text.length; i++) {
    const c = text.charAt(i);
    switch (state) {
      case "fieldStart":
        if (c === '"') {
          state = "quoted";
        } else if (c === ",") {
          fields.push(cell);
          cell = "";
        } else if (c === "\r" || c === "\n") {
          if (c === "\r" && text.charAt(i + 1) === "\n") i++;
          pushRecord();
        } else {
          cell += c;
          state = "unquoted";
        }
        break;
      case "unquoted":
        if (c === ",") {
          fields.push(cell);
          cell = "";
          state = "fieldStart";
        } else if (c === "\r" || c === "\n") {
          if (c === "\r" && text.charAt(i + 1) === "\n") i++;
          pushRecord();
        } else {
          cell += c;
        }
        break;
      case "quoted":
        if (c === '"') {
          if (text.charAt(i + 1) === '"') {
            cell += '"';
            i++;
          } else {
            state = "quoteClosed";
          }
        } else {
          cell += c;
        }
        break;
      case "quoteClosed":
        if (c === ",") {
          fields.push(cell);
          cell = "";
          state = "fieldStart";
        } else if (c === "\r" || c === "\n") {
          if (c === "\r" && text.charAt(i + 1) === "\n") i++;
          pushRecord();
        } else {
          // Lenient recovery (Python csv-style): keep the stray chars in the
          // cell but flag the record so it is reported invalid.
          defect ??= "unexpected content after closing quote";
          cell += c;
          state = "unquoted";
        }
        break;
    }
  }

  if (state === "quoted") {
    // An unmatched `"` legally swallows the rest of the file into this cell
    // (newlines inside quotes are data). Recover: end the record at the
    // first physical line break and re-parse the remainder as fresh
    // records, so one stray quote forfeits only its own record. The
    // re-parse runs with recovery off — a second unterminated quote inside
    // the tail reports plainly instead of recursing per line.
    const breakAt = recoverUnterminated ? cell.search(/\r\n|\r|\n/) : -1;
    if (breakAt === -1) {
      defect ??= "unterminated quoted field";
    } else {
      const rest = cell.slice(breakAt).replace(/^(\r\n|\r|\n)/, "");
      cell = cell.slice(0, breakAt);
      const recovered = parseRecords(rest, false);
      fields.push(cell);
      records.push({
        fields,
        defect:
          recovered.length === 0
            ? "unterminated quoted field"
            : `unterminated quoted field; ${recovered.length} following record(s) recovered`,
      });
      records.push(...recovered);
      return records;
    }
  }
  // Trailing record without a final line break; a clean pushRecord() already
  // reset state, so this cannot double-push after a terminated file.
  if (state !== "fieldStart" || cell !== "" || fields.length > 0) {
    pushRecord();
  }
  return records;
}

/** A record is "blank" when it carries a single empty/whitespace-only field. */
function isBlankRecord(record: RawRecord): boolean {
  return (
    record.defect === undefined &&
    record.fields.length === 1 &&
    (record.fields[0] ?? "").trim() === ""
  );
}

/** ISO 8601 date or datetime (Zulu, numeric offset, or local form). */
const CreatedStamp = z.union([
  z.iso.datetime({ offset: true, local: true }),
  z.iso.date(),
]);

/**
 * Parse CSV text into validated rows. Fatal only for missing content
 * (`"empty"`), a header missing required column names (`"missing_columns"`),
 * or an oversized file (`"too_large"` — the same {@link MAX_FILE_BYTES} cap
 * as Netscape/JSON imports, checked on UTF-8 byte length before any parsing
 * work); every row-level problem is collected into `invalid` with its
 * 1-based record number and a reason.
 */
export function parseCsv(text: string): CsvParseResult {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `File is ${bytes} bytes; CSV imports are capped at ${MAX_FILE_BYTES} bytes (20 MiB).`,
    };
  }
  const records = parseRecords(text);
  const headerIdx = records.findIndex((r) => !isBlankRecord(r));
  if (headerIdx === -1) {
    return { ok: false, code: "empty", message: "CSV file contains no records" };
  }
  const header = records[headerIdx]!;

  // Exact-name, order-insensitive header match; unknown columns ignored;
  // a duplicated required name resolves to its first occurrence.
  const columnIndex = new Map<CsvColumn, number>();
  for (const col of CSV_COLUMNS) {
    const idx = header.fields.findIndex((f) => f.trim() === col);
    if (idx !== -1) {
      columnIndex.set(col, idx);
    }
  }
  const missing = CSV_COLUMNS.filter((col) => !columnIndex.has(col));
  if (missing.length > 0) {
    return {
      ok: false,
      code: "missing_columns",
      message: `CSV header is missing required column(s): ${missing.join(", ")}`,
    };
  }

  const rows: CsvBookmarkRow[] = [];
  const invalid: InvalidCsvRow[] = [];

  for (let i = headerIdx + 1; i < records.length; i++) {
    const record = records[i]!;
    if (isBlankRecord(record)) {
      continue;
    }
    const row = i + 1; // header counts as row 1 — matches spreadsheet display
    const reject = (reason: string): void => {
      invalid.push({ row, reason });
    };

    if (record.defect !== undefined) {
      reject(record.defect);
      continue;
    }
    if (record.fields.length > header.fields.length) {
      reject(
        `${record.fields.length} cells but header has ${header.fields.length}`,
      );
      continue;
    }

    // Inverse of the export formula escape: ONE leading `'` is stripped
    // only when the next char is a formula trigger — our own `'=x` cells
    // return to `=x` while foreign `'` data stays verbatim.
    const unescapeCell = (value: string): string =>
      value.charAt(0) === "'" && FORMULA_TRIGGER.test(value.charAt(1))
        ? value.slice(1)
        : value;
    const cell = (col: CsvColumn): string =>
      unescapeCell(record.fields[columnIndex.get(col)!] ?? "");

    const url = cell("url").trim();
    if (url === "") {
      reject("missing url");
      continue;
    }
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      reject(`invalid url ${JSON.stringify(url)}`);
      continue;
    }
    if (protocol !== "http:" && protocol !== "https:") {
      reject(`non-http(s) url ${JSON.stringify(url)}`);
      continue;
    }

    const categoryText = cell("category").trim();
    let category: Category | undefined;
    if (categoryText !== "") {
      const parsed = Category.safeParse(categoryText);
      if (!parsed.success) {
        reject(`invalid category ${JSON.stringify(categoryText)}`);
        continue;
      }
      category = parsed.data;
    }

    const created = cell("created").trim();
    if (created !== "" && !CreatedStamp.safeParse(created).success) {
      reject(`invalid created ${JSON.stringify(created)}`);
      continue;
    }

    const tags = splitTags(cell("tags"))
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");

    const notes = cell("notes");
    rows.push({
      title: cell("title"),
      url,
      folderPath: cell("folder_path").trim(),
      tags,
      ...(category === undefined ? {} : { category }),
      ...(notes === "" ? {} : { notes }),
      ...(created === "" ? {} : { created }),
    });
  }

  return { ok: true, rows, invalid };
}
