import { describe, expect, it } from "vitest";
import {
  CSV_COLUMNS,
  CSV_HEADER,
  TAG_SEPARATOR,
  exportCsv,
  parseCsv,
  type CsvBookmarkRow,
} from "../../src/io/csv";
import { MAX_FILE_BYTES } from "../../src/io/netscape";

// Contract under test (documented in src/io/csv.ts):
//  - Columns, exact header: title,url,folder_path,tags,category,notes,created
//  - Records separated by CRLF; file ends with CRLF.
//  - RFC 4180 quoting: cells containing `"` `,` CR or LF are wrapped in `"`;
//    internal `"` is doubled.
//  - Formula-injection escape: a cell whose FIRST raw char is one of
//    = + - @ TAB CR gets a leading `'` BEFORE quoting. Leading whitespace is
//    NOT trimmed for the check (spreadsheets treat whitespace-prefixed cells
//    as text, so there is nothing to escape).
//  - `tags` is a `;`-separated list inside one cell (commas are the CSV
//    delimiter). `category` is a Category enum value or empty. `created` is an
//    ISO datetime or empty.
//  - Import does NOT strip the `'` escape: it stays in stored data so the
//    value is permanently inert no matter which exporter it later leaves by
//    (CSV re-export, JSON, Netscape, UI). Cost: a user's literal leading `'`
//    is also kept verbatim. Locked by tests below.

const HEADER = "title,url,folder_path,tags,category,notes,created";

function row(partial: Partial<CsvBookmarkRow> = {}): CsvBookmarkRow {
  return {
    title: "Example",
    url: "https://example.com/",
    folderPath: "",
    tags: [],
    ...partial,
  };
}

describe("exportCsv — header and framing", () => {
  it("exports the documented constants", () => {
    expect(CSV_HEADER).toBe(HEADER);
    expect([...CSV_COLUMNS]).toEqual(HEADER.split(","));
    expect(TAG_SEPARATOR).toBe(";");
  });

  it("writes the exact header as the first line", () => {
    const out = exportCsv([row()]);
    expect(out.split("\r\n")[0]).toBe(HEADER);
  });

  it("separates records with CRLF and ends the file with CRLF", () => {
    const out = exportCsv([row(), row({ title: "Two" })]);
    expect(out.endsWith("\r\n")).toBe(true);
    // header + 2 data records, each terminated
    expect(out.split("\r\n")).toHaveLength(4); // trailing "" after final CRLF
    expect(out).not.toContain("\n\r");
  });

  it("emits only the header line for an empty row set", () => {
    expect(exportCsv([])).toBe(`${HEADER}\r\n`);
  });

  it("emits all seven columns in header order", () => {
    const out = exportCsv([
      row({
        title: "T",
        url: "https://a.b/c",
        folderPath: "Work/Docs",
        tags: ["x", "y"],
        category: "docs",
        notes: "n",
        created: "2026-01-15T10:30:00Z",
      }),
    ]);
    expect(out.split("\r\n")[1]).toBe(
      "T,https://a.b/c,Work/Docs,x;y,docs,n,2026-01-15T10:30:00Z",
    );
  });

  it("writes empty cells for absent optional fields", () => {
    const out = exportCsv([row()]);
    // 6 commas ⇒ 7 cells: title, url, then five empty cells.
    expect(out.split("\r\n")[1]).toBe("Example,https://example.com/,,,,,");
  });
});

describe("exportCsv — RFC 4180 quoting", () => {
  it("does not quote plain cells", () => {
    const out = exportCsv([row({ title: "plain title" })]);
    expect(out.split("\r\n")[1]).toMatch(/^plain title,/);
  });

  it("quotes a cell containing a comma", () => {
    const out = exportCsv([row({ title: "a,b" })]);
    expect(out.split("\r\n")[1]).toMatch(/^"a,b",/);
  });

  it("doubles internal quotes and wraps the cell", () => {
    const out = exportCsv([row({ title: 'say "hi"' })]);
    expect(out.split("\r\n")[1]).toMatch(/^"say ""hi""",/);
  });

  it.each(["line1\nline2", "cell\rmid", "a\r\nb"])(
    "quotes a cell containing a line break (%j)",
    (cell) => {
      const out = exportCsv([row({ title: cell })]);
      // The whole data record is one quoted cell field; find it back via parse.
      const parsed = parseCsv(out);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.rows[0]?.title).toBe(cell);
      }
    },
  );

  it("does not quote a cell that only contains spaces", () => {
    const out = exportCsv([row({ title: "  padded  " })]);
    expect(out.split("\r\n")[1]).toMatch(/^ {2}padded {2},/);
  });
});

