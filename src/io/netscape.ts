/**
 * Netscape bookmark-file (NETSCAPE-Bookmark-file-1) export and import parsing.
 *
 * Export produces the same dialect Chrome writes: a fixed header, `<DL><p>`
 * containers, `<DT><H3 ADD_DATE="…" LAST_MODIFIED="…">` folder rows, and
 * `<DT><A HREF="…" ADD_DATE="…" TAGS="a,b">` bookmark rows. `ADD_DATE` on the
 * wire is Unix *seconds*; the in-memory types keep Chrome's millisecond
 * convention (`dateAdded`/`dateGroupModified`) on export input and the wire's
 * second convention (`addDate`/`lastModified`) on parse output — both fields
 * are documented on the interfaces below.
 *
 * Import parsing uses `DOMParser` with `text/html` and walks the resulting
 * element tree; no HTML string is ever injected into a live document. The
 * walker tolerates the format's sloppy realities: the `<DL>` holding a
 * folder's children may sit inside the folder's `<DT>` (no `</DT>` written),
 * inside an unclosed `<H3>`, or as the `<DT>`'s next sibling (explicit
 * `</DT>` style); orphan `<DL>`/`<DT>`/`<A>` elements are merged at the level
 * they appear rather than dropped — including rows living entirely outside
 * any `<DL>` (a file that lost its root `<DL>` still parses; see the orphan
 * pass in {@link parseNetscape}).
 */

/**
 * Maximum accepted input size: 20 MiB. Bookmark files are user-picked local
 * files, and a multi-hundred-megabyte "HTML" file is either hostile or a
 * mistake; the check runs on the UTF-8 byte length before any parsing work.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * URL schemes whose bookmark rows are skipped wholesale. `javascript:` and
 * `vbscript:` are script sinks that must never be re-created as clickable
 * bookmarks; `data:` carries whole payloads and is equally unwelcome. The
 * check is case-insensitive and is performed after stripping ASCII whitespace
 * and control characters (`java\tscript:` obfuscation included) — see
 * {@link isBlockedScheme}.
 */
export const BLOCKED_URL_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "data",
  "vbscript",
]);

/**
 * Minimal structural input for {@link exportNetscape}. `url` present ⇒
 * bookmark, absent ⇒ folder (the Chrome `BookmarkTreeNode` convention), so
 * `BookmarksTreeNode[]`, `ExportTreeNode[]`-adjacent shapes, and hand-built
 * fixtures all fit without mapping.
 */
export interface ExportableNode {
  title: string;
  /** Present ⇒ bookmark row; absent ⇒ folder row with `children`. */
  url?: string;
  /** Folder contents; ignored when `url` is set. */
  children?: ExportableNode[];
  /** Milliseconds since the epoch (Chrome convention) → `ADD_DATE` seconds. */
  dateAdded?: number;
  /** Milliseconds since the epoch → `LAST_MODIFIED` seconds (folders only). */
  dateGroupModified?: number;
  /** Written as the `TAGS="a,b"` attribute; omitted when empty. */
  tags?: string[];
}

/** A parsed bookmark row. */
export interface NetscapeBookmark {
  kind: "bookmark";
  title: string;
  /** The `HREF` value verbatim (entity-decoded, edge-trimmed). */
  url: string;
  /** Unix seconds, exactly as written in `ADD_DATE`; absent if unparsable. */
  addDate?: number;
  /** `TAGS="a,b"` split on commas, trimmed, empties dropped. `[]` when absent. */
  tags: string[];
}

/** A parsed folder row; `children` preserves file order. */
export interface NetscapeFolder {
  kind: "folder";
  title: string;
  /** Unix seconds from `ADD_DATE`. */
  addDate?: number;
  /** Unix seconds from `LAST_MODIFIED`. */
  lastModified?: number;
  children: NetscapeNode[];
}

export type NetscapeNode = NetscapeBookmark | NetscapeFolder;

