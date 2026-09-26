/**
 * Deterministic URL normalization for local duplicate detection.
 *
 * Pure functions only — no DOM, no `chrome`, no network. `normalizeUrl` maps
 * a raw bookmark URL to a canonical key so that trivially-different spellings
 * of the same page compare equal:
 *
 * - scheme and host lowercased (the WHATWG parser does this for special
 *   schemes; asserted here anyway so the rule is explicit)
 * - default port dropped (80 for http, 443 for https — again parser-native,
 *   so `http://x:443` keeps `:443` while `https://x:443` loses it)
 * - fragment dropped
 * - one leading `www.` dropped from the host
 * - http and https treated as equal: the scheme is erased from the key
 * - trailing slash(es) stripped from the path (root `/` becomes empty)
 * - query parameters sorted by name, then value
 * - common tracking parameters dropped: `utm_*` (any name with that prefix)
 *   plus every name in {@link TRACKING_PARAMS}, all case-insensitive
 *
 * Key shape: `[userinfo@]host[:port][/path][?query]` — deliberately
 * scheme-free so `http://…` and `https://…` keys are identical.
 *
 * Returns `null` for unparseable input AND for non-http(s) URLs
 * (`chrome:`, `file:`, `javascript:`, `data:`, `mailto:`, `ftp:`, …). Those
 * URLs are intentionally never normalized — they can only participate in
 * "exact" duplicate groups. Callers treat both `null` cases identically.
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  // Userinfo is kept when present: credentials change what the URL reaches,
  // so folding them away could merge distinct bookmarks.
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ""}@`
    : "";

  let host = url.hostname.toLowerCase();
  if (host.startsWith("www.") && host.length > "www.".length) {
    host = host.slice("www.".length);
  }

  // `url.port` is already empty when the port equals the scheme's default
  // (the URL parser drops it); non-default ports survive verbatim.
  const port = url.port === "" ? "" : `:${url.port}`;

  // Strip trailing slashes only — interior `//` stays significant.
  const path = url.pathname.replace(/\/+$/, "");

  const query = canonicalQuery(url.search);

  return `${auth}${host}${port}${path}${query === "" ? "" : `?${query}`}`;
}

/**
 * Query parameter names dropped during normalization, in addition to the
 * `utm_*` prefix rule. Matching is case-insensitive (`FBCLID` drops too).
 * Locked by tests/unit/duplicates-normalize.test.ts — extend the list rather
 * than rename entries, since stored/grouped keys depend on it.
 */
export const TRACKING_PARAMS: readonly string[] = [
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "mc_eid",
  "msclkid",
  "ref",
  "wbraid",
];

const TRACKING_PARAM_SET: ReadonlySet<string> = new Set(TRACKING_PARAMS);
const UTM_PREFIX = "utm_";

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(UTM_PREFIX) || TRACKING_PARAM_SET.has(lower);
}

/**
 * Rebuild a query string with tracking params removed and the rest sorted by
 * name then value (code-unit order — deterministic, locale-independent).
 * Round-tripping through URLSearchParams also collapses equivalent encodings
 * (`%20` vs `+`, stray escapes) into one canonical form.
 */
function canonicalQuery(search: string): string {
  if (search === "") {
    return "";
  }
  const pairs: [string, string][] = [];
  for (const [name, value] of new URLSearchParams(search)) {
    if (!isTrackingParam(name)) {
      pairs.push([name, value]);
    }
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) {
      return a[0] < b[0] ? -1 : 1;
    }
    if (a[1] === b[1]) {
      return 0;
    }
    return a[1] < b[1] ? -1 : 1;
  });
  return new URLSearchParams(pairs).toString();
}