describe("exportCsv — formula-injection escaping", () => {
  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "prefixes a cell starting with %j with '",
    (ch) => {
      const out = exportCsv([row({ title: `${ch}payload` })]);
      const firstCell = out.split("\r\n")[1]?.split(",")[0];
      // \r also triggers quoting; compare the raw cell text inside any quotes.
      expect(firstCell?.startsWith('"')).toBe(ch === "\r");
      expect(firstCell).toContain(`'${ch}payload`);
      expect(parseCsv(out)).toMatchObject({ ok: true });
    },
  );

  it("escapes trigger cells in every column, not just title", () => {
    const out = exportCsv([
      row({
        title: "=title",
        url: "https://example.com/",
        folderPath: "-folder",
        tags: ["=tag"],
        notes: "@note",
        created: "2026-01-15T10:30:00Z",
      }),
    ]);
    const record = out.split("\r\n")[1] ?? "";
    expect(record).toContain("'=title");
    expect(record).toContain("'-folder");
    expect(record).toContain("'=tag");
    expect(record).toContain("'@note");
    // url is untouched — 'h' is not a trigger.
    expect(record).toContain("https://example.com/");
  });

  it("applies the ' prefix BEFORE quoting", () => {
    const out = exportCsv([row({ title: "=a,b" })]);
    expect(out.split("\r\n")[1]).toMatch(/^"'=a,b",/);
  });

  it("does not escape a trigger char in a non-first position", () => {
    const out = exportCsv([row({ title: "a=b-c+d@e" })]);
    expect(out.split("\r\n")[1]).toMatch(/^a=b-c\+d@e,/);
  });

  it("does not trim before checking: ' =x' (leading space) stays untouched", () => {
    // Spreadsheet apps treat whitespace-prefixed cells as text, so the cell is
    // already inert; escaping it would permanently add a ' on import.
    const out = exportCsv([row({ title: " =x" })]);
    expect(out.split("\r\n")[1]).toMatch(/^ =x,/);
  });
});