/**
 * Counts for the import preview: `folders`/`bookmarks` are rows kept in the
 * tree; `skipped` are `<A>` rows dropped for a blocked URL scheme; `invalid`
 * are `<A>` rows dropped for a missing or empty `HREF`. `<DT>` rows containing
 * neither `<A>` nor `<H3>` are ignored without counting — they carry no
 * importable content.
 */
export interface NetscapeParseStats {
  folders: number;
  bookmarks: number;
  skipped: number;
  invalid: number;
}

/** `"too_large"` — input exceeded {@link MAX_FILE_BYTES}; `"not_netscape"` — the input parsed to a DOM containing zero elements (i.e. wasn't HTML at all). */
export type NetscapeParseErrorCode = "too_large" | "not_netscape";

/**
 * Total result union — the house pattern for fallible IO. `tree` holds the
 * top-level rows of every top-level `<DL>` in document order.
 */
export type NetscapeParseResult =
  | { ok: true; tree: NetscapeNode[]; stats: NetscapeParseStats }
  | { ok: false; code: NetscapeParseErrorCode; message: string };

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Escapes the four characters that corrupt markup in text and attributes. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** ` ADD_DATE="…"` — Chrome's ms epoch converted to the wire's seconds. */
function addDateAttr(dateAdded: number | undefined): string {
  if (dateAdded === undefined || !Number.isFinite(dateAdded)) {
    return "";
  }
  return ` ADD_DATE="${Math.floor(dateAdded / 1000)}"`;
}

/** ` LAST_MODIFIED="…"` — same conversion, folders only. */
function lastModifiedAttr(dateGroupModified: number | undefined): string {
  if (dateGroupModified === undefined || !Number.isFinite(dateGroupModified)) {
    return "";
  }
  return ` LAST_MODIFIED="${Math.floor(dateGroupModified / 1000)}"`;
}

/** ` TAGS="a,b"` — omitted entirely when there are no tags. */
function tagsAttr(tags: string[] | undefined): string {
  if (tags === undefined || tags.length === 0) {
    return "";
  }
  return ` TAGS="${escapeHtml(tags.join(","))}"`;
}

function emitNodes(
  nodes: readonly ExportableNode[],
  depth: number,
  lines: string[],
): void {
  const pad = "    ".repeat(depth);
  for (const node of nodes) {
    if (node.url !== undefined) {
      lines.push(
        `${pad}<DT><A HREF="${escapeHtml(node.url)}"${addDateAttr(node.dateAdded)}${tagsAttr(node.tags)}>${escapeHtml(node.title)}</A>`,
      );
    } else {
      lines.push(
        `${pad}<DT><H3${addDateAttr(node.dateAdded)}${lastModifiedAttr(node.dateGroupModified)}>${escapeHtml(node.title)}</H3>`,
      );
      lines.push(`${pad}<DL><p>`);
      emitNodes(node.children ?? [], depth + 1, lines);
      lines.push(`${pad}</DL><p>`);
    }
  }
}

/**
 * Serialize a node forest as a Netscape bookmark file. Pure string building —
 * infallible, so it returns `string` rather than a result union. `heading`
 * becomes the `<H1>` text (`"Bookmarks"` like Chrome when omitted).
 */
export function exportNetscape(
  nodes: readonly ExportableNode[],
  heading = "Bookmarks",
): string {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    `<H1>${escapeHtml(heading)}</H1>`,
    "<DL><p>",
  ];
  emitNodes(nodes, 1, lines);
  lines.push("</DL><p>");
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

// nodeType literals — used instead of the Node constants so the module never
// touches globals beyond DOMParser (safe in any DOM-providing realm).
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Element tags that carry *structure* rather than title text. Unclosed
 * `<H3>`/`<A>` elements can end up *containing* the `<DL>`/`<DT>` markup that
 * was meant to follow them; dropping these subtrees keeps the title clean
 * while the walker still finds the folder contents through the element tree.
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set(["DL", "DT", "DD"]);

