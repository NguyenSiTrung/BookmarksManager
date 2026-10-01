import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { DB_NAME } from "./db";
import {
  EXTENSION_DIR,
  extensionId,
  headlessFromEnv,
  serviceWorker,
} from "./extension";
import type { Extension } from "./extension";
import { readStoreRows } from "./provider";

/**
 * Audit-hardening data-safety e2e plumbing (Phase 6 Task 2).
 *
 * These helpers expose the browser-facing primitives the data-safety
 * regressions need — guarded IndexedDB probes, native bookmark-tree probes,
 * the real worker message channel, a persistent-profile launcher for
 * restart-based checks, and controlled-failure patches for the SW and page
 * `chrome` surfaces. Everything runs against the BUILT extension loaded by
 * the existing isolated launcher; nothing is stubbed.
 *
 * "Guarded" probes follow the house contract in `./db.ts`: reads are
 * NON-CREATING (`indexedDB.databases()` first) so a probe can never create a
 * stray empty database, and writes refuse when the extension database does
 * not exist yet instead of materializing one.
 */

/** The Dexie database name (see `./db.ts`). */
export const AUDIT_DB_NAME = DB_NAME;

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/** A synthetic bookmark URL bound to one audit scenario. */
export function syntheticUrl(tag: string): string {
  return `https://audit-synthetic.example/${tag}`;
}

/** A folder name no real library would contain, so probes cannot collide. */
export function syntheticFolderName(tag: string): string {
  return `Audit folder ${tag}`;
}

// ---------------------------------------------------------------------------
// Row shapes (kept structural: the store is read by name, not by module)
// ---------------------------------------------------------------------------

/** A `bookmarkMeta` row as the audit probes read it. */
export interface AuditMetaRow {
  id: string;
  tags?: readonly string[];
  category?: string;
  notes?: string;
  summary?: string;
  updatedAt?: string;
}

/** A `undo` row as the audit probes read it. */
export interface AuditUndoRow {
  id?: number;
  kind: string;
  nodes: readonly unknown[];
  meta: readonly unknown[];
  idMap?: Record<string, string>;
  createdAt?: string;
}

/** A `jobs` row as the audit probes read it. */
export interface AuditJobRow {
  id: string;
  kind: string;
  status: string;
  progress: {
    totalBatches: number;
    committedBatches: number;
    processedCount: number;
  };
  batchSize?: number;
  bookmarkIds?: readonly string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    requests: number;
    costUsd?: number;
  };
  restructure?: {
    proposal: {
      folders: readonly { path: string; description: string }[];
    };
    assignments: readonly {
      bookmarkId: string;
      proposedPath: string | null;
      confidence: number | null;
    }[];
  };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Guarded IndexedDB probes
// ---------------------------------------------------------------------------

/**
 * Write rows into one object store of the extension database. Refuses when
 * the database does not exist yet (mirroring `seedTags`): seeding must never
 * be the write that creates it, so a caller has to open a real surface first.
 */
export async function writeStoreRows<Row>(
  page: Page,
  store: string,
  rows: readonly Row[],
): Promise<void> {
  await page.evaluate(
    async ({ dbName, storeName, payload }) => {
      const databases = await indexedDB.databases();
      if (!databases.some((info) => info.name === dbName)) {
        throw new Error(
          `The extension database does not exist yet — open an extension surface before writing ${storeName}.`,
        );
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(storeName, "readwrite");
          const objectStore = transaction.objectStore(storeName);
          for (const row of payload) objectStore.put(row);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { dbName: DB_NAME, storeName: store, payload: [...rows] },
  );
}

/** Every `bookmarkMeta` row (non-creating). */
export function metaRows(page: Page): Promise<AuditMetaRow[]> {
  return readStoreRows<AuditMetaRow>(page, "bookmarkMeta");
}

/** Every `undo` row (non-creating). */
export function undoRows(page: Page): Promise<AuditUndoRow[]> {
  return readStoreRows<AuditUndoRow>(page, "undo");
}

/** Every `jobs` row (non-creating). */
export function jobRows(page: Page): Promise<AuditJobRow[]> {
  return readStoreRows<AuditJobRow>(page, "jobs");
}

// ---------------------------------------------------------------------------
// Native bookmark-tree probes
// ---------------------------------------------------------------------------

/**
 * How many live native bookmarks currently carry `url`. The B13 race asserts
 * this is exactly 1: a double replay of one delete snapshot creates a second
 * node with the same synthetic URL (Chrome never lets two idempotent replays
 * collapse into one). Read from the page's own `chrome.bookmarks.getTree`,
 * i.e. the same native authority the extension mutates.
 */
export async function restoredBookmarkCount(
  page: Page,
  url: string,
): Promise<number> {
  return page.evaluate(
    async (target) => {
      const api = (
        globalThis as unknown as { chrome: { bookmarks: AuditBookmarksApi } }
      ).chrome.bookmarks;
      let count = 0;
      const walk = (nodes: readonly AuditTreeNode[]): void => {
        for (const node of nodes) {
          if (node.url === target) count += 1;
          if (node.children !== undefined) walk(node.children);
        }
      };
      walk(await api.getTree());
      return count;
    },
    url,
  );
}

/**
 * The fixed root ids this Chromium profile actually exposes (children of the
 * synthetic root "0"). A stock offline profile usually has "1" (bar) and "2"
 * (Other); "3" (Mobile) only materializes when mobile bookmarks exist, so
 * specs that need it must detect it rather than assume it — see the B15
 * coverage limitation in `tests/e2e/audit-data-safety.spec.ts`.
 */
export async function fixedRootIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = (
      globalThis as unknown as { chrome: { bookmarks: AuditBookmarksApi } }
    ).chrome.bookmarks;
    const tree = await api.getTree();
    return (tree[0]?.children ?? []).map((child) => child.id);
  });
}

