/**
 * Bounded success-body reader shared by the Jev and LLM clients (audit A06).
 * A provider can answer a permitted request with an unbounded or deeply
 * nested body; reading it through `response.json()` hands an attacker
 * arbitrary memory and stack. Every success body is therefore read through
 * `readJsonCapped`: at most {@link MAX_RESPONSE_BYTES} are consumed, the JSON
 * nesting depth is capped before `JSON.parse`, and the stream is cancelled
 * whenever we stop reading early — never leave a live body attached.
 */

/** Success-response cap: generous headroom over real completions/answers. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
/** Maximum JSON nesting depth accepted before parse (matches export depth). */
export const MAX_RESPONSE_DEPTH = 64;

/** Thrown when a body exceeds the byte or depth cap, or cannot decode. */
export class BodyCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyCapError";
  }
}

/** Deepest `{`/`[` nesting in `text`, ignoring structure inside strings. */
function jsonDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === 0x5c) escaped = true; // backslash
      else if (ch === 0x22) inString = false; // '"'
      continue;
    }
    if (ch === 0x22) {
      inString = true;
    } else if (ch === 0x7b || ch === 0x5b) { // '{' | '['
      depth += 1;
      if (depth > max) max = depth;
      if (max > MAX_RESPONSE_DEPTH) return max;
    } else if (ch === 0x7d || ch === 0x5d) { // '}' | ']'
      depth -= 1;
      if (depth < 0) return max; // malformed — JSON.parse reports it
    }
  }
  return max;
}

/**
 * Read `response`'s body under {@link MAX_RESPONSE_BYTES} and parse it as
 * JSON at most {@link MAX_RESPONSE_DEPTH} deep. Throws `BodyCapError` when
 * the body exceeds either cap or is not valid UTF-8, and the native parse
 * error for malformed JSON — callers classify the outcome, never inspect
 * the text. The stream is cancelled whenever reading stops early, so an
 * over-cap or aborted response can never hold the connection open.
 */
export async function readJsonCapped(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new BodyCapError("Response body is not readable.");
  }
  let completed = false;
  try {
    const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        const text = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes.subarray(0, length));
        if (jsonDepth(text) > MAX_RESPONSE_DEPTH) {
          throw new BodyCapError("Response body exceeds the JSON depth cap.");
        }
        return JSON.parse(text) as unknown;
      }
      if (value.byteLength > MAX_RESPONSE_BYTES - length) {
        throw new BodyCapError("Response body exceeds the byte cap.");
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Cancel is best-effort; the read outcome is already decided.
      }
    }
  }
}
