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
import { writeImport } from "../../src/io/import-write";
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
  await db.importStates.clear();
  await db.importQueues.clear();

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
// ImportDialog — drop path (Task 3 of the dialogs plan)
// ---------------------------------------------------------------------------

describe("ImportDialog — drop path", () => {
  it("routes a dropped .json file to the preview", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    fireEvent.drop(
      screen.getByRole("button", { name: "Drop your bookmarks file here" }),
      {
        dataTransfer: {
          files: [
            new File([importEnvelopeJson()], "bookmarks.json", {
              type: "application/json",
            }),
          ],
        },
      },
    );
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
  });

  it("rejects an obviously-not-bookmarks file with a friendly message", () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    fireEvent.drop(
      screen.getByRole("button", { name: "Drop your bookmarks file here" }),
      { dataTransfer: { files: [new File(["%PDF-1.7"], "manual.pdf")] } },
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "That doesn't look like a bookmarks file",
    );
    expect(screen.queryByTestId("import-preview")).toBeNull();
  });

  it("a drop that misses the zone does nothing (no preview, no error)", () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    fireEvent.drop(screen.getByRole("dialog"), {
      dataTransfer: {
        files: [
          new File([importEnvelopeJson()], "bookmarks.json", {
            type: "application/json",
          }),
        ],
      },
    });
    expect(screen.queryByTestId("import-preview")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
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
// Phase 5 Task 4 — I02 dialog busy guards / resume, I07 notes + revoke delay
// ---------------------------------------------------------------------------

describe("ImportDialog — I02 busy guards and resume", () => {
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const TWO_ITEM_JSON = JSON.stringify({
    version: 1,
    exportedAt: "2026-09-26T12:00:00.000Z",
    tree: [
      { id: "x1", title: "X1", url: "https://x1.example/" },
      { id: "x2", title: "X2", url: "https://x2.example/" },
    ],
    tags: [],
    meta: [],
  });
  const THREE_ITEM_JSON = JSON.stringify({
    version: 1,
    exportedAt: "2026-09-26T12:00:00.000Z",
    tree: [
      { id: "x1", title: "X1", url: "https://x1.example/" },
      { id: "x2", title: "X2", url: "https://x2.example/" },
      { id: "x3", title: "X3", url: "https://x3.example/" },
    ],
    tags: [],
    meta: [],
  });

  it("Esc is inert while a write is in flight; the dialog cannot close", async () => {
    const onOpenChange = vi.fn();
    const gate = deferred<BookmarksTreeNode>();
    const original = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "X2" ? gate.promise : original(details),
    );
    render(<ImportDialog open onOpenChange={onOpenChange} tree={tree} />);
    upload("two.json", TWO_ITEM_JSON);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    clickAndFlush(/confirm import/i);
    // Wait until the write actually started (X1 lands first).
    await vi.waitFor(async () => {
      expect((await importRoot()) !== undefined).toBe(true);
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    gate.resolve({
      id: "x2n",
      parentId: "2",
      title: "X2",
      url: "https://x2.example/",
    } as BookmarksTreeNode);
    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("a thrown persist keeps the dialog closable and retryable", async () => {
    // I02 fix pin: writeImport can reject OUTSIDE its typed results (the
    // importStates.put lands before driveImport's try/catch) — the ref
    // must clear in `finally` or the dialog bricks behind a stuck
    // importing flag.
    const onOpenChange = vi.fn();
    const put = vi
      .spyOn(db.importStates, "put")
      .mockRejectedValueOnce(new Error("simulated put failure"));
    render(<ImportDialog open onOpenChange={onOpenChange} tree={tree} />);
    upload("two.json", TWO_ITEM_JSON);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    clickAndFlush(/confirm import/i);
    expect(
      await screen.findByText(/interrupted: simulated put failure/i),
    ).toBeTruthy();
    // The ref cleared in `finally`: a retry on the same preview starts a
    // fresh run (the mock only rejected once)…
    clickAndFlush(/confirm import/i);
    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    // …and the finished dialog is closable again.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    put.mockRestore();
  });

  it("double Confirm starts exactly one import", async () => {
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    upload("two.json", TWO_ITEM_JSON);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    // Two clicks in the same tick — raw dispatch bypasses the act flush so
    // the second hits the synchronous re-entrancy guard (not just the
    // disabled attr), while the first click's handler has already run.
    const confirm = screen.getByRole("button", { name: /confirm import/i });
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    // Exactly one import root with two bookmarks.
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    const roots = children.filter((c) => c.title.startsWith("Imported "));
    expect(roots).toHaveLength(1);
    const written = await subtree(roots[0]!.id);
    expect(written.children?.map((c) => c.title)).toEqual(["X1", "X2"]);
  });

  it("Cancel import aborts the run and shows the partial summary", async () => {
    const gate = deferred<BookmarksTreeNode>();
    const original = fake.create.bind(fake);
    vi.spyOn(fake, "create").mockImplementation((details) =>
      details.title === "X2" ? gate.promise : original(details),
    );
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    // Three items: the gate blocks X2 while X3 still waits, so the aborted
    // run stops at the next item boundary instead of finishing the queue.
    upload("three.json", THREE_ITEM_JSON);
    expect(await screen.findByTestId("import-preview")).toBeTruthy();
    clickAndFlush(/confirm import/i);
    await vi.waitFor(async () => {
      expect((await importRoot()) !== undefined).toBe(true);
    });
    clickAndFlush(/cancel import/i);
    // The in-flight create resolves but the aborted run stops after it.
    gate.resolve({
      id: "x2n",
      parentId: "2",
      title: "X2",
      url: "https://x2.example/",
    } as BookmarksTreeNode);
    expect(
      await screen.findByText(/import cancelled/i),
    ).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("reopen offers Resume for an interrupted import; Resume completes it", async () => {
    // Seed a genuinely interrupted import through the io layer.
    const seeded = await writeImport(
      [
        { kind: "folder", title: "D", children: [] },
        { kind: "bookmark", title: "Y1", url: "https://y1.example/" },
        { kind: "bookmark", title: "Y2", url: "https://y2.example/" },
      ],
      {
        onProgress: ({ done }) => {
          if (done === 1) throw new Error("simulated crash");
        },
      },
    );
    expect(seeded.ok).toBe(false);

    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    // The resume offer lists the row with its position.
    const resumePanel = await screen.findByTestId("import-resume");
    expect(resumePanel.textContent).toMatch(/1 of 3/);
    clickAndFlush(/resume/i);
    expect(await screen.findByText(/import complete/i)).toBeTruthy();
    // No duplicates: D + Y1 + Y2 exactly once.
    const children = await fake.getChildren(OTHER_BOOKMARKS_ID);
    const roots = children.filter((c) => c.title.startsWith("Imported "));
    expect(roots).toHaveLength(1);
    const written = await subtree(roots[0]!.id);
    expect(written.children?.map((c) => c.title)).toEqual(["D", "Y1", "Y2"]);
  });

  it("Discard drops the interrupted state and returns to pick", async () => {
    await writeImport([{ kind: "bookmark", title: "Y", url: "https://y.example/" }], {
      onProgress: () => {
        throw new Error("simulated crash");
      },
    });
    render(<ImportDialog open onOpenChange={noop} tree={tree} />);
    expect(await screen.findByTestId("import-resume")).toBeTruthy();
    clickAndFlush(/discard/i);
    // Back at the file pick; the persisted row is gone.
    expect(await screen.findByTestId("import-file-input")).toBeTruthy();
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
    // I07: notes are OFF by default for the interop formats — opt in.
    fireEvent.click(screen.getByTestId("include-notes"));
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

  it("JSON includes notes by default and omits them when unchecked (I07)", async () => {
    renderDialog();
    fireEvent.click(exportButton());
    const withNotes = JSON.parse(await exportedBlobs[0]!.text()) as {
      meta: { id: string; notes?: string }[];
    };
    expect(withNotes.meta).toEqual([
      expect.objectContaining({ id: "kb", notes: "note-kb" }),
    ]);

    exportedBlobs = [];
    fireEvent.click(screen.getByTestId("include-notes"));
    fireEvent.click(exportButton());
    const withoutNotes = JSON.parse(await exportedBlobs[0]!.text()) as {
      meta: { id: string; notes?: string }[];
    };
    // The notes FIELD is gone entirely — not just emptied.
    expect(withoutNotes.meta).toEqual([
      expect.objectContaining({ id: "kb" }),
    ]);
    expect(withoutNotes.meta[0] && "notes" in withoutNotes.meta[0]).toBe(false);
  });

  it("CSV omits notes by default (I07)", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /^csv/i }));
    // Default for the interop formats is OFF — no checkbox click.
    fireEvent.click(exportButton());
    const text = await exportedBlobs[0]!.text();
    const kept = text.split("\r\n").find((line) => line.includes("kept.example"));
    expect(kept).toBeDefined();
    expect(kept).not.toContain("note-kb");
    // Column position preserved: category, empty notes, created.
    expect(kept).toContain("docs,,2023-11-14");
  });

  it("the notes checkbox is disabled for Netscape (no notes field) (I07)", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /netscape html/i }));
    const checkbox = screen.getByTestId("include-notes");
    expect(checkbox).toHaveProperty("disabled", true);
  });

  it("revokes the object URL only after the download grace delay (I07)", async () => {
    vi.useFakeTimers();
    const revoked: string[] = [];
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => {
        revoked.push(url);
      },
    });
    renderDialog();
    fireEvent.click(exportButton());
    // The download fired but the URL still lives — revoking in the same
    // task would race the browser's own fetch of the blob.
    expect(exportedBlobs).toHaveLength(1);
    expect(revoked).toHaveLength(0);
    vi.advanceTimersByTime(31_000);
    expect(revoked).toEqual(["blob:mock-1"]);
    vi.useRealTimers();
  });
});
