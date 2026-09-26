import "fake-indexeddb/auto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "../../src/db/database";
import { createTag, getMeta, listTags } from "../../src/db/meta";
import { normalizeUrl } from "../../src/duplicates/normalize";
import { exportCsv, parseCsv } from "../../src/io/csv";
import { parseExport } from "../../src/io/export-json";
import {
  collectNormalizedUrls,
  fromCsvRows,
  fromEnvelope,
  fromNetscape,
  planImport,
} from "../../src/io/import-plan";
import type {
  ImportFolder,
  ImportItem,
  ImportMeta,
} from "../../src/io/import-plan";
import { importRootTitle, writeImport } from "../../src/io/import-write";
import { parseNetscape } from "../../src/io/netscape";
import type { TagDef } from "../../src/schemas/meta";
import { OTHER_BOOKMARKS_ID } from "../../src/sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { registerBookmarkListeners } from "../../src/sync/listeners";
import { removeTree } from "../../src/sync/mutations";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Coverage for `src/io/import-plan.ts` (pure planner + format adapters) and
 * `src/io/import-write.ts` (guarded writer).
 *
 * Contract under test (track spec §5):
 *  - Preview before any write: counts of folders, bookmarks, duplicates to
 *    skip, invalid rows. `planImport` is pure — it never touches chrome or
 *    the database.
 *  - Writes always land in a NEW `Imported <YYYY-MM-DD HH:mm>` folder under
 *    Other bookmarks ("2"); the file's own folder structure is preserved
 *    inside it.
 *  - Bookmarks whose NORMALIZED url already exists in the library are
 *    skipped; `importDuplicates` re-includes them.
 *  - JSON restores tags/categories/notes plus tag definitions; CSV restores
 *    tags/category/notes; HTML restores the TAGS attribute.
 *  - A summary comes back; undo is `removeTree(importRootId)` — meta rows
 *    are cascade-deleted by the Phase-1 onRemoved listener.
 */

// Deterministic local-time stamp for the import root title.
const IMPORT_NOW = new Date(2026, 5, 4, 9, 7); // 2026-06-04 09:07
const IMPORT_TITLE = "Imported 2026-06-04 09:07";

/** The seeded library bookmark — normalized to "existing.example/page". */
const EXISTING_URL = "https://existing.example/page";

let fake: FakeBookmarksApi;

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
    otherBookmarks: [
      { id: "existing", title: "Existing", url: EXISTING_URL },
    ],
  });
  await db.bookmarkMeta.clear();
  await db.tags.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function bm(title: string, url: string, meta?: ImportMeta): ImportItem {
  return { kind: "bookmark", title, url, ...(meta === undefined ? {} : { meta }) };
}

function dir(
  title: string,
  children: ImportItem[],
  meta?: ImportMeta,
): ImportItem {
  return {
    kind: "folder",
    title,
    children,
    ...(meta === undefined ? {} : { meta }),
  };
}

function asFolder(item: ImportItem | undefined): ImportFolder {
  if (item === undefined || item.kind !== "folder") {
    throw new Error("expected a folder item");
  }
  return item;
}

/** Plain nested {title,url,children} view of a fake subtree for toEqual. */
interface NodeShape {
  title: string;
  url?: string;
  children?: NodeShape[];
}

function shape(node: BookmarksTreeNode): NodeShape {
  const out: NodeShape = { title: node.title };
  if (node.url !== undefined) out.url = node.url;
  if (node.children !== undefined) out.children = node.children.map(shape);
  return out;
}

async function subtree(id: string): Promise<BookmarksTreeNode> {
  const [root] = await fake.getSubTree(id);
  expect(root).toBeDefined();
  return root as BookmarksTreeNode;
}

/** Depth-first id list of a subtree — the cascade-delete domain. */
function subtreeIds(node: BookmarksTreeNode, into: string[] = []): string[] {
  into.push(node.id);
  for (const child of node.children ?? []) subtreeIds(child, into);
  return into;
}

