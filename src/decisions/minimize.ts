import type { SentBookmark } from "../schemas/decision-state";

/**
 * Data minimization for outbound Jev states (spec FR2, PROJECT_PLAN.md §12).
 * Pure module — no `chrome`, DOM, React, or `fetch`.
 *
 * - `cleanUrl` strips query strings, fragments, and `user:password@`
 *   credentials and returns the canonical WHATWG serialization — exactly the
 *   form `CleanedUrl` in `src/schemas/decision-state.ts` validates.
 * - `isSensitiveUrl` is the sensitive-site blocklist: banking, health
 *   portals, and webmail domains ({@link BUILTIN_SENSITIVE_SITES}), `file:`
 *   URLs, private/loopback IP ranges (v4 and v6, including IPv4-mapped and
 *   NAT64 spellings), dotless intranet hostnames, private-use TLDs, and
 *   hostless schemes (`data:`, `javascript:`, `mailto:`, …). It fails closed
 *   on unparseable input. Matching bookmarks are skipped — never sent.
 * - The user's own entries are a pure function parameter
 *   (`userBlocklist`); `addBlocklistEntry`/`removeBlocklistEntry`/
 *   `normalizeBlocklistEntry` are the edit helpers the Options UI will call.
 *   Persistence is a later task's job.
 */

/** Matches `SentBookmark.title`'s bound so minimized output always parses. */
const TITLE_MAX = 500;

/** Matches `CleanedUrl`'s bound so minimized output always parses. */
const CLEANED_URL_MAX = 2_048;

/**
 * Strip the parts of a URL that must never leave the device: query string,
 * fragment, and `user[:pass]@` credentials. Returns the canonical WHATWG
 * serialization (lowercase scheme/host, punycode IDN, default port dropped,
 * trailing bare `?`/`#` markers removed) or `null` when the input is not an
 * absolute URL. Scheme-agnostic — whether a scheme is sendable is the
 * blocklist's call, not the cleaner's.
 */
export function cleanUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The `domain` value for a sent bookmark: the URL's hostname verbatim
 * (lowercased, punycode, IPv6 bracketed), or `null` when the URL is
 * unparseable or has no host.
 */
