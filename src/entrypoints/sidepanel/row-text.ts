/**
 * Pure text helpers for list and duplicate rows. Kept free of React so the
 * formatting rules (domain, tag cap, folder trail, date) are unit-testable.
 */

/** The URL's hostname without a leading `www.`; the raw text if it has none. */
export function displayDomain(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return host === "" ? url : host;
  } catch {
    return url;
  }
}

/** Split `tags` into the chips to draw and the ones folded into `+N`. */
export function visibleTags(
  tags: readonly string[],
  max: number,
): { shown: string[]; hidden: string[] } {
  return { shown: tags.slice(0, max), hidden: tags.slice(max) };
}

/** Last two folder segments, prefixed with an ellipsis when the path is deeper. */
export function folderLabel(path: readonly string[]): string {
  if (path.length === 0) return "";
  const tail = path.slice(-2).join(" / ");
  return path.length > 2 ? `… / ${tail}` : tail;
}

/** `Mar 12, 2026`-style date for a `dateAdded` value, or `undefined`. */
export function formatAdded(
  ms: number | undefined,
  locale?: string,
): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
