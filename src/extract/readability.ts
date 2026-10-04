import { Readability } from "@mozilla/readability";
import { PAGE_EXTRACT_LIMITS, READABILITY_LIMITS } from "./limits";

/**
 * The pure in-page half of spec FR9 extraction: everything Readability can
 * derive from a Document clone, returned as plain strings so nothing
 * DOM-flavoured crosses back to the worker. `extractActivePage`
 * (`./page.ts`) owns the tab checks, the `chrome.scripting` call, the Zod
 * boundary, and document checks. This function caps what the page claims
 * before any strings cross back to the worker.
 *
 * Runs inside the injected unlisted script
 * (`entrypoints/extract.ts`) and under jsdom in unit tests; nothing
 * here touches `chrome.*`.
 */

/** Capped before crossing the process boundary; the worker validates again. */
export interface ReadabilityPage {
  title: string;
  excerpt: string;
  description?: string;
  siteName?: string;
  byline?: string;
  headings: string[];
}

const HEADING_SELECTOR = "h1, h2, h3";

/**
 * Parse `doc` with Readability and return its representation, or `null`
 * when the page yields nothing usable (empty body, unparseable markup, or
 * a page Readability cannot score). Total: exceptions from Readability or
 * DOMParser collapse to `null`.
 *
 * The document is cloned first so hostile page mutations in flight while
 * Readability works cannot reach the live DOM through this code path.
 */
export function runReadabilityExtract(
  doc: Document,
): ReadabilityPage | null {
  try {
    const clone = doc.cloneNode(true) as Document;
    const article = new Readability(clone, READABILITY_LIMITS).parse();
    if (article === null) {
      return null;
    }
    const excerpt = (article.textContent ?? "").trim();
    if (excerpt === "") {
      return null;
    }
    const page: ReadabilityPage = {
      title: (article.title ?? "").trim().slice(0, PAGE_EXTRACT_LIMITS.title),
      excerpt: excerpt.slice(0, PAGE_EXTRACT_LIMITS.excerpt),
      headings: collectHeadings(doc, article.content),
    };
    const metaDesc = readMetaDescription(doc);
    if (
      article.excerpt !== undefined &&
      article.excerpt !== null &&
      article.excerpt !== ""
    ) {
      page.description = article.excerpt.slice(0, PAGE_EXTRACT_LIMITS.description);
    } else if (metaDesc !== null) {
      page.description = metaDesc.slice(0, PAGE_EXTRACT_LIMITS.description);
    }
    if (article.siteName !== undefined && article.siteName !== null) {
      page.siteName = article.siteName.slice(0, PAGE_EXTRACT_LIMITS.siteName);
    } else {
      const siteName = readSiteName(doc);
      if (siteName !== null) page.siteName = siteName.slice(0, PAGE_EXTRACT_LIMITS.siteName);
    }
    if (article.byline !== undefined && article.byline !== null) {
      page.byline = article.byline.slice(0, PAGE_EXTRACT_LIMITS.byline);
    }
    return page;
  } catch {
    return null;
  }
}

/**
 * Headings from the article HTML Readability produced, falling back to the
 * source document's outline when the article carries none. Strings only —
 * no elements escape.
 */
function collectHeadings(doc: Document, content: unknown): string[] {
  const parser =
    doc.defaultView?.DOMParser ??
    (typeof DOMParser !== "undefined" ? DOMParser : undefined);
  if (parser === undefined || typeof content !== "string") {
    return outlineOf(doc);
  }
  try {
    const articleDoc = new parser().parseFromString(content, "text/html");
    const headings = outlineOf(articleDoc);
    return headings.length > 0 ? headings : outlineOf(doc);
  } catch {
    return outlineOf(doc);
  }
}

/** Bounded h1–h3 strings in document order. */
function outlineOf(doc: Document): string[] {
  try {
    const headings: string[] = [];
    for (const element of doc.querySelectorAll(HEADING_SELECTOR)) {
      const text = (element.textContent?.trim() ?? "").slice(0, PAGE_EXTRACT_LIMITS.heading);
      if (text !== "") headings.push(text);
      if (headings.length === PAGE_EXTRACT_LIMITS.headings) break;
    }
    return headings;
  } catch {
    return [];
  }
}

function readMetaDescription(doc: Document): string | null {
  try {
    const content = doc
      .querySelector('meta[name="description"]')
      ?.getAttribute("content");
    return typeof content === "string" && content.trim() !== ""
      ? content.trim()
      : null;
  } catch {
    return null;
  }
}

function readSiteName(doc: Document): string | null {
  try {
    const content = doc
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute("content");
    return typeof content === "string" && content.trim() !== ""
      ? content.trim()
      : null;
  } catch {
    return null;
  }
}