export function domainOf(raw: string): string | null {
  try {
    const { hostname } = new URL(raw);
    return hostname === "" ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * Built-in sensitive-site blocklist: host suffixes covering banking and
 * payments, health portals and insurers, and webmail. An entry matches a URL
 * whose canonical host equals it or ends with `.<entry>` (subdomains
 * included, look-alike suffixes excluded). Frozen — user additions arrive as
 * a separate list via `userBlocklist`.
 */
export const BUILTIN_SENSITIVE_SITES: readonly string[] = Object.freeze([
  // Banking, payments, brokerages
  "ally.com",
  "americanexpress.com",
  "bankofamerica.com",
  "barclays.com",
  "capitalone.com",
  "chase.com",
  "chime.com",
  "citi.com",
  "citibank.com",
  "coinbase.com",
  "discover.com",
  "fidelity.com",
  "hsbc.com",
  "navyfederal.org",
  "paypal.com",
  "pnc.com",
  "revolut.com",
  "robinhood.com",
  "santander.com",
  "schwab.com",
  "sofi.com",
  "td.com",
  "tdbank.com",
  "usaa.com",
  "usbank.com",
  "vanguard.com",
  "venmo.com",
  "wellsfargo.com",
  "wise.com",
  // Health portals and insurers
  "aetna.com",
  "anthem.com",
  "athenahealth.com",
  "bcbs.com",
  "cigna.com",
  "epichosted.com",
  "followmyhealth.com",
  "healow.com",
  "humana.com",
  "kaiserpermanente.org",
  "kp.org",
  "mychart.com",
  "myhealth.va.gov",
  "myuhc.com",
  "uhc.com",
  // Webmail
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.net",
  "hey.com",
  "hotmail.com",
  "hushmail.com",
  "icloud.com",
  "mail.aol.com",
  "mail.com",
  "mail.google.com",
  "mail.icloud.com",
  "mail.yahoo.com",
  "mail.yandex.com",
  "mail.yandex.ru",
  "mail.zoho.com",
  "mailfence.com",
  "outlook.com",
  "outlook.live.com",
  "outlook.office.com",
  "proton.me",
  "protonmail.com",
  "tuta.com",
  "tutanota.com",
]);

/**
 * Private-use / non-public TLDs: a host equal to one of these or ending in
 * `.<tld>` is intranet or unreachable-infrastructure naming and is never
 * sent. Covers mDNS `.local`, the RFC 6761 reserved names, common private
 * zones, `*.arpa` (incl. `home.arpa` and reverse-DNS), and `.onion`.
 */
const INTRANET_SUFFIXES: readonly string[] = [
  "arpa",
  "corp",
  "example",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localhost",
  "onion",
  "test",
];

/**
 * WHATWG "special" schemes — only these get canonical (lowercased, IDNA,
 * IPv4-normalized) hostnames from the URL parser. Everything else has an
 * opaque host that keeps its raw spelling.
 */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set([
  "ftp:",
  "file:",
  "http:",
  "https:",
  "ws:",
  "wss:",
]);

/** Canonical compare form for a hostname: unbracketed IPv6, no trailing
 * dot, lowercased (DNS matching is case-insensitive). */
function canonicalHost(hostname: string): string {
  let host = hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host.replace(/\.+$/, "").toLowerCase();
}

/**
 * Canonical compare form for `url.hostname`. Special-scheme hostnames are
 * already canonical; opaque-scheme hosts keep case, percent-escapes, and
 * IPv4 shorthand verbatim (`foo://0x7f.1/`, `foo://Bücher.de/`), so they are
 * re-canonicalized through a `https://` parse — percent-decoding first — and
 * the raw spelling is kept only when that fails.
 */
function canonicalUrlHost(url: URL): string {
  let host = url.hostname;
  if (host !== "" && !SPECIAL_SCHEMES.has(url.protocol)) {
    try {
      if (host.includes("%")) {
        host = decodeURIComponent(host);
      }
      host = new URL(`https://${host}`).hostname;
    } catch {
      // keep the raw opaque form — matching below just won't find it
    }
  }
  return canonicalHost(host);
}

/**
 * Canonical form of a user-facing blocklist entry: a bare host or domain
 * (`mybank.example`, `::1`, `[::1]`, `bücher.de`), an optional `*.` prefix,
 * or a full URL whose hostname is taken. Returns `null` for input that is
 * empty, unparseable, or carries a path/query/credentials. The result is
 * lowercase, punycoded, port-free, dot-trimmed, and IPv6-unbracketed — the
 * same form `isSensitiveUrl` compares against.
 */
export function normalizeBlocklistEntry(raw: string): string | null {
  let text = raw.trim();
  if (text === "") {
    return null;
  }
  if (text.startsWith("*.")) {
    text = text.slice(2);
  }

  let hostname: string;
  try {
    if (text.includes("://")) {
      hostname = canonicalUrlHost(new URL(text));
    } else {
      if (/[\s/?#@]/.test(text)) {
        return null;
      }
      try {
        // Bare hosts (and `host:port`) parse under a dummy https scheme;
        // this also lowercases and punycodes.
        hostname = new URL(`https://${text}`).hostname;
      } catch {
        // Bare IPv6 literals ("::1") need brackets to parse as a URL.
        hostname = new URL(`https://[${text}]`).hostname;
      }
    }
  } catch {
    return null;
  }

  const host = canonicalHost(hostname);
  return host === "" ? null : host;
}

/** True when `host` (canonical form) equals `entry` or ends with `.<entry>`. */
function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

/** Parse a canonical dotted-decimal IPv4 hostname into its octets. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const quad: number[] = [];
  for (const part of parts) {
    // The WHATWG parser canonicalizes hex/octal/short spellings to dotted
    // decimal, so this only ever sees plain digits.
    if (!/^[0-9]{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    quad.push(value);
  }
  return quad as [number, number, number, number];
}

/**
 * Private or non-routable IPv4: 0/8 (this network), 10/8, 172.16/12,
 * 192.168/16 (RFC 1918), 127/8 (loopback), 169.254/16 (link-local),
 * 100.64/10 (CGNAT), 198.18/15 (benchmarking), 192.0.0.0/24 (IETF protocol
 * assignments), 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (RFC 5737
 * documentation ranges), and 224.0.0.0/4 + 240.0.0.0/4 (multicast and
 * reserved, including 255.255.255.255 broadcast).
 */
function isPrivateIpv4([a, b, c]: readonly [
  number,
  number,
  number,
  number,
]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

type Ipv6Groups = [number, number, number, number, number, number, number, number];

/**
 * Expand an IPv6 literal (no brackets) to its eight 16-bit groups.
 * Handles `::` compression and a dotted IPv4 tail. `null` when malformed —
 * defensive depth, since URL-parser hostnames are already canonical.
 */
function parseIpv6(address: string): Ipv6Groups | null {
  if (address === "" || !address.includes(":")) {
    return null;
  }
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const headText = halves[0] ?? "";
  const headGroups = headText === "" ? [] : headText.split(":");
  const tailText = halves.length === 2 ? (halves[1] ?? "") : null;
  const tailGroups =
    tailText === null ? null : tailText === "" ? [] : tailText.split(":");

  const parseGroups = (groups: readonly string[]): number[] | null => {
    const out: number[] = [];
    for (const [index, group] of groups.entries()) {
      if (group.includes(".")) {
        if (index !== groups.length - 1) {
          return null;
        }
        const v4 = parseIpv4(group);
        if (v4 === null) {
          return null;
        }
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
          return null;
        }
        out.push(Number.parseInt(group, 16));
      }
    }
    return out;
  };

  const head = parseGroups(headGroups);
  if (head === null) {
    return null;
  }
  if (tailGroups === null) {
    return head.length === 8 ? (head as Ipv6Groups) : null;
  }
  const tail = parseGroups(tailGroups);
  if (tail === null) {
    return null;
  }
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) {
    return null; // "::" must compress at least one group
  }
  return [
    ...head,
    ...new Array<number>(zeros).fill(0),
    ...tail,
  ] as Ipv6Groups;
}

/**
 * Private or non-routable IPv6: `::` (unspecified) and `::1` (loopback),
 * `::ffff:0:0/96` IPv4-mapped and deprecated `::/96` IPv4-compatible (both
 * defer to the embedded address's IPv4 rules), NAT64 `64:ff9b::/96` ditto,
 * `fc00::/7` (ULA), `fe80::/10` and `fec0::/10` (link-local / site-local),
 * `ff00::/8` (multicast), `2001:db8::/32` (documentation), `2002::/16` (6to4)
 * and `2001::/32` (Teredo) — the transition mechanisms embed a possibly-
 * private IPv4 inside a public-looking address.
 */
function isPrivateIpv6(g: Ipv6Groups): boolean {
  const embeddedV4 = (): [number, number, number, number] => [
    g[6] >> 8,
    g[6] & 0xff,
    g[7] >> 8,
    g[7] & 0xff,
  ];
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    (g[5] === 0 || g[5] === 0xffff)
  ) {
    return isPrivateIpv4(embeddedV4());
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    return isPrivateIpv4(embeddedV4());
  }
  return (
    (g[0] & 0xff00) === 0xff00 ||
    (g[0] === 0x2001 && g[1] === 0) ||
    (g[0] === 0x2001 && g[1] === 0x0db8) ||
    g[0] === 0x2002 ||
    (g[0] & 0xfe00) === 0xfc00 ||
    (g[0] & 0xffc0) === 0xfe80 ||
    (g[0] & 0xffc0) === 0xfec0
  );
}

/**
 * Is this URL structurally non-public — something a real saved bookmark
 * should never be, regardless of its content? Covers `file:` URLs, hostless
 * opaque schemes (`data:`, `mailto:`, `javascript:`, `about:`, `blob:`, …),
 * private/loopback/reserved IP ranges (v4 and v6), dotless intranet
 * hostnames, and private-use TLDs. Fails closed on unparseable input.
 *
 * Unlike {@link isSensitiveUrl} this ignores the builtin and user
 * blocklists — a public banking or webmail domain passes. Eval fixtures use
 * it to stay public-looking while still allowing builtin-sensitive domains
 * for exclusion cases.
 */
export function isNonPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol === "file:") {
    return true;
  }
  const host = canonicalUrlHost(url);
  if (host === "") {
    return true;
  }
  if (host.includes(":")) {
    const groups = parseIpv6(host);
    return groups === null || isPrivateIpv6(groups);
  }
  const v4 = parseIpv4(host);
  if (v4 !== null) {
    return isPrivateIpv4(v4);
  }
  return (
    !host.includes(".") ||
    INTRANET_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  );
}