/**
 * Text of `el` excluding structural subtrees (see {@link STRUCTURAL_TAGS}).
 * Inline markup (`<B>`, `<I>`, …) keeps its text. The result is trimmed — an
 * unclosed element otherwise trails the source's indent whitespace into the
 * title.
 */
function ownText(el: Element): string {
  let text = "";
  for (const node of el.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      text += node.nodeValue ?? "";
    } else if (
      node.nodeType === ELEMENT_NODE &&
      !STRUCTURAL_TAGS.has((node as Element).tagName)
    ) {
      text += ownText(node as Element);
    }
  }
  return text.trim();
}

/** Integer attribute, `undefined` when absent or unparsable. */
function parseIntAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null) {
    return undefined;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** `TAGS="a,b"` → `["a","b"]`; absent attribute → `[]`. */
function parseTags(el: Element): string[] {
  const raw = el.getAttribute("tags");
  if (raw === null) {
    return [];
  }
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Scheme check matching browser behavior: ASCII whitespace/control characters
 * are removed before reading the scheme (that's how `java\tscript:` still
 * executes in an href), so obfuscated spellings cannot slip a blocked scheme
 * through. Schemeless URLs pass — they are odd but not dangerous, and the
 * import writer decides whether to keep them.
 *
 * Exported as THE shared blocklist check — `src/io/import-plan.ts` applies it
 * at planning time and `src/io/import-write.ts` re-applies it at write time,
 * so a blocked URL can never be recreated no matter the input format.
 */
export function isBlockedScheme(url: string): boolean {
  // Browser-style scheme detection strips ASCII control chars (\x00-\x1f)
  // and spaces too — the control-char range below is intentional.
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\x00-\x20]/g, "");
  const match = SCHEME_PATTERN.exec(compact);
  const scheme = match?.[1];
  return scheme !== undefined && BLOCKED_URL_SCHEMES.has(scheme.toLowerCase());
}

/** Appends a bookmark for `a` — or bumps `skipped`/`invalid` and returns. */
function pushAnchor(
  a: Element,
  out: NetscapeNode[],
  stats: NetscapeParseStats,
): void {
  const href = a.getAttribute("href");
  if (href === null || href.trim() === "") {
    stats.invalid += 1;
    return;
  }
  const url = href.trim();
  if (isBlockedScheme(url)) {
    stats.skipped += 1;
    return;
  }
  const bookmark: NetscapeBookmark = {
    kind: "bookmark",
    title: ownText(a),
    url,
    tags: parseTags(a),
  };
  const addDate = parseIntAttr(a, "ADD_DATE");
  if (addDate !== undefined) {
    bookmark.addDate = addDate;
  }
  stats.bookmarks += 1;
  out.push(bookmark);
}

interface DtOutcome {
  /** Set when the DT held an `<H3>` — i.e. it was a folder row. */
  folder: NetscapeFolder | null;
  /**
   * True when the folder's content `<DL>` was found inside the DT (or inside
   * its `<H3>`); false means the caller may consume a following sibling `<DL>`
   * (the explicit-`</DT>` shape).
   */
  hasOwnDl: boolean;
}

/**
 * After a folder DT without an internal DL, consume the next sibling element
 * if it is a `<DL>` (skipping `<p>`/`<hr>` noise but never crossing another
 * `<DT>`). Returns the index actually consumed, or `i` unchanged.
 */
function consumeSiblingDl(
  siblings: Element[],
  i: number,
  folder: NetscapeFolder,
  stats: NetscapeParseStats,
  walkedDl: Set<Element>,
): number {
  let j = i + 1;
  while (j < siblings.length) {
    const tag = siblings[j]?.tagName;
    if (tag === "DL") {
      walkDl(siblings[j] as Element, folder.children, stats, walkedDl);
      return j;
    }
    if (tag === "DT") {
      return i;
    }
    j += 1;
  }
  return i;
}

/**
 * Walk a `<DL>` element, deduped through `walkedDl`: malformed markup can make
 * one element reachable from two walks (e.g. a `<DL>` inside an orphan `<DT>`
 * is also a top-level `<DL>` candidate), and the set guarantees its rows are
 * collected exactly once. Marks BEFORE recursing so a nested `<DL>` inside it
 * is handled by the inner walk, never re-entered here.
 */
