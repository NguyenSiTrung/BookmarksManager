/**
 * Pure guard deciding whether a bookmark URL may be handed to the Chrome
 * tabs API. Shared by every search surface — side-panel search bar, command
 * palette, popup search, and the `bm` omnibox keyword — which is why it
 * lives in `src/search/` and imports nothing Chrome-, DOM-, or
 * React-related.
 *
 * Policy (spec §5–§7: `javascript:`/`data:` bookmarks are indexed and
 * listed but their open actions are disabled everywhere):
 *
 * - **`javascript:` and `data:` URLs are never openable.** Both smuggle an
 *   executable payload into a navigation: `tabs.update`/`create` would run
 *   a stored-XSS bookmark in the target tab or render attacker markup as a
 *   top-level document. The compare runs on a NORMALIZED view of the input
 *   — ASCII tab/newline removed everywhere, leading/trailing whitespace
 *   trimmed — mirroring how URL parsers canonicalize obfuscation such as
 *   `java\tscript:` or padded `  JAVASCRIPT:…`, and it is
 *   case-insensitive.
 * - **Blank input is not openable** — there is nothing to navigate to.
 * - **Every other input stays openable** (denylist, not allowlist):
 *   `https`/`http`, `chrome-extension:` pages, relative paths (the tabs
 *   API resolves them against the extension origin), `file:`, `ftp:`,
 *   `mailto:`, `about:`, `view-source:`, and schemes we have never heard
 *   of. Chrome applies its own per-scheme rules at call time; a URL it
 *   refuses surfaces as a typed `api` failure from `openBookmarkUrl`
 *   (`src/sync/tabs.ts`). Over-permitting degrades gracefully, while
 *   over-blocking would silently disable opens for legitimate bookmarks
 *   such as `mailto:` links.
 */

/** Schemes whose URLs must never reach `chrome.tabs.*` (case-insensitive). */
const BLOCKED_SCHEME = /^(?:javascript|data):/i;

/**
 * `true` when `url` may be passed to `chrome.tabs.create`/`update`.
 * Total and pure: any string input yields a boolean; nothing throws.
 */
export function isOpenableUrl(url: string): boolean {
  // URL parsers delete ASCII tab/newline ANYWHERE in the input before
  // reading the scheme; mirroring that (plus a whitespace trim) keeps
  // obfuscated forms — `java\nscript:`, `javascript\t:`, padded
  // `  JAVASCRIPT:…` — from slipping past the denylist.
  const cleaned = url.replace(/[\t\n\r]/g, "").trim();
  if (cleaned === "") return false;
  return !BLOCKED_SCHEME.test(cleaned);
}
