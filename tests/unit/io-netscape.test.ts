import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_URL_SCHEMES,
  MAX_FILE_BYTES,
  exportNetscape,
  parseNetscape,
} from "../../src/io/netscape";
import type {
  ExportableNode,
  NetscapeFolder,
  NetscapeNode,
  NetscapeParseResult,
} from "../../src/io/netscape";

/**
 * Coverage for `src/io/netscape.ts` — Netscape bookmark-file export and import
 * parsing. HTML fixtures live in `tests/fixtures/netscape/` and are read from
 * disk so they stay byte-for-byte realistic; `parseNetscape` is exercised in
 * the jsdom DOMParser environment.
 */

// Vitest runs with cwd at the project root; fixture paths resolve from there
// (import.meta.url is rewritten by the vite transform and is not a file: URL).
const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/netscape");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf8");
}

function ok(result: NetscapeParseResult) {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${result.code}: ${result.message}`);
  }
  return result;
}

function folder(node: NetscapeNode | undefined): NetscapeFolder {
  if (node === undefined || node.kind !== "folder") {
    throw new Error("expected a folder node");
  }
  return node;
}

describe("exportNetscape output shape", () => {
  it("emits the Netscape header, META, TITLE, H1, and a root DL", () => {
    const out = exportNetscape([]);
    expect(out).toContain("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
    expect(out).toContain("<META HTTP-EQUIV=");
    expect(out).toContain("<TITLE>Bookmarks</TITLE>");
    expect(out).toContain("<H1>Bookmarks</H1>");
    expect(out).toContain("<DL><p>");
    expect(out).toContain("</DL><p>");
  });

  it("nests folders as <DT><H3 …> followed by a child <DL>", () => {
    const out = exportNetscape([
      {
        title: "Folder",
        dateAdded: 1_700_000_000_000,
        dateGroupModified: 1_700_000_100_000,
        children: [
          { title: "Leaf", url: "https://leaf.example/", dateAdded: 1_700_000_200_000 },
        ],
      },
    ]);
    expect(out).toContain(
      '<DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000100">Folder</H3>',
    );
    expect(out).toContain(
      '<DT><A HREF="https://leaf.example/" ADD_DATE="1700000200">Leaf</A>',
    );
    // The child DL must appear after the folder's DT line.
    const h3 = out.indexOf("<H3");
    const innerDl = out.indexOf("<DL><p>", h3);
    expect(innerDl).toBeGreaterThan(h3);
  });

  it("writes ADD_DATE as Unix seconds and TAGS as a comma-joined attribute", () => {
    const out = exportNetscape([
      {
        title: "Tagged",
        url: "https://t.example/",
        dateAdded: 1_700_000_400_000,
        tags: ["alpha", "beta"],
      },
    ]);
    expect(out).toContain(
      '<DT><A HREF="https://t.example/" ADD_DATE="1700000400" TAGS="alpha,beta">Tagged</A>',
    );
  });

  it("omits ADD_DATE/TAGS attributes when the fields are absent", () => {
    const out = exportNetscape([{ title: "Bare", url: "https://bare.example/" }]);
    const line = out
      .split("\n")
      .find((l) => l.includes("https://bare.example/"));
    expect(line?.trim()).toBe(
      '<DT><A HREF="https://bare.example/">Bare</A>',
    );
  });

  it("uses the supplied heading and escapes it", () => {
    const out = exportNetscape([], 'Mine & <yours>');
    expect(out).toContain("<H1>Mine &amp; &lt;yours&gt;</H1>");
  });
});

describe("exportNetscape escaping", () => {
  const tricky: ExportableNode[] = [
    {
      title: 'Folder & <Co> "x"',
      children: [
        {
          title: 'B "q" & <i>',
          url: 'https://e.example/?a=1&b=<x>"y"',
          tags: ["t&1", "<t2>"],
        },
      ],
    },
  ];

  it("escapes & < > \" in H3 text, A text, HREF, and TAGS", () => {
    const out = exportNetscape(tricky);
    expect(out).toContain("<H3>Folder &amp; &lt;Co&gt; &quot;x&quot;</H3>");
    expect(out).toContain(
      'HREF="https://e.example/?a=1&amp;b=&lt;x&gt;&quot;y&quot;"',
    );
    expect(out).toContain('TAGS="t&amp;1,&lt;t2&gt;"');
    expect(out).toContain('>B &quot;q&quot; &amp; &lt;i&gt;</A>');
    // No raw ampersand or angle bracket may survive inside emitted values.
    expect(out).not.toContain('a=1&b=');
    expect(out).not.toContain("<Co>");
  });

  it("round-trips through parseNetscape with original titles, urls, and tags", () => {
    const nodes: ExportableNode[] = [
      {
        title: "F & 1",
        dateAdded: 1_700_000_000_000,
        children: [
          {
            title: "B <b>",
            url: "https://b.example/?x=1&y=2",
            dateAdded: 1_700_000_100_000,
            tags: ["a", "b"],
          },
        ],
      },
      { title: "Top", url: "https://top.example/" },
    ];
    const result = ok(parseNetscape(exportNetscape(nodes)));
    const f = folder(result.tree[0]);
    expect(f.title).toBe("F & 1");
    expect(f.addDate).toBe(1_700_000_000);
    const inner = f.children[0];
    expect(inner).toMatchObject({
      kind: "bookmark",
      title: "B <b>",
      url: "https://b.example/?x=1&y=2",
      addDate: 1_700_000_100,
      tags: ["a", "b"],
    });
    expect(result.tree[1]).toMatchObject({
      kind: "bookmark",
      title: "Top",
      url: "https://top.example/",
    });
    expect(result.stats).toEqual({
      folders: 1,
      bookmarks: 2,
      skipped: 0,
      invalid: 0,
    });
  });
});

describe("parseNetscape Chrome-style fixture", () => {
  const result = () => ok(parseNetscape(fixture("chrome.html")));

  it("parses nested folders into a typed tree", () => {
    const { tree } = result();
    expect(tree).toHaveLength(2);
    const bar = folder(tree[0]);
    expect(bar.title).toBe("Bookmarks bar");
    expect(bar.addDate).toBe(1_700_000_000);
    expect(bar.lastModified).toBe(1_700_000_100);

    const work = folder(bar.children[0]);
    expect(work.title).toBe("Work");
    expect(work.children.map((n) => n.title)).toEqual([
      "Example & Co.",
      "Deep <Link>",
      "Empty folder",
    ]);
    expect(folder(work.children[2]).children).toEqual([]);
    expect(bar.children[1]).toMatchObject({
      kind: "bookmark",
      title: "Bar",
      url: "https://bar.example/",
    });
    expect(folder(tree[1]).title).toBe("Other bookmarks");
  });

  it("decodes HTML entities in titles, hrefs, and TAGS", () => {
    const { tree } = result();
    const work = folder(folder(tree[0]).children[0]);
    const example = work.children[0];
    expect(example).toMatchObject({
      title: "Example & Co.",
      url: "https://example.com/?a=1&b=2",
      tags: ["work", "reference"],
    });
    const other = folder(tree[1]);
    // &#98; decodes to "b" inside the TAGS attribute.
    expect(other.children[0]).toMatchObject({ tags: ["misc", "beta"] });
  });

  it("collects ADD_DATE/LAST_MODIFIED as numbers", () => {
    const { tree } = result();
    const work = folder(folder(tree[0]).children[0]);
    expect(work.addDate).toBe(1_700_000_200);
    expect(work.lastModified).toBe(1_700_000_300);
    expect(work.children[0]).toMatchObject({ addDate: 1_700_000_400 });
  });

  it("reports exact stats for folders, bookmarks, skipped, and invalid", () => {
    expect(result().stats).toEqual({
      folders: 4,
      bookmarks: 4,
      skipped: 4,
      invalid: 2,
    });
  });

  it("drops blocked-scheme rows from the tree entirely", () => {
    const { tree } = result();
    const titles = JSON.stringify(tree);
    expect(titles).not.toContain("javascript:");
    expect(titles).not.toContain("DATA:");
    expect(titles).not.toContain("vbscript:");
    expect(titles).not.toContain("Evil JS");
    expect(titles).not.toContain("Tab JS");
  });
});

describe("parseNetscape Firefox-style fixture", () => {
  it("parses Places-style markup and ignores Firefox-only attributes", () => {
    const { tree, stats } = ok(parseNetscape(fixture("firefox.html")));
    expect(stats).toEqual({ folders: 2, bookmarks: 3, skipped: 0, invalid: 0 });
    const toolbar = folder(tree[0]);
    expect(toolbar.title).toBe("Bookmarks Toolbar");
    expect(toolbar.children[0]).toMatchObject({
      kind: "bookmark",
      title: "Mozilla",
      url: "https://mozilla.example/",
      addDate: 1_690_000_200,
    });
    // &quot; inside an H3 decodes to a literal quote.
    const sub = folder(toolbar.children[1]);
    expect(sub.title).toBe('Sub "Folder"');
    expect(sub.children[0]).toMatchObject({
      title: "Inner",
      tags: ["fx", "test"],
    });
    // An <HR> separator is ignored; the trailing bookmark stays top-level.
    expect(tree[1]).toMatchObject({
      kind: "bookmark",
      title: "Top level",
      url: "https://menu.example/",
    });
  });
});

describe("parseNetscape malformed markup", () => {
  it("does not throw and recovers a usable tree with counts", () => {
    const result = parseNetscape(fixture("malformed.html"));
    expect(result.ok).toBe(true);
    const { tree, stats } = ok(result);
    const root = folder(tree[0]);
    expect(root.title).toBe("Unclosed folder");
    expect(root.children.map((n) => n.title)).toEqual([
      "OK link",
      "Second",
      "After",
      "Orphan",
    ]);
    expect(stats.folders).toBe(1);
    expect(stats.bookmarks).toBe(4);
    // The <A HREF=""> row is invalid; the bare text <DT> is ignored.
    expect(stats.invalid).toBe(1);
    expect(stats.skipped).toBe(0);
  });
});

describe("parseNetscape scheme filtering", () => {
  function parseOne(href: string) {
    return ok(
      parseNetscape(
        `<DL><p><DT><A HREF="${href}">x</A></DL><p>`,
      ),
    );
  }

  it("skips javascript:, data:, and vbscript: case-insensitively", () => {
    for (const href of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html;base64,AAAA",
      "Data:,x",
      "vbscript:msgbox(1)",
      "VBSCRIPT:x",
    ]) {
      const { tree, stats } = parseOne(href);
      expect(tree, href).toEqual([]);
      expect(stats.skipped, href).toBe(1);
      expect(stats.bookmarks, href).toBe(0);
    }
  });

  it("skips obfuscated schemes with whitespace/control characters", () => {
    for (const href of [
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "\tDATA:x",
    ]) {
      const { stats } = parseOne(href);
      expect(stats.skipped, JSON.stringify(href)).toBe(1);
    }
  });

  it("keeps ordinary schemes including http, https, ftp, and file", () => {
    for (const href of [
      "https://a.example/",
      "http://b.example/",
      "ftp://c.example/",
      "file:///d",
    ]) {
      const { tree, stats } = parseOne(href);
      expect(stats.bookmarks, href).toBe(1);
      expect(tree[0]).toMatchObject({ url: href });
    }
  });

  it("counts anchors with missing or empty HREF as invalid", () => {
    const { stats, tree } = ok(
      parseNetscape(
        '<DL><p><DT><A>no href</A><DT><A HREF="">empty</A><DT><A HREF="   ">blank</A></DL><p>',
      ),
    );
    expect(stats.invalid).toBe(3);
    expect(stats.bookmarks).toBe(0);
    expect(tree).toEqual([]);
  });
});

describe("parseNetscape input rejection", () => {
  it("fails with too_large above MAX_FILE_BYTES (20 MiB)", () => {
    expect(MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    const big = `<DL>${"x".repeat(MAX_FILE_BYTES)}`;
    const result = parseNetscape(big);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("too_large");
      expect(result.message).toContain("20");
    }
  });

  it("fails with not_netscape for inputs that contain no HTML elements", () => {
    for (const input of ["", "   \n\t  ", "just some plain text", '{"a":1}']) {
      const result = parseNetscape(input);
      expect(result.ok, JSON.stringify(input.slice(0, 20))).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("not_netscape");
      }
    }
  });

  it("returns ok with an empty tree for HTML that simply has no DL", () => {
    const result = ok(
      parseNetscape("<html><body><p>not a bookmark file</p></body></html>"),
    );
    expect(result.tree).toEqual([]);
    expect(result.stats).toEqual({
      folders: 0,
      bookmarks: 0,
      skipped: 0,
      invalid: 0,
    });
  });
});

describe("parseNetscape safety surface", () => {
  it("exports the documented blocked-scheme list", () => {
    expect([...BLOCKED_URL_SCHEMES].sort()).toEqual([
      "data",
      "javascript",
      "vbscript",
    ]);
  });

  it("never uses innerHTML — the module source is DOMParser-only", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "src/io/netscape.ts"),
      "utf8",
    );
    expect(src).not.toContain("innerHTML");
    expect(src).toContain("DOMParser");
  });
});
