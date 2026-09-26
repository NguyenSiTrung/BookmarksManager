/**
 * v1 JSON export/import envelope — the portable file format.
 *
 * This module is pure: no `chrome`, no DOM, no Dexie. The UI layer reads the
 * tree via `chrome.bookmarks.getTree()`/`getSubTree()` and meta/tag rows via
 * `src/db/meta.ts` (`listMeta()`/`listTags()`), then hands everything in
 * through {@link buildExport}. Import goes the other way: {@link parseExport}
 * validates a file into an {@link ExportEnvelope} and the import writer
 * (`src/io/import-*.ts`) recreates nodes and remaps meta ids.
 *
 * Id contract (see also `src/schemas/export.ts`): `ExportTreeNode.id` and
 * `BookmarkMeta.id` carry the Chrome node id at export time. They are
 * export-local join keys only — the importer maps them to the new Chrome ids
 * it creates and must never reuse them as real node ids.
 *
 * Envelope shape is fixed by the `ExportEnvelope` schema: `version`,
 * `exportedAt`, `tree`, `tags`, `meta`, nothing else. Every level is a strict
 * object, so envelopes smuggling secret-bearing fields (`keys`, `apiKey`,
 * `consents`, `sentLog`, `keyMaterials`, `decisions`, `providerSettings`, …)
 * fail validation — on the way in via {@link parseExport}, and on the way out
 * via {@link buildExport}/{@link serializeExport}, both of which re-validate
 * instead of trusting the caller.
 */

import { ExportEnvelope, type ExportTreeNode } from "../schemas/export";
import type { BookmarkMeta, TagDef } from "../schemas/meta";
import { ROOT_NODE_ID } from "../sync/chrome-bookmarks";
import type { BookmarksTreeNode } from "../sync/chrome-bookmarks";

/** Why a build/serialize call failed. */
export type ExportErrorCode =
  /** `folderId` does not match any node in the supplied tree. */
  | "scope_not_found"
  /** Caller-supplied data could not produce a schema-valid envelope. */
  | "invalid_envelope";

/** Thrown by {@link buildExport}/{@link serializeExport} — see codes above. */
export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(
    code: ExportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExportError";
    this.code = code;
  }
}

/** Inputs to {@link buildExport}; every field is caller-supplied data. */
export interface BuildExportOptions {
  /**
   * Chrome forest to export. For a whole-library export pass the `getTree()`
   * result (`[{ id: "0", … }]`) — the synthetic root "0" is unwrapped and its
   * children (the fixed root folders) become the top level, since "0" itself
   * has no title and cannot be recreated on import. Any other forest shape
   * (e.g. a `getSubTree()` slice) is exported verbatim at the top level.
   */
  tree: readonly BookmarksTreeNode[];
  /**
   * Meta rows to join in (e.g. `listMeta()`). Rows are scoped to the exported
   * tree by node id: rows for nodes outside the export — including orphans
   * for deleted nodes — are dropped before validation, so a stale row can
   * never leak into the file.
   */
  meta: readonly BookmarkMeta[];
  /**
   * Tag definitions (e.g. `listTags()`), exported wholesale: a whole-library
   * backup must not lose definitions the user has not applied yet, and a
   * folder-scoped export deliberately keeps the full tag library so colors
   * and descriptions survive intact.
   */
  tags: readonly TagDef[];
  /**
   * Single-folder scope: export only this node (it becomes the single
   * top-level `ExportTreeNode`, so the folder's own title is preserved) and
   * only meta rows within its subtree. Any node id works — a bookmark id
   * yields a one-bookmark export. Throws `ExportError("scope_not_found")`
   * when the id is not in `tree`.
   */
  folderId?: string;
  /**
   * `exportedAt` override (must satisfy `z.iso.datetime()`); defaults to
   * `new Date().toISOString()`. Tests pass a fixed value for determinism.
   */
  exportedAt?: string;
}

/** Why a parse call failed. */
export type ParseExportErrorCode =
  /** Input was a string that `JSON.parse` rejected. */
  | "invalid_json"
  /**
   * Input decoded to an object carrying `version` ≠ 1 — reported separately
   * so the UI can say "unsupported file format" rather than "not an export".
   * A missing `version` key is plain `invalid_envelope`.
   */
  | "unsupported_version"
  /** Decoded value failed the `ExportEnvelope` schema. */
  | "invalid_envelope";

/** Total result of {@link parseExport}: never throws. */
export type ParseExportResult =
  | { ok: true; data: ExportEnvelope }
  | { ok: false; code: ParseExportErrorCode; message: string };

/**
 * Convert a Chrome bookmark forest to export nodes. `id`/`title`/`url` are
 * kept and `children` recurses (folders always carry an array, possibly
 * empty); every other Chrome field — `parentId`, `index`, `dateAdded`,
 * `dateGroupModified`, `unmodifiable` — is dropped. Sibling position is the
 * array order, so children are sorted by `index` when every sibling carries
 * one (the same ordering contract as `flattenTree` in `src/sync/tree.ts`),
 * and left in array order otherwise.
 */