/**
 * Is this URL on the sensitive-site blocklist (never sent to Jev)? Fails
 * closed: unparseable input counts as sensitive. `userBlocklist` entries may
 * be raw user input — each is run through {@link normalizeBlocklistEntry}
 * and malformed entries are skipped.
 */
export function isSensitiveUrl(
  raw: string,
  userBlocklist?: readonly string[],
): boolean {
  if (isNonPublicUrl(raw)) {
    return true;
  }

  const url = new URL(raw); // parseable — non-public input returned above.
  const host = canonicalUrlHost(url);

  // The builtin list only applies to dotted DNS names — an IP literal that
  // survived isNonPublicUrl is public and never matches a domain suffix.
  if (
    !host.includes(":") &&
    parseIpv4(host) === null &&
    BUILTIN_SENSITIVE_SITES.some((entry) => hostMatches(host, entry))
  ) {
    return true;
  }

  for (const rawEntry of userBlocklist ?? []) {
    const entry = normalizeBlocklistEntry(rawEntry);
    if (entry !== null && hostMatches(host, entry)) {
      return true;
    }
  }
  return false;
}

/**
 * Add `raw` (normalized via {@link normalizeBlocklistEntry}) to a user
 * blocklist, returning a new array — no duplicates. Throws `TypeError` on
 * input that cannot name a host, so the Options editor can surface it.
 */
