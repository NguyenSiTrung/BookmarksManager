import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import { getMeta, getTag } from "../../src/db/meta";
import { undoLatest } from "../../src/undo/restore";
import { ExportDialog } from "../../src/entrypoints/sidepanel/ExportDialog";
import { ImportDialog } from "../../src/entrypoints/sidepanel/ImportDialog";
import type { BookmarkMeta, TagDef } from "../../src/schemas/meta";
import { OTHER_BOOKMARKS_ID } from "../../src/sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../../src/sync/chrome-bookmarks";
import { flattenTree } from "../../src/sync/tree";
import type { FlattenedTree } from "../../src/sync/tree";
import type { FakeBookmarksApi } from "../fakes/chrome-bookmarks";
import { installBookmarksFake } from "../fakes/chrome-bookmarks";

/**
 * Phase 4 Task 7 — import/export dialogs.
 *
 * ImportDialog: file picker (.json/.html/.htm/.csv), format detection, parse
 * errors as typed code+message, preview counts, "Import duplicates anyway"
 * re-plan, Confirm writes through `writeImport` into a new `Imported <…>`
 * folder under Other bookmarks, summary with "Delete import folder" undo.
 *
 * ExportDialog: format radio (JSON/Netscape/CSV), scope radio (whole library
 * / current folder), download through Blob + `URL.createObjectURL` +
 * `<a download>` click — no `downloads` permission, no network.
 *
 * `chrome.bookmarks` is the in-memory fake; IndexedDB is fake-indexeddb
 * (writeImport's meta/tag sidecar rows are real writes). `URL.createObjectURL`
 * is stubbed because jsdom does not implement it.
 */

const ISO = "2026-09-26T10:00:00.000Z";
const EXISTING_URL = "https://existing.example/page";
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

const METAS: BookmarkMeta[] = [
  {
    id: "kb",
    tags: ["reading"],
    category: "docs",
    notes: "note-kb",
    updatedAt: ISO,
  },
];

const TAG_DEFS: TagDef[] = [
  {
    name: "Reading",
    nameKey: "reading",
    color: "#3178c6",
    createdAt: ISO,
    updatedAt: ISO,
  },
];

let fake: FakeBookmarksApi;
let tree: FlattenedTree;

/** Captured `<a download>` clicks — jsdom would try to navigate otherwise. */
let clickedAnchor: HTMLAnchorElement | undefined;
/** Blobs handed to `URL.createObjectURL`, in order. */
let exportedBlobs: Blob[];

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  await db.open();
});

