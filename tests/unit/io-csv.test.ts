import { describe, expect, it } from "vitest";
import {
  CSV_COLUMNS,
  CSV_HEADER,
  TAG_SEPARATOR,
  exportCsv,
  joinFolderPath,
  parseCsv,
  splitFolderPath,
  splitTags,
  type CsvBookmarkRow,
} from "../../src/io/csv";
import { MAX_FILE_BYTES } from "../../src/io/netscape";

// Contract under test (documented in src/io/csv.ts):
//  - Columns, exact header: title,url,folder_path,tags,category,notes,created
//  - Records separated by CRLF; file ends with CRLF.
//  - RFC 4180 quoting: cells containing `"` `,` CR or LF are wrapped in `"`;
//    internal `"` is doubled.
//  - Formula-injection escape: a cell whose FIRST raw char is one of
//    = + - @ TAB CR gets a leading `'` BEFORE quoting.
//  - Import strips ONE leading `'` only when followed by a formula trigger —
//    the exact inverse of the export escape (D15-style paired policy).
//  - `folder_path` segments and tag names carry `\`-escapes for their
//    wire delimiters (`/` and `;`) so `/`-in-title round-trips.
//  - An unterminated `"` reports its own record and re-parses the rest of
//    the file as fresh records instead of swallowing them.

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
  it("exports the documented constants and header structure", () => {
    expect(CSV_HEADER).toBe(HEADER);
    expect([...CSV_COLUMNS]).toEqual(HEADER.split(","));
    expect(TAG_SEPARATOR).toBe(";");

    const out = exportCsv([row()]);
    expect(out.split("\r\n")[0]).toBe(HEADER);

    const outTwo = exportCsv([row(), row({ title: "Two" })]);
    expect(outTwo.endsWith("\r\n")).toBe(true);
    expect(outTwo.split("\r\n")).toHaveLength(4);
    expect(outTwo).not.toContain("\n\r");
    expect(exportCsv([])).toBe(`${HEADER}\r\n`);
  });

  it("emits all seven columns in header order and writes empty cells for optional fields", () => {
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

    const emptyRow = exportCsv([row()]);
    expect(emptyRow.split("\r\n")[1]).toBe("Example,https://example.com/,,,,,");
  });
});

describe("exportCsv — RFC 4180 quoting", () => {
  it("handles quoting rules for plain, spaced, comma, quote, and newline cells", () => {
    expect(exportCsv([row({ title: "plain title" })]).split("\r\n")[1]).toMatch(/^plain title,/);
    expect(exportCsv([row({ title: "  padded  " })]).split("\r\n")[1]).toMatch(/^ {2}padded {2},/);
    expect(exportCsv([row({ title: "a,b" })]).split("\r\n")[1]).toMatch(/^"a,b",/);
    expect(exportCsv([row({ title: 'say "hi"' })]).split("\r\n")[1]).toMatch(/^"say ""hi""",/);

    for (const cell of ["line1\nline2", "cell\rmid", "a\r\nb"]) {
      const out = exportCsv([row({ title: cell })]);
      const parsed = parseCsv(out);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.rows[0]?.title).toBe(cell);
      }
    }
  });
});

describe("exportCsv — formula-injection escaping", () => {
  it("prefixes trigger characters with ' before quoting", () => {
    for (const ch of ["=", "+", "-", "@", "\t", "\r"]) {
      const out = exportCsv([row({ title: `${ch}payload` })]);
      const firstCell = out.split("\r\n")[1]?.split(",")[0];
      expect(firstCell?.startsWith('"')).toBe(ch === "\r");
      expect(firstCell).toContain(`'${ch}payload`);
      expect(parseCsv(out)).toMatchObject({ ok: true });
    }
  });

  it("handles trigger chars across columns and avoids escaping non-trigger locations", () => {
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
    expect(record).toContain("https://example.com/");

    expect(exportCsv([row({ title: "=a,b" })]).split("\r\n")[1]).toMatch(/^"'=a,b",/);
    expect(exportCsv([row({ title: "a=b-c+d@e" })]).split("\r\n")[1]).toMatch(/^a=b-c\+d@e,/);
    expect(exportCsv([row({ title: " =x" })]).split("\r\n")[1]).toMatch(/^ =x,/);
  });
});

