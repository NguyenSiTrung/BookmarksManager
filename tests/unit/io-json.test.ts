import { describe, expect, it } from "vitest";
import { ExportEnvelope } from "../../src/schemas/export";
import type { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import {
  buildExport,
  buildExportTree,
  MAX_TREE_DEPTH,
  parseExport,
  serializeExport,
  type BuildExportOptions,
} from "../../src/io/export-json";
import { MAX_FILE_BYTES } from "../../src/io/netscape";
import { minimalTagDef, validTagDef } from "../fixtures/meta";
import {
  invalidExportEnvelopes,
  malformedExportEnvelopes,
  minimalExportEnvelope,
  validExportEnvelope,
} from "../fixtures/export";

/**
 * Coverage for the pure v1 JSON envelope in `src/io/export-json.ts`. Trees
 * are hand-built `BookmarksTreeNode[]` literals (the `getTree()`/`getSubTree()`
 * shape) and meta/tag rows are plain literals — the module touches no
 * `chrome`, DOM, or Dexie surface, so no fakes are needed.
 *
 * Field names that must never survive an export or a parse: every level of
 * the envelope schema is a strict object, so secret-bearing keys fail
 * outright instead of being carried through.
 */
const SECRET_KEYS = [
  "keys",
  "apiKey",
  "consents",
  "sentLog",
  "keyMaterials",
  "keyMaterial",
  "decisions",
  "providerSettings",
] as const;

const EXPORTED_AT = "2026-09-26T12:00:00.000Z";

/** The shape `getTree()` returns: a one-element array rooted at "0". */
function chromeTree(): BookmarksTreeNode[] {
  return [
    {
      id: "0",
      title: "",
      children: [
        {
          id: "1",
          parentId: "0",
          index: 0,
          title: "Bookmarks bar",
          dateGroupModified: 1000,
          children: [
            {
              id: "10",
              parentId: "1",
              index: 0,
              title: "Work",
              children: [
                {
                  id: "11",
                  parentId: "10",
                  index: 0,
                  title: "A",
                  url: "https://a.example/",
                  dateAdded: 1,
                },
                {
                  id: "12",
                  parentId: "10",
                  index: 1,
                  title: "B",
                  url: "https://b.example/",
                  dateAdded: 2,
                },
              ],
            },
            {
              id: "13",
              parentId: "1",
              index: 1,
              title: "Direct",
              url: "https://d.example/",
              unmodifiable: "managed",
            },
          ],
        },
        {
          id: "2",
          parentId: "0",
          index: 1,
          title: "Other bookmarks",
          children: [
            {
              id: "20",
              parentId: "2",
              index: 0,
              title: "Solo",
              url: "https://solo.example/",
            },
          ],
        },
        {
          id: "3",
          parentId: "0",
          index: 2,
          title: "Mobile bookmarks",
          children: [],
        },
      ],
    },
  ];
}

/** Meta rows keyed to the chromeTree ids; the last row is an orphan. */
const META_ROWS: BookmarkMeta[] = [
  {
    id: "11",
    tags: ["typescript", "reading list"],
    category: "docs",
    notes: "Reference for the migration writeup.",
    updatedAt: "2026-09-26T10:00:00.000Z",
  },
  // Meta can hang off a folder id too — the join key is the node id.
  { id: "10", tags: [], notes: "Folder note.", updatedAt: "2026-09-26T10:01:00.000Z" },
  {
    id: "13",
    tags: ["typescript"],
    category: "reference",
    updatedAt: "2026-09-26T10:02:00.000Z",
  },
  {
    id: "20",
    tags: ["reading list"],
    notes: "Other-bookmarks item.",
    updatedAt: "2026-09-26T10:03:00.000Z",
  },
  // Row for a node that no longer exists — must be dropped from exports.
  { id: "deleted-node", tags: ["typescript"], updatedAt: "2026-09-26T10:04:00.000Z" },
];

/** "unassigned" is deliberately unused by any meta row. */
const TAG_DEFS: TagDef[] = [
  { ...validTagDef },
  { ...minimalTagDef },
  {
    name: "Unassigned",
    nameKey: "unassigned",
    createdAt: "2026-09-26T09:00:00.000Z",
    updatedAt: "2026-09-26T09:00:00.000Z",
  },
];

/** Unwrap a build result — the "happy path" most tests exercise. */
function mustBuild(options: BuildExportOptions): ExportEnvelope {
  const result = buildExport(options);
  if (!result.ok) {
    throw new Error(`expected ok build, got ${result.code}: ${result.message}`);
  }
  return result.data;
}

/** Unwrap a serialize result — the "happy path" most tests exercise. */
function mustSerialize(envelope: ExportEnvelope): string {
  const result = serializeExport(envelope);
  if (!result.ok) {
    throw new Error(`expected ok serialize, got ${result.code}: ${result.message}`);
  }
  return result.data;
}

describe("buildExportTree", () => {
  it("returns [] for an empty forest", () => {
    expect(buildExportTree([])).toEqual([]);
  });

  it("keeps id/title/url/children and drops every other Chrome field", () => {
    const [node] = buildExportTree([
      {
        id: "9",
        parentId: "1",
        index: 3,
        title: "F",
        dateAdded: 1,
        dateGroupModified: 2,
        unmodifiable: "managed",
        children: [
          {
            id: "8",
            parentId: "9",
            index: 0,
            title: "L",
            url: "https://l.example/",
            dateAdded: 3,
          },
        ],
      },
    ]);
    // Exact equality pins the shape: no parentId/index/dateAdded/
    // dateGroupModified/unmodifiable anywhere in the output graph.
    expect(node).toEqual({
      id: "9",
      title: "F",
      children: [{ id: "8", title: "L", url: "https://l.example/" }],
    });
  });

  it("gives leaf folders an empty children array, not an absent one", () => {
    const [node] = buildExportTree([{ id: "f", title: "Empty" }]);
    expect(node).toEqual({ id: "f", title: "Empty", children: [] });
  });

  it("orders children by numeric index when every sibling carries one", () => {
    const [node] = buildExportTree([
      {
        id: "f",
        title: "F",
        children: [
          { id: "b", index: 1, title: "b", url: "https://b/" },
          { id: "c", index: 2, title: "c", url: "https://c/" },
          { id: "a", index: 0, title: "a", url: "https://a/" },
        ],
      },
    ]);
    expect(node?.children?.map((child) => child.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps array order when any sibling lacks an index", () => {
    const nodes = buildExportTree([
      { id: "b", title: "b", url: "https://b/" },
      { id: "a", index: 0, title: "a", url: "https://a/" },
    ]);
    expect(nodes.map((node) => node.id)).toEqual(["b", "a"]);
  });
});

describe("buildExport — whole library", () => {
  it("unwraps the synthetic root and exports the fixed roots as top level", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    expect(envelope.version).toBe(1);
    expect(envelope.exportedAt).toBe(EXPORTED_AT);
    // "0" itself must not be exported — it has no title and cannot be
    // recreated on import.
    expect(envelope.tree.map((node) => node.id)).toEqual(["1", "2", "3"]);
    expect(envelope.tree[0]?.title).toBe("Bookmarks bar");
  });

  it("keeps meta rows for exported node ids only, in input order", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    // "deleted-node" has no node in the tree and is dropped; the folder row
    // for "10" survives.
    expect(envelope.meta.map((row) => row.id)).toEqual(["11", "10", "13", "20"]);
  });

  it("exports the tag library wholesale, including unused defs", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    expect(envelope.tags.map((def) => def.nameKey)).toEqual([
      "reading list",
      "typescript",
      "unassigned",
    ]);
  });

  it("produces output that satisfies ExportEnvelope with exactly the five keys", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    expect(ExportEnvelope.safeParse(envelope).success).toBe(true);
    expect(Object.keys(envelope).sort()).toEqual(
      ["exportedAt", "meta", "tags", "tree", "version"].sort(),
    );
  });

  it("exports a non-rooted forest verbatim at top level", () => {
    const forest: BookmarksTreeNode[] = [
      { id: "s-1", title: "Slice", children: [] },
      { id: "s-2", title: "Leaf", url: "https://leaf/" },
    ];
    const envelope = mustBuild({
      tree: forest,
      meta: [],
      tags: [],
      exportedAt: EXPORTED_AT,
    });
    expect(envelope.tree.map((node) => node.id)).toEqual(["s-1", "s-2"]);
  });

  it("stamps a default exportedAt that parses as an ISO datetime", () => {
    const envelope = mustBuild({ tree: chromeTree(), meta: [], tags: [] });
    expect(Number.isNaN(Date.parse(envelope.exportedAt))).toBe(false);
  });

  it("fails with invalid_envelope on an invalid exportedAt", () => {
    const result = buildExport({
      tree: chromeTree(),
      meta: [],
      tags: [],
      exportedAt: "noon",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_envelope" });
  });
});

describe("buildExport — folder scope", () => {
  it("exports the folder itself as the single top-level node", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      folderId: "10",
      exportedAt: EXPORTED_AT,
    });
    expect(envelope.tree).toEqual([
      {
        id: "10",
        title: "Work",
        children: [
          { id: "11", title: "A", url: "https://a.example/" },
          { id: "12", title: "B", url: "https://b.example/" },
        ],
      },
    ]);
  });

  it("scopes meta to the subtree (folder row plus descendants)", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      folderId: "10",
      exportedAt: EXPORTED_AT,
    });
    // "13" and "20" are outside the subtree and excluded along with the orphan.
    expect(envelope.meta.map((row) => row.id)).toEqual(["11", "10"]);
  });

  it("still exports the tag library wholesale under folder scope", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      folderId: "10",
      exportedAt: EXPORTED_AT,
    });
    expect(envelope.tags).toHaveLength(3);
  });

  it("finds the scope node anywhere in the supplied forest", () => {
    // getSubTree("2")-shaped input: the caller may pass a subtree slice.
    const subtree = chromeTree()[0]?.children?.[1];
    expect(subtree).toBeDefined();
    if (subtree === undefined) return;
    const envelope = mustBuild({
      tree: [subtree],
      meta: META_ROWS,
      tags: TAG_DEFS,
      folderId: "2",
      exportedAt: EXPORTED_AT,
    });
    expect(envelope.tree[0]?.id).toBe("2");
    expect(envelope.meta.map((row) => row.id)).toEqual(["20"]);
  });

  it("fails with scope_not_found when folderId is absent from the tree", () => {
    const result = buildExport({
      tree: chromeTree(),
      meta: [],
      tags: [],
      folderId: "nope",
    });
    expect(result).toMatchObject({ ok: false, code: "scope_not_found" });
  });
});

