/**
 * Provider-text sanitization (H05). Anything an LLM wrote — a page summary,
 * a proposed folder name — is untrusted content: it can carry URLs that
 * phish the UI it lands in and markdown that restructures a rendered
 * paragraph. Strip both before the text is persisted or rendered.
 *
 * The transform is idempotent and honest: markdown links keep their visible
 * label (the `[text]` of `[text](url)`), bare URLs are removed outright, and
 * structural markdown (headers, quotes, list bullets, emphasis, code
 * markers) loses its markers. It never invents or rewrites wording.
 */

/** Markdown link/image — `![alt](url)` or `[label](url)` → the visible text. */
const MD_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
/** A bare URL — any `scheme://` form plus protocol-relative `//host/…`. */
const BARE_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+|(?<=^|[\s("'])\/\/\S+/gi;
/** `www.` host without a scheme. */
const WWW_URL = /\bwww\.[^\s/]+\.[^\s/]+\S*/gi;
/** Line-leading structural markdown: `##`, `>`, `-`/`*`/`+` bullets, `1.` items. */
const LINE_MARKERS = /^[ \t]*(?:#{1,6}|>{1,}|[*+-]|\d+\.)[ \t]*/gm;
/** Emphasis/code markers anywhere in the text. */
const EMPHASIS = /[*_~`]+/g;
/** C0/C1-style control characters (except \t and \n, which are structure). */
// Providers occasionally emit C0/C1 control bytes; dropping them is the point.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Leftover markdown brackets/parens that were never part of a link. */
const BRACKETS = /[[\]()]/g;

/**
 * Strip URLs, markdown structure, and control characters from `text`.
 * Returns the cleaned text with whitespace collapsed.
 */
export function stripUrlsAndMarkdown(text: string): string {
  return text
    .replace(CONTROL_CHARS, "")
    .replace(MD_LINK, "$1")
    .replace(BARE_URL, "")
    .replace(WWW_URL, "")
    .replace(LINE_MARKERS, "")
    .replace(EMPHASIS, "")
    .replace(BRACKETS, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