describe("parseCsv — header validation", () => {
  it("validates headers, handles BOM, and enforces size limit", () => {
    expect(parseCsv(`${HEADER}\r\n`)).toEqual({ ok: true, rows: [], invalid: [] });

    const reordered = parseCsv(
      "url,created,notes,category,tags,folder_path,title\n" +
        "https://x.y/,2026-01-15T10:30:00Z,n,docs,a;b,F/G,T\n",
    );
    expect(reordered.ok).toBe(true);

    const missingCol = parseCsv("title,folder_path,tags,category,notes,created\r\nx,,,,,\r\n");
    expect(missingCol.ok).toBe(false);

    for (const emptyText of ["", "   \n  ", "\uFEFF"]) {
      expect(parseCsv(emptyText)).toMatchObject({ ok: false, code: "empty" });
    }

    const bom = parseCsv(`\uFEFF${HEADER}\nT,https://x.y/,,,,\n`);
    expect(bom).toMatchObject({ ok: true });

    const tooLarge = parseCsv(`${HEADER}\r\n${"x".repeat(MAX_FILE_BYTES)}`);
    expect(tooLarge).toMatchObject({ ok: false, code: "too_large" });

    const extra = parseCsv(
      "title,url,rating,folder_path,tags,category,notes,created,extra\n" +
        "T,https://x.y/,5,F,a,docs,n,2026-01-15T10:30:00Z,z\n",
    );
    expect(extra).toMatchObject({ ok: true });
  });
});

describe("parseCsv — record decoding", () => {
  it("decodes CRLF and LF records with embedded formatting and skips blank lines", () => {
    const res = parseCsv(
      `${HEADER}\r\n` +
        `\r\n` +
        `T,https://x.y/,Work/Docs,a;b,docs,note,2026-01-15T10:30:00Z\r\n` +
        `"Big, ""Quoted""\nTitle",https://x.y/,,,,\r\n` +
        `   \r\n`,
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.rows).toHaveLength(2);
      expect(res.rows[0]?.title).toBe("T");
      expect(res.rows[0]?.tags).toEqual(["a", "b"]);
      expect(res.rows[1]?.title).toBe('Big, "Quoted"\nTitle');
      expect(res.invalid).toEqual([]);
    }
  });

  it("handles cell counts, unterminated quotes, tag splits, and escapes", () => {
    const fewer = parseCsv(`${HEADER}\nT,https://x.y/\n`);
    expect(fewer).toMatchObject({ ok: true });
    if (fewer.ok) expect(fewer.rows[0]?.title).toBe("T");

    const extra = parseCsv(`${HEADER}\nT,https://x.y/,,,,,,extra\n`);
    expect(extra).toMatchObject({ ok: true });
    if (extra.ok) expect(extra.invalid).toHaveLength(1);

    const unclosed = parseCsv(`${HEADER}\nT,https://x.y/,,,,\n"unclosed,https://y.z/,,,,\n`);
    expect(unclosed).toMatchObject({ ok: true });
    if (unclosed.ok) expect(unclosed.invalid).toHaveLength(1);

    const stray = parseCsv(`${HEADER}\n"T"abc,https://x.y/,,,,\n`);
    expect(stray).toMatchObject({ ok: true });
    if (stray.ok) expect(stray.invalid).toHaveLength(1);

    const tags = parseCsv(`${HEADER}\nT,https://x.y/,," a ; ;b ;; ",,,\n`);
    expect(tags).toMatchObject({ ok: true });
    if (tags.ok) expect(tags.rows[0]?.tags).toEqual(["a", "b"]);

    // I05: a `'` ahead of a formula trigger is the export escape and is
    // stripped on import — foreign `'=x` data loses the escape too (an
    // apostrophe followed by a trigger was never distinguishable from it).
    const formula = parseCsv(`${HEADER}\n'=1+1,https://x.y/,,,,\n`);
    expect(formula).toMatchObject({ ok: true });
    if (formula.ok) expect(formula.rows[0]?.title).toBe("=1+1");

    // But a `'` NOT ahead of a trigger is literal data and stays.
    const literal = parseCsv(`${HEADER}\n'quoted title,https://x.y/,,,,\n',https://x.y/,,,,\n`);
    expect(literal).toMatchObject({ ok: true });
    if (literal.ok) {
      expect(literal.rows[0]?.title).toBe("'quoted title");
      expect(literal.rows[1]?.title).toBe("'");
    }
  });
});