function walkDl(
  dl: Element,
  out: NetscapeNode[],
  stats: NetscapeParseStats,
  walkedDl: Set<Element>,
): void {
  if (walkedDl.has(dl)) return;
  walkedDl.add(dl);
  walkContainer(dl, out, stats, walkedDl);
}

/**
 * Handles one `<DT>` element: folder when a direct-child `<H3>` exists
 * (content DLs may live inside the DT, inside the H3, or on the following
 * sibling — reported via {@link DtOutcome.hasOwnDl}), bookmark when a
 * direct-child `<A>` exists, otherwise merges any stray content it contains.
 * Degenerate `<DT>` children of a folder DT are treated as folder contents.
 */
function processDt(
  dt: Element,
  out: NetscapeNode[],
  stats: NetscapeParseStats,
  walkedDl: Set<Element>,
): DtOutcome {
  const kids = Array.from(dt.children);
  const h3 = kids.find((k) => k.tagName === "H3");
  const anchor = kids.find((k) => k.tagName === "A");

  if (h3 !== undefined) {
    const folder: NetscapeFolder = {
      kind: "folder",
      title: ownText(h3),
      children: [],
    };
    const addDate = parseIntAttr(h3, "ADD_DATE");
    if (addDate !== undefined) {
      folder.addDate = addDate;
    }
    const lastModified = parseIntAttr(h3, "LAST_MODIFIED");
    if (lastModified !== undefined) {
      folder.lastModified = lastModified;
    }
    stats.folders += 1;
    out.push(folder);

    // The folder's content <DL> may sit anywhere inside the DT — as a direct
    // child (no </DT> written), inside the H3 (unclosed <H3>), or deeper.
    // `closest("dt")` scopes the check: a DL belonging to a *nested* folder DT
    // does not count, and neither does the sibling-DL form, which the caller
    // consumes only when no internal DL exists.
    const hasOwnDl = Array.from(dt.querySelectorAll("dl")).some(
      (dl) => dl.closest("dt") === dt,
    );
    // Walk the DT itself as a container: H3/DD are transparent passthroughs
    // there, so swallowed children are reached wherever they landed.
    walkContainer(dt, folder.children, stats, walkedDl);
    return { folder, hasOwnDl };
  }

  if (anchor !== undefined) {
    pushAnchor(anchor, out, stats);
    // Stray rows riding inside a bookmark DT (or inside the A itself) merge
    // at the same level — dropping them would silently lose bookmarks from
    // malformed files. The anchor itself is skipped so it isn't pushed twice.
    walkContainer(dt, out, stats, walkedDl, anchor);
    walkContainer(anchor, out, stats, walkedDl);
    return { folder: null, hasOwnDl: false };
  }

  // Neither heading nor anchor — merge stray content, ignore the rest.
  walkContainer(dt, out, stats, walkedDl);
  return { folder: null, hasOwnDl: false };
}

/** Headings and description cells are transparent containers: malformed
 * markup can bury real rows inside them, so the walk descends rather than
 * skipping them outright. */
const TRANSPARENT_PATTERN = /^(?:H[1-6]|DD)$/;

/**
 * Iterates a container's element children as Netscape rows: `DT` via
 * {@link processDt}, orphan `DL` merged at this level, stray `A` treated as a
 * bookmark row, headings/`DD` descended into; `P`/`HR`/etc. are ignored.
 */
function walkContainer(
  container: Element,
  out: NetscapeNode[],
  stats: NetscapeParseStats,
  walkedDl: Set<Element>,
  skip?: Element,
): void {
  const kids = Array.from(container.children);
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i];
    if (el === undefined || el === skip) {
      continue;
    }
    if (el.tagName === "DT") {
      const outcome = processDt(el, out, stats, walkedDl);
      if (outcome.folder !== null && !outcome.hasOwnDl) {
        i = consumeSiblingDl(kids, i, outcome.folder, stats, walkedDl);
      }
    } else if (el.tagName === "DL") {
      walkDl(el, out, stats, walkedDl);
    } else if (el.tagName === "A") {
      pushAnchor(el, out, stats);
    } else if (TRANSPARENT_PATTERN.test(el.tagName)) {
      walkContainer(el, out, stats, walkedDl);
    }
  }
}