/** The parent id of one live node, or `null` when it no longer resolves. */
export async function bookmarkParentId(
  page: Page,
  id: string,
): Promise<string | null> {
  return page.evaluate(async (nodeId) => {
    const api = (
      globalThis as unknown as { chrome: { bookmarks: AuditBookmarksApi } }
    ).chrome.bookmarks;
    const tree = await api.getTree();
    let found: string | null = null;
    const walk = (nodes: readonly AuditTreeNode[]): void => {
      for (const node of nodes) {
        if (node.id === nodeId) found = node.parentId ?? null;
        if (node.children !== undefined) walk(node.children);
      }
    };
    walk(tree);
    return found;
  }, id);
}

/** Find the first live node whose title matches, returning its id or null. */
export async function bookmarkIdByTitle(
  page: Page,
  title: string,
): Promise<string | null> {
  return page.evaluate(async (wanted) => {
    const api = (
      globalThis as unknown as { chrome: { bookmarks: AuditBookmarksApi } }
    ).chrome.bookmarks;
    const tree = await api.getTree();
    let found: string | null = null;
    const walk = (nodes: readonly AuditTreeNode[]): void => {
      for (const node of nodes) {
        if (node.title === wanted) found = node.id;
        if (node.children !== undefined) walk(node.children);
      }
    };
    walk(tree);
    return found;
  }, title);
}

/** Find the first live child folder of `parentId` with `title`, else null. */
export async function childFolderId(
  page: Page,
  parentId: string,
  title: string,
): Promise<string | null> {
  return page.evaluate(
    async ({ parent, wanted }) => {
      const api = (
        globalThis as unknown as { chrome: { bookmarks: AuditBookmarksApi } }
      ).chrome.bookmarks;
      const children = await api.getChildren(parent);
      const match = children.find(
        (child) => child.title === wanted && child.url === undefined,
      );
      return match?.id ?? null;
    },
    { parent: parentId, wanted: title },
  );
}

// ---------------------------------------------------------------------------
// Worker message channel
// ---------------------------------------------------------------------------

/**
 * Send one message from an extension page and return the worker's raw reply.
 * The restructure protocol trusts any extension-page sender, so evaluating
 * this from a sidepanel/options page exercises the real production entry.
 */
export async function sendWorkerMessage(
  page: Page,
  message: unknown,
): Promise<unknown> {
  return page.evaluate((payload) => {
    const api = (
      globalThis as unknown as {
        chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
      }
    ).chrome;
    return api.runtime.sendMessage(payload);
  }, message);
}

// ---------------------------------------------------------------------------
// Persistent-profile launcher (restart-based checks)
// ---------------------------------------------------------------------------

/**
 * Launch the built extension on a PERSISTENT profile directory so a second
 * launch restores the same extension IndexedDB and Chrome bookmark tree. Used
 * by the reconcile check, where the startup pass of the second launch is the
 * behavior under test. `profileDir` is caller-owned.
 */
export async function launchPersistentExtension(
  profileDir: string,
): Promise<Extension> {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: headlessFromEnv(),
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
    ],
  });
  const id = await extensionId(context);
  return { context, id };
}

/** A temp profile directory the caller must remove. */
export function tempProfileDir(tag: string): string {
  return mkdtempSync(path.join(tmpdir(), `bm-audit-${tag}-`));
}

// ---------------------------------------------------------------------------
// Controlled-failure patches
// ---------------------------------------------------------------------------

/** The `chrome.bookmarks` slice the evaluated patches mutate in place. */
interface AuditTreeNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  children?: AuditTreeNode[];
}

interface AuditCreateDetails {
  parentId?: string;
  index?: number;
  title?: string;
  url?: string;
}

interface AuditBookmarksApi {
  getTree(): Promise<AuditTreeNode[]>;
  getChildren(id: string): Promise<AuditTreeNode[]>;
  create(details: AuditCreateDetails): Promise<AuditTreeNode>;
  move(
    id: string,
    destination: { parentId?: string; index?: number },
  ): Promise<AuditTreeNode>;
}

