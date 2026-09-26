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
 *                   **Known format limitation:** `/` is an UNESCAPED
 *                   delimiter, so a folder title that itself contains `/`
 *                   cannot round-trip — it splits into nested folders on
 *                   import (`"A/B"` becomes `A` → `B`). Titles are written
 *                   verbatim on export; the corruption only surfaces if the
 *                   file is re-imported. Use JSON export for lossless trees.
 * - `tags`        — `;`-separated tag names inside ONE cell (`;` because `,`
 *                   is the CSV delimiter). Import splits, trims each, drops
 *                   empties.
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
 * - Import does NOT strip the `'` escape. Keeping it means imported data is
 *   permanently inert no matter which path it later leaves the app by (a
 *   foreign CSV's `=evil()` payload can never wake up via JSON/Netscape
 *   export or a naive re-export), and CSV parse→export is byte-stable. The
 *   cost: a user's own literal leading `'` stays put too — an acceptable
 *   cosmetic trade-off since stripping could not distinguish our escape from
 *   a real apostrophe anyway.
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
      escapeCell(row.tags.join(TAG_SEPARATOR)),
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
function parseRecords(text: string): RawRecord[] {
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
    defect ??= "unterminated quoted field";
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

    const cell = (col: CsvColumn): string =>
      record.fields[columnIndex.get(col)!] ?? "";

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

    const tags = cell("tags")
      .split(TAG_SEPARATOR)
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