describe("parseCsv — per-row validation", () => {
  function parseOne(dataRecord: string) {
    const res = parseCsv(`${HEADER}\r\n${dataRecord}\r\n`);
    if (!res.ok) throw new Error(`Unexpected parse failure: ${res.code}`);
    return res;
  }

  it("validates URLs: rejects missing, unparseable, and non-http(s) schemes", () => {
    expect(parseOne("T,,,,,").invalid).toHaveLength(1);

    for (const url of ["not a url", "example.com", "https://", "%%%"]) {
      const res = parseOne(`T,${url},,,,`);
      expect(res.invalid).toHaveLength(1);
    }

    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "JAVASCRIPT:alert(1)",
      "chrome://extensions/",
      "file:///tmp/x",
      "ftp://example.com/f",
      "mailto:a@b.c",
    ]) {
      const res = parseOne(`T,${url},,,,`);
      expect(res.invalid).toHaveLength(1);
    }

    const trimmed = parseOne(`T," https://x.y/ ",,,,`);
    expect(trimmed.rows[0]?.url).toBe("https://x.y/");
  });

  it("validates categories, dates, and whitespace handling", () => {
    for (const cat of ["article", "docs", "tool", "video", "repo", "reference", "shopping", "social", "other", ""]) {
      const res = parseOne(`T,https://x.y/,,,${cat},`);
      expect(res.invalid).toEqual([]);
      expect(res.rows[0]?.category).toBe(cat === "" ? undefined : cat);
    }

    for (const badCat of ["invalid_cat", "DOCS ", "=cmd"]) {
      expect(parseOne(`T,https://x.y/,,,${badCat},`).invalid).toHaveLength(1);
    }

    for (const d of ["2026-01-15T10:30:00Z", "2026-01-15T10:30:00.123Z", "2026-01-15T10:30:00+02:00", "2026-01-15", ""]) {
      expect(parseOne(`T,https://x.y/,,,,,${d}`).invalid).toEqual([]);
    }

    for (const badDate of ["yesterday", "2026-13-99", "Jan 1 2026", "2026/01/15"]) {
      expect(parseOne(`T,https://x.y/,,,,,${badDate}`).invalid).toHaveLength(1);
    }

    const trimmedFields = parseOne('"  T  ","https://x.y/"," Work/Docs ",,"docs","  n  ",""');
    expect(trimmedFields.rows[0]?.title).toBe("  T  ");
    expect(trimmedFields.rows[0]?.folderPath).toBe("Work/Docs");

    const multi = parseCsv(
      `${HEADER}\n` +
        "bad1,javascript:x,,,,\n" +
        "ok,https://a.b/,,,,\n" +
        "bad2,https://c.d/,,,nope,\n",
    );
    if (!multi.ok) throw new Error("Unexpected parse failure");
    expect(multi.rows).toHaveLength(1);
    expect(multi.invalid).toHaveLength(2);
  });
});

describe("I05 — formula-escape round trip", () => {
  it("export → parse restores `-5 degrees`, `+1 tip`, `@handle` verbatim", () => {
    const rows: CsvBookmarkRow[] = [
      row({ title: "-5 degrees", notes: "+1 tip", tags: ["@handle", "-x"] }),
      row({ title: "+1 tip" }),
      row({ title: "@handle" }),
    ];
    const res = parseCsv(exportCsv(rows));
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toEqual([]);
      expect(res.rows).toEqual(rows);
    }
  });
});

