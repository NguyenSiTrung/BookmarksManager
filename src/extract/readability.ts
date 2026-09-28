import { Readability } from "@mozilla/readability";

/**
 * The pure in-page half of spec FR9 extraction: everything Readability can
 * derive from a Document clone, returned as plain strings so nothing
 * DOM-flavoured crosses back to the worker. `extractActivePage`
 * (`./page.ts`) owns the tab checks, the `chrome.scripting` call, the Zod
 * boundary, and the deterministic caps — this function only reports what
 * the page claims.
 *
 * Runs inside the injected unlisted script
 * (`entrypoints/extract.ts`) and under jsdom in unit tests; nothing
 * here touches `chrome.*`.
 */

/** Raw (uncapped) page representation — caps apply at the trust boundary. */
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
    const article = new Readability(clone).parse();
    if (article === null) {
      return null;
    }
    const excerpt = (article.textContent ?? "").trim();
    if (excerpt === "") {
      return null;
    }
    const page: ReadabilityPage = {
      title: (article.title ?? "").trim(),
      excerpt,
      headings: collectHeadings(doc, article.content),
    };
    const metaDesc = readMetaDescription(doc);
    if (
      article.excerpt !== undefined &&
      article.excerpt !== null &&
      article.excerpt !== ""
    ) {
      page.description = article.excerpt;
    } else if (metaDesc !== null) {
      page.description = metaDesc;
    }
    if (article.siteName !== undefined && article.siteName !== null) {
      page.siteName = article.siteName;
    } else {
      const siteName = readSiteName(doc);
      if (siteName !== null) page.siteName = siteName;
    }
    if (article.byline !== undefined && article.byline !== null) {
      page.byline = article.byline;
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

/** h1–h3 textContent in document order; the boundary caps them later. */
function outlineOf(doc: Document): string[] {
  try {
    return Array.from(doc.querySelectorAll(HEADING_SELECTOR))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((text) => text !== "");
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