describe("serializeExport", () => {
  it("pretty-prints with two-space indent and a trailing newline", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    const json = mustSerialize(envelope);
    expect(json).toBe(`${JSON.stringify(envelope, null, 2)}\n`);
    expect(json.startsWith('{\n  "version": 1,')).toBe(true);
  });

  it("refuses to write an envelope carrying secret-bearing extra keys", () => {
    const dirty = {
      ...validExportEnvelope,
      keys: ["sk-live-000"],
    } as unknown as ExportEnvelope;
    const result = serializeExport(dirty);
    expect(result).toMatchObject({ ok: false, code: "invalid_envelope" });
  });
});

describe("parseExport", () => {
  it("accepts a JSON string", () => {
    const result = parseExport(JSON.stringify(validExportEnvelope));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe(1);
      expect(result.data.tree[0]?.children?.[0]?.url).toBe(
        "https://example.com/article",
      );
    }
  });

  it("accepts an already-parsed value", () => {
    const result = parseExport(validExportEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.meta[0]?.category).toBe("docs");
    }
  });

  it("accepts an empty library", () => {
    const result = parseExport(minimalExportEnvelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tree).toEqual([]);
      expect(result.data.tags).toEqual([]);
      expect(result.data.meta).toEqual([]);
    }
  });

  it("applies schema defaults on the way in (meta.tags)", () => {
    const result = parseExport({
      ...minimalExportEnvelope,
      meta: [{ id: "b", updatedAt: "2026-09-26T10:05:00.000Z" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.meta[0]?.tags).toEqual([]);
  });

  it("rejects malformed JSON with invalid_json", () => {
    for (const input of ["", "{", "not json", "[1,2", "undefined"]) {
      const result = parseExport(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_json");
    }
  });

  it("rejects valid JSON that is not an envelope with invalid_envelope", () => {
    for (const input of ["null", "42", '"a string"', "[]", "{}"]) {
      const result = parseExport(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_envelope");
    }
  });

  it("rejects a wrong version literal with unsupported_version", () => {
    const result = parseExport(malformedExportEnvelopes.versionTwo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported_version");
  });

  it("rejects every schema-invalid fixture with invalid_envelope", () => {
    for (const [name, bad] of Object.entries(invalidExportEnvelopes)) {
      const result = parseExport(bad);
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.code, name).toBe("invalid_envelope");
    }
  });

  it("rejects every malformed/smuggled fixture", () => {
    for (const [name, bad] of Object.entries(malformedExportEnvelopes)) {
      const result = parseExport(bad);
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        const expected = name === "versionTwo" ? "unsupported_version" : "invalid_envelope";
        expect(result.code, name).toBe(expected);
      }
    }
  });

  it("rejects envelopes smuggling secret keys as JSON text too", () => {
    const result = parseExport(
      JSON.stringify({ ...validExportEnvelope, consents: [], sentLog: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_envelope");
  });

  it("rejects string input above MAX_FILE_BYTES before parsing (too_large)", () => {
    // The cap fires before JSON.parse — the body needs no envelope shape.
    const result = parseExport(" ".repeat(MAX_FILE_BYTES + 1));
    expect(result).toMatchObject({ ok: false, code: "too_large" });
  });

  it("rejects a tree nested deeper than MAX_TREE_DEPTH (invalid_envelope)", () => {
    let node: unknown = { id: "leaf", title: "Leaf", url: "https://leaf/" };
    for (let i = 0; i < MAX_TREE_DEPTH + 10; i++) {
      node = { id: `f${i}`, title: `f${i}`, children: [node] };
    }
    const result = parseExport(
      JSON.stringify({ ...minimalExportEnvelope, tree: [node] }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_envelope" });
    if (!result.ok) expect(result.message).toContain("depth");
  });

  it("accepts a tree nested exactly at the MAX_TREE_DEPTH boundary", () => {
    let node: unknown = { id: "leaf", title: "Leaf", url: "https://leaf/" };
    for (let i = 0; i < MAX_TREE_DEPTH; i++) {
      node = { id: `f${i}`, title: `f${i}`, children: [node] };
    }
    const result = parseExport({ ...minimalExportEnvelope, tree: [node] });
    expect(result.ok).toBe(true);
  });
});

describe("round trip", () => {
  it("restores folders, bookmarks, tags, categories, notes and tag defs", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    const result = parseExport(mustSerialize(envelope));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(envelope);
    // Spot-check the fields the plan calls out by name.
    const meta = result.data.meta.find((row) => row.id === "11");
    expect(meta?.tags).toEqual(["typescript", "reading list"]);
    expect(meta?.category).toBe("docs");
    expect(meta?.notes).toBe("Reference for the migration writeup.");
    const def = result.data.tags.find((tag) => tag.nameKey === "reading list");
    expect(def?.name).toBe("Reading List");
    expect(def?.color).toBe("#3178c6");
    expect(def?.description).toBe("Long-form articles to read later.");
  });

  it("round-trips a folder-scoped export", () => {
    const envelope = mustBuild({
      tree: chromeTree(),
      meta: META_ROWS,
      tags: TAG_DEFS,
      folderId: "10",
      exportedAt: EXPORTED_AT,
    });
    const result = parseExport(mustSerialize(envelope));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(envelope);
  });
});

describe("secret-bearing fields never reach the output", () => {
  it("serialized output contains none of the forbidden field names", () => {
    const json = mustSerialize(
      mustBuild({
        tree: chromeTree(),
        meta: META_ROWS,
        tags: TAG_DEFS,
        exportedAt: EXPORTED_AT,
      }),
    );
    for (const key of SECRET_KEYS) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it("buildExport fails rather than silently emit a meta row with extra fields", () => {
    const dirty = { ...META_ROWS[0], apiKey: "sk-live-000" } as BookmarkMeta;
    const result = buildExport({
      tree: chromeTree(),
      meta: [dirty],
      tags: TAG_DEFS,
      exportedAt: EXPORTED_AT,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_envelope" });
  });
});

describe("buildExport — depth cap", () => {
  it("fails with invalid_envelope when the input tree exceeds MAX_TREE_DEPTH", () => {
    let node: BookmarksTreeNode = { id: "leaf", title: "Leaf", url: "https://l/" };
    for (let i = 0; i < MAX_TREE_DEPTH + 10; i++) {
      node = { id: `f${i}`, title: `f${i}`, children: [node] };
    }
    const result = buildExport({ tree: [node], meta: [], tags: [] });
    expect(result).toMatchObject({ ok: false, code: "invalid_envelope" });
  });
});
