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
 * - scheme KEPT: `http:` and `https:` are not the same page (D01) — one
 *   may 301 to the other, or serve different content entirely, and a merge
 *   built on that guess can destroy a bookmark the user meant to keep
 * - route-like fragments kept (`#/…`, `#!…` — SPAs route on them, so
 *   `app.com/#/inbox` and `app.com/#/settings` are different pages);
 *   plain anchor fragments (`#section`) are dropped
 * - one leading `www.` dropped from the host
 * - trailing slash(es) stripped from the path (root `/` becomes empty)
 * - query parameters sorted by name, then value
 * - common tracking parameters dropped: `utm_*` (any name with that prefix)
 *   plus every name in {@link TRACKING_PARAMS}, all case-insensitive;
 *   `ref` drops only on {@link REF_TRACKING_HOSTS} — elsewhere it carries
 *   content (a repo `?ref=` picks the branch) and folding it away merges
 *   distinct bookmarks
 *
 * Key shape: `scheme://[userinfo@]host[:port][/path][?query][#route]`.
 *
 * Returns `null` for unparseable input AND for non-http(s) URLs
 * (`chrome:`, `file:`, `javascript:`, `data:`, `mailto:`, `ftp:`, …). Those
 * URLs are intentionally never normalized — they can only participate in
 * "exact" duplicate groups. Callers treat both `null` cases identically.
 *
 * Normalized keys are a SUGGESTION layer only: exact groups still key on
 * the raw URL, and `merge_duplicates` decisions never auto-apply.
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
  const scheme = url.protocol.slice(0, -1);

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

  const query = canonicalQuery(url.search, host);
  const route = routeFragment(url.hash);

  return (
    `${scheme}://${auth}${host}${port}${path}` +
    `${query === "" ? "" : `?${query}`}${route}`
  );
}

/**
 * Route-like fragments survive: SPA routers dispatch on `#/…` and the
 * legacy hashbang `#!…`, so those fragments are the page's identity, not
 * an anchor. Anything else is a same-page anchor and drops.
 */
function routeFragment(hash: string): string {
  if (hash.startsWith("#/") || hash.startsWith("#!")) {
    return hash;
  }
  return "";
}

/**
 * Query parameter names dropped during normalization, in addition to the
 * `utm_*` prefix rule. Matching is case-insensitive (`FBCLID` drops too).
 * Locked by tests/unit/duplicates-normalize.test.ts — extend the list rather
 * than rename entries, since stored/grouped keys depend on it.
 *
 * `ref` is NOT here: it is host-scoped — see {@link REF_TRACKING_HOSTS}.
 */
export const TRACKING_PARAMS: readonly string[] = [
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "mc_eid",
  "msclkid",
  "wbraid",
];

const TRACKING_PARAM_SET: ReadonlySet<string> = new Set(TRACKING_PARAMS);
const UTM_PREFIX = "utm_";

/**
 * Hosts where a bare `?ref=` (or `&ref=`) is a referral/analytics tag and
 * drops during normalization (D01). Everywhere else `ref` stays: on repo
 * hosts it names the branch or revision the page renders
 * (`github.com/x?ref=main` vs `?ref=dev` are different pages), and on
 * unknown hosts failing closed keeps two pages distinct rather than
 * merging bookmarks that may differ. Entries are matched against the
 * `www.`-stripped host with suffix semantics (a listed `example.com` also
 * covers `a.example.com`).
 */
export const REF_TRACKING_HOSTS: readonly string[] = [
  "amazon.com",
  "dev.to",
  "imdb.com",
  "medium.com",
  "reddit.com",
];

function isRefTrackingHost(host: string): boolean {
  return REF_TRACKING_HOSTS.some(
    (listed) => host === listed || host.endsWith(`.${listed}`),
  );
}

function isTrackingParam(name: string, host: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "ref") {
    return isRefTrackingHost(host);
  }
  return lower.startsWith(UTM_PREFIX) || TRACKING_PARAM_SET.has(lower);
}

/**
 * Rebuild a query string with tracking params removed and the rest sorted by
 * name then value (code-unit order — deterministic, locale-independent).
 * Round-tripping through URLSearchParams also collapses equivalent encodings
 * (`%20` vs `+`, stray escapes) into one canonical form. `host` scopes the
 * `ref` rule per {@link REF_TRACKING_HOSTS}.
 */
function canonicalQuery(search: string, host: string): string {
  if (search === "") {
    return "";
  }
  const pairs: [string, string][] = [];
  for (const [name, value] of new URLSearchParams(search)) {
    if (!isTrackingParam(name, host)) {
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