/** The one v1 envelope used by the JSON end-to-end tests. */
function envelopeJson(): string {
  return JSON.stringify({
    version: 1,
    exportedAt: "2026-09-26T12:00:00.000Z",
    tree: [
      {
        id: "ef",
        title: "Work",
        children: [
          { id: "ea", title: "A", url: "https://a.example/" },
          { id: "eb", title: "B", url: "https://b.example/" },
        ],
      },
      { id: "et", title: "Top", url: "https://top.example/" },
    ],
    tags: [
      {
        name: "Reading",
        nameKey: "reading",
        color: "#3178c6",
        description: "Long-form articles.",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    meta: [
      {
        id: "ea",
        tags: ["reading"],
        category: "docs",
        notes: "note-a",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "ef",
        category: "other",
        notes: "folder note",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "et",
        tags: ["reading"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
}

/** Find a node by title inside a subtree (depth-first). */
function findByTitle(
  node: BookmarksTreeNode,
  title: string,
): BookmarksTreeNode | undefined {
  if (node.title === title) return node;
  for (const child of node.children ?? []) {
    const found = findByTitle(child, title);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// planImport — pure preview counts
// ---------------------------------------------------------------------------

describe("planImport — preview counts", () => {
  it("counts folders, bookmarks and passthrough invalid rows", () => {
    const plan = planImport({
      items: [
        dir("F1", [bm("a", "https://a.example/"), bm("b", "https://b.example/")]),
        dir("F2", []),
        bm("c", "https://c.example/"),
      ],
      existingUrls: new Set(),
      invalid: 2,
    });
    expect(plan.folders).toBe(2);
    expect(plan.bookmarks).toBe(3);
    expect(plan.duplicatesSkipped).toBe(0);
    expect(plan.invalid).toBe(2);
    expect(plan.items).toHaveLength(3);
  });

  it("returns an all-zero plan for an empty import", () => {
    const plan = planImport({ items: [], existingUrls: new Set() });
    expect(plan).toEqual({
      folders: 0,
      bookmarks: 0,
      duplicatesSkipped: 0,
      invalid: 0,
      items: [],
    });
  });

  it("is pure — planning writes nothing to chrome or the database", async () => {
    const createSpy = vi.spyOn(fake, "create");
    planImport({
      items: [dir("F", [bm("a", "https://a.example/")])],
      existingUrls: collectNormalizedUrls(await fake.getTree()),
    });
    expect(createSpy).not.toHaveBeenCalled();
    expect(await db.bookmarkMeta.count()).toBe(0);
    // Other bookmarks still holds only the seeded bookmark.
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.map((c) => c.title)).toEqual(["Existing"]);
  });
});

describe("planImport — duplicate skip by normalized URL", () => {
  it("skips a bookmark whose normalized URL already exists in the library", () => {
    // The seeded bookmark is https://existing.example/page → "existing.example/page".
    // www., utm_*, the fragment and the https scheme all normalize away.
    const plan = planImport({
      items: [
        bm("dup", "https://www.existing.example/page?utm_source=x#frag"),
        bm("new", "https://new.example/"),
      ],
      existingUrls: collectNormalizedUrls([
        { id: "existing", title: "Existing", url: EXISTING_URL },
      ]),
    });
    expect(plan.duplicatesSkipped).toBe(1);
    expect(plan.bookmarks).toBe(1);
    expect(plan.items).toEqual([bm("new", "https://new.example/")]);
  });

  it("importDuplicates re-includes skipped bookmarks", () => {
    const items = [bm("dup", "https://www.existing.example/page#frag")];
    const plan = planImport({
      items,
      existingUrls: new Set([normalizeUrl(EXISTING_URL) as string]),
      options: { importDuplicates: true },
    });
    expect(plan.duplicatesSkipped).toBe(0);
    expect(plan.bookmarks).toBe(1);
    expect(plan.items).toEqual(items);
  });

  it("skips a repeated URL inside the import itself (second occurrence)", () => {
    // Once a URL is kept it is "in the library" for the rest of the file —
    // importing a twin of it would create the very duplicate the preview
    // promised to avoid.
    const plan = planImport({
      items: [
        bm("one", "https://a.example/"),
        dir("F", [bm("two", "https://a.example/#other")]),
      ],
      existingUrls: new Set(),
    });
    expect(plan.bookmarks).toBe(1);
    expect(plan.duplicatesSkipped).toBe(1);
    expect(asFolder(plan.items[1]).children).toEqual([]);
  });

  it("keeps folders whose children were all skipped", () => {
    const plan = planImport({
      items: [dir("F", [bm("dup", EXISTING_URL)])],
      existingUrls: new Set([normalizeUrl(EXISTING_URL) as string]),
    });
    expect(plan.folders).toBe(1);
    expect(plan.bookmarks).toBe(0);
    expect(plan.duplicatesSkipped).toBe(1);
    expect(plan.items).toEqual([dir("F", [])]);
  });

  it("never treats non-http(s) unblocked URLs as duplicates", () => {
    // ftp: has no normalized form (normalizeUrl → null), so it can neither
    // match the library nor collide with a twin inside the file.
    const plan = planImport({
      items: [
        bm("ftp1", "ftp://f.example/x"),
        bm("ftp2", "ftp://f.example/x"),
      ],
      existingUrls: new Set(),
    });
    expect(plan.bookmarks).toBe(2);
    expect(plan.duplicatesSkipped).toBe(0);
    expect(plan.items).toHaveLength(2);
  });

  it("drops blocked-scheme and empty URLs into the invalid count", () => {
    const plan = planImport({
      items: [
        bm("j", "javascript:alert(1)"),
        bm("j2", "java\tscript:alert(1)"), // control-char obfuscation
        bm("d", "data:text/html,<p>x</p>"),
        bm("v", "VBSCRIPT:msgbox(1)"),
        bm("e", "   "),
      ],
      existingUrls: new Set(),
      invalid: 1,
    });
    expect(plan.invalid).toBe(6);
    expect(plan.bookmarks).toBe(0);
    expect(plan.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adapters — normalized intermediate shapes
// ---------------------------------------------------------------------------

describe("fromCsvRows", () => {
  it("maps folder_path into nested folders and shares common prefixes", () => {
    const items = fromCsvRows([
      {
        title: "A",
        url: "https://a.example/",
        folderPath: "W/D",
        tags: ["Docs", "Reading"],
        category: "article",
        notes: "note-a",
        created: "2026-01-15T10:30:00Z",
      },
      {
        title: "B",
        url: "https://b.example/",
        folderPath: "W",
        tags: [],
      },
      {
        title: "C",
        url: "https://c.example/",
        folderPath: "",
        tags: [],
      },
    ]);
    // W/D>A is built first; B joins W after D; C lands at the top level.
    expect(items).toHaveLength(2);
    const w = asFolder(items[0]);
    expect(w.title).toBe("W");
    expect(w.children).toHaveLength(2);
    const d = asFolder(w.children[0]);
    expect(d.title).toBe("D");
    expect(d.children[0]).toMatchObject({
      kind: "bookmark",
      title: "A",
      url: "https://a.example/",
      meta: { tags: ["Docs", "Reading"], category: "article", notes: "note-a" },
    });
    expect(w.children[1]).toMatchObject({ kind: "bookmark", title: "B" });
    expect(items[1]).toMatchObject({ kind: "bookmark", title: "C" });
  });

  it("trims path segments and drops empties", () => {
    const items = fromCsvRows([
      {
        title: "A",
        url: "https://a.example/",
        folderPath: "  W // D  ",
        tags: [],
      },
    ]);
    const w = asFolder(items[0]);
    expect(w.title).toBe("W");
    expect(asFolder(w.children[0]).title).toBe("D");
  });
});

describe("fromNetscape", () => {
  it("converts the parsed tree and carries TAGS into meta", () => {
    const items = fromNetscape([
      {
        kind: "folder",
        title: "F",
        children: [
          {
            kind: "bookmark",
            title: "A",
            url: "https://a.example/",
            tags: ["t1", "t2"],
          },
        ],
      },
      { kind: "bookmark", title: "B", url: "https://b.example/", tags: [] },
    ]);
    expect(items).toHaveLength(2);
    const f = asFolder(items[0]);
    expect(f.title).toBe("F");
    expect(f.children[0]).toMatchObject({
      kind: "bookmark",
      title: "A",
      meta: { tags: ["t1", "t2"] },
    });
    expect(items[1]).toEqual(bm("B", "https://b.example/"));
  });
});

describe("fromEnvelope", () => {
  it("joins meta rows by export-local id and never carries the ids over", () => {
    const parsed = parseExport(envelopeJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const items = fromEnvelope(parsed.data);
    expect(items).toHaveLength(2);
    const work = asFolder(items[0]);
    expect(work.title).toBe("Work");
    expect(work.meta).toEqual({ category: "other", notes: "folder note" });
    expect(work.children[0]).toMatchObject({
      kind: "bookmark",
      title: "A",
      url: "https://a.example/",
      meta: { tags: ["reading"], category: "docs", notes: "note-a" },
    });
    // "eb" has no meta row → no meta field at all.
    expect(work.children[1]).toEqual(bm("B", "https://b.example/"));
    expect(items[1]).toMatchObject({
      kind: "bookmark",
      title: "Top",
      meta: { tags: ["reading"] },
    });
    // Export-local ids are join keys only — nothing carries them onward.
    for (const item of items) {
      expect(item).not.toHaveProperty("id");
    }
    expect(asFolder(items[0]).children[0]).not.toHaveProperty("id");
  });
});

describe("collectNormalizedUrls", () => {
  it("collects normalized URLs from a chrome tree for planImport", async () => {
    const urls = collectNormalizedUrls(await fake.getTree());
    expect(urls).toEqual(new Set([normalizeUrl(EXISTING_URL)]));
  });
});

// ---------------------------------------------------------------------------
// writeImport — destination, structure, ordering
// ---------------------------------------------------------------------------

describe("writeImport — destination and structure", () => {
  it("formats the import root title as Imported <YYYY-MM-DD HH:mm>", () => {
    expect(importRootTitle(IMPORT_NOW)).toBe(IMPORT_TITLE);
    expect(importRootTitle(new Date(2026, 0, 2, 3, 4))).toBe(
      "Imported 2026-01-02 03:04",
    );
  });

  it("creates the dated folder under Other bookmarks and reports its id", async () => {
    const res = await writeImport([], { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.map((c) => c.title)).toEqual(["Existing", IMPORT_TITLE]);
    expect(children[1]?.id).toBe(res.summary.importRootId);
    expect(res.summary).toMatchObject({
      foldersCreated: 0,
      bookmarksCreated: 0,
      duplicatesSkipped: 0,
      invalidSkipped: 0,
      tagsCreated: 0,
      failures: [],
    });
  });

  it("preserves the file's nested structure and sibling order", async () => {
    const res = await writeImport(
      [
        dir("W", [
          bm("A", "https://a.example/"),
          dir("D", [bm("B", "https://b.example/")]),
          bm("C", "https://c.example/"),
        ]),
        bm("T", "https://t.example/"),
      ],
      { now: IMPORT_NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(shape(await subtree(res.summary.importRootId))).toEqual({
      title: IMPORT_TITLE,
      children: [
        {
          title: "W",
          children: [
            { title: "A", url: "https://a.example/" },
            { title: "D", children: [{ title: "B", url: "https://b.example/" }] },
            { title: "C", url: "https://c.example/" },
          ],
        },
        { title: "T", url: "https://t.example/" },
      ],
    });
    expect(res.summary.foldersCreated).toBe(2);
    expect(res.summary.bookmarksCreated).toBe(4);
  });

  it("skips planned duplicates so they never reach the tree", async () => {
    const plan = planImport({
      items: [
        bm("dup", "https://www.existing.example/page?utm_campaign=z"),
        bm("new", "https://new.example/"),
      ],
      existingUrls: collectNormalizedUrls(await fake.getTree()),
    });
    const res = await writeImport(plan, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary).toMatchObject({
      bookmarksCreated: 1,
      duplicatesSkipped: 1,
      invalidSkipped: 0,
    });
    const root = await subtree(res.summary.importRootId);
    expect(root.children?.map((c) => c.title)).toEqual(["new"]);
  });

  it("a raw items array writes everything verbatim (no dedupe)", async () => {
    const res = await writeImport(
      [bm("x", "https://x.example/"), bm("x2", "https://x.example/")],
      { now: IMPORT_NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.bookmarksCreated).toBe(2);
    expect(res.summary.duplicatesSkipped).toBe(0);
    const root = await subtree(res.summary.importRootId);
    expect(root.children).toHaveLength(2);
  });

  it("refuses blocked-scheme and empty URLs even in a raw items array", async () => {
    // Raw input bypasses planImport's pruning — the writer re-checks at the
    // write boundary so a scriptable/empty URL can never reach createBookmark.
    const createSpy = vi.spyOn(fake, "create");
    const res = await writeImport(
      [
        bm("ok", "https://ok.example/"),
        bm("evil", "javascript:alert(1)"),
        bm("evil2", "java\tscript:alert(1)"), // control-char obfuscation
        bm("data", "data:text/html,<p>x</p>"),
        bm("blank", "   "),
      ],
      { now: IMPORT_NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.bookmarksCreated).toBe(1);
    expect(res.summary.failures).toEqual([
      {
        kind: "bookmark",
        title: "evil",
        message: expect.stringContaining("blocked"),
      },
      {
        kind: "bookmark",
        title: "evil2",
        message: expect.stringContaining("blocked"),
      },
      {
        kind: "bookmark",
        title: "data",
        message: expect.stringContaining("blocked"),
      },
      {
        kind: "bookmark",
        title: "blank",
        message: expect.stringContaining("empty"),
      },
    ]);
    // Only the import root folder + the one safe bookmark reached chrome —
    // the four unsafe rows were refused before createBookmark ran.
    expect(createSpy).toHaveBeenCalledTimes(2);
    const root = await subtree(res.summary.importRootId);
    expect(root.children?.map((c) => c.title)).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// writeImport — metadata and tag definition restore
// ---------------------------------------------------------------------------

describe("writeImport — JSON metadata restore", () => {
  it("restores tags, categories and notes on bookmarks AND folders", async () => {
    const parsed = parseExport(envelopeJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = planImport({
      items: fromEnvelope(parsed.data),
      existingUrls: new Set(),
    });
    const res = await writeImport(plan, {
      now: IMPORT_NOW,
      tagDefs: parsed.data.tags,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.tagsCreated).toBe(1);

    const root = await subtree(res.summary.importRootId);
    const a = findByTitle(root, "A");
    const work = findByTitle(root, "Work");
    const top = findByTitle(root, "Top");
    const b = findByTitle(root, "B");
    for (const n of [a, work, top, b]) expect(n).toBeDefined();
    if (!a || !work || !top || !b) return;

    // The created Chrome ids are fresh — the export-local ids ("ea", …)
    // are join keys, never reused.
    for (const n of [a, work, top, b]) {
      expect(["ef", "ea", "eb", "et"]).not.toContain(n.id);
    }

    expect(await getMeta(a.id)).toMatchObject({
      tags: ["reading"],
      category: "docs",
      notes: "note-a",
    });
    expect(await getMeta(work.id)).toMatchObject({
      category: "other",
      notes: "folder note",
    });
    expect(await getMeta(top.id)).toMatchObject({ tags: ["reading"] });
    // No meta row for B — the lazy-row rule keeps empty metadata absent.
    expect(await getMeta(b.id)).toBeUndefined();

    expect(await listTags()).toEqual([
      expect.objectContaining({
        name: "Reading",
        nameKey: "reading",
        color: "#3178c6",
        description: "Long-form articles.",
      }),
    ]);
  });

  it("reuses an existing tag definition on a nameKey collision", async () => {
    await createTag("reading", { color: "#111111" });
    const parsed = parseExport(envelopeJson());
    if (!parsed.ok) throw new Error("envelope fixture must parse");
    const plan = planImport({
      items: fromEnvelope(parsed.data),
      existingUrls: new Set(),
    });
    const res = await writeImport(plan, {
      now: IMPORT_NOW,
      tagDefs: parsed.data.tags,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.tagsCreated).toBe(0);
    // The library def wins — the file's color/description do not clobber it.
    expect(await listTags()).toEqual([
      expect.objectContaining({ nameKey: "reading", color: "#111111" }),
    ]);
  });
});

describe("writeImport — CSV metadata restore", () => {
  it("imports csv rows end-to-end: folder_path, tags, category, notes", async () => {
    const csv = exportCsv([
      {
        title: "A",
        url: "https://a.example/",
        folderPath: "W/D",
        tags: ["Docs", "Reading"],
        category: "article",
        notes: "note-a",
        created: "2026-01-15T10:30:00Z",
      },
      {
        title: "B",
        url: "https://b.example/",
        folderPath: "W",
        tags: [],
      },
    ]);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = planImport({
      items: fromCsvRows(parsed.rows),
      existingUrls: new Set(),
      invalid: parsed.invalid.length,
    });
    const res = await writeImport(plan, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary).toMatchObject({
      foldersCreated: 2,
      bookmarksCreated: 2,
      invalidSkipped: 0,
    });
    const root = await subtree(res.summary.importRootId);
    const a = findByTitle(root, "A");
    const w = findByTitle(root, "W");
    const d = findByTitle(root, "D");
    for (const n of [a, w, d]) expect(n).toBeDefined();
    if (!a || !w || !d) return;
    // Tag names normalize to nameKeys on write.
    expect(await getMeta(a.id)).toMatchObject({
      tags: ["docs", "reading"],
      category: "article",
      notes: "note-a",
    });
    expect(d.parentId).toBe(w.id);
  });
});

describe("writeImport — Netscape restore", () => {
  it("imports the parsed tree end-to-end with TAGS and parser counts", async () => {
    const html = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      "<DL><p>",
      '<DT><H3>Folder</H3>',
      "<DL><p>",
      '<DT><A HREF="https://a.example/" TAGS="one,two">A</A>',
      '<DT><A HREF="">no href</A>',
      '<DT><A HREF="javascript:alert(1)">bad</A>',
      "</DL><p>",
      "</DL><p>",
    ].join("\n");
    const parsed = parseNetscape(html);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.stats).toMatchObject({ invalid: 1, skipped: 1 });
    const plan = planImport({
      items: fromNetscape(parsed.tree),
      existingUrls: new Set(),
      invalid: parsed.stats.invalid + parsed.stats.skipped,
    });
    expect(plan.invalid).toBe(2);
    const res = await writeImport(plan, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary).toMatchObject({
      foldersCreated: 1,
      bookmarksCreated: 1,
      invalidSkipped: 2,
    });
    const root = await subtree(res.summary.importRootId);
    const a = findByTitle(root, "A");
    expect(a).toBeDefined();
    if (!a) return;
    expect(await getMeta(a.id)).toMatchObject({ tags: ["one", "two"] });
  });
});

// ---------------------------------------------------------------------------
// writeImport — summary, partial failures, undo
// ---------------------------------------------------------------------------

describe("writeImport — summary and partial failures", () => {
  it("collects a per-item failure and keeps writing siblings", async () => {
    const original = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "BOOM"
        ? Promise.reject(new Error("simulated create failure"))
        : original(details),
    );
    const res = await writeImport(
      [
        bm("ok1", "https://ok1.example/"),
        bm("BOOM", "https://boom.example/"),
        bm("ok2", "https://ok2.example/"),
      ],
      { now: IMPORT_NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.bookmarksCreated).toBe(2);
    expect(res.summary.failures).toEqual([
      {
        kind: "bookmark",
        title: "BOOM",
        message: expect.stringContaining("simulated create failure"),
      },
    ]);
    const root = await subtree(res.summary.importRootId);
    expect(root.children?.map((c) => c.title)).toEqual(["ok1", "ok2"]);
  });

  it("records a failed folder's descendants as skipped too", async () => {
    const original = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "BADFOLDER"
        ? Promise.reject(new Error("simulated folder failure"))
        : original(details),
    );
    const res = await writeImport(
      [
        dir("BADFOLDER", [
          bm("c1", "https://c1.example/"),
          dir("sub", [bm("c2", "https://c2.example/")]),
        ]),
        bm("after", "https://after.example/"),
      ],
      { now: IMPORT_NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.foldersCreated).toBe(0);
    expect(res.summary.bookmarksCreated).toBe(1);
    expect(res.summary.failures).toEqual([
      {
        kind: "folder",
        title: "BADFOLDER",
        message: expect.stringContaining("simulated folder failure"),
      },
      { kind: "bookmark", title: "c1", message: expect.stringContaining("parent folder") },
      { kind: "folder", title: "sub", message: expect.stringContaining("parent folder") },
      { kind: "bookmark", title: "c2", message: expect.stringContaining("parent folder") },
    ]);
  });

  it("records a meta failure without losing the created node", async () => {
    const res = await writeImport(
      [bm("M", "https://m.example/", { notes: "n".repeat(10_001) })],
      { now: IMPORT_NOW },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.bookmarksCreated).toBe(1);
    expect(res.summary.failures).toEqual([
      { kind: "meta", title: "M", message: expect.any(String) },
    ]);
    const root = await subtree(res.summary.importRootId);
    expect(root.children?.[0]?.title).toBe("M");
    expect(await getMeta(root.children?.[0]?.id ?? "")).toBeUndefined();
  });

  it("collects a tag-definition failure without aborting the import", async () => {
    // A def that cannot satisfy TagDef (name > 64 chars) — unreachable through
    // parseExport, so the failure path is exercised with a cast fixture.
    const badDef = {
      name: "x".repeat(65),
      nameKey: "x".repeat(65),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as TagDef;
    const res = await writeImport([bm("a", "https://a.example/")], {
      now: IMPORT_NOW,
      tagDefs: [badDef],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.tagsCreated).toBe(0);
    expect(res.summary.bookmarksCreated).toBe(1);
    expect(res.summary.failures).toEqual([
      { kind: "tag", title: "x".repeat(65), message: expect.any(String) },
    ]);
  });

  it("returns ok:false when the import root itself cannot be created", async () => {
    vi.spyOn(fake, "create").mockRejectedValue(new Error("no writes allowed"));
    const res = await writeImport([bm("a", "https://a.example/")], {
      now: IMPORT_NOW,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("import_root_failed");
    expect(res.message).toContain("no writes allowed");
    // Nothing was written under Other bookmarks.
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.map((c) => c.title)).toEqual(["Existing"]);
  });
});

describe("writeImport — undo", () => {
  it("removeTree(importRootId) removes the whole import, meta included", async () => {
    // Meta cleanup is the Phase-1 onRemoved cascade's job
    // (src/sync/listeners.ts) — registered here so the undo path is the real
    // one. `deleteMetaByIds` fires detached inside the listener, hence
    // vi.waitFor below.
    registerBookmarkListeners();
    const parsed = parseExport(envelopeJson());
    if (!parsed.ok) throw new Error("envelope fixture must parse");
    const plan = planImport({
      items: fromEnvelope(parsed.data),
      existingUrls: new Set(),
    });
    const res = await writeImport(plan, {
      now: IMPORT_NOW,
      tagDefs: parsed.data.tags,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rootId = res.summary.importRootId;
    const createdIds = subtreeIds(await subtree(rootId));
    // root + Work + A + B + Top
    expect(createdIds).toHaveLength(5);
    // Meta rows exist pre-undo (sanity check that the cascade has work).
    expect(await db.bookmarkMeta.count()).toBe(3);

    await removeTree(rootId);

    for (const id of createdIds) {
      await expect(fake.get(id)).rejects.toThrow(/Can't find bookmark/);
    }
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.map((c) => c.title)).toEqual(["Existing"]);
    // The listener cascade deletes every meta row of the removed subtree.
    await vi.waitFor(async () => {
      expect(await db.bookmarkMeta.count()).toBe(0);
    });
    // Tag definitions are library data — undo deliberately keeps them.
    expect(await listTags()).toHaveLength(1);
  });
});