/**
 * Parse a Netscape bookmark file into a typed tree plus preview counts.
 *
 * Never throws on malformed markup — `DOMParser`/`text/html` tolerates
 * anything, and the walker only inspects element structure. The two typed
 * failures: `too_large` when the UTF-8 byte length exceeds
 * {@link MAX_FILE_BYTES} (checked before parsing), and `not_netscape` when
 * the input produces a DOM with zero elements, i.e. it wasn't HTML at all.
 * HTML that simply contains no `<DL>` parses to an empty tree — preview
 * counts of zero tell that story.
 */
export function parseNetscape(html: string): NetscapeParseResult {
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `File is ${bytes} bytes; Netscape imports are capped at ${MAX_FILE_BYTES} bytes (20 MiB).`,
    };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  // A non-HTML string still parses — into an implicit <body> holding only a
  // text node. Zero elements below <body> ⇒ the input wasn't markup.
  if (body === null || body.querySelector("*") === null) {
    return {
      ok: false,
      code: "not_netscape",
      message:
        "Input contains no HTML markup; expected a NETSCAPE-Bookmark-file-1 export.",
    };
  }

  const stats: NetscapeParseStats = {
    folders: 0,
    bookmarks: 0,
    skipped: 0,
    invalid: 0,
  };
  const tree: NetscapeNode[] = [];
  // `<DL>` elements already walked, so a `<DL>` reachable from two candidate
  // roots (e.g. nested inside an orphan `<DT>` while also being a top-level
  // `<DL>` by the ancestry rule) contributes its rows exactly once.
  const walkedDl = new Set<Element>();

  // Rows that live entirely outside any <DL> — a file that dropped its root
  // <DL> still parses. An element qualifies only when NO structural ancestor
  // (dl/dt/dd) contains it: anything inside one is reached by that container's
  // own walk, so the ancestor check is also what prevents double counting
  // (an <A> inside an orphan <DT> is pushed by processDt, not again here).
  // This pass runs BEFORE the <DL> loop so a <DL> nested inside an orphan
  // <DT> folds into the folder (marked walked) instead of re-walking at top
  // level. A folder <DT> that lacks an internal <DL> also consumes a
  // FOLLOWING sibling <DL> — the same sibling-consumption rule as inside a
  // <DL> container — so the explicit `</DT><DL>` style still nests.
  for (const el of doc.querySelectorAll("dt, a, dd")) {
    if (el.parentElement?.closest("dl, dt, dd")) {
      continue;
    }
    if (el.tagName === "DT") {
      const outcome = processDt(el, tree, stats, walkedDl);
      if (
        outcome.folder !== null &&
        !outcome.hasOwnDl &&
        el.parentElement !== null
      ) {
        const siblings = Array.from(el.parentElement.children);
        const idx = siblings.indexOf(el);
        if (idx !== -1) {
          consumeSiblingDl(siblings, idx, outcome.folder, stats, walkedDl);
        }
      }
    } else if (el.tagName === "A") {
      pushAnchor(el, tree, stats);
    } else {
      // DD — transparent container, descend.
      walkContainer(el, tree, stats, walkedDl);
    }
  }

  // Only top-level DLs start the main walk — nested ones are reached through
  // their owning folder DTs (or merged by the DL branch when orphaned), and
  // ones already consumed by the orphan pass above are skipped.
  for (const dl of doc.querySelectorAll("dl")) {
    if (walkedDl.has(dl) || dl.parentElement?.closest("dl") !== null) {
      continue;
    }
    walkDl(dl, tree, stats, walkedDl);
  }
  return { ok: true, tree, stats };
}
