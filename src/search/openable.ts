/**
 * THE shared scheme policy (D15): one normalization and one allowlist for
 * every surface that hands a bookmark URL to `chrome.tabs.*` — side-panel
 * search bar, command palette, popup search, and the `bm` omnibox keyword —
 * which is why it lives in `src/search/` and imports nothing Chrome-, DOM-,
 * or React-related. The import guard `isBlockedScheme`
 * (`src/io/netscape.ts`) consumes the same {@link urlScheme} normalizer, so
 * an obfuscated scheme spelling can never split the two guards: a URL
 * blocked at import is never openable, and only an allowlisted scheme ever
 * reaches the tabs API.
 *
 * Policy (fail-closed, spec D15):
 *
 * - **Allowlist, not denylist.** Only `http`, `https`, `mailto`, and `ftp`
 *   are openable. `javascript:`/`data:`/`vbscript:` smuggle executable
 *   payloads into navigation; `blob:`/`view-source:`/`file:`/`about:`/
 *   `chrome-extension:`/relative/schemeless inputs and schemes we have
 *   never heard of are equally not openable — a bookmark may exist and be
 *   listed while every open action stays disabled.
 * - **C0 controls stripped before the scheme is read.** URL parsers
 *   delete ASCII tab/newline ANYWHERE in the input; this policy strips
 *   the whole C0 range plus space (\x00-\x20) — the same normalization
 *   `isBlockedScheme` applies — so `java\tscript:`, `java script:`,
 *   `\x01javascript:` and padded `  JAVASCRIPT:…` all resolve to the
 *   scheme they would execute as.
 * - **Blank input is not openable** — there is nothing to navigate to.
 */

/** Schemes whose URLs may reach `chrome.tabs.*` (lowercase). */
export const OPENABLE_URL_SCHEMES: ReadonlySet<string> = new Set([
  "http",
  "https",
  "mailto",
  "ftp",
]);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * The scheme a browser would honor for `url`, lowercased — or `undefined`
 * when the input has no scheme. ASCII control characters (\x00-\x1f) and
 * spaces are removed first, matching how navigations canonicalize
 * obfuscated spellings: `java\tscript:` and `java script:` both parse as
 * `javascript:`. Shared with `isBlockedScheme` — THE one normalization
 * both the open guard and the import guard apply.
 */
export function urlScheme(url: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\x00-\x20]/g, "");
  const scheme = SCHEME_PATTERN.exec(compact)?.[1];
  return scheme === undefined ? undefined : scheme.toLowerCase();
}

/**
 * `true` when `url` may be passed to `chrome.tabs.create`/`update`.
 * Total and pure: any string input yields a boolean; nothing throws.
 */
export function isOpenableUrl(url: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (url.replace(/[\x00-\x20]/g, "") === "") return false;
  const scheme = urlScheme(url);
  return scheme !== undefined && OPENABLE_URL_SCHEMES.has(scheme);
}