export function addBlocklistEntry(
  entries: readonly string[],
  raw: string,
): readonly string[] {
  const entry = normalizeBlocklistEntry(raw);
  if (entry === null) {
    throw new TypeError(
      `${JSON.stringify(raw)} is not a valid blocklist host or URL.`,
    );
  }
  if (entries.includes(entry)) {
    return entries;
  }
  return [...entries, entry];
}

/**
 * Remove `raw` from a user blocklist (compared in normalized form), or return
 * the list unchanged when it is absent or invalid. Returns a new array.
 */
export function removeBlocklistEntry(
  entries: readonly string[],
  raw: string,
): readonly string[] {
  const entry = normalizeBlocklistEntry(raw);
  if (entry === null) {
    return entries;
  }
  return entries.filter(
    (item) => item !== entry && normalizeBlocklistEntry(item) !== entry,
  );
}

/**
 * Reduce a bookmark to the only triple Jev may see — `{title, url, domain}` —
 * or `null` when it is unparseable or blocklisted (the pipeline marks those
 * "not sent"). The title is truncated to the `SentBookmark` bound so the
 * result always parses. Extra input keys — notes included — are never
 * copied: notes stay on the device (plan §12).
 */
export function minimizeBookmark(
  input: { readonly title: string; readonly url: string; readonly notes?: string },
  userBlocklist?: readonly string[],
): SentBookmark | null {
  const cleaned = cleanUrl(input.url);
  if (
    cleaned === null ||
    cleaned.length > CLEANED_URL_MAX ||
    isSensitiveUrl(cleaned, userBlocklist)
  ) {
    return null;
  }
  // Unreachable today — isSensitiveUrl already rejected hostless schemes —
  // but keep the guard so the function stays total if rules change.
  const domain = domainOf(cleaned);
  if (domain === null) {
    return null;
  }
  return { title: input.title.slice(0, TITLE_MAX), url: cleaned, domain };
}
