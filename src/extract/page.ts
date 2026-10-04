import { z } from "../schemas/z";
import { PAGE_EXTRACT_LIMITS } from "./limits";

export { PAGE_EXTRACT_LIMITS } from "./limits";

/**
 * The worker-side half of spec FR9: given a tabId resolved inside an
 * explicit user action (a click on Summarize — `activeTab` grants that one
 * tab), inject the bundled extraction script, validate its return as
 * hostile input, and hand back a bounded page representation or a redacted
 * refusal. The function is total — every failure mode is a typed
 * `{ok:false, code, message}`.
 *
 * Boundaries held here:
 * - incognito tabs are refused before `chrome.scripting` is touched;
 * - only `http:`/`https:` pages extract — chrome://, extension, file:,
 *   about:, and the Chrome Web Store all refuse;
 * - the injected file is the extension's own unlisted script (no static
 *   content scripts, no caller-supplied functions);
 * - strings are capped in-page and rejected above {@link PAGE_EXTRACT_LIMITS}
 *   at this boundary; the excerpt and document identity never persist.
 */

/** Bounded, page-facing representation — the only shape callers receive. */
export interface PageExtract {
  url: string;
  /** Captured in the isolated document, not inferred from a stale tab URL. */
  documentIdentity?: number;
  /** Chrome's document id when returned by executeScript. Local-only. */
  documentId?: string;
  title: string;
  excerpt: string;
  description?: string;
  siteName?: string;
  byline?: string;
  headings: string[];
}

export type PageExtractErrorCode =
  /** `chrome.tabs`/`chrome.scripting` absent or partial in this context. */
  | "unavailable"
  /** The tab could not be resolved (closed, bad id). */
  | "no_tab"
  /** Extraction from incognito is never allowed (spec FR9.5). */
  | "incognito"
  /** Non-http(s) or Chrome-internal URL — nothing to inject into. */
  | "restricted_url"
  /** `chrome.scripting.executeScript` threw or rejected. */
  | "injection"
  /** The tab navigated during extraction; never pair its old URL with new text. */
  | "mismatch"
  /** The script returned nothing usable (Readability found no article). */
  | "empty";

export interface PageExtractFailure {
  ok: false;
  code: PageExtractErrorCode;
  message: string;
}

export interface PageExtractSuccess {
  ok: true;
  extract: PageExtract;
}

export type PageExtractResult = PageExtractSuccess | PageExtractFailure;

/** The injected script's return shape — hostile until this schema passes. */
const ScriptResult = z.strictObject({
  url: z.string().min(1).max(8_192),
  documentIdentity: z.number().positive(),
  title: z.string().max(PAGE_EXTRACT_LIMITS.title),
  excerpt: z.string().max(PAGE_EXTRACT_LIMITS.excerpt),
  description: z.string().max(PAGE_EXTRACT_LIMITS.description).optional(),
  siteName: z.string().max(PAGE_EXTRACT_LIMITS.siteName).optional(),
  byline: z.string().max(PAGE_EXTRACT_LIMITS.byline).optional(),
  headings: z.array(z.string().max(PAGE_EXTRACT_LIMITS.heading)).max(PAGE_EXTRACT_LIMITS.headings),
});
const ScriptIdentity = z.object({
  url: z.string().min(1).max(8_192),
  documentIdentity: z.number().positive(),
});

interface ChromeTabLike {
  id?: number;
  incognito?: boolean;
  url?: string;
  pendingUrl?: string;
}

interface ChromeTabsSlice {
  get(tabId: number): Promise<ChromeTabLike>;
}

interface InjectionResult {
  result?: unknown;
  documentId?: string;
  frameId?: number;
}

interface ChromeScriptingSlice {
  executeScript(injection: {
    target: { tabId: number; documentIds?: string[] };
    files?: string[];
    func?: () => { url: string; documentIdentity: number };
    world?: string;
  }): Promise<InjectionResult[]>;
}

declare const chrome: {
  tabs?: Partial<ChromeTabsSlice> | null;
  scripting?: Partial<ChromeScriptingSlice> | null;
  runtime?: { getURL?(path: string): string } | null;
};

function failure(
  code: PageExtractErrorCode,
  message: string,
): PageExtractFailure {
  return { ok: false, code, message };
}

/** Restricted host allowlist never injects into — Chrome refuses anyway. */
const RESTRICTED_HOSTS = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
]);

