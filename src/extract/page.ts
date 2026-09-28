import { z } from "../schemas/z";

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
 * - every returned string is truncated to {@link PAGE_EXTRACT_LIMITS}
 *   before it can reach a prompt — the excerpt never persists.
 */

/** Deterministic caps applied AFTER schema validation, before any use. */
export const PAGE_EXTRACT_LIMITS = {
  title: 300,
  description: 1000,
  siteName: 200,
  byline: 200,
  heading: 200,
  headings: 50,
  excerpt: 20_000,
} as const;

/** Bounded, page-facing representation — the only shape callers receive. */
export interface PageExtract {
  url: string;
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
  title: z.string(),
  excerpt: z.string(),
  description: z.string().optional(),
  siteName: z.string().optional(),
  byline: z.string().optional(),
  headings: z.array(z.string()),
});

interface ChromeTabLike {
  id?: number;
  incognito?: boolean;
  url?: string;
}

interface ChromeTabsSlice {
  get(tabId: number): Promise<ChromeTabLike>;
}

interface InjectionResult {
  result?: unknown;
}

interface ChromeScriptingSlice {
  executeScript(injection: {
    target: { tabId: number };
    files?: string[];
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

/**
 * Extract a bounded representation of the page in `tabId`.
 *
 * Order matters: the tab is fetched (absent → `no_tab`), incognito and
 * non-http(s)/restricted URLs refuse BEFORE `chrome.scripting` runs, the
 * injected script's return crosses a Zod boundary, and only then do the
 * deterministic caps apply. `extract` carries the tab's own URL so callers
 * can match it against the bookmark being summarized.
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
  } catch (cause) {
    return failure(
      "no_tab",
      cause instanceof Error ? cause.message : String(cause),
    );
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
  } catch (cause) {
    return failure(
      "injection",
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  const parsed = ScriptResult.safeParse(results?.[0]?.result);
  if (!parsed.success || parsed.data.excerpt.trim() === "") {
    return failure(
      "empty",
      "The page did not yield a readable article to summarize.",
    );
  }

  const data = parsed.data;
  const extract: PageExtract = {
    url: tab.url ?? "",
    title: truncate(data.title.trim(), PAGE_EXTRACT_LIMITS.title),
    excerpt: truncate(data.excerpt, PAGE_EXTRACT_LIMITS.excerpt),
    headings: data.headings
      .slice(0, PAGE_EXTRACT_LIMITS.headings)
      .map((h) => truncate(h.trim(), PAGE_EXTRACT_LIMITS.heading))
      .filter((h) => h !== ""),
  };
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