describe("parseCsv — header validation", () => {
  it("accepts the exact documented header", () => {
    const res = parseCsv(`${HEADER}\r\n`);
    expect(res).toEqual({ ok: true, rows: [], invalid: [] });
  });

  it("matches required columns by name, order-insensitive", () => {
    const res = parseCsv(
      "url,created,notes,category,tags,folder_path,title\n" +
        "https://x.y/,2026-01-15T10:30:00Z,n,docs,a;b,F/G,T\n",
    );
    expect(res).toEqual({
      ok: true,
      rows: [
        {
          title: "T",
          url: "https://x.y/",
          folderPath: "F/G",
          tags: ["a", "b"],
          category: "docs",
          notes: "n",
          created: "2026-01-15T10:30:00Z",
        },
      ],
      invalid: [],
    });
  });

  it("rejects a file missing a required column", () => {
    const res = parseCsv("title,folder_path,tags,category,notes,created\r\nx,,,,,\r\n");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("missing_columns");
      expect(res.message).toContain("url");
    }
  });

  it("lists every missing column in the failure message", () => {
    const res = parseCsv("title,url\nT,https://x.y/\n");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      for (const col of ["folder_path", "tags", "category", "notes", "created"]) {
        expect(res.message).toContain(col);
      }
    }
  });

  it.each(["", "   \n  ", "\uFEFF"])(
    "rejects effectively-empty input (%j) with code 'empty'",
    (text) => {
      const res = parseCsv(text);
      expect(res).toMatchObject({ ok: false, code: "empty" });
    },
  );

  it("strips a UTF-8 BOM before reading the header", () => {
    const res = parseCsv(`\uFEFF${HEADER}\nT,https://x.y/,,,,\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.title).toBe("T");
    }
  });

  it("rejects input above MAX_FILE_BYTES (too_large) before parsing", () => {
    // Same 20 MiB cap as the Netscape/JSON parsers — fires before any
    // record decoding, so the body needs no valid rows.
    const res = parseCsv(`${HEADER}\r\n${"x".repeat(MAX_FILE_BYTES)}`);
    expect(res).toMatchObject({ ok: false, code: "too_large" });
  });

  it("ignores extra unknown columns and maps by name", () => {
    const res = parseCsv(
      "title,url,rating,folder_path,tags,category,notes,created,extra\n" +
        "T,https://x.y/,5,F,a,docs,n,2026-01-15T10:30:00Z,z\n",
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]).toEqual({
        title: "T",
        url: "https://x.y/",
        folderPath: "F",
        tags: ["a"],
        category: "docs",
        notes: "n",
        created: "2026-01-15T10:30:00Z",
      });
      expect(res.invalid).toEqual([]);
    }
  });
});

describe("parseCsv — record decoding", () => {
  it("decodes a simple CRLF record", () => {
    const res = parseCsv(
      `${HEADER}\r\nT,https://x.y/,Work/Docs,a;b,docs,note,2026-01-15T10:30:00Z\r\n`,
    );
    expect(res).toEqual({
      ok: true,
      rows: [
        {
          title: "T",
          url: "https://x.y/",
          folderPath: "Work/Docs",
          tags: ["a", "b"],
          category: "docs",
          notes: "note",
          created: "2026-01-15T10:30:00Z",
        },
      ],
      invalid: [],
    });
  });

  it("accepts LF-only line endings", () => {
    const res = parseCsv(`${HEADER}\nT,https://x.y/,,,,\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.rows).toHaveLength(1);
  });

  it("handles a quoted cell with embedded comma, quotes and newline", () => {
    const res = parseCsv(
      `${HEADER}\r\n"Big, ""Quoted""\nTitle",https://x.y/,,,,\r\n`,
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.title).toBe('Big, "Quoted"\nTitle');
    }
  });

  it("skips blank lines without counting them invalid", () => {
    const res = parseCsv(
      `${HEADER}\r\n\r\nT,https://x.y/,,,,\r\n   \r\n`,
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows).toHaveLength(1);
      expect(res.invalid).toEqual([]);
    }
  });

  it("tolerates records with fewer cells than the header", () => {
    const res = parseCsv(`${HEADER}\nT,https://x.y/\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]).toEqual({
        title: "T",
        url: "https://x.y/",
        folderPath: "",
        tags: [],
      });
    }
  });

  it("flags records with more cells than the header as invalid", () => {
    const res = parseCsv(`${HEADER}\nT,https://x.y/,,,,,,extra\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows).toEqual([]);
      expect(res.invalid).toEqual([
        { row: 2, reason: expect.stringContaining("cells") },
      ]);
    }
  });

  it("flags an unterminated quoted field without aborting the parse", () => {
    const res = parseCsv(
      `${HEADER}\nT,https://x.y/,,,,\n"unclosed,https://y.z/,,,,\n`,
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows).toHaveLength(1);
      expect(res.invalid).toEqual([
        { row: 3, reason: expect.stringContaining("unterminated") },
      ]);
    }
  });

  it("flags stray content after a closing quote", () => {
    const res = parseCsv(`${HEADER}\n"T"abc,https://x.y/,,,,\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toEqual([
        { row: 2, reason: expect.stringContaining("quote") },
      ]);
    }
  });

  it("splits tags on ';', trims each, and drops empties", () => {
    const res = parseCsv(`${HEADER}\nT,https://x.y/,," a ; ;b ;; ",,,\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.tags).toEqual(["a", "b"]);
    }
  });

  it("keeps the formula-escape ' on import (no stripping)", () => {
    // Locked decision: the apostrophe stays in the stored value so imported
    // data can never become a live formula via any other export path, and a
    // strip heuristic could not distinguish our escape from a user's literal
    // leading apostrophe.
    const res = parseCsv(`${HEADER}\n'=1+1,https://x.y/,,,,\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.title).toBe("'=1+1");
    }
  });
});

describe("parseCsv — per-row validation", () => {
  function parseOne(dataRecord: string) {
    return parseCsv(`${HEADER}\r\n${dataRecord}\r\n`);
  }

  it("counts invalid rows with their 1-based record number (header = row 1)", () => {
    const res = parseCsv(
      `${HEADER}\r\n` +
        "good,https://a.b/,,,,\r\n" +
        "bad,not a url,,,,\r\n" +
        "also good,https://c.d/,,,,\r\n" +
        ",,,,,\r\n",
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows.map((r) => r.title)).toEqual(["good", "also good"]);
      expect(res.invalid).toEqual([
        { row: 3, reason: expect.stringContaining("url") },
        { row: 5, reason: expect.stringContaining("url") },
      ]);
    }
  });

  it("rejects a missing url", () => {
    const res = parseOne("T,,,,,");
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toEqual([
        { row: 2, reason: expect.stringContaining("url") },
      ]);
    }
  });

  it.each(["not a url", "example.com", "https://", "%%%"])(
    "rejects unparseable url %j",
    (url) => {
      const res = parseOne(`T,${url},,,,`);
      expect(res).toMatchObject({ ok: true });
      if (res.ok) {
        expect(res.rows).toEqual([]);
        expect(res.invalid).toHaveLength(1);
      }
    },
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    "JAVASCRIPT:alert(1)",
    "chrome://extensions/",
    "file:///tmp/x",
    "ftp://example.com/f",
    "mailto:a@b.c",
  ])("rejects non-http(s) url %j", (url) => {
    const res = parseOne(`T,${url},,,,`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows).toEqual([]);
      expect(res.invalid).toEqual([
        { row: 2, reason: expect.stringContaining("http") },
      ]);
    }
  });

  it("trims surrounding whitespace on url before validating", () => {
    const res = parseOne(`T," https://x.y/ ",,,,`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.url).toBe("https://x.y/");
    }
  });

  it("accepts every Category value and empty", () => {
    for (const category of [
      "article",
      "docs",
      "tool",
      "video",
      "repo",
      "reference",
      "shopping",
      "social",
      "other",
      "",
    ]) {
      const res = parseOne(`T,https://x.y/,,,${category},`);
      expect(res).toMatchObject({ ok: true });
      if (res.ok) {
        expect(res.invalid).toEqual([]);
        expect(res.rows[0]?.category).toBe(
          category === "" ? undefined : category,
        );
      }
    }
  });

  it.each(["invalid_cat", "DOCS ", "=cmd"])(
    "rejects invalid category %j",
    (category) => {
      const res = parseOne(`T,https://x.y/,,,${category},`);
      expect(res).toMatchObject({ ok: true });
      if (res.ok) {
        expect(res.rows).toEqual([]);
        expect(res.invalid).toEqual([
          { row: 2, reason: expect.stringContaining("category") },
        ]);
      }
    },
  );

  it.each([
    "2026-01-15T10:30:00Z",
    "2026-01-15T10:30:00.123Z",
    "2026-01-15T10:30:00+02:00",
    "2026-01-15T10:30:00",
    "2026-01-15",
    "",
  ])("accepts ISO created %j", (created) => {
    const res = parseOne(`T,https://x.y/,,,,,${created}`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toEqual([]);
      expect(res.rows[0]?.created).toBe(
        created === "" ? undefined : created,
      );
    }
  });

  it.each(["yesterday", "2026-13-99", "Jan 1 2026", "2026/01/15"])(
    "rejects non-ISO created %j",
    (created) => {
      const res = parseOne(`T,https://x.y/,,,,,${created}`);
      expect(res).toMatchObject({ ok: true });
      if (res.ok) {
        expect(res.rows).toEqual([]);
        expect(res.invalid).toEqual([
          { row: 2, reason: expect.stringContaining("created") },
        ]);
      }
    },
  );

  it("keeps title, notes and folder_path verbatim but trims folder_path ends", () => {
    const res = parseOne('"  T  ","https://x.y/"," Work/Docs ",,"docs","  n  ",""');
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.title).toBe("  T  ");
      expect(res.rows[0]?.notes).toBe("  n  ");
      expect(res.rows[0]?.folderPath).toBe("Work/Docs");
    }
  });

  it("never fails the whole file because one row is invalid", () => {
    const res = parseCsv(
      `${HEADER}\n` +
        "bad1,javascript:x,,,,\n" +
        "ok,https://a.b/,,,,\n" +
        "bad2,https://c.d/,,,nope,\n" +
        "bad3,https://e.f/,,,,,notadate\n",
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows).toHaveLength(1);
      expect(res.invalid).toHaveLength(3);
      expect(res.invalid.map((i) => i.row)).toEqual([2, 4, 5]);
    }
  });
});

describe("round-trip", () => {
  it("export → parse preserves ordinary rows", () => {
    const rows: CsvBookmarkRow[] = [
      row({
        title: 'Comma, "quote" and\nnewline',
        url: "https://example.com/a?b=1,c=2",
        folderPath: "Work/Docs",
        tags: ["one", "two"],
        category: "article",
        notes: "multi\nline\nnotes",
        created: "2026-01-15T10:30:00Z",
      }),
      row({ title: "", url: "https://minimal.example/" }),
    ];
    const out = exportCsv(rows);
    const res = parseCsv(out);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toEqual([]);
      expect(res.rows).toEqual(rows);
    }
  });

  it("escape ' survives a round trip instead of being stripped", () => {
    const res = parseCsv(exportCsv([row({ title: "=SUM(1,2)" })]));
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows[0]?.title).toBe("'=SUM(1,2)");
      // Re-exporting keeps the stored (inert) value byte-stable.
      expect(exportCsv(res.rows)).toContain("'=SUM(1,2)");
    }
  });
});
