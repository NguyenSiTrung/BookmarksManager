import { isSensitiveUrl } from "./minimize";

/** Local-only resource identity, never an outbound URL or persisted key. */
export function summaryResourceKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || isSensitiveUrl(raw)) {
    return null;
  }
  // Decode names only for the allowlist. Preserve every remaining query
  // byte, including order, duplicate keys, plus signs and percent escapes.
  const query = url.search.slice(1).split("&").filter((part) => {
    const name = new URLSearchParams(part).keys().next().value;
    return name === undefined || !(
      name === "utm" || name.startsWith("utm_") ||
      name === "gclid" || name === "fbclid" || name === "msclkid"
    );
  }).join("&");
  url.search = query;
  // Nonempty fragments are conservatively identity-bearing, even when
  // they might be document anchors rather than application routes.
  if (url.hash === "") url.hash = "";
  return url.toString();
}

export function sameSummaryResource(saved: string, active: string): boolean {
  const savedKey = summaryResourceKey(saved);
  return savedKey !== null && savedKey === summaryResourceKey(active);
}
