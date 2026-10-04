/**
 * Pure outbound-only path contract, shared by the cleaner and the schemas.
 * Never use this for native bookmark URLs or local resource identity.
 */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;
const REDACTED_SEGMENT = "_redacted_";
/** Fixed pass count makes inspection linear in the serialized segment size. */
const MAX_DECODE_PASSES = 8;

/**
 * Decode bytes for inspection only, retaining each byte's original offset.
 * Unlike decodeURIComponent, malformed escapes/UTF-8 cannot hide a later
 * encoded semicolon or token. Peel at most eight layers, including encoded
 * percent signs and hex digits. If more escapes remain, fail closed instead
 * of retaining an undecoded potential secret or doing quadratic work.
 * The original spelling of fully inspected short paths stays untouched.
 */
function inspectSegment(raw: string): { decoded: string; offsets: number[] } | null {
  let decoded = raw;
  let offsets = Array.from({ length: raw.length }, (_, i) => i);
  let passes = 0;
  while (/%[0-9a-f]{2}/i.test(decoded)) {
    if (passes === MAX_DECODE_PASSES) return null;
    const nextOffsets: number[] = [];
    let cursor = 0;
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (match, hex: string, index: number) => {
      for (; cursor < index; cursor += 1) nextOffsets.push(offsets[cursor]!);
      nextOffsets.push(offsets[index]!);
      cursor = index + match.length;
      return String.fromCharCode(Number.parseInt(hex, 16));
    });
    for (; cursor < offsets.length; cursor += 1) nextOffsets.push(offsets[cursor]!);
    decoded = next;
    offsets = nextOffsets;
    passes += 1;
  }
  return { decoded, offsets };
}

function minimizeSegment(raw: string): string {
  // Normal paths avoid decoding and its offset allocations.
  const inspected = raw.includes("%")
    ? inspectSegment(raw) : { decoded: raw, offsets: [] };
  // An unresolved escape may conceal either matrix data or an opaque token.
  // Replace the entire original segment, never return its partial decoding.
  if (inspected === null) return REDACTED_SEGMENT;
  const { decoded, offsets } = inspected;
  const matrix = decoded.indexOf(";");
  const base = matrix < 0 ? decoded : decoded.slice(0, matrix);
  // Encoded separators must not smuggle an opaque subsegment through.
  // Redact the entire serialized segment rather than introduce delimiters.
  if (base.split(/[/\\]/).some((segment) => OPAQUE_SEGMENT.test(segment))) {
    return REDACTED_SEGMENT;
  }
  return matrix < 0 ? raw : raw.slice(0, offsets[matrix] ?? matrix);
}

/** Strip each segment's matrix suffix, then redact opaque segment bases. */
export function minimizeUrlPath(pathname: string): string {
  return pathname.split(/[/\\]/).map(minimizeSegment).join("/");
}

/**
 * Semantic path admission without demanding byte-canonical URL spelling.
 * Inspect the raw path too: WHATWG normalization removes dot segments, but
 * a gate sends the caller's original string, including any hidden secrets.
 * The caller has already parsed the absolute URL and refused query/hash.
 */
export function isMinimizedUrlPath(rawUrl: string, pathname: string): boolean {
  const afterScheme = rawUrl.slice(rawUrl.indexOf(":") + 1);
  const rawPath = afterScheme.replace(/^[/\\]{2}[^/\\]*/, "");
  return minimizeUrlPath(pathname) === pathname &&
    // Backslashes are a semantic separator for special URLs, not a demand
    // that a clean caller rewrite them to canonical forward slashes.
    minimizeUrlPath(rawPath) === rawPath.replaceAll("\\", "/");
}