/** Whether `url` is an injectable http(s) page address. */
function isExtractableUrl(url: string | undefined): boolean {
  if (typeof url !== "string" || url === "") return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return !RESTRICTED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

/** Content-free probe of the captured document before each provider attempt.
 * Chrome's document target also refuses a replaced/closed document. */
export async function verifyExtractedDocument(
  tabId: number,
  extract: PageExtract,
): Promise<{ ok: true } | PageExtractFailure> {
  try {
    const get = chrome.tabs?.get;
    const execute = chrome.scripting?.executeScript;
    if (typeof get !== "function" || typeof execute !== "function") {
      return failure("unavailable", "The captured document could not be rechecked.");
    }
    const tab = await get.call(chrome.tabs, tabId);
    if (
      tab.incognito === true || tab.url !== extract.url ||
      (tab.pendingUrl !== undefined && tab.pendingUrl !== "")
    ) {
      return failure("mismatch", "The active document changed after extraction.");
    }
    const results = await execute.call(chrome.scripting, {
      target: {
        tabId,
        ...(extract.documentId !== undefined ? { documentIds: [extract.documentId] } : {}),
      },
      world: "ISOLATED",
      // Self-contained, bundled code. No page text is read on this probe.
      func: () => ({ url: location.href, documentIdentity: performance.timeOrigin }),
    });
    const identity = ScriptIdentity.safeParse(results[0]?.result);
    if (
      !identity.success || identity.data.url !== extract.url ||
      identity.data.documentIdentity !== extract.documentIdentity ||
      (results[0]?.frameId !== undefined && results[0].frameId !== 0) ||
      (extract.documentId !== undefined && results[0]?.documentId !== extract.documentId)
    ) {
      return failure("mismatch", "The captured document is no longer active.");
    }
    return { ok: true };
  } catch {
    return failure("mismatch", "The captured document could not be verified.");
  }
}

/**
 * Extract a bounded representation of the page in `tabId`.
 *
 * Order matters: the tab is fetched (absent → `no_tab`), incognito and
 * non-http(s)/restricted URLs refuse BEFORE `chrome.scripting` runs, the
 * injected script's capped return crosses a Zod boundary, and the tab is
 * rechecked. `extract` carries the captured document URL and identity so
 * callers cannot match new page text to an earlier tab URL.
 */
export async function extractActivePage(
  tabId: number,
): Promise<PageExtractResult> {
  let tab: ChromeTabLike;
  try {
    const get = chrome.tabs?.get;
    if (typeof get !== "function") {
      return failure(
        "unavailable",
        "chrome.tabs is not available in this context.",
      );
    }
    tab = await get.call(chrome.tabs, tabId);
  } catch {
    return failure("no_tab", "The requested tab could not be read.");
  }

  if (tab.incognito === true) {
    return failure(
      "incognito",
      "Page text is never extracted from incognito tabs.",
    );
  }
  if (!isExtractableUrl(tab.url)) {
    return failure(
      "restricted_url",
      "This page's address cannot be extracted (only public http/https pages).",
    );
  }

  let results: InjectionResult[];
  try {
    const execute = chrome.scripting?.executeScript;
    if (typeof execute !== "function") {
      return failure(
        "unavailable",
        "chrome.scripting is not available in this context.",
      );
    }
    results = await execute.call(chrome.scripting, {
      target: { tabId },
      files: ["extract.js"],
      world: "ISOLATED",
    });
  } catch {
    return failure("injection", "The page could not be extracted.");
  }

  const parsed = ScriptResult.safeParse(results?.[0]?.result);
  if (!parsed.success || parsed.data.excerpt.trim() === "") {
    return failure(
      "empty",
      "The page did not yield a readable article to summarize.",
    );
  }

  const data = parsed.data;
  let current: ChromeTabLike;
  try {
    const get = chrome.tabs?.get;
    if (typeof get !== "function") {
      return failure("unavailable", "chrome.tabs is not available in this context.");
    }
    current = await get.call(chrome.tabs, tabId);
  } catch {
    return failure("no_tab", "The requested tab could not be rechecked.");
  }
  if (current.incognito === true) {
    return failure("incognito", "Page text is never extracted from incognito tabs.");
  }
  if (
    data.url !== tab.url || current.url !== data.url ||
    (current.pendingUrl !== undefined && current.pendingUrl !== "")
  ) {
    return failure("mismatch", "The active document changed during extraction.");
  }
  if (results[0]?.frameId !== undefined && results[0].frameId !== 0) {
    return failure("mismatch", "The result did not come from the active main document.");
  }
  const extract: PageExtract = {
    url: data.url,
    documentIdentity: data.documentIdentity,
    title: truncate(data.title.trim(), PAGE_EXTRACT_LIMITS.title),
    excerpt: truncate(data.excerpt, PAGE_EXTRACT_LIMITS.excerpt),
    headings: data.headings
      .slice(0, PAGE_EXTRACT_LIMITS.headings)
      .map((h) => truncate(h.trim(), PAGE_EXTRACT_LIMITS.heading))
      .filter((h) => h !== ""),
  };
  const documentId = results[0]?.documentId;
  if (typeof documentId === "string" && documentId.length > 0 && documentId.length <= 100) {
    extract.documentId = documentId;
  }
  if (data.description !== undefined) {
    extract.description = truncate(
      data.description.trim(),
      PAGE_EXTRACT_LIMITS.description,
    );
  }
  if (data.siteName !== undefined) {
    extract.siteName = truncate(
      data.siteName.trim(),
      PAGE_EXTRACT_LIMITS.siteName,
    );
  }
  if (data.byline !== undefined) {
    extract.byline = truncate(data.byline.trim(), PAGE_EXTRACT_LIMITS.byline);
  }
  return { ok: true, extract };
}