export function buildExportTree(
  nodes: readonly BookmarksTreeNode[],
): ExportTreeNode[] {
  return ordered(nodes).map(toExportNode);
}

/**
 * Build a v1 envelope from caller-supplied data. The result is run through
 * `ExportEnvelope` before it is returned, so a returned envelope is always
 * schema-valid; a violation means the caller handed in malformed rows and
 * the call throws `ExportError("invalid_envelope")` (with the first schema
 * issues in the message) rather than emitting a bad file.
 */
export function buildExport(options: BuildExportOptions): ExportEnvelope {
  const tree = buildExportTree(scopeForest(options));
  const exportedIds = new Set<string>();
  collectIds(tree, exportedIds);
  const envelope = {
    version: 1,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    tree,
    tags: options.tags,
    meta: options.meta.filter((row) => exportedIds.has(row.id)),
  } satisfies ExportEnvelopeInput;
  // Schema pass: validates (strict — rejects rows smuggling extra keys) and
  // returns a fresh object graph decoupled from the caller's arrays.
  return parseOrThrow(envelope);
}

/** Internal pre-validation shape — `version`/`exportedAt` may be invalid. */
interface ExportEnvelopeInput {
  version: 1;
  exportedAt: string;
  tree: ExportTreeNode[];
  tags: readonly TagDef[];
  meta: readonly BookmarkMeta[];
}

/**
 * Serialize an envelope to the on-disk file text: pretty-printed with a
 * two-space indent and a trailing newline. The envelope is validated first
 * (strict), so a hand-built object carrying extra keys throws
 * `ExportError("invalid_envelope")` instead of writing secrets to disk.
 */
export function serializeExport(envelope: ExportEnvelope): string {
  return `${JSON.stringify(parseOrThrow(envelope), null, 2)}\n`;
}

/**
 * Parse a JSON export — either raw file text or an already-decoded value —
 * into a validated `ExportEnvelope`. Total: every failure is a result, not
 * an exception. Strict schema validation rejects wrong `version` literals,
 * malformed envelopes, and any smuggled extra key at any level.
 */
export function parseExport(json: string | unknown): ParseExportResult {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch {
      return {
        ok: false,
        code: "invalid_json",
        message: "input is not valid JSON",
      };
    }
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    (value as { version: unknown }).version !== 1
  ) {
    return {
      ok: false,
      code: "unsupported_version",
      message: `unsupported export version ${JSON.stringify(
        (value as { version: unknown }).version,
      )} (expected 1)`,
    };
  }
  const parsed = ExportEnvelope.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_envelope",
      message: `not a valid v1 export: ${describeIssues(parsed.error)}`,
    };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** First few schema issues as `"path: message"` pairs for error text. */
function describeIssues(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
  const parts = error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
  const rest =
    error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : "";
  return parts + rest || "schema validation failed";
}

/** Validate a candidate envelope or throw `ExportError("invalid_envelope")`. */
function parseOrThrow(envelope: ExportEnvelopeInput): ExportEnvelope {
  const parsed = ExportEnvelope.safeParse(envelope);
  if (!parsed.success) {
    throw new ExportError(
      "invalid_envelope",
      `envelope failed schema validation: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * Resolve the scope of a build: with `folderId`, the single matching node
 * (depth-first search over the supplied forest — works for both `getTree()`
 * and `getSubTree()` input); without one, the whole forest with the
 * synthetic root "0" unwrapped.
 */
function scopeForest(
  options: BuildExportOptions,
): readonly BookmarksTreeNode[] {
  if (options.folderId !== undefined) {
    const found = findNode(options.tree, options.folderId);
    if (found === undefined) {
      throw new ExportError(
        "scope_not_found",
        `folderId "${options.folderId}" is not in the supplied tree`,
      );
    }
    return [found];
  }
  return options.tree.flatMap((node) =>
    node.id === ROOT_NODE_ID ? (node.children ?? []) : [node],
  );
}

/** Depth-first search for a node by id. */
function findNode(
  nodes: readonly BookmarksTreeNode[],
  id: string,
): BookmarksTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Chrome delivers children in `index` order already; the explicit sort keeps
 * the contract correct for hand-built input. When any sibling lacks a
 * numeric `index` the array order is trusted as-is (mirrors `flattenTree`).
 */
function ordered(
  nodes: readonly BookmarksTreeNode[],
): readonly BookmarksTreeNode[] {
  if (nodes.every((node) => node.index !== undefined)) {
    return [...nodes].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }
  return nodes;
}

/** Collect every node id in an export tree — the meta join-key domain. */
function collectIds(
  nodes: readonly ExportTreeNode[],
  into: Set<string>,
): void {
  for (const node of nodes) {
    into.add(node.id);
    collectIds(node.children ?? [], into);
  }
}

/** Convert one Chrome node; folders always carry a `children` array. */
function toExportNode(node: BookmarksTreeNode): ExportTreeNode {
  if (node.url === undefined) {
    return {
      id: node.id,
      title: node.title,
      children: buildExportTree(node.children ?? []),
    };
  }
  return { id: node.id, title: node.title, url: node.url };
}
