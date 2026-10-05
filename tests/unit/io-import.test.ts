// @vitest-environment jsdom
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
import { createTag, getMeta, listMeta, listTags, putMeta } from "../../src/db/meta";
import { normalizeUrl } from "../../src/duplicates/normalize";
import { exportCsv, joinFolderPath, parseCsv } from "../../src/io/csv";
import { buildExport, parseExport, serializeExport } from "../../src/io/export-json";
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
import {
  cancelImport,
  importRootTitle,
  listInterruptedImports,
  resumeImport,
  writeImport,
} from "../../src/io/import-write";
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

async function resetEnv() {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fake = installBookmarksFake({
    otherBookmarks: [
      { id: "existing", title: "Existing", url: EXISTING_URL },
    ],
  });
  await db.bookmarkMeta.clear();
  await db.tags.clear();
}

beforeEach(resetEnv);

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
      existingUrls: new Map(),
      invalid: 2,
    });
    expect(plan.folders).toBe(2);
    expect(plan.bookmarks).toBe(3);
    expect(plan.duplicatesSkipped).toBe(0);
    expect(plan.invalid).toBe(2);
    expect(plan.items).toHaveLength(3);
  });

  it("returns an all-zero plan for an empty import, and is pure", async () => {
    expect(planImport({ items: [], existingUrls: new Map() })).toEqual({
      folders: 0,
      bookmarks: 0,
      duplicatesSkipped: 0,
      invalid: 0,
      skipped: [],
      items: [],
    });
    // Planning writes nothing to chrome or the database.
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
    // The seeded bookmark is https://existing.example/page → "https://existing.example/page".
    // www., utm_* and the plain anchor fragment all normalize away.
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

  it("keeps distinct SPA routes, repo `ref` values, and http vs https (D01)", () => {
    // The normalized key is scheme- and route-aware: none of these may be
    // skipped as duplicates of the https bookmark already in the library.
    const plan = planImport({
      items: [
        bm("r1", "https://app.com/#/inbox"),
        bm("r2", "https://app.com/#/settings"),
        bm("ref", "https://github.com/o/r?ref=dev"),
        bm("plain", "http://existing.example/page"),
      ],
      existingUrls: new Map([
        [normalizeUrl("https://app.com/#/inbox") as string, "r1-id"],
        [normalizeUrl("https://github.com/o/r?ref=main") as string, "ref-id"],
        [normalizeUrl(EXISTING_URL) as string, "existing"],
      ]),
    });
    expect(plan.duplicatesSkipped).toBe(1); // only the exact r1 match
    expect(plan.bookmarks).toBe(3);
  });

  it("importDuplicates re-includes skipped bookmarks", () => {
    const items = [bm("dup", "https://www.existing.example/page#frag")];
    const plan = planImport({
      items,
      existingUrls: new Map([[normalizeUrl(EXISTING_URL) as string, "existing"]]),
      options: { importDuplicates: true },
    });
    expect(plan.duplicatesSkipped).toBe(0);
    expect(plan.bookmarks).toBe(1);
    expect(plan.items).toEqual(items);
  });

  it("skips a repeated URL inside the import and keeps folders left empty by skips", () => {
    // Once a URL is kept it is "in the library" for the rest of the file —
    // importing a twin of it would create the very duplicate the preview
    // promised to avoid.
    const plan = planImport({
      items: [
        bm("one", "https://a.example/"),
        dir("F", [bm("two", "https://a.example/#other")]),
      ],
      existingUrls: new Map(),
    });
    expect(plan.bookmarks).toBe(1);
    expect(plan.duplicatesSkipped).toBe(1);
    expect(asFolder(plan.items[1]).children).toEqual([]);
    const empty = planImport({
      items: [dir("F", [bm("dup", EXISTING_URL)])],
      existingUrls: new Map([[normalizeUrl(EXISTING_URL) as string, "existing"]]),
    });
    expect(empty.folders).toBe(1);
    expect(empty.bookmarks).toBe(0);
    expect(empty.duplicatesSkipped).toBe(1);
    expect(empty.items).toEqual([dir("F", [])]);
  });

  it("never treats non-http(s) URLs as duplicates and drops blocked/empty URLs into invalid", () => {
    // ftp: has no normalized form (normalizeUrl → null), so it can neither
    // match the library nor collide with a twin inside the file.
    const ftp = planImport({
      items: [
        bm("ftp1", "ftp://f.example/x"),
        bm("ftp2", "ftp://f.example/x"),
      ],
      existingUrls: new Map(),
    });
    expect(ftp.bookmarks).toBe(2);
    expect(ftp.duplicatesSkipped).toBe(0);
    expect(ftp.items).toHaveLength(2);
    const blocked = planImport({
      items: [
        bm("j", "javascript:alert(1)"),
        bm("j2", "java\tscript:alert(1)"), // control-char obfuscation
        bm("d", "data:text/html,<p>x</p>"),
        bm("v", "VBSCRIPT:msgbox(1)"),
        bm("e", "   "),
      ],
      existingUrls: new Map(),
      invalid: 1,
    });
    expect(blocked.invalid).toBe(6);
    expect(blocked.bookmarks).toBe(0);
    expect(blocked.items).toEqual([]);
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

describe("fromCsvRows — escaped path keys", () => {
  it("a folder titled A/B does not collide with nested A → B", () => {
    // Review fix: pathKey on decoded segments joined by `/` collided.
    const items = fromCsvRows([
      {
        title: "in flat",
        url: "https://flat.example/",
        folderPath: joinFolderPath(["A/B"]),
        tags: [],
      },
      {
        title: "in nested",
        url: "https://nested.example/",
        folderPath: joinFolderPath(["A", "B"]),
        tags: [],
      },
    ]);
    expect(items).toHaveLength(2);
    const flat = items[0];
    const nested = items[1];
    expect(flat?.kind === "folder" && flat.title).toBe("A/B");
    expect(nested?.kind === "folder" && nested.title).toBe("A");
    if (flat?.kind === "folder" && nested?.kind === "folder") {
      expect(flat.children[0]?.title).toBe("in flat");
      expect(nested.children[0]?.title).toBe("B");
      if (nested.children[0]?.kind === "folder") {
        expect(nested.children[0].children[0]?.title).toBe("in nested");
      }
    }
  });
});

describe("collectNormalizedUrls", () => {
  it("collects normalized URLs from a chrome tree for planImport", async () => {
    const urls = collectNormalizedUrls(await fake.getTree());
    expect(urls).toEqual(new Map([[normalizeUrl(EXISTING_URL), "existing"]]));
  });
});

// ---------------------------------------------------------------------------
// writeImport — destination, structure, ordering
// ---------------------------------------------------------------------------

describe("writeImport — destination and structure", () => {
  it("formats the import root title and creates it under Other bookmarks", async () => {
    expect(importRootTitle(IMPORT_NOW)).toBe(IMPORT_TITLE);
    expect(importRootTitle(new Date(2026, 0, 2, 3, 4))).toBe(
      "Imported 2026-01-02 03:04",
    );
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

  it("skips planned duplicates, while a raw items array writes everything verbatim", async () => {
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
    // Raw input skips the planner — twins land verbatim (no dedupe).
    const raw = await writeImport(
      [bm("x", "https://x.example/"), bm("x2", "https://x.example/")],
      { now: IMPORT_NOW },
    );
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    expect(raw.summary.bookmarksCreated).toBe(2);
    expect(raw.summary.duplicatesSkipped).toBe(0);
    const rawRoot = await subtree(raw.summary.importRootId);
    expect(rawRoot.children).toHaveLength(2);
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
  it("round-trips summary metadata through a real JSON backup", async () => {
    for (const fields of [
      { tags: [], summary: "Verified summary only." },
      {
        tags: ["reading"],
        category: "paper" as const,
        notes: "Local notes.",
        summary: "Verified full summary.",
      },
    ]) {
    await resetEnv();
    await putMeta("existing", fields);
    const exported = buildExport({
      tree: await fake.getTree(),
      meta: await listMeta(),
      tags: await listTags(),
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("export failed");
    const serialized = serializeExport(exported.data);
    if (!serialized.ok) throw new Error("serialization failed");
    const parsed = parseExport(serialized.data);
    if (!parsed.ok) throw new Error("backup failed to parse");
    const plan = planImport({
      items: fromEnvelope(parsed.data),
      existingUrls: new Map(),
    });
    const result = await writeImport(plan, { now: IMPORT_NOW });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("import failed");
    expect(result.summary.bookmarksCreated).toBe(1);
    expect(result.summary.failures).toEqual([]);
    const created = findByTitle(await subtree(result.summary.importRootId), "Existing");
    expect(created).toBeDefined();
    expect(created?.id).not.toBe("existing");
    expect(await getMeta(created!.id)).toMatchObject(fields);
    expect(await getMeta("existing")).toMatchObject(fields);
    }
  });

  it("keeps summary duplicates out of the planned import", async () => {
    const parsed = parseExport({
      version: 1,
      exportedAt: "2026-09-30T00:00:00.000Z",
      tree: [{ id: "old", title: "Duplicate", url: EXISTING_URL }],
      tags: [],
      meta: [{
        id: "old", tags: [], summary: "Duplicate summary.",
        updatedAt: "2026-09-30T00:00:00.000Z",
      }],
    });
    if (!parsed.ok) throw new Error("fixture failed to parse");
    const plan = planImport({
      items: fromEnvelope(parsed.data),
      existingUrls: collectNormalizedUrls(await fake.getTree()),
    });
    const result = await writeImport(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("import failed");
    expect(result.summary).toMatchObject({
      bookmarksCreated: 0, duplicatesSkipped: 1, failures: [],
    });
    expect(await db.bookmarkMeta.count()).toBe(0);
  });

  it("rejects invalid JSON summary metadata", () => {
    for (const summary of ["", "s".repeat(2_001), 42]) {
      const parsed = parseExport({
        version: 1,
        exportedAt: "2026-09-30T00:00:00.000Z",
        tree: [{ id: "old", title: "Invalid", url: "https://ref.dev/" }],
        tags: [],
        meta: [{
          id: "old", tags: [], summary,
          updatedAt: "2026-09-30T00:00:00.000Z",
        }],
      });
      expect(parsed, JSON.stringify(summary)).toMatchObject({ ok: false, code: "invalid_envelope" });
    }
  });

  it("restores tags, categories and notes on bookmarks AND folders", async () => {
    const parsed = parseExport(envelopeJson());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = planImport({
      items: fromEnvelope(parsed.data),
      existingUrls: new Map(),
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
      existingUrls: new Map(),
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
      existingUrls: new Map(),
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
      existingUrls: new Map(),
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
  it("collects per-item and folder failures — siblings keep writing, descendants are recorded skipped", async () => {
    const original = fake.create.bind(fake);
    const flaky = vi.spyOn(fake, "create").mockImplementation((details) =>
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
    flaky.mockRestore();
    // A failed folder cascades: every descendant is recorded as skipped.
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "BADFOLDER"
        ? Promise.reject(new Error("simulated folder failure"))
        : original(details),
    );
    const bad = await writeImport(
      [
        dir("BADFOLDER", [
          bm("c1", "https://c1.example/"),
          dir("sub", [bm("c2", "https://c2.example/")]),
        ]),
        bm("after", "https://after.example/"),
      ],
      { now: IMPORT_NOW },
    );
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.summary.foldersCreated).toBe(0);
    expect(bad.summary.bookmarksCreated).toBe(1);
    expect(bad.summary.failures).toEqual([
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

  it("records meta and tag-definition failures without losing created nodes", async () => {
    const meta = await writeImport(
      [bm("M", "https://m.example/", { notes: "n".repeat(10_001) })],
      { now: IMPORT_NOW },
    );
    expect(meta.ok).toBe(true);
    if (!meta.ok) return;
    expect(meta.summary.bookmarksCreated).toBe(1);
    expect(meta.summary.failures).toEqual([
      { kind: "meta", title: "M", message: expect.any(String) },
    ]);
    const root = await subtree(meta.summary.importRootId);
    expect(root.children?.[0]?.title).toBe("M");
    expect(await getMeta(root.children?.[0]?.id ?? "")).toBeUndefined();
    // A def that cannot satisfy TagDef (name > 64 chars) — unreachable through
    // parseExport, so the failure path is exercised with a cast fixture.
    const badDef = {
      name: "x".repeat(65),
      nameKey: "x".repeat(65),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as TagDef;
    const tagged = await writeImport([bm("a", "https://a.example/")], {
      now: IMPORT_NOW,
      tagDefs: [badDef],
    });
    expect(tagged.ok).toBe(true);
    if (!tagged.ok) return;
    expect(tagged.summary.tagsCreated).toBe(0);
    expect(tagged.summary.bookmarksCreated).toBe(1);
    expect(tagged.summary.failures).toEqual([
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
      existingUrls: new Map(),
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

// ---------------------------------------------------------------------------
// I03 — tag definitions for imported tags
// I04 — duplicate meta merge + preview list
// ---------------------------------------------------------------------------

describe("writeImport — I03 tag defs and I04 duplicate merge", () => {
  it("creates a TagDef per distinct tag on CSV/Netscape-style imports", async () => {
    const items = [
      bm("A", "https://a.example/", { tags: ["Reading", "news"] }),
      bm("B", "https://b.example/", { tags: ["reading", "other"] }),
    ];
    const plan = planImport({ items, existingUrls: new Map() });
    const res = await writeImport(plan, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Distinct keys: reading, news, other — "Reading"/"reading" share a def.
    expect(res.summary.tagsCreated).toBe(3);
    const defs = await listTags();
    expect(defs.map((d) => d.nameKey).sort()).toEqual([
      "news",
      "other",
      "reading",
    ]);
    // The first-seen display name wins the def's name.
    expect(defs.find((d) => d.nameKey === "reading")?.name).toBe("Reading");
  });

  it("an over-long tag is truncated individually, not row-failing", async () => {
    const longTag = "t".repeat(100);
    const items = [
      bm("A", "https://a.example/", { tags: [longTag, "ok", "   "] }),
    ];
    const res = await writeImport(items, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const root = await subtree(res.summary.importRootId);
    const a = findByTitle(root, "A");
    expect(a).toBeDefined();
    if (!a) return;
    // Row written, long tag truncated to 64, blank one dropped, no failures.
    expect(res.summary.failures).toEqual([]);
    expect(await getMeta(a.id)).toMatchObject({
      tags: [longTag.slice(0, 64), "ok"],
    });
    // And a def exists for the truncated key.
    expect((await listTags()).map((d) => d.nameKey).sort()).toEqual([
      "ok",
      "t".repeat(64),
    ]);
  });

  it("a library duplicate is skipped, its url listed, and its meta merged", async () => {
    // Existing bookmark already carries curated meta.
    await putMeta("existing", {
      tags: ["mine"],
      notes: "keep me",
    });
    const plan = planImport({
      items: [
        bm("dup", "https://www.existing.example/page?utm_source=x#frag", {
          tags: ["fromFile", "Mine"],
          category: "article",
          notes: "file notes",
        }),
      ],
      existingUrls: collectNormalizedUrls(await fake.getTree()),
    });
    expect(plan.duplicatesSkipped).toBe(1);
    // I04: the skipped URL is visible for the preview.
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.url).toBe(
      "https://www.existing.example/page?utm_source=x#frag",
    );
    expect(plan.skipped[0]?.existingId).toBe("existing");

    const res = await writeImport(plan, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.summary.bookmarksCreated).toBe(0);

    // Tags union (case-insensitive on keys), notes kept (existing not empty),
    // category filled (existing had none).
    const merged = await getMeta("existing");
    expect(merged).toMatchObject({
      tags: ["mine", "fromfile"],
      category: "article",
      notes: "keep me",
    });
    // Defs now exist for the merged file tags.
    expect((await listTags()).map((d) => d.nameKey).sort()).toEqual([
      "fromfile",
      "mine",
    ]);
  });

  it("notes merge only into an EMPTY notes field", async () => {
    const plan = planImport({
      items: [
        bm("dup", "https://existing.example/page", {
          notes: "imported notes",
          category: "article",
        }),
      ],
      existingUrls: collectNormalizedUrls(await fake.getTree()),
    });
    await writeImport(plan, { now: IMPORT_NOW });
    const merged = await getMeta("existing");
    // No prior meta row: file's notes AND category fill in.
    expect(merged).toMatchObject({
      notes: "imported notes",
      category: "article",
    });
  });

  it("an in-file repeat merges its meta into the kept sibling", async () => {
    const items = [
      bm("first", "https://dup.example/", { tags: ["a"], notes: "first" }),
      bm("second", "https://www.dup.example/?utm_source=x", {
        tags: ["b"],
        category: "docs",
      }),
    ];
    const plan = planImport({ items, existingUrls: new Map() });
    expect(plan.duplicatesSkipped).toBe(1);
    expect(plan.skipped[0]?.existingId).toBeUndefined();
    // The kept sibling absorbed the repeat's tags + category.
    const kept = plan.items[0];
    expect(kept?.kind).toBe("bookmark");
    if (kept?.kind !== "bookmark") return;
    expect(kept.meta?.tags).toEqual(["a", "b"]);
    expect(kept.meta?.category).toBe("docs");
    expect(kept.meta?.notes).toBe("first");
  });

  it("a duplicate deleted between plan and write records no dangling merge", async () => {
    const plan = planImport({
      items: [
        bm("dup", "https://existing.example/page", { tags: ["x"] }),
      ],
      existingUrls: collectNormalizedUrls(await fake.getTree()),
    });
    // The twin vanishes after planning.
    await fake.remove("existing");
    const res = await writeImport(plan, { now: IMPORT_NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No meta row created for the dead id — nothing dangles.
    expect(await getMeta("existing")).toBeUndefined();
    expect(await db.bookmarkMeta.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// I01 — resumable import
// ---------------------------------------------------------------------------

describe("writeImport — I01 resumable import", () => {
  const forest = (): ImportItem[] => [
    {
      kind: "folder",
      title: "outer",
      children: [
        bm("b1", "https://b1.example/"),
        bm("b2", "https://b2.example/"),
      ],
    },
    bm("b3", "https://b3.example/"),
    bm("b4", "https://b4.example/"),
  ]; // preorder: outer, b1, b2, b3, b4 → total 5

  it("an interrupted run persists root id + cursor and resumes without duplicates", async () => {
    // Interrupt after 3 items by throwing out of the progress callback.
    let fired = 0;
    const first = await writeImport(forest(), {
      now: IMPORT_NOW,
      onProgress: ({ done }) => {
        fired = done;
        if (done === 3) throw new Error("simulated crash");
      },
    });
    expect(fired).toBe(3);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.code).toBe("interrupted");

    const interrupted = await listInterruptedImports();
    expect(interrupted).toHaveLength(1);
    const state = interrupted[0]!;
    expect(state.importRootId).not.toBe("");
    expect(state.cursor).toBe(3);
    expect(state.total).toBe(5);

    const resumed = await resumeImport(state.id, { now: IMPORT_NOW });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.foldersCreated).toBe(1);
    expect(resumed.summary.bookmarksCreated).toBe(4);
    expect(resumed.summary.failures).toEqual([]);

    // No duplicates: the import root holds outer + b3 + b4 exactly once.
    const root = await subtree(resumed.summary.importRootId);
    expect(root.children?.map((c) => c.title)).toEqual(["outer", "b3", "b4"]);
    expect(root.children?.[0]?.children?.map((c) => c.title)).toEqual([
      "b1",
      "b2",
    ]);
    // The row is gone — nothing left to resume.
    expect(await listInterruptedImports()).toHaveLength(0);
  });

  it("Cancel via AbortSignal stops cleanly and deletes the state row", async () => {
    const controller = new AbortController();
    const result = await writeImport(forest(), {
      now: IMPORT_NOW,
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done === 2) controller.abort();
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("cancelled");
    // Partial work kept, row deleted — nothing resumable remains.
    expect(result.summary?.bookmarksCreated).toBe(1);
    expect(await listInterruptedImports()).toHaveLength(0);
    const lost = await resumeImport("whatever");
    expect(lost.ok).toBe(false);
    if (lost.ok) return;
    expect(lost.code).toBe("state_lost");
  });

  it("Cancel via cancelImport() flips the persisted status the driver polls", async () => {
    let importId = "";
    const result = await writeImport(forest(), {
      now: IMPORT_NOW,
      onProgress: async ({ done }) => {
        if (done === 2) {
          importId = (await listInterruptedImports())[0]!.id;
          await cancelImport(importId);
        }
      },
    });
    expect(importId).not.toBe("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("cancelled");
    expect(await listInterruptedImports()).toHaveLength(0);
  });

  it("progress callbacks fire once per item and once up front", async () => {
    const seen: { done: number; total: number }[] = [];
    const result = await writeImport(forest(), {
      now: IMPORT_NOW,
      onProgress: ({ done, total }) => seen.push({ done, total }),
    });
    expect(result.ok).toBe(true);
    // one opening callback + one per item (5 items)
    expect(seen.map((p) => p.done)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.every((p) => p.total === 5)).toBe(true);
  });

  it("a resumed drive records new failures on the persisted row", async () => {
    // Interrupt after the first of three items, then let the remaining
    // create fail — the resumed drive must record it (the old
    // summary-shadowing bug lost resumed failures).
    let importId = "";
    const seeded = await writeImport(forest(), {
      now: IMPORT_NOW,
      onProgress: ({ done }) => {
        if (done === 1) throw new Error("simulated crash");
      },
    });
    expect(seeded.ok).toBe(false);
    importId = (await listInterruptedImports())[0]!.id;

    const original = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "b2"
        ? Promise.reject(new Error("simulated create failure"))
        : original(details),
    );
    const resumed = await resumeImport(importId, { now: IMPORT_NOW });
    vi.restoreAllMocks();
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.summary.failures).toEqual([
      {
        kind: "bookmark",
        title: "b2",
        message: expect.stringContaining("simulated create failure"),
      },
    ]);
    expect(resumed.summary.bookmarksCreated).toBe(3);
  });

  it("a second resumeImport on a live claim reports already_running", async () => {
    const seeded = await writeImport(forest(), {
      now: IMPORT_NOW,
      onProgress: ({ done }) => {
        if (done === 1) throw new Error("simulated crash");
      },
    });
    expect(seeded.ok).toBe(false);
    const importId = (await listInterruptedImports())[0]!.id;

    const [first, second] = await Promise.all([
      resumeImport(importId, { now: IMPORT_NOW }),
      resumeImport(importId, { now: IMPORT_NOW }),
    ]);
    // Exactly one driver wins the claim; the other is refused.
    const outcomes = [first, second].map((r) => (r.ok ? "ok" : r.code));
    expect(outcomes.sort()).toEqual(["already_running", "ok"]);
    expect(await listInterruptedImports()).toHaveLength(0);
  });

  it("a cancelled run leaves its partial folder usable for the undo path", async () => {
    const controller = new AbortController();
    const result = await writeImport(forest(), {
      now: IMPORT_NOW,
      signal: controller.signal,
      onProgress: ({ done }) => {
        if (done === 1) controller.abort();
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary?.importRootId).not.toBe("");
    const removed = await removeTree(result.summary!.importRootId);
    expect(removed).toBeUndefined(); // removeTree resolves; no throw
  });
});