beforeEach(async () => {
  fake = installBookmarksFake({
    now: () => FIXED_NOW,
    otherBookmarks: [
      { id: "existing", title: "Existing", url: EXISTING_URL },
      {
        id: "fold",
        title: "Keep",
        children: [{ id: "kb", title: "Kept", url: "https://kept.example/" }],
      },
    ],
  });
  tree = flattenTree(await fake.getTree());
  await db.bookmarkMeta.clear();
  await db.tags.clear();
  await db.undo.clear();

  clickedAnchor = undefined;
  exportedBlobs = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      exportedBlobs.push(blob);
      return `blob:mock-${exportedBlobs.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- capturing the spy's receiver
      clickedAnchor = this;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const url = URL as unknown as Record<string, unknown>;
  delete url.createObjectURL;
  delete url.revokeObjectURL;
});

afterAll(() => {
  db.close();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT;
});

const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** v1 envelope: 1 folder (Work>A), 1 duplicate, 1 blocked-scheme bookmark. */
function importEnvelopeJson(): string {
  return JSON.stringify({
    version: 1,
    exportedAt: "2026-09-26T12:00:00.000Z",
    tree: [
      {
        id: "wf",
        title: "Work",
        children: [{ id: "wa", title: "A", url: "https://a.example/" }],
      },
      {
        id: "dup",
        title: "Dup",
        url: "https://www.existing.example/page?utm_source=x#frag",
      },
      { id: "bad", title: "Bad", url: "javascript:alert(1)" },
    ],
    tags: [
      {
        name: "Reading",
        nameKey: "reading",
        color: "#3178c6",
        createdAt: ISO,
        updatedAt: ISO,
      },
    ],
    meta: [{ id: "wa", tags: ["reading"], updatedAt: ISO }],
  });
}

const NETSCAPE_HTML = [
  "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
  "<DL><p>",
  '<DT><H3>Stuff</H3>',
  "<DL><p>",
  '<DT><A HREF="https://n.example/" TAGS="one">N</A>',
  '<DT><A HREF="">empty href</A>',
  '<DT><A HREF="javascript:alert(1)">evil</A>',
  "</DL><p>",
  "</DL><p>",
].join("\n");

const CSV_TEXT = [
  "title,url,folder_path,tags,category,notes,created",
  "A,https://a.example/,Work/Docs,Reading;Docs,article,note-a,2026-01-15T10:30:00Z",
  "B,https://b.example/,Work,,,,",
  "bad,not-a-url,,,,,",
  "nope,,,,,,",
].join("\r\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function upload(name: string, content: string | File): void {
  const file =
    typeof content === "string" ? new File([content], name) : content;
  fireEvent.change(screen.getByTestId("import-file-input"), {
    target: { files: [file] },
  });
}

function count(testid: string): HTMLElement {
  return screen.getByTestId(testid);
}

async function subtree(id: string): Promise<BookmarksTreeNode> {
  const [node] = await fake.getSubTree(id);
  expect(node).toBeDefined();
  return node as BookmarksTreeNode;
}

/** The `Imported <…>` child of Other bookmarks, when present. */
async function importRoot(): Promise<BookmarksTreeNode | undefined> {
  const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
  return children.find((child) => child.title.startsWith("Imported "));
}

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

function clickAndFlush(name: string | RegExp): void {
  // The click handler is fire-and-forget async; the following findBy* /
  // waitFor calls poll inside an act window until the chain settles.
  fireEvent.click(screen.getByRole("button", { name }));
}

// ---------------------------------------------------------------------------
// ImportDialog — pick → preview
// ---------------------------------------------------------------------------

describe("ImportDialog — pick and preview", () => {
  it("detects a .json file and previews folder/bookmark/duplicate/invalid counts", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.json", importEnvelopeJson());

    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    expect(count("count-folders").textContent).toBe("1");
    expect(count("count-bookmarks").textContent).toBe("1");
    expect(count("count-duplicates").textContent).toBe("1");
    expect(count("count-invalid").textContent).toBe("1");
    // Nothing written before Confirm.
    expect(await importRoot()).toBeUndefined();
  });

  it("lists invalid items (blocked-scheme URLs) in the preview details", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.json", importEnvelopeJson());
    const details = await screen.findByTestId("invalid-details");
    expect(details.textContent).toMatch(/javascript:alert/);
  });

  it('"Import duplicates anyway" re-plans the preview', async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.json", importEnvelopeJson());
    const dupCount = await screen.findByTestId("count-duplicates");
    expect(dupCount.textContent).toBe("1");

    fireEvent.click(
      screen.getByRole("checkbox", { name: /import duplicates anyway/i }),
    );

    expect(count("count-duplicates").textContent).toBe("0");
    expect(count("count-bookmarks").textContent).toBe("2");
    // And toggling back re-skips them.
    fireEvent.click(
      screen.getByRole("checkbox", { name: /import duplicates anyway/i }),
    );
    expect(count("count-duplicates").textContent).toBe("1");
  });

  it("surfaces the typed parser error for a malformed JSON file", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("broken.json", "{not json");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/invalid_json/);
    // Still on the picker — no preview panel.
    expect(screen.queryByTestId("import-preview")).toBeNull();
    expect(await importRoot()).toBeUndefined();
  });

  it("rejects an oversized file up-front with a too_large message", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    const big = new File(["x"], "big.json");
    Object.defineProperty(big, "size", {
      configurable: true,
      value: 21 * 1024 * 1024,
    });
    upload("big.json", big);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/too_large/);
    expect(alert.textContent).toMatch(/20 MiB/);
    expect(screen.queryByTestId("import-preview")).toBeNull();
  });

  it("detects a .csv file and reports per-row invalid details", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.csv", CSV_TEXT);

    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    // Work + Docs folders; A + B kept; two invalid data rows.
    expect(count("count-folders").textContent).toBe("2");
    expect(count("count-bookmarks").textContent).toBe("2");
    expect(count("count-invalid").textContent).toBe("2");
    expect(screen.getByTestId("invalid-details").textContent).toMatch(/Row 4:/);
    expect(screen.getByTestId("invalid-details").textContent).toMatch(/Row 5:/);
  });

  it("detects a .html file and folds parser skip counts into invalid", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.html", NETSCAPE_HTML);

    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    // 1 folder, 1 kept bookmark; invalid = empty href (1) + blocked (1).
    expect(count("count-folders").textContent).toBe("1");
    expect(count("count-bookmarks").textContent).toBe("1");
    expect(count("count-invalid").textContent).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// ImportDialog — confirm → summary → undo
// ---------------------------------------------------------------------------

describe("ImportDialog — confirm writes and summary", () => {
  it('Confirm writes into a new "Imported …" folder under Other bookmarks', async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.json", importEnvelopeJson());
    expect(await screen.findByTestId("import-preview")).toBeTruthy();

    clickAndFlush(/confirm import/i);

    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    const root = await importRoot();
    expect(root).toBeDefined();
    if (root === undefined) return;
    const written = await subtree(root.id);
    // Dup was skipped, Bad was invalid: only Work>A lands.
    const work = findByTitle(written, "Work");
    expect(work).toBeDefined();
    expect(work?.children?.map((c) => c.title)).toEqual(["A"]);
    expect(findByTitle(written, "Dup")).toBeUndefined();
    expect(findByTitle(written, "Bad")).toBeUndefined();
    // Meta + tag definition restored from the envelope.
    const a = findByTitle(written, "A");
    expect(await getMeta(a?.id ?? "")).toMatchObject({ tags: ["reading"] });
    expect(await getTag("reading")).toBeDefined();
    // Summary counts: 1 folder + 1 bookmark created, 1 dup + 1 invalid skipped.
    expect(screen.getByTestId("summary").textContent).toMatch(/created/i);
    expect(count("summary-created").textContent).toBe("2");
    expect(count("summary-skipped").textContent).toBe("2");
  });

  it('"Delete import folder" removes the whole written tree', async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.csv", CSV_TEXT);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    clickAndFlush(/confirm import/i);
    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    const root = await importRoot();
    expect(root).toBeDefined();

    clickAndFlush(/delete import folder/i);

    expect(await screen.findByText(/import folder deleted/i)).toBeTruthy();
    expect(await importRoot()).toBeUndefined();
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    expect(children.map((c) => c.title)).toEqual(["Existing", "Keep"]);
  });

  it('"Delete import folder" snapshots first so Undo restores the folder + contents', async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.csv", CSV_TEXT);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    clickAndFlush(/confirm import/i);
    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    expect(await importRoot()).toBeDefined();

    clickAndFlush(/delete import folder/i);
    expect(await screen.findByText(/import folder deleted/i)).toBeTruthy();
    expect(await importRoot()).toBeUndefined();
    // The delete path routes through deleteNodesWithUndo: ONE snapshot pushed.
    expect(await db.undo.count()).toBe(1);

    const result = await undoLatest();
    expect(result.ok).toBe(true);

    const restored = await importRoot();
    expect(restored).toBeDefined();
    if (restored === undefined) return;
    const written = await subtree(restored.id);
    // The folder AND its contents came back.
    expect(findByTitle(written, "Work")).toBeDefined();
    expect(findByTitle(written, "A")).toBeDefined();
  });

  it("csv confirm preserves folder_path nesting and meta", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("bookmarks.csv", CSV_TEXT);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    clickAndFlush(/confirm import/i);
    expect(await screen.findByText(/import complete/i)).toBeTruthy();

    const root = await importRoot();
    if (root === undefined) throw new Error("no import root");
    const written = await subtree(root.id);
    const work = findByTitle(written, "Work");
    const docs = findByTitle(written, "Docs");
    const a = findByTitle(written, "A");
    const b = findByTitle(written, "B");
    expect(docs?.parentId).toBe(work?.id);
    expect(b?.parentId).toBe(work?.id);
    expect(await getMeta(a?.id ?? "")).toMatchObject({
      tags: ["reading", "docs"],
      category: "article",
      notes: "note-a",
    });
  });
});

// ---------------------------------------------------------------------------
// ExportDialog
// ---------------------------------------------------------------------------

describe("ExportDialog", () => {
  function renderDialog(
    extra: { currentFolderId?: string; currentFolderTitle?: string } = {},
  ): void {
    render(
      <ExportDialog
        open
        onOpenChange={noop}
        tree={tree}
        meta={METAS}
        tagDefs={TAG_DEFS}
        {...extra}
      />,
    );
  }

  function exportButton(): HTMLElement {
    return screen.getByRole("button", { name: /^export$/i });
  }

  it("downloads the whole library as JSON via Blob + anchor (no downloads API)", async () => {
    renderDialog();
    fireEvent.click(exportButton());

    expect(await screen.findByText(/^exported /i)).toBeTruthy();
    expect(clickedAnchor).toBeDefined();
    expect(clickedAnchor?.download).toMatch(
      /^bookmarks-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(clickedAnchor?.getAttribute("href")).toBe("blob:mock-1");
    expect(exportedBlobs).toHaveLength(1);
    const blob = exportedBlobs[0] as Blob;
    expect(blob.type).toContain("application/json");

    const envelope = JSON.parse(await blob.text()) as {
      version: number;
      tree: { title: string }[];
      meta: { id: string }[];
      tags: { nameKey: string }[];
    };
    expect(envelope.version).toBe(1);
    // Root "0" unwrapped: the fixed roots are the top level.
    expect(envelope.tree.map((n) => n.title)).toEqual([
      "Bookmarks bar",
      "Other bookmarks",
      "Mobile bookmarks",
    ]);
    expect(envelope.meta).toEqual([expect.objectContaining({ id: "kb" })]);
    expect(envelope.tags.map((t) => t.nameKey)).toEqual(["reading"]);
  });

  it("exports Netscape HTML with display tag names", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /netscape html/i }));
    fireEvent.click(exportButton());

    expect(clickedAnchor?.download).toMatch(/\.html$/);
    const blob = exportedBlobs[0] as Blob;
    expect(blob.type).toContain("text/html");
    const text = await blob.text();
    expect(text.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>")).toBe(true);
    expect(text).toContain('HREF="https://kept.example/"');
    // meta.tags hold nameKeys — the file carries display names.
    expect(text).toContain('TAGS="Reading"');
  });

  it("exports CSV with folder_path, tag names, category, notes and ISO created", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /^csv/i }));
    fireEvent.click(exportButton());

    expect(clickedAnchor?.download).toMatch(/\.csv$/);
    const blob = exportedBlobs[0] as Blob;
    const text = await blob.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(
      "title,url,folder_path,tags,category,notes,created",
    );
    const kept = lines.find((line) => line.includes("kept.example"));
    expect(kept).toBeDefined();
    expect(kept).toContain("Other bookmarks/Keep");
    expect(kept).toContain("Reading");
    expect(kept).toContain("docs");
    expect(kept).toContain("note-kb");
    expect(kept).toContain("2023-11-14T22:13:20.000Z");
  });

  it("scopes the export to the current folder when one is passed", async () => {
    renderDialog({ currentFolderId: "fold", currentFolderTitle: "Keep" });
    fireEvent.click(screen.getByRole("radio", { name: /current folder/i }));
    fireEvent.click(exportButton());

    const blob = exportedBlobs[0] as Blob;
    const envelope = JSON.parse(await blob.text()) as {
      tree: { title: string; children?: { url?: string }[] }[];
      meta: { id: string }[];
    };
    // The folder itself is the single top-level node (its title survives).
    expect(envelope.tree).toHaveLength(1);
    expect(envelope.tree[0]?.title).toBe("Keep");
    expect(envelope.tree[0]?.children?.[0]?.url).toBe(
      "https://kept.example/",
    );
    expect(envelope.meta).toHaveLength(1);
  });

  it("disables the folder scope when no current folder is provided", () => {
    renderDialog();
    const radio = screen.getByRole("radio", { name: /current folder/i });
    expect(radio).toHaveProperty("disabled", true);
  });
});