interface AuditChromeGlobal {
  chrome: { bookmarks: AuditBookmarksApi };
  __auditMoveOriginal?: AuditBookmarksApi["move"];
  __auditMoveCount?: number;
  __auditCreateOriginal?: AuditBookmarksApi["create"];
  /** Gate state for {@link patchPageCreateGate}. */
  __auditCreateEntered?: boolean;
  __auditCreateRelease?: () => void;
  __auditCreateGate?: Promise<void>;
}

/**
 * Patch the SERVICE WORKER's `chrome.bookmarks.move` so the `failOnCall`-th
 * move rejects, simulating a concurrent native failure mid-apply. When
 * `raceChild` is set, the failing call first creates that child inside the
 * destination folder — a user filing into a folder the apply just created,
 * which is exactly the case the fixed compensation must not delete.
 *
 * Only ever used in a fresh test context; call {@link restoreWorkerMove}
 * during teardown. The original bound method is kept on the worker global so
 * restore is exact.
 */
export async function patchWorkerMove(
  context: BrowserContext,
  options: {
    failOnCall: number;
    raceChild?: { title: string; url: string };
  },
): Promise<void> {
  const worker: Worker = await serviceWorker(context);
  await worker.evaluate((config) => {
    const scope = globalThis as unknown as AuditChromeGlobal;
    const bookmarks = scope.chrome.bookmarks;
    if (scope.__auditMoveOriginal === undefined) {
      scope.__auditMoveOriginal = bookmarks.move.bind(bookmarks);
    }
    if (scope.__auditCreateOriginal === undefined) {
      scope.__auditCreateOriginal = bookmarks.create.bind(bookmarks);
    }
    const originalMove = scope.__auditMoveOriginal;
    const originalCreate = scope.__auditCreateOriginal;
    if (originalMove === undefined || originalCreate === undefined) {
      throw new Error("audit patch: original chrome.bookmarks methods missing");
    }
    scope.__auditMoveCount = 0;
    bookmarks.move = async (id, destination) => {
      scope.__auditMoveCount = (scope.__auditMoveCount ?? 0) + 1;
      if (scope.__auditMoveCount === config.failOnCall) {
        const parentId = destination.parentId;
        if (config.raceChild !== undefined && parentId !== undefined) {
          await originalCreate({
            parentId,
            title: config.raceChild.title,
            url: config.raceChild.url,
          });
        }
        throw new Error("audit: injected forward-move failure");
      }
      return originalMove(id, destination);
    };
  }, options);
}

/** Restore the worker's native `chrome.bookmarks.move`. */
export async function restoreWorkerMove(
  context: BrowserContext,
): Promise<void> {
  const worker: Worker = await serviceWorker(context);
  await worker.evaluate(() => {
    const scope = globalThis as unknown as AuditChromeGlobal;
    if (scope.__auditMoveOriginal !== undefined) {
      scope.chrome.bookmarks.move = scope.__auditMoveOriginal;
      delete scope.__auditMoveOriginal;
      delete scope.__auditMoveCount;
      delete scope.__auditCreateOriginal;
    }
  });
}

/**
 * Patch ONE PAGE's `chrome.bookmarks.create` behind a RELEASE GATE. The B13
 * race uses this to freeze a replay after it has peeked the shared undo row
 * but before it recreates the bookmark: the gate keeps the row unpopped, so
 * two contexts that each peek the same snapshot provably overlap. The gate
 * is opened with {@link releasePageCreate} once the spec has observed the
 * entries it needs.
 *
 * Fresh-context only; restore with {@link restorePageCreate}.
 */
export async function patchPageCreateGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as unknown as AuditChromeGlobal;
    const bookmarks = scope.chrome.bookmarks;
    if (scope.__auditCreateOriginal === undefined) {
      scope.__auditCreateOriginal = bookmarks.create.bind(bookmarks);
    }
    const originalCreate = scope.__auditCreateOriginal;
    if (originalCreate === undefined) {
      throw new Error("audit patch: original chrome.bookmarks.create missing");
    }
    scope.__auditCreateEntered = false;
    scope.__auditCreateGate = new Promise<void>((resolve) => {
      scope.__auditCreateRelease = resolve;
    });
    bookmarks.create = async (details) => {
      scope.__auditCreateEntered = true;
      await scope.__auditCreateGate;
      return originalCreate(details);
    };
  });
}

/** `true` once this page's gated `create` has been entered. */
export async function pageCreateEntered(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (globalThis as unknown as AuditChromeGlobal).__auditCreateEntered ===
      true,
  );
}

/** Open this page's create gate (idempotent). */
export async function releasePageCreate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as unknown as AuditChromeGlobal;
    scope.__auditCreateRelease?.();
  });
}

/** Restore one page's native `chrome.bookmarks.create`. */
export async function restorePageCreate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = globalThis as unknown as AuditChromeGlobal;
    if (scope.__auditCreateOriginal !== undefined) {
      scope.chrome.bookmarks.create = scope.__auditCreateOriginal;
      delete scope.__auditCreateOriginal;
      delete scope.__auditCreateGate;
      delete scope.__auditCreateRelease;
      delete scope.__auditCreateEntered;
    }
  });
}