describe("I05 — unterminated quote recovery", () => {
  it("reports the broken record and recovers the following records", () => {
    const res = parseCsv(
      `${HEADER}\n` +
        `T,https://x.y/,,,,\n` +
        `"unclosed title,https://y.z/,,,,\n` +
        `Recovered,https://r.e/,,,,\n` +
        `Last,https://l.st/,,,,\n`,
    );
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      // The unterminated record is reported...
      expect(res.invalid).toHaveLength(1);
      expect(res.invalid[0]?.reason).toContain("unterminated quoted field");
      expect(res.invalid[0]?.reason).toContain("recovered");
      // ...and the two rows it would have swallowed parse normally.
      expect(res.rows.map((r) => r.title)).toEqual([
        "T",
        "Recovered",
        "Last",
      ]);
      expect(res.rows[1]?.url).toBe("https://r.e/");
    }
  });

  it("a trailing unterminated quote with no newline still reports plainly", () => {
    const res = parseCsv(`${HEADER}\n"unclosed,https://y.z/,,,,\n`);
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toHaveLength(1);
      expect(res.invalid[0]?.reason).toBe("unterminated quoted field");
      expect(res.rows).toHaveLength(0);
    }
  });
});

describe("I05 — delimiter escaping in folder_path and tags", () => {
  it("joinFolderPath/splitFolderPath round-trip `/` and `\\` in titles", () => {
    expect(splitFolderPath(joinFolderPath(["A/B", "C"]))).toEqual(["A/B", "C"]);
    expect(splitFolderPath(joinFolderPath(["a\\b"]))).toEqual(["a\\b"]);
    expect(joinFolderPath(["A/B"])).toBe("A\\/B");
    // Legacy hand-written files still split on raw `/`.
    expect(splitFolderPath("W/D")).toEqual(["W", "D"]);
    // A `\` before a non-delimiter is kept literally (forward-compatible).
    expect(splitFolderPath("a\\nb")).toEqual(["a\\nb"]);
    expect(splitFolderPath("")).toEqual([]);
  });

  it("splitTags unescapes `\\;` and `\\\\`, raw `;` still separates", () => {
    expect(splitTags("a;b")).toEqual(["a", "b"]);
    expect(splitTags("a\\;b")).toEqual(["a;b"]);
    expect(splitTags("x\\;y;z")).toEqual(["x;y", "z"]);
    expect(splitTags("")).toEqual([]);
  });

  it("export → parse round-trips folder and tag text containing `/`, `;`, `\\`", () => {
    const wire = row({
      folderPath: joinFolderPath(["Work/Docs", "Q\\A"]),
      tags: ["x;y", "a\\b", "plain"],
    });
    const res = parseCsv(exportCsv([wire]));
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.invalid).toEqual([]);
      expect(res.rows[0]?.folderPath).toBe("Work\\/Docs/Q\\\\A");
      expect(splitFolderPath(res.rows[0]?.folderPath ?? "")).toEqual([
        "Work/Docs",
        "Q\\A",
      ]);
      expect(res.rows[0]?.tags).toEqual(["x;y", "a\\b", "plain"]);
    }
  });
});

describe("round-trip", () => {
  it("export → parse preserves ordinary rows and escape '", () => {
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

    // I05: the formula escape is now undone on import — `=SUM(1,2)`
    // round-trips intact and re-exports with the same escape.
    const escRes = parseCsv(exportCsv([row({ title: "=SUM(1,2)" })]));
    expect(escRes).toMatchObject({ ok: true });
    if (escRes.ok) {
      expect(escRes.rows[0]?.title).toBe("=SUM(1,2)");
      expect(exportCsv(escRes.rows)).toContain("'=SUM(1,2)");
    }
  });
});
